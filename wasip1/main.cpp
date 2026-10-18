// SPDX-License-Identifier: MPL-2.0
// Gecko's application thread owns its event loop and windowserver connection.
#include "../gecko.js/src/embed-xul.h"
#include "windowserver.h"
#include "nsPrintfCString.h"
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

// Device pixels per CSS pixel (GDK_SCALE); windowserver speaks device pixels.
static int g_scale = 1;
// DOM button state (bit 1 left, 2 right, 4 middle) and modifier state
// (nsIDOMWindowUtils MODIFIER_ALT 1, CONTROL 2, SHIFT 4, META 8).
static int g_buttons = 0;
static int g_modifiers = 0;
// The shortcut modifier. The desktop is laid out like macOS, so it is ⌘ (Meta)
// as in Firefox for macOS (ui.key.accelKey, set in main).
static const int kAccel = 8;
// What the system clipboard holds, as far as this window knows. Gecko's
// clipboard differing from it means the page copied something.
static std::string g_clipboard;
// The typing place last told to the windowserver (" x y width height", or
// empty when nothing editable has the focus).
static std::string g_cursor;

// Linux input-event key codes (the windowserver protocol) for keys without
// text, as DOM key names and key codes.
struct NamedKey { int code; const char* key; int keyCode; };
static const NamedKey kNamedKeys[] = {
    {1, "Escape", 27},     {14, "Backspace", 8},  {15, "Tab", 9},
    {28, "Enter", 13},     {57, " ", 32},         {102, "Home", 36},
    {103, "ArrowUp", 38},  {104, "PageUp", 33},   {105, "ArrowLeft", 37},
    {106, "ArrowRight", 39}, {107, "End", 35},    {108, "ArrowDown", 40},
    {109, "PageDown", 34}, {110, "Insert", 45},   {111, "Delete", 46},
    {59, "F1", 112},       {60, "F2", 113},       {61, "F3", 114},
    {62, "F4", 115},       {63, "F5", 116},       {64, "F6", 117},
    {65, "F7", 118},       {66, "F8", 119},       {67, "F9", 120},
    {68, "F10", 121},      {87, "F11", 122},      {88, "F12", 123},
};
// KeyboardEvent.code for Linux input-event key codes (the US layout's
// physical keys, as the UI Events code spec names them).
static const char* domCode(int code) {
  static const char* const kCodes[] = {
      nullptr, "Escape", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5",
      "Digit6", "Digit7", "Digit8", "Digit9", "Digit0", "Minus", "Equal",
      "Backspace", "Tab", "KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY",
      "KeyU", "KeyI", "KeyO", "KeyP", "BracketLeft", "BracketRight", "Enter",
      "ControlLeft", "KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ",
      "KeyK", "KeyL", "Semicolon", "Quote", "Backquote", "ShiftLeft",
      "Backslash", "KeyZ", "KeyX", "KeyC", "KeyV", "KeyB", "KeyN", "KeyM",
      "Comma", "Period", "Slash", "ShiftRight", "NumpadMultiply", "AltLeft",
      "Space", "CapsLock", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8",
      "F9", "F10", "NumLock", "ScrollLock", "Numpad7", "Numpad8", "Numpad9",
      "NumpadSubtract", "Numpad4", "Numpad5", "Numpad6", "NumpadAdd",
      "Numpad1", "Numpad2", "Numpad3", "Numpad0", "NumpadDecimal"};
  if (code > 0 && code < (int)(sizeof(kCodes) / sizeof(kCodes[0]))) {
    return kCodes[code];
  }
  switch (code) {
    case 87: return "F11";
    case 88: return "F12";
    case 89: return "IntlRo";
    case 92: return "Convert";
    case 93: return "KanaMode";
    case 94: return "NonConvert";
    case 96: return "NumpadEnter";
    case 97: return "ControlRight";
    case 98: return "NumpadDivide";
    case 100: return "AltRight";
    case 102: return "Home";
    case 103: return "ArrowUp";
    case 104: return "PageUp";
    case 105: return "ArrowLeft";
    case 106: return "ArrowRight";
    case 107: return "End";
    case 108: return "ArrowDown";
    case 109: return "PageDown";
    case 110: return "Insert";
    case 111: return "Delete";
    case 117: return "NumpadEqual";
    case 124: return "IntlYen";
    case 125: return "MetaLeft";
    case 126: return "MetaRight";
  }
  return nullptr;
}
// US layout characters for codes, so shortcuts (Ctrl+L, Ctrl+T) work when the
// windowserver sends no text for a modified key.
static char usCharacter(int code, bool shift) {
  static const char* rows[] = {"1234567890-=", "qwertyuiop[]", "asdfghjkl;'`", "\\zxcvbnm,./"};
  static const char* shifted[] = {"!@#$%^&*()_+", "QWERTYUIOP{}", "ASDFGHJKL:\"~", "|ZXCVBNM<>?"};
  static const int starts[] = {2, 16, 30, 43};
  for (int r = 0; r < 4; r++) {
    int n = (int)strlen(rows[r]);
    if (code >= starts[r] && code < starts[r] + n) {
      return (shift ? shifted : rows)[r][code - starts[r]];
    }
  }
  return 0;
}
static int modifierBit(int code) {
  switch (code) {
    case 42: case 54: return 4;    // Shift
    case 29: case 97: return 2;    // Control
    case 56: case 100: return 1;   // Alt
    case 125: case 126: return 8;  // Meta
  }
  return 0;
}

