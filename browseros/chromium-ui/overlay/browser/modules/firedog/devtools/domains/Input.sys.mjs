/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Input domain: trusted mouse, wheel, touch and key input to the page,
// as if the user had given it. Mouse and touch go through the window's
// synthesize*Event; keys and text through a TextInputProcessor driven by the
// mochitest EventUtils the Remote Agent ships (WebDriver's key actions use
// it), which fills in keyCode and code and presses the modifiers.
//
// Coordinates are CSS pixels in the page's viewport, as in Chromium.

import {
  InvalidParams,
  ProtocolError,
} from "resource:///modules/firedog/devtools/Session.sys.mjs";

const MOUSE_TYPES = {
  mousePressed: "mousedown",
  mouseReleased: "mouseup",
  mouseMoved: "mousemove",
};

const MOUSE_BUTTONS = { none: 0, left: 0, middle: 1, right: 2, back: 3, forward: 4 };

// MouseEvent.MOZ_SOURCE_* and DOM_DELTA_PIXEL, which a system
// module's global does not define.
const MOZ_SOURCE_MOUSE = 1;
const MOZ_SOURCE_PEN = 2;
const MOZ_SOURCE_TOUCH = 5;
const DOM_DELTA_PIXEL = 0;

// How far a finger may move, in CSS pixels, and still tap (Chromium's
// default touch slop).
const TOUCH_SLOP = 15;

const TOUCH_TYPES = {
  touchStart: "touchstart",
  touchEnd: "touchend",
  touchMove: "touchmove",
  touchCancel: "touchcancel",
};

// CDP's modifier bits (Alt=1, Ctrl=2, Meta=4, Shift=8) in nsIDOMWindowUtils'.
function geckoModifiers(modifiers = 0) {
  return (
    (modifiers & 1 ? Ci.nsIDOMWindowUtils.MODIFIER_ALT : 0) |
    (modifiers & 2 ? Ci.nsIDOMWindowUtils.MODIFIER_CONTROL : 0) |
    (modifiers & 4 ? Ci.nsIDOMWindowUtils.MODIFIER_META : 0) |
    (modifiers & 8 ? Ci.nsIDOMWindowUtils.MODIFIER_SHIFT : 0)
  );
}

// Blink's editing commands (the `commands` of dispatchKeyEvent, which
// clients send on macOS for shortcuts the native key bindings handle there)
// as Gecko's.
const COMMANDS = {
  selectAll: "cmd_selectAll",
  copy: "cmd_copy",
  cut: "cmd_cut",
  paste: "cmd_paste",
  undo: "cmd_undo",
  redo: "cmd_redo",
  deleteBackward: "cmd_deleteCharBackward",
  deleteForward: "cmd_deleteCharForward",
  deleteWordBackward: "cmd_deleteWordBackward",
  deleteWordForward: "cmd_deleteWordForward",
  deleteToBeginningOfLine: "cmd_deleteToBeginningOfLine",
  deleteToEndOfLine: "cmd_deleteToEndOfLine",
  moveLeft: "cmd_charPrevious",
  moveRight: "cmd_charNext",
  moveUp: "cmd_linePrevious",
  moveDown: "cmd_lineNext",
  moveWordLeft: "cmd_wordPrevious",
  moveWordRight: "cmd_wordNext",
  moveToBeginningOfLine: "cmd_beginLine",
  moveToEndOfLine: "cmd_endLine",
  moveToBeginningOfDocument: "cmd_moveTop",
  moveToEndOfDocument: "cmd_moveBottom",
  moveLeftAndModifySelection: "cmd_selectCharPrevious",
  moveRightAndModifySelection: "cmd_selectCharNext",
  moveUpAndModifySelection: "cmd_selectLinePrevious",
  moveDownAndModifySelection: "cmd_selectLineNext",
  moveToBeginningOfLineAndModifySelection: "cmd_selectBeginLine",
  moveToEndOfLineAndModifySelection: "cmd_selectEndLine",
};

