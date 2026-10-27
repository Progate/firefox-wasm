// SPDX-License-Identifier: MPL-2.0
#include "windowserver.h"
#include <arpa/inet.h>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
#include <vector>

static bool pwriteAll(int fd, const void* data, size_t size, off_t offset) {
  auto bytes = static_cast<const uint8_t*>(data);
  while (size) {
    ssize_t n = pwrite(fd, bytes, size, offset);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return false;
    bytes += n;
    size -= n;
    offset += n;
  }
  return true;
}

static bool writeAll(int fd, const void* data, size_t size) {
  auto bytes = static_cast<const uint8_t*>(data);
  while (size) {
    ssize_t n = write(fd, bytes, size);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return false;
    bytes += n;
    size -= n;
  }
  return true;
}

WindowServer::~WindowServer() {
  if (socket_ >= 0) {
    if (id_) command("destroy " + std::to_string(id_));
    close(socket_);
  }
  if (surface_ >= 0) close(surface_);
}

bool WindowServer::command(const std::string& text) {
  if (!connected()) return false;
  const auto line = text + "\n";
  std::lock_guard<std::mutex> lock(send_);
  if (writeAll(socket_, line.data(), line.size())) return true;
  lost();
  return false;
}

bool WindowServer::setClipboard(const std::string& text) {
  // The protocol's text encoding: every byte but ASCII letters and digits as %XX.
  std::string encoded;
  for (unsigned char byte : text) {
    if (isalnum(byte)) {
      encoded += static_cast<char>(byte);
    } else {
      char escape[4];
      snprintf(escape, sizeof escape, "%%%02X", byte);
      encoded += escape;
    }
  }
  return command("clipboard-set " + std::to_string(id_) + " " + encoded);
}

bool WindowServer::setCursor(const std::string& rectangle) {
  return command("cursor " + std::to_string(id_) + rectangle);
}

bool WindowServer::resize(int w, int h) {
  if (w < 1 || h < 1 || w > 8192 || h > 8192) return false;
  width = w;
  height = h;
  return true;
}

bool WindowServer::open(int w, int h, const std::string& appId) {
  if (!resize(w, h)) return false;
  // DISPLAY is host:port[.screen], the X form host:display.screen with the
  // listening port in place of the display number. The screen picks the
  // screen the window goes on (X's DefaultScreen); without it, screen 0.
  const char* display = getenv("DISPLAY");
  std::string address = display ? display : "127.0.0.1:6000";
  const auto colon = address.rfind(':');
  if (colon == std::string::npos) return false;
  char* end = nullptr;
  long port = strtol(address.c_str() + colon + 1, &end, 10);
  if (!end || port < 1 || port > 65535) return false;
  long screen = 0;
  if (*end == '.') {
    char* screenEnd = nullptr;
    screen = strtol(end + 1, &screenEnd, 10);
    if (!screenEnd || *screenEnd || screenEnd == end + 1 || screen < 0) return false;
  } else if (*end) {
    return false;
  }
  sockaddr_in target{};
  target.sin_family = AF_INET;
  target.sin_port = htons(port);
  if (inet_pton(AF_INET, address.substr(0, colon).c_str(), &target.sin_addr) != 1) return false;
  socket_ = socket(AF_INET, SOCK_STREAM, 0);
  if (socket_ < 0 || connect(socket_, reinterpret_cast<sockaddr*>(&target), sizeof(target)) < 0) return false;
  // Name the screen like X's CreateWindow names the root of that screen as the
  // parent. Screen 0 is left unsaid so the line stays the same as before.
  std::string request = "surface " + std::to_string(width) + " " + std::to_string(height);
  if (screen != 0) request += " screen=" + std::to_string(screen);
  if (!command(request)) return false;
  // Other notices (focus, properties) may arrive before the surface reply;
  // keep reading until it comes.
  std::string line;
  char path[4096];
  int actualWidth = 0, actualHeight = 0;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  for (;;) {
    if (next(line, 100) &&
        sscanf(line.c_str(), "surface %d %4095s %d %d", &id_, path, &actualWidth, &actualHeight) == 4) {
      break;
    }
    if (!connected() || std::chrono::steady_clock::now() >= deadline) {
      fprintf(stderr, "windowserver: no surface reply (last line: %s)\n", line.c_str());
      return false;
    }
  }
  if (id_ <= 0 || !resize(actualWidth, actualHeight)) return false;
  surface_ = ::open(path, O_WRONLY);
  if (surface_ < 0) {
    fprintf(stderr, "windowserver: cannot open %s: %s\n", path, strerror(errno));
    return false;
  }
  return command("app " + std::to_string(id_) + " " + appId) &&
      command("title " + std::to_string(id_) + " FireDog");
}

bool WindowServer::next(std::string& line, int timeoutMs) {
  if (!connected()) return false;
  auto newline = pending_.find('\n');
  if (newline == std::string::npos) {
    pollfd fd{socket_, POLLIN, 0};
    int ready;
    do { ready = poll(&fd, 1, timeoutMs); } while (ready < 0 && errno == EINTR);
    if (ready == 0) return false;
    if (ready < 0 || (fd.revents & (POLLERR | POLLNVAL))) { lost(); return false; }
    char bytes[4096];
    ssize_t size = read(socket_, bytes, sizeof(bytes));
    if (size <= 0) { lost(); return false; }
    pending_.append(bytes, size);
    if (pending_.size() > 65536) { lost(); return false; }
    newline = pending_.find('\n');
    if (newline == std::string::npos) return false;
  }
  line = pending_.substr(0, newline);
  pending_.erase(0, newline + 1);
  return true;
}

bool WindowServer::presentRows(const uint8_t* bgra, int top, int rows) {
  if (!bgra || surface_ < 0) return false;
  if (top < 0) { rows += top; top = 0; }
  if (top + rows > height) rows = height - top;
  if (rows <= 0) return true;
  const size_t stride = static_cast<size_t>(width) * 4;
  const size_t size = stride * rows;
  if (rgba_.size() < size) rgba_.resize(size);
  // BGRA (Gecko's native 32-bit order) to the windowserver's RGBA, opaque.
  // Done a 32-bit word at a time so the compiler can vectorize it with simd128.
  const uint8_t* from = bgra + stride * top;
  const size_t count = static_cast<size_t>(width) * rows;
  for (size_t i = 0; i < count; i++) {
    uint32_t pixel;
    memcpy(&pixel, from + i * 4, 4);
    pixel = (pixel & 0x0000ff00u) | ((pixel >> 16) & 0xffu) | ((pixel & 0xffu) << 16) | 0xff000000u;
    memcpy(rgba_.data() + i * 4, &pixel, 4);
  }
  const off_t offset = static_cast<off_t>(stride * top);
  // pwrite saves the lseek round trip through the syscall bridge; a surface
  // that cannot pwrite (ENOTSUP from a file system without it) still takes
  // lseek + write.
  if (!pwriteAll(surface_, rgba_.data(), size, offset) &&
      (lseek(surface_, offset, SEEK_SET) != offset || !writeAll(surface_, rgba_.data(), size))) {
    return false;
  }
  return command("commit " + std::to_string(id_) + " " + std::to_string(top) + " " + std::to_string(rows));
}
