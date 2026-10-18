// SPDX-License-Identifier: MPL-2.0
// Gecko's application thread owns its event loop and windowserver connection.
#include "../gecko.js/src/embed-xul.h"
#include "windowserver.h"
#include "nsPrintfCString.h"
#include "nsITimer.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <mutex>
#include <thread>
#include <vector>

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

// Notices the reader thread took off the windowserver socket, waiting for the
// application thread. The reader wakes the application thread with a Gecko
// runnable, so the application thread can sleep in Gecko's own event loop:
// timers, network replies and refresh ticks that other threads post then run
// at once instead of after a socket poll timed out (it waited up to 16 ms).
static std::mutex g_inboxLock;
static std::vector<std::string> g_inbox;
static std::atomic<bool> g_wakePosted{false};

static void wakeApplication() {
  if (g_wakePosted.exchange(true)) return;  // one runnable per batch is enough
  NS_DispatchToMainThread(NS_NewRunnableFunction("firedog::notices", [] {
    g_wakePosted.store(false);
  }));
}

static void readNotices(WindowServer* window) {
  std::string line;
  while (window->connected()) {
    // The timeout only bounds how long a dead connection goes unnoticed.
    if (!window->next(line, 1000)) continue;
    std::vector<std::string> batch{line};
    while (window->next(line, 0)) batch.push_back(line);  // everything already sent
    {
      std::lock_guard<std::mutex> lock(g_inboxLock);
      for (auto& entry : batch) g_inbox.push_back(std::move(entry));
    }
    wakeApplication();
  }
  wakeApplication();  // let the application thread see the connection is gone
}

static bool isMotion(const std::string& line) {
  int id;
  char state[16];
  return sscanf(line.c_str(), "pointer %d %15s", &id, state) == 2 &&
      strcmp(state, "down") != 0 && strcmp(state, "up") != 0;
}

// Merge notices that only matter as a total, so a burst queued while Gecko was
// busy costs one event instead of many: of consecutive pointer motions only
// the last position counts (each motion otherwise hit-tests, updates hover
// state and fires mousemove), and consecutive wheel steps at one place add up
// to one scroll. Order relative to every other notice is kept.
static void coalesce(std::vector<std::string>& batch) {
  std::vector<std::string> out;
  out.reserve(batch.size());
  for (auto& line : batch) {
    if (!out.empty() && isMotion(line) && isMotion(out.back())) {
      out.back() = std::move(line);
      continue;
    }
    int id, x, y, dx, dy, id2, x2, y2, dx2, dy2;
    if (!out.empty() &&
        sscanf(line.c_str(), "scroll %d %d %d %d %d", &id, &x, &y, &dx, &dy) == 5 &&
        sscanf(out.back().c_str(), "scroll %d %d %d %d %d", &id2, &x2, &y2, &dx2, &dy2) == 5 &&
        id == id2 && x == x2 && y == y2) {
      out.back() = nsPrintfCString("scroll %d %d %d %d %d", id, x, y, dx + dx2, dy + dy2).get();
      continue;
    }
    out.push_back(std::move(line));
  }
  batch.swap(out);
}

// The window's frames: Gecko paints into `back`, which is compared with
// `front` (what the windowserver shows) so only the band of rows that
// changed is converted, written and composited. A frame that changed nothing
// (a repaint after a mouse move over plain text) is not sent at all.
struct Frames {
  std::vector<uint8_t> front, back;
  int width = 0, height = 0;
  bool valid = false;  // front holds what is on screen

  void ensure(int w, int h) {
    if (w == width && h == height) return;
    width = w;
    height = h;
    const size_t size = static_cast<size_t>(w) * h * 4;
    front.assign(size, 0);
    back.assign(size, 0);
    valid = false;
  }
};

