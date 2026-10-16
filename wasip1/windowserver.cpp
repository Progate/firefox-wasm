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
  const auto line = text + "\n";
  return writeAll(socket_, line.data(), line.size());
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

bool WindowServer::open(int w, int h) {
  if (!resize(w, h)) return false;
  const char* display = getenv("DISPLAY");
  std::string address = display ? display : "127.0.0.1:6000";
  const auto colon = address.rfind(':');
  if (colon == std::string::npos) return false;
  char* end = nullptr;
  long port = strtol(address.c_str() + colon + 1, &end, 10);
  if (!end || *end || port < 1 || port > 65535) return false;
  sockaddr_in target{};
  target.sin_family = AF_INET;
  target.sin_port = htons(port);
  if (inet_pton(AF_INET, address.substr(0, colon).c_str(), &target.sin_addr) != 1) return false;
  socket_ = socket(AF_INET, SOCK_STREAM, 0);
  if (socket_ < 0 || connect(socket_, reinterpret_cast<sockaddr*>(&target), sizeof(target)) < 0) return false;
  if (!command("surface " + std::to_string(width) + " " + std::to_string(height))) return false;
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
  return command("app " + std::to_string(id_) + " firefox") &&
      command("title " + std::to_string(id_) + " Firefox");
}

bool WindowServer::next(std::string& line, int timeoutMs) {
  auto newline = pending_.find('\n');
  if (newline == std::string::npos) {
    pollfd fd{socket_, POLLIN, 0};
    int ready;
    do { ready = poll(&fd, 1, timeoutMs); } while (ready < 0 && errno == EINTR);
    if (ready == 0) return false;
    if (ready < 0 || (fd.revents & (POLLERR | POLLNVAL))) {
      close(socket_); socket_ = -1; return false;
    }
    char bytes[4096];
    ssize_t size = read(socket_, bytes, sizeof(bytes));
    if (size <= 0) { close(socket_); socket_ = -1; return false; }
    pending_.append(bytes, size);
    if (pending_.size() > 65536) { close(socket_); socket_ = -1; return false; }
    newline = pending_.find('\n');
    if (newline == std::string::npos) return false;
  }
  line = pending_.substr(0, newline);
  pending_.erase(0, newline + 1);
  return true;
}

bool WindowServer::present(const uint8_t* bgra) {
  if (!bgra || surface_ < 0) return false;
  const size_t size = static_cast<size_t>(width) * height * 4;
  std::vector<uint8_t> rgba(size);
  for (size_t i = 0; i < size; i += 4) {
    rgba[i] = bgra[i + 2]; rgba[i + 1] = bgra[i + 1];
    rgba[i + 2] = bgra[i]; rgba[i + 3] = 255;
  }
  return lseek(surface_, 0, SEEK_SET) == 0 && writeAll(surface_, rgba.data(), size) &&
      command("commit " + std::to_string(id_) + " 0 " + std::to_string(height));
}