static void key(int down, int code, const std::string& text) {
  if (int bit = modifierBit(code)) {
    g_modifiers = down ? (g_modifiers | bit) : (g_modifiers & ~bit);
    return;
  }
  for (const auto& named : kNamedKeys) {
    if (named.code == code) {
      do_key(down ? 0 : 1, named.key, named.keyCode, code == 57 ? ' ' : 0, g_modifiers,
             domCode(code));
      return;
    }
  }
  std::string character = text;
  if (character.empty()) {
    char c = usCharacter(code, g_modifiers & 4);
    if (!c) return;
    character.assign(1, c);
  }
  unsigned char first = character[0];
  int keyCode = 0;
  if (first >= 'a' && first <= 'z') keyCode = first - 'a' + 'A';
  else if ((first >= 'A' && first <= 'Z') || (first >= '0' && first <= '9')) keyCode = first;
  // charCode only for a single ASCII character; other text keeps keyCode 0.
  int charCode = (character.size() == 1 && first >= 0x20 && first < 0x7f) ? first : 0;
  do_key(down ? 0 : 1, character.c_str(), keyCode, charCode, g_modifiers, domCode(code));
}

static bool dispatch(WindowServer& window, const std::string& line) {
  int id, x, y, dx, dy, code, button = 0;
  char state[16], text[4096];
  if (sscanf(line.c_str(), "close %d", &id) == 1) return false;
  if (sscanf(line.c_str(), "configure %d %d %d", &id, &x, &y) == 3) {
    if (!window.resize(x, y)) return false;
    EnsureSize(x, y);
    return true;
  }
  int fields = sscanf(line.c_str(), "pointer %d %15s %d %d %d", &id, state, &x, &y, &button);
  if (fields >= 4) {
    // X numbers buttons 1 left, 2 middle, 3 right; DOM uses 0, 1, 2.
    int domButton = button == 3 ? 2 : (button == 2 ? 1 : 0);
    int bit = domButton == 2 ? 2 : (domButton == 1 ? 4 : 1);
    int phase = 0;
    if (strcmp(state, "down") == 0) { phase = 1; g_buttons |= bit; }
    else if (strcmp(state, "up") == 0) { phase = 2; g_buttons &= ~bit; }
    do_mouse(phase, x / g_scale, y / g_scale, domButton, phase ? 1 : 0, g_buttons, g_modifiers);
    // The headless widget raises no contextmenu event of its own; on Linux it
    // follows the right button's press.
    if (phase == 1 && domButton == 2) {
      do_mouse(3, x / g_scale, y / g_scale, domButton, 1, g_buttons, g_modifiers);
    }
    return true;
  }
  if (sscanf(line.c_str(), "scroll %d %d %d %d %d", &id, &x, &y, &dx, &dy) == 5) {
    do_wheel(x / g_scale, y / g_scale, double(dx) / g_scale, double(dy) / g_scale, g_modifiers);
    return true;
  }
  text[0] = 0;
  fields = sscanf(line.c_str(), "key %d %15s %d %4095s", &id, state, &code, text);
  if (fields >= 3) {
    key(strcmp(state, "up") != 0, code, decode(text));  // down and repeat press
    return true;
  }
  // The input method's text: composed (preedit, shown underlined until it is
  // converted) and committed. Neither has a key of its own.
  if (sscanf(line.c_str(), "preedit %d", &id) == 1) {
    const auto space = line.find(' ', strlen("preedit "));
    set_composition(space == std::string::npos ? "" : decode(line.substr(space + 1)).c_str());
    return true;
  }
  if (sscanf(line.c_str(), "text %d %4095s", &id, text) == 2) {
    commit_text(decode(text).c_str());
    return true;
  }
  // The system clipboard changed or the focus came here: Gecko's clipboard
  // follows it, so ⌘V pastes what other windows copied.
  if (sscanf(line.c_str(), "selection %d", &id) == 1) {
    const auto space = line.find(' ', strlen("selection "));
    g_clipboard = space == std::string::npos ? "" : decode(line.substr(space + 1));
    set_clipboard_text(g_clipboard.c_str());
  }
  return true;
}