static bool rowEqual(const uint8_t* a, const uint8_t* b, size_t bytes) {
  // 8 bytes at a time: wasi-libc's memcmp goes byte by byte, which is ~8x
  // slower over a 2240-pixel row.
  const size_t words = bytes / 8;
  for (size_t i = 0; i < words; i++) {
    uint64_t x, y;
    memcpy(&x, a + i * 8, 8);
    memcpy(&y, b + i * 8, 8);
    if (x != y) return false;
  }
  return memcmp(a + words * 8, b + words * 8, bytes - words * 8) == 0;
}

// Paint and present what changed. Returns false when the windowserver is gone.
static bool paintFrame(WindowServer& window, Frames& frames, bool& firstFrame) {
  frames.ensure(window.width, window.height);
  if (!xul_paint_into(frames.back.data(), frames.width, frames.height)) return true;
  const size_t stride = static_cast<size_t>(frames.width) * 4;
  int top = 0, bottom = frames.height;  // the changed band is [top, bottom)
  if (frames.valid) {
    const uint8_t* now = frames.back.data();
    const uint8_t* shown = frames.front.data();
    while (top < bottom && rowEqual(now + stride * top, shown + stride * top, stride)) top++;
    while (bottom > top && rowEqual(now + stride * (bottom - 1), shown + stride * (bottom - 1), stride)) bottom--;
    if (top == bottom) return true;
  }
  if (!window.presentRows(frames.back.data(), top, bottom - top)) {
    perror("firedog: windowserver present");
    return false;
  }
  frames.front.swap(frames.back);
  // back now holds the previous frame; it differs from front only inside the
  // band, which the next paint overwrites anyway (it paints every pixel).
  frames.valid = true;
  if (firstFrame) {
    fprintf(stderr, "firedog: first frame presented (%dx%d)\n", window.width, window.height);
    firstFrame = false;
  }
  return true;
}

// Frames from Gecko's own compositor (WebRender's software renderer, SWGL).
//
// The headless widget has no surface of its own, so the compositor rendered
// every frame into nothing ("RenderCompositorSWGL failed mapping default
// framebuffer") while this program painted the window a second time with
// RenderDocument. With gecko-fast-paint.patch the widget asks
// firedog_remote_drawing for a draw target instead: the render thread then
// rasterizes into `pixels` (off the application thread, reusing its cached
// tiles) and reports the rectangles it changed, and the application thread
// only converts and sends those rows.
//
// libxul without the patch never calls these hooks; the window then keeps
// RenderDocument (see compositorFrames). FIREDOG_PAINT=document forces that
// path for comparison.
extern "C" {
struct FireDogRemoteDrawing {
  // Render thread. A new reference (the caller adopts it) to a draw target
  // covering the whole widget from its origin, or null to skip the frame.
  mozilla::gfx::DrawTarget* (*start)(nsIWidget* aWidget);
  // Render thread, after a non-null start. aRects holds aCount rectangles
  // (x, y, width, height in device pixels) that the frame changed.
  void (*end)(nsIWidget* aWidget, const int32_t* aRects, size_t aCount);
};
}

namespace {
struct Composited {
  // Held by the render thread from start to end: SWGL draws straight into
  // `pixels`, and WebRender's partial present assumes the rows it did not
  // redraw still hold the previous frame, so the application thread must not
  // read a half-drawn frame or replace the buffer meanwhile.
  std::mutex lock;
  std::vector<uint8_t> pixels;
  int width = 0, height = 0;
  int top = 0, bottom = 0;  // rows changed since the last present
};
Composited g_composited;
std::atomic<nsIWidget*> g_mainWidget{nullptr};
std::atomic<bool> g_compositorEnabled{true};
// Set by the first compositor frame; from then on the window shows them.
std::atomic<bool> g_compositorFrames{false};
// Rows are waiting in g_composited. Read without the lock, so the application
// thread does not wait out a frame the render thread is still drawing.
std::atomic<bool> g_damaged{false};
thread_local bool g_drawing = false;
}  // namespace