const eventUtilsByWindow = new WeakMap();
function eventUtils(win) {
  let utils = eventUtilsByWindow.get(win);
  if (!utils) {
    utils = { window: win, parent: win, _EU_Ci: Ci, _EU_Cc: Cc };
    Services.scriptloader.loadSubScript(
      "chrome://remote/content/external/EventUtils.js",
      utils
    );
    eventUtilsByWindow.set(win, utils);
  }
  return utils;
}

// One user-perceived character: a key whose `key` is text rather than a
// key name ("Enter", "ArrowLeft").
function isPrintable(key) {
  return [...key].length === 1;
}

export class Input {
  constructor(session) {
    this.session = session;
    this.target = session.target;
  }

  get _window() {
    const win = this.target.contentWindow;
    if (!win) {
      throw new ProtocolError("The page has no window");
    }
    return win;
  }

  // Key events go to the focused element of the focused window. Chromium
  // sends them to the page whatever has focus in the browser UI, so the
  // page's <browser> takes focus first when the address bar or another
  // part of the window has it.
  _focusPage() {
    const focused = Services.focus.focusedWindow;
    if (focused?.browsingContext?.top !== this.target.browsingContext) {
      this.target.browser.focus();
    }
  }

  dispatchMouseEvent({
    type,
    x,
    y,
    modifiers,
    button = "none",
    buttons,
    clickCount,
    deltaX = 0,
    deltaY = 0,
    pointerType = "mouse",
    force,
  }) {
    const win = this._window;
    if (type === "mouseWheel") {
      win.windowUtils.sendWheelEvent(
        x,
        y,
        deltaX,
        deltaY,
        0,
        DOM_DELTA_PIXEL,
        geckoModifiers(modifiers),
        0,
        0,
        0
      );
      return;
    }
    const geckoType = MOUSE_TYPES[type];
    if (!geckoType) {
      throw new InvalidParams(`Unrecognized type: ${type}`);
    }
    if (!(button in MOUSE_BUTTONS)) {
      throw new InvalidParams(`Unrecognized button: ${button}`);
    }
    const data = {
      button: MOUSE_BUTTONS[button],
      modifiers: geckoModifiers(modifiers),
      inputSource:
        pointerType === "pen" ? MOZ_SOURCE_PEN : MOZ_SOURCE_MOUSE,
      ...(buttons !== undefined ? { buttons } : {}),
      ...(clickCount !== undefined ? { clickCount } : {}),
      ...(force !== undefined ? { pressure: force } : {}),
    };
    // isDOMEventSynthesized: false makes them the trusted, non-test input the
    // page and the touch simulator (setEmitTouchEventsForMouse) react to.
    const options = { toWindow: true, isDOMEventSynthesized: false };
    win.synthesizeMouseEvent(geckoType, x, y, data, options);
    // Chromium shows the context menu as the right button goes down.
    if (geckoType === "mousedown" && button === "right") {
      win.synthesizeMouseEvent("contextmenu", x, y, data, options);
    }
  }

  dispatchTouchEvent({ type, touchPoints = [], modifiers }) {
    const geckoType = TOUCH_TYPES[type];
    if (!geckoType) {
      throw new InvalidParams(`Unrecognized type: ${type}`);
    }
    if (geckoType !== "touchend" && geckoType !== "touchcancel" && !touchPoints.length) {
      throw new InvalidParams("TouchStart and TouchMove must have at least one touch point.");
    }
    const touches = touchPoints.map((point, index) => ({
      identifier: point.id ?? index,
      offsetX: Math.round(point.x),
      offsetY: Math.round(point.y),
      radiiX: Math.max(1, Math.round(point.radiusX ?? 1)),
      radiiY: Math.max(1, Math.round(point.radiusY ?? 1)),
      rotationAngle: point.rotationAngle ?? 0,
      ...(point.force !== undefined ? { pressure: point.force } : {}),
      tiltX: point.tiltX ?? 0,
      tiltY: point.tiltY ?? 0,
      twist: point.twist ?? 0,
    }));
    // FireDog runs in one process, where Gecko only synthesizes touch input
    // through the widget's input path (isAsyncEnabled), as it arrives from
    // the OS.
    const win = this._window;
    const prevented = win.synthesizeTouchEvent(geckoType, touches, geckoModifiers(modifiers), {
      toWindow: true,
      isAsyncEnabled: true,
      isDOMEventSynthesized: false,
    });
    this._followTap(geckoType, touches, modifiers, prevented);
  }

