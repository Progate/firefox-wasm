// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <cstdint>
#include <string>

// BrowserOS windowserver: TCP commands + an RGBA surface file.
class WindowServer {
 public:
  ~WindowServer();
  bool open(int width, int height);
  bool next(std::string& line, int timeoutMs);
  bool present(const uint8_t* bgra);
  bool resize(int width, int height);
  // Put text on the system clipboard (only while this window has the focus).
  bool setClipboard(const std::string& text);
  // Where text is typed (" x y width height" in the window, or empty for none).
  bool setCursor(const std::string& rectangle);
  bool connected() const { return socket_ >= 0; }
  int width = 1000;
  int height = 720;
 private:
  bool command(const std::string& text);
  int socket_ = -1;
  int surface_ = -1;
  int id_ = 0;
  std::string pending_;
};
