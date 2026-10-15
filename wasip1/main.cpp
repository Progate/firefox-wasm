// SPDX-License-Identifier: MPL-2.0
// Gecko's application thread owns its event loop and windowserver connection.
#include "../gecko.js/src/embed-xul.h"
#include "windowserver.h"
#include <chrono>

XulCmd* g_cmd = nullptr;
bool g_gpu = false;
bool g_mirror = false;

static std::string decode(const std::string& value) {
  std::string out;
  for (size_t i = 0; i < value.size(); ++i) {
    if (value[i] == '%' && i + 2 < value.size()) {
      char code[] = {value[i + 1], value[i + 2], 0};
      char* end;
      auto byte = strtol(code, &end, 16);
      if (*end == 0) { out += static_cast<char>(byte); i += 2; continue; }
    }
    out += value[i];
  }
  return out;
}

static bool dispatch(WindowServer& window, const std::string& line) {
  int id, x, y, dx, dy, code;
  char state[16], text[4096];
  if (sscanf(line.c_str(), "close %d", &id) == 1) return false;
  if (sscanf(line.c_str(), "configure %d %d %d", &id, &x, &y) == 3) {
    if (!window.resize(x, y)) return false;
    EnsureSize(x, y);
  } else if (sscanf(line.c_str(), "pointer %d %15s %d %d", &id, state, &x, &y) == 4) {
    int phase = strcmp(state, "down") == 0 ? 1 : strcmp(state, "up") == 0 ? 2 : 0;
    do_mouse(phase, x, y, 0, phase == 1 ? 1 : 0, -1, 0);
  } else if (sscanf(line.c_str(), "scroll %d %d %d %d %d", &id, &x, &y, &dx, &dy) == 5) {
    do_wheel(x, y, dx, dy, 0);
  } else if (sscanf(line.c_str(), "text %d %4095s", &id, text) == 2) {
    // Native Gecko paste also handles multi-byte text and IME commits.
    const auto value = decode(text);
    if (set_clipboard_text(value.c_str())) {
      do_key(0, "v", 86, 'v', 2);
      do_key(1, "v", 86, 'v', 2);
    }
  } else if (sscanf(line.c_str(), "key %d %15s %d", &id, state, &code) == 3) {
    // Linux input-event key codes (windowserver protocol).
    const char* key = nullptr;
    int domCode = 0;
    switch (code) {
      case 1: key = "Escape"; domCode = 27; break;
      case 14: key = "Backspace"; domCode = 8; break;
      case 15: key = "Tab"; domCode = 9; break;
      case 28: key = "Enter"; domCode = 13; break;
      case 102: key = "Home"; domCode = 36; break;
      case 103: key = "ArrowUp"; domCode = 38; break;
      case 104: key = "PageUp"; domCode = 33; break;
      case 105: key = "ArrowLeft"; domCode = 37; break;
      case 106: key = "ArrowRight"; domCode = 39; break;
      case 107: key = "End"; domCode = 35; break;
      case 108: key = "ArrowDown"; domCode = 40; break;
      case 109: key = "PageDown"; domCode = 34; break;
      case 111: key = "Delete"; domCode = 46; break;
    }
    if (key) do_key(strcmp(state, "up") == 0 ? 1 : 0, key, domCode, 0, 0);
  }
  return true;
}

int main(int argc, char** argv) {
  if (argc > 1 && strcmp(argv[1], "--help") == 0) {
    puts("usage: firefox [URL]\nUses DISPLAY and PROFILE_DIR inside BrowserOS.");
    return 0;
  }
  const char* gre = getenv("GRE_DIR");
  if (!gre) gre = "/usr/lib/firefox";
  setenv("MOZ_FORCE_DISABLE_E10S", "1", 1);
  setenv("MOZ_HEADLESS", "1", 1);
  setenv("GECKO_NOWASMJIT", "1", 1);
  WindowServer window;
  if (!window.open(1000, 720)) { perror("firefox: windowserver"); return 1; }
  int result = xul_init(gre);
  if (result) { fprintf(stderr, "firefox: XPCOM initialization failed: %x\n", result); return 1; }
  if (!xul_load(argc > 1 ? argv[1] : "about:blank", window.width, window.height)) return 1;
  fprintf(stderr, "firefox: page loading, entering the event loop\n");
  bool firstFrame = true;
  while (window.connected()) {
    std::string line;
    if (window.next(line, 16) && !dispatch(window, line)) break;
    NS_ProcessPendingEvents(nullptr, 0);
    uint8_t* pixels = xul_paint(window.width, window.height);
    if (!pixels) continue;
    bool shown = window.present(pixels);
    free(pixels);
    if (!shown) {
      perror("firefox: windowserver present");
      return 1;
    }
    if (firstFrame) {
      fprintf(stderr, "firefox: first frame presented (%dx%d)\n", window.width, window.height);
      firstFrame = false;
    }
  }
  return 0;
}