// Without a URL argument, open browser.startup.homepage like Firefox does.
// Distributions set it in /usr/lib/firefox/browser/defaults/preferences/*.js. about:home and
// about:newtab need the Firefox front-end, which this window does not have yet.
static std::string startUrl(const char* argument) {
  if (argument && *argument) return argument;
  nsAutoCString home;
  if (NS_SUCCEEDED(mozilla::Preferences::GetCString("browser.startup.homepage", home))) {
    int32_t bar = home.FindChar('|');  // several pages are separated by |
    if (bar >= 0) home.Truncate(bar);
    if (!home.IsEmpty() && !StringBeginsWith(home, "about:home"_ns) &&
        !StringBeginsWith(home, "about:newtab"_ns)) {
      return home.get();
    }
  }
  return "about:blank";
}

// Chromium's switches that FireDog takes. They come before the URL, as with
// chrome: --remote-debugging-port=N serves the Chrome DevTools Protocol on
// 127.0.0.1:N (an embedder that reloads or inspects the page uses it), and
// --remote-allow-origins=LIST lets those web origins open its WebSocket.
struct Switches {
  int remoteDebuggingPort = 0;
  std::string remoteAllowOrigins;
  const char* url = nullptr;
};

static bool switchValue(const char* argument, const char* name, const char** value) {
  const size_t length = strlen(name);
  if (strncmp(argument, name, length) != 0 || argument[length] != '=') return false;
  *value = argument + length + 1;
  return true;
}

static Switches parseSwitches(int argc, char** argv) {
  Switches switches;
  for (int i = 1; i < argc; i++) {
    const char* value;
    if (switchValue(argv[i], "--remote-debugging-port", &value)) {
      switches.remoteDebuggingPort = atoi(value);
    } else if (switchValue(argv[i], "--remote-allow-origins", &value)) {
      switches.remoteAllowOrigins = value;
    } else if (!switches.url) {
      switches.url = argv[i];
    }
  }
  return switches;
}

