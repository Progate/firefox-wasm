// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

// BrowserOS windowserver: TCP commands + an RGBA surface file.
//
// One thread reads notices (next) while the application thread sends commands
// and presents. The reader never closes the socket: closing it under a writer
// on the other thread could hand the descriptor number to a new file in
// between, so a dead connection only turns connected() false.
class WindowServer {
 public:
  ~WindowServer();
  bool open(int width, int height);
  bool next(std::string& line, int timeoutMs);
  // Put rows [top, top + rows) of a width x height BGRA frame (stride
  // width * 4) on the window and commit only those rows. The windowserver then
  // rereads and recomposites just that band (the commit's damage) instead of
  // the whole window.
  bool presentRows(const uint8_t* bgra, int top, int rows);
  bool resize(int width, int height);
  // Put text on the system clipboard (only while this window has the focus).
  bool setClipboard(const std::string& text);
  // Where text is typed (" x y width height" in the window, or empty for none).
  bool setCursor(const std::string& rectangle);
  bool connected() const { return socket_ >= 0 && !closed_.load(std::memory_order_acquire); }
  int width = 1000;
  int height = 720;
 private:
  bool command(const std::string& text);
  void lost() { closed_.store(true, std::memory_order_release); }
  int socket_ = -1;
  int surface_ = -1;
  int id_ = 0;
  std::atomic<bool> closed_{false};
  // Lines from two threads must not interleave their bytes on the socket.
  std::mutex send_;
  std::string pending_;
  // RGBA rows for presentRows, kept between frames: allocating a window-sized
  // vector per frame zeroes ~10 MB at 2240x1440 before a single row is copied.
  std::vector<uint8_t> rgba_;
};