static mozilla::gfx::DrawTarget* startDrawing(nsIWidget* aWidget) {
  using namespace mozilla::gfx;
  // Popups are separate widgets with compositors of their own; they are
  // painted over the window by paint_popups_into instead.
  if (!g_compositorEnabled.load() || !aWidget || aWidget != g_mainWidget.load()) return nullptr;
  const auto size = aWidget->GetClientSize();
  if (size.width <= 0 || size.height <= 0) return nullptr;
  g_composited.lock.lock();
  auto& c = g_composited;
  if (c.width != size.width || c.height != size.height) {
    // WebRender redraws everything after the widget size changed.
    c.width = size.width;
    c.height = size.height;
    c.pixels.assign(static_cast<size_t>(c.width) * c.height * 4, 0xff);
    c.top = 0;
    c.bottom = c.height;
  }
  RefPtr<DrawTarget> dt = Factory::CreateDrawTargetForData(
      BackendType::SKIA, c.pixels.data(), IntSize(c.width, c.height), c.width * 4,
      SurfaceFormat::B8G8R8A8);
  if (!dt) {
    g_composited.lock.unlock();
    return nullptr;
  }
  g_drawing = true;
  g_compositorFrames.store(true);
  return dt.forget().take();
}

static void endDrawing(nsIWidget*, const int32_t* aRects, size_t aCount) {
  if (!g_drawing) return;
  g_drawing = false;
  auto& c = g_composited;
  for (size_t i = 0; i < aCount; i++) {
    const int y = aRects[i * 4 + 1], h = aRects[i * 4 + 3];
    if (h <= 0) continue;
    const int top = std::max(0, y), bottom = std::min(c.height, y + h);
    if (bottom <= top) continue;
    if (c.top >= c.bottom) { c.top = top; c.bottom = bottom; }
    else { c.top = std::min(c.top, top); c.bottom = std::max(c.bottom, bottom); }
  }
  const bool changed = c.top < c.bottom;
  if (changed) g_damaged.store(true);
  g_composited.lock.unlock();
  if (changed) wakeApplication();
}

extern "C" FireDogRemoteDrawing firedog_remote_drawing = {startDrawing, endDrawing};

// Whether popups were drawn over the last presented compositor frame.
static bool g_popupsShown = false;