  // Chromium's gesture detector turns a tap (one finger, released near
  // where it went down) into mouse events and a click; Gecko leaves that to
  // APZ, which FireDog does not run. Pages and clients (Puppeteer's tap())
  // expect the click.
  _followTap(type, touches, modifiers, prevented) {
    if (type === "touchstart") {
      this.tap =
        touches.length === 1 && !prevented && !this.tap
          ? { x: touches[0].offsetX, y: touches[0].offsetY }
          : null;
      return;
    }
    if (type === "touchmove") {
      const point = touches[0];
      if (
        this.tap &&
        (touches.length !== 1 || Math.hypot(point.offsetX - this.tap.x, point.offsetY - this.tap.y) > TOUCH_SLOP)
      ) {
        this.tap = null;
      }
      return;
    }
    const tap = this.tap;
    this.tap = null;
    if (type !== "touchend" || !tap || prevented) {
      return;
    }
    const data = {
      button: 0,
      clickCount: 1,
      modifiers: geckoModifiers(modifiers),
      inputSource: MOZ_SOURCE_TOUCH,
    };
    const options = { toWindow: true, isDOMEventSynthesized: false };
    for (const mouseType of ["mousemove", "mousedown", "mouseup"]) {
      this._window.synthesizeMouseEvent(mouseType, tap.x, tap.y, data, options);
    }
  }

  dispatchKeyEvent({
    type,
    modifiers = 0,
    text,
    unmodifiedText,
    key,
    code,
    windowsVirtualKeyCode,
    location,
    autoRepeat = false,
    commands = [],
  }) {
    if (!["keyDown", "keyUp", "rawKeyDown", "char"].includes(type)) {
      throw new InvalidParams(`Unrecognized type: ${type}`);
    }
    const win = this._window;
    this._focusPage();
    const utils = eventUtils(win);
    if (type === "char") {
      // A char event carries text only, without key events of its own.
      if (text) {
        utils._getTIP(win).commitCompositionWith(text);
      }
      return;
    }
    const name = key || text || unmodifiedText || "Unidentified";
    const event = {
      type: type === "keyUp" ? "keyup" : "keydown",
      altKey: !!(modifiers & 1),
      ctrlKey: !!(modifiers & 2),
      metaKey: !!(modifiers & 4),
      shiftKey: !!(modifiers & 8),
      repeat: autoRepeat,
      ...(code ? { code } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(windowsVirtualKeyCode ? { keyCode: windowsVirtualKeyCode } : {}),
    };
    utils.synthesizeKey(isPrintable(name) ? name : `KEY_${name}`, event, win);
    if (type !== "keyUp") {
      for (const command of commands) {
        const geckoCommand = COMMANDS[command];
        if (geckoCommand) {
          win.docShell.doCommand(geckoCommand);
        }
      }
    }
  }

  insertText({ text }) {
    const win = this._window;
    this._focusPage();
    eventUtils(win)._getTIP(win).commitCompositionWith(text);
  }

  imeSetComposition({ text, selectionStart, selectionEnd }) {
    const win = this._window;
    this._focusPage();
    const tip = eventUtils(win)._getTIP(win);
    if (!text) {
      tip.cancelComposition();
      return;
    }
    tip.setPendingCompositionString(text);
    tip.appendClauseToPendingComposition(text.length, tip.ATTR_RAW_CLAUSE);
    tip.setCaretInPendingComposition(Math.min(selectionEnd ?? selectionStart, text.length));
    tip.flushPendingComposition();
  }

  setIgnoreInputEvents({ ignore }) {
    this.target.browser.style.pointerEvents = ignore ? "none" : "";
  }

  _destroy() {
    try {
      this.target.browser.style.pointerEvents = "";
    } catch {
      // The tab is gone.
    }
  }
}