int main(int argc, char** argv) {
  if (argc > 1 && strcmp(argv[1], "--help") == 0) {
    puts("usage: firedog [--remote-debugging-port=PORT] [--remote-allow-origins=ORIGINS] [URL]\n"
         "Uses DISPLAY and PROFILE_DIR inside BrowserOS.");
    return 0;
  }
  const Switches switches = parseSwitches(argc, argv);
  const char* gre = getenv("GRE_DIR");
  if (!gre) gre = "/usr/lib/firedog";
  setenv("MOZ_FORCE_DISABLE_E10S", "1", 1);
  setenv("MOZ_HEADLESS", "1", 1);
  setenv("GECKO_NOWASMJIT", "1", 1);
  // The firefox command shows Firefox's own front-end (tabs, address bar).
  setenv("GECKO_CHROME", "1", 0);
  // The desktop runs at GDK_SCALE device pixels per CSS pixel, like GTK.
  const char* scaleEnv = getenv("GDK_SCALE");
  int scale = scaleEnv ? atoi(scaleEnv) : 1;
  if (scale < 1) scale = 1;
  g_scale = scale;
  WindowServer window;
  if (!window.open(1120 * scale, 720 * scale)) { perror("firedog: windowserver"); return 1; }
  int result = xul_init(gre);
  if (result) { fprintf(stderr, "firedog: XPCOM initialization failed: %x\n", result); return 1; }
  mozilla::Preferences::SetCString("layout.css.devPixelsPerPx", nsPrintfCString("%d", scale));
  mozilla::Preferences::SetUint("ui.key.accelKey", 224);  // ⌘ (see kAccel)
  // The window repaints a few times a second, so the caret can blink as on
  // other desktops (xul_init stops it for one-shot snapshots).
  mozilla::Preferences::SetInt("ui.caretBlinkTime", 530);
  // Before browser.xhtml loads: its script starts the endpoint from these prefs.
  if (switches.remoteDebuggingPort > 0) {
    mozilla::Preferences::SetInt("firedog.devtools.remote-debugging-port", switches.remoteDebuggingPort);
  }
  if (!switches.remoteAllowOrigins.empty()) {
    mozilla::Preferences::SetCString("firedog.devtools.remote-allow-origins", switches.remoteAllowOrigins.c_str());
  }
  const bool chrome = getenv("GECKO_CHROME") && *getenv("GECKO_CHROME");
  // Firefox's window (browser.xhtml) comes up first; pages then open in its tabs.
  if (chrome && !xul_load("chrome://browser/content/browser.xhtml", window.width, window.height)) return 1;
  const std::string url = startUrl(switches.url);
  if ((!chrome || url != "about:blank") && !xul_load(url.c_str(), window.width, window.height)) return 1;
  fprintf(stderr, "firedog: page loading, entering the event loop\n");
  bool firstFrame = true;
  auto lastPaint = std::chrono::steady_clock::now();
  while (window.connected()) {
    // Take every notice that is waiting before painting, so a click's down and
    // up are not separated by a whole frame.
    bool active = false;
    std::string line;
    int timeout = 16;
    while (window.next(line, timeout)) {
      if (!dispatch(window, line)) return 0;
      active = true;
      timeout = 0;
    }
    NS_ProcessPendingEvents(nullptr, 0);
    if (active) {
      // Tell the windowserver where text is typed, so the input method's
      // candidates open under the caret.
      int cx = 0, cy = 0, cw = 0, ch = 0;
      const std::string cursor = caret_rect(&cx, &cy, &cw, &ch)
          ? nsPrintfCString(" %d %d %d %d", cx, cy, cw, ch).get()
          : "";
      if (cursor != g_cursor) {
        g_cursor = cursor;
        window.setCursor(cursor);
      }
      // Hand what the page copied (⌘C, a menu's Copy) to the system clipboard.
      const auto copied = get_clipboard_text();
      if (!copied.empty() && copied != g_clipboard) {
        g_clipboard = copied;
        window.setClipboard(copied);
      }
    }
    // Repaint after input; otherwise a few times a second for page updates.
    const auto now = std::chrono::steady_clock::now();
    if (!active && !firstFrame && now - lastPaint < std::chrono::milliseconds(100)) continue;
    lastPaint = now;
    uint8_t* pixels = xul_paint(window.width, window.height);
    if (!pixels) continue;
    bool shown = window.present(pixels);
    free(pixels);
    if (!shown) {
      perror("firedog: windowserver present");
      return 1;
    }
    if (firstFrame) {
      fprintf(stderr, "firedog: first frame presented (%dx%d)\n", window.width, window.height);
      firstFrame = false;
    }
  }
  return 0;
}