// Present the compositor's changed rows, with any open popups painted over
// them. Returns false when the windowserver is gone.
static bool presentComposited(WindowServer& window, Frames& frames, bool& firstFrame) {
  auto& c = g_composited;
  const bool popups = popups_visible();
  std::unique_lock<std::mutex> lock(c.lock);
  // Between a configure and the compositor's first frame at the new size the
  // rows would have the wrong stride; that frame follows shortly.
  if (c.width != window.width || c.height != window.height) return true;
  g_damaged.store(false);
  if (!popups && !g_popupsShown) {
    if (c.top >= c.bottom) return true;
    const int top = c.top, rows = c.bottom - c.top;
    c.top = c.bottom = 0;
    if (!window.presentRows(c.pixels.data(), top, rows)) {
      perror("firedog: windowserver present");
      return false;
    }
    frames.valid = false;  // `front` no longer mirrors the screen
  } else {
    // Popups overlap the frame, so compose a copy and send what differs from
    // what is shown (closing a popup restores the rows it covered).
    frames.ensure(window.width, window.height);
    memcpy(frames.back.data(), c.pixels.data(), frames.back.size());
    c.top = c.bottom = 0;
    lock.unlock();
    paint_popups_into(frames.back.data(), frames.width, frames.height);
    const size_t stride = static_cast<size_t>(frames.width) * 4;
    int top = 0, bottom = frames.height;
    if (frames.valid) {
      const uint8_t* now = frames.back.data();
      const uint8_t* shown = frames.front.data();
      while (top < bottom && rowEqual(now + stride * top, shown + stride * top, stride)) top++;
      while (bottom > top && rowEqual(now + stride * (bottom - 1), shown + stride * (bottom - 1), stride)) bottom--;
    }
    if (top < bottom) {
      if (!window.presentRows(frames.back.data(), top, bottom - top)) {
        perror("firedog: windowserver present");
        return false;
      }
      frames.front.swap(frames.back);
      frames.valid = true;
    }
    g_popupsShown = popups;
  }
  if (firstFrame) {
    fprintf(stderr, "firedog: first frame presented from the compositor (%dx%d)\n", window.width, window.height);
    firstFrame = false;
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
  // The window repaints whenever the refresh driver paints, so the caret can
  // blink as on other desktops (xul_init stops it for one-shot snapshots).
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
  if (const char* paint = getenv("FIREDOG_PAINT"); paint && strcmp(paint, "document") == 0) {
    g_compositorEnabled.store(false);
  }
  std::thread(readNotices, &window).detach();
  // A backstop for a change that never reaches the refresh driver: one paint a
  // second costs one RenderDocument and, if nothing changed, no present. The
  // timer also wakes the event loop when nothing else would.
  nsCOMPtr<nsITimer> backstop;
  NS_NewTimerWithCallback(getter_AddRefs(backstop), [](nsITimer*) {}, 1000,
                          nsITimer::TYPE_REPEATING_SLACK, "firedog::backstop"_ns);
  Frames frames;
  bool firstFrame = true;
  uint64_t paintedGeneration = 0;
  auto lastPaint = std::chrono::steady_clock::now();
  std::vector<std::string> batch;
  while (window.connected()) {
    {
      std::lock_guard<std::mutex> lock(g_inboxLock);
      batch.swap(g_inbox);
    }
    const bool active = !batch.empty();
    // The compositor only draws a widget that is shown, sized to the window and
    // allowed to paint; RenderDocument never needed any of that, so nothing
    // else keeps it so (idempotent and cheap once it holds).
    if (g_compositorEnabled.load()) gpu_ensure_active(window.width, window.height);
    g_mainWidget.store(main_widget());
    // Pointer motion alone repaints only if it changed something (a hover
    // style, a cursor-dependent highlight): at 60 Hz of motion over plain
    // content a RenderDocument per move cost ~13 ms of CPU for nothing.
    bool onlyMotion = active;
    if (active) {
      for (const auto& line : batch) {
        if (!isMotion(line)) { onlyMotion = false; break; }
      }
      coalesce(batch);
      for (const auto& line : batch) {
        if (!dispatch(window, line)) return 0;
      }
      batch.clear();
      // Let what the input started (handlers, focus changes) settle before
      // painting, without waiting for anything.
      NS_ProcessPendingEvents(nullptr, 0);
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
    const auto now = std::chrono::steady_clock::now();
    const uint64_t generation = paint_generation();
    const auto since = now - lastPaint;
    if (g_compositorFrames.load()) {
      // The compositor draws the window. After input, paint at once instead of
      // at the next refresh tick; the render thread's frame then wakes this
      // loop (endDrawing) and only its rows are sent. Popups are painted here,
      // so their changes (hover, a menu opening) follow the refresh driver.
      if (active) paint_now_if_pending();
      const bool popups = popups_visible();
      if (g_damaged.load() || popups != g_popupsShown ||
          (popups && (active || generation != paintedGeneration))) {
        paintedGeneration = generation;
        lastPaint = now;
        if (!presentComposited(window, frames, firstFrame)) return 1;
      }
    } else if (
        // RenderDocument: paint right after input (the change shows without
        // waiting for a refresh tick), when Gecko painted on its own since the
        // last frame (animations, smooth scrolling, the caret's blink, loads),
        // when a paint has been pending a while, and once a second as a
        // backstop.
        (active && (!onlyMotion || paint_pending())) || firstFrame ||
        generation != paintedGeneration ||
        (paint_pending() && since >= std::chrono::milliseconds(100)) ||
        since >= std::chrono::seconds(1)) {
      paintedGeneration = generation;
      lastPaint = now;
      if (!paintFrame(window, frames, firstFrame)) return 1;
    }
    // Sleep until Gecko has something to run: a notice (the reader's runnable),
    // a timer, a refresh tick, a network reply.
    NS_ProcessNextEvent(nullptr, true);
  }
  return 0;
}
