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
