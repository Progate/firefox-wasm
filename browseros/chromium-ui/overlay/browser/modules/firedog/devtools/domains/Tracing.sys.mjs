/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Tracing domain: what the Performance panel records. Chromium's
// front-end starts a trace, ends it and reads back trace events (the JSON
// "Trace Event Format"), which it lays out as the main thread's tasks, the
// JavaScript call tree and markers.
//
// Chromium fills a trace from instrumentation compiled into the browser and
// from V8's sampling profiler. FireDog's single-threaded build has no
// sampler thread (see Profiler), so a trace is built from hooks that exist
// only while it records, and nothing runs when it does not:
//
// - Gecko's debugger notifications (DebuggerNotificationObserver, which
//   DOMDebugger's event breakpoints also use) mark where an event listener,
//   a timer or an animation frame callback starts and ends, and where a timer
//   or an animation frame is requested. They become EventDispatch, TimerFire,
//   FireAnimationFrame, TimerInstall and RequestAnimationFrame.
// - A SpiderMonkey Debugger marks where a page's script runs (EvaluateScript)
//   with a breakpoint at its start, and names the function an event listener runs
//   (FunctionCall): when an event reaches a target, the target's listeners
//   for it (nsIEventListenerService) get a breakpoint at their entry, which
//   SpiderMonkey compiles into those functions alone. Setting onEnterFrame
//   instead, even for one frame, throws away the JIT code of the whole page
//   each time, and the code an event runs was five times slower.
// - With JavaScript samples on (the Performance panel's "Disable JavaScript
//   samples" unchecked; FireDog's front-end starts with it checked, see
//   devtools-frontend-patches.mjs), onEnterFrame stays set for the whole
//   recording: every outermost frame becomes FunctionCall or EvaluateScript,
//   and the call stack is taken about every SAMPLING_INTERVAL_MS into a CPU
//   profile (Profile and ProfileChunk), as V8 samples. Observing every call
//   keeps SpiderMonkey's JIT out of the page's code and calls the hook on each
//   call, so the page's JavaScript runs about forty times slower while such a
//   trace records. Without samples, recording leaves its speed as it is.
// - The docshell's reflow observer reports each layout with its duration
//   (Layout), and MozAfterPaint the paint after it (Paint, without a
//   duration: Gecko does not report one).
// - performance.mark() and measure() calls of the recorded time are read from
//   the page's performance timeline when the recording ends (UserTiming),
//   and console.time()/timeEnd() and console.timeStamp() calls are seen as
//   they are logged (blink.console, TimeStamp).
//
// Times are ChromeUtils.now() (milliseconds since the process started, the
// clock of Page's and Network's monotonic timestamps) in microseconds, as
// trace events count them.

import { ProtocolError } from "resource:///modules/firedog/devtools/Session.sys.mjs";
import {
  frameIdOf,
  newDebugger,
} from "resource:///modules/firedog/devtools/domains/Runtime.sys.mjs";

// Chromium's renderer and browser processes, as the front-end tells them
// apart: the page's main thread is the renderer's CrRendererMain.
const BROWSER_PID = 1;
const BROWSER_TID = 1;
const RENDERER_PID = 2;
const RENDERER_TID = 1;

const TIMELINE = "devtools.timeline";
const TIMELINE_TASKS = "disabled-by-default-devtools.timeline";
const CPU_PROFILER = "disabled-by-default-v8.cpu_profiler";
const USER_TIMING = "blink.user_timing";
const CONSOLE = "blink.console";

// The categories this domain can record, for Tracing.getCategories.
const CATEGORIES = [TIMELINE, TIMELINE_TASKS, CPU_PROFILER, USER_TIMING, CONSOLE, "v8.execute", "loading"];

// V8's default sampling interval, which the front-end also asks for.
const SAMPLING_INTERVAL_MS = 0.1;

// Event targets (the window, the document and its elements) whose listeners
// get breakpoints when a recording starts; listeners of a larger page get
// theirs at their first event.
const MAX_TARGETS_AT_START = 5000;

// Trace events per Tracing.dataCollected, as Chromium sends them in batches.
const EVENTS_PER_MESSAGE = 1000;

// Gecko's debugger notification types for the trace events they mark.
const CALLBACKS = {
  setTimeoutCallback: "TimerFire",
  setIntervalCallback: "TimerFire",
  requestAnimationFrameCallback: "FireAnimationFrame",
};
const CALLS = {
  setTimeout: "TimerInstall",
  setInterval: "TimerInstall",
  clearTimeout: "TimerRemove",
  clearInterval: "TimerRemove",
  requestAnimationFrame: "RequestAnimationFrame",
  cancelAnimationFrame: "CancelAnimationFrame",
};

const consoleStorage = () =>
  Cc["@mozilla.org/consoleAPI-storage;1"].getService(Ci.nsIConsoleAPIStorage);

const now = () => ChromeUtils.now();
const ONE_MICROSECOND = 0.001;
const micros = ms => Math.round(ms * 1000);

// One trace records at a time in the process, as in Chromium.
let recordingSession = null;

export class Tracing {
  constructor(session) {
    this.session = session;
    this.recording = null;
  }

  getCategories() {
    return { categories: [...CATEGORIES] };
  }

  start({ categories, traceConfig, transferMode = "ReportEvents", streamFormat = "json" } = {}) {
    if (recordingSession) {
      throw new ProtocolError("Tracing has already been started (possibly in another tab).");
    }
    if (transferMode === "ReturnAsStream" && streamFormat !== "json") {
      throw new ProtocolError("Only the json stream format is supported");
    }
    const included = traceConfig?.includedCategories ?? (categories ? categories.split(",") : ["*"]);
    this.recording = new Recording(this.session, included, transferMode);
    recordingSession = this;
    this.recording.start();
  }

  end() {
    if (recordingSession !== this || !this.recording) {
      throw new ProtocolError("Tracing is not started");
    }
    const recording = this.recording;
    this.recording = null;
    recordingSession = null;
    const events = recording.stop();
    // Chromium answers Tracing.end first and then sends the data.
    Services.tm.dispatchToMainThread(() => this._deliver(events, recording.transferMode));
  }

  _deliver(events, transferMode) {
    if (transferMode === "ReturnAsStream") {
      const bytes = new TextEncoder().encode(JSON.stringify({ traceEvents: events }));
      this.session.emit("Tracing.tracingComplete", {
        dataLossOccurred: false,
        stream: this.session.domain("IO")._open(bytes),
        traceFormat: "json",
        streamCompression: "none",
      });
      return;
    }
    for (let i = 0; i < events.length; i += EVENTS_PER_MESSAGE) {
      this.session.emit("Tracing.dataCollected", { value: events.slice(i, i + EVENTS_PER_MESSAGE) });
    }
    this.session.emit("Tracing.tracingComplete", { dataLossOccurred: false });
  }

  _destroy() {
    if (this.recording) {
      this.recording.stop();
      this.recording = null;
    }
    if (recordingSession === this) {
      recordingSession = null;
    }
  }
}

class Recording {
  constructor(session, included, transferMode) {
    this.session = session;
    this.target = session.target;
    this.included = included;
    this.transferMode = transferMode;
    this.events = [];
    this.windows = new Set();
    this.documents = new WeakSet();
    // Trace events begun and not yet ended, innermost last. A RunTask opens
    // under whatever begins with nothing else open, as the event loop's task.
    this.open = [];
    // Call frames of Debugger.Script objects, and calls seen since the
    // sampling hook last read the clock.
    this.callFrames = new WeakMap();
    this.calls = 0;
    // Whether a layout happened since the last Paint.
    this.laidOut = false;
    this.nextTimerId = 1;
    // Ids of async trace events (measures, console timers).
    this.nextAsyncId = 1;
  }

  // A category is on when listed, or when "*" is listed and it is not one of
  // the disabled-by-default ones, as Chromium's TraceConfig decides.
  _enabled(category) {
    if (this.included.includes(category)) {
      return true;
    }
    return (
      this.included.includes("*") &&
      !category.startsWith("disabled-by-default-") &&
      !this.included.includes(`-${category}`)
    );
  }

  start() {
    this.startTime = now();
    this.timeline = this._enabled(TIMELINE) || this._enabled(TIMELINE_TASKS);
    this.sampling = this._enabled(CPU_PROFILER);

    // Gecko reports listener invocations only while it knows DevTools are
    // open, as DOMDebugger also tells it.
    ChromeUtils.notifyDevToolsOpened();
    this.notifications = new DebuggerNotificationObserver();
    this.notifications.addListener(notification => this._guard(() => this._onNotification(notification)));

    if (this.timeline || this.sampling) {
      this.dbg = newDebugger();
      this.onTopPop = () => this._guard(() => this._leaveTop());
    }
    if (this.sampling) {
      this.profile = new CpuProfile(this.startTime);
      this.dbg.onEnterFrame = frame => this._guard(() => this._onSampledFrame(frame));
    } else if (this.dbg) {
      this.listenerBreakpoint = {
        // The function also hits when other code calls it; it is the
        // listener when the event it listens to has not entered a function yet.
        hit: frame => {
          this._guard(() => {
            if (this.open.at(-1)?.name === "EventDispatch") {
              this._enterTop(frame, now());
            }
          });
          return undefined;
        },
      };
      this.listenerScripts = new WeakSet();
      // A page's script (a <script>, a module) runs right after it compiles:
      // a breakpoint at its start, set from onNewScript, which costs nothing
      // while code runs, marks EvaluateScript.
      this.scriptBreakpoint = {
        hit: frame => {
          this._guard(() => {
            if (frame.older === null && frame.type !== "call") {
              this._enterTop(frame, now());
            }
          });
          return undefined;
        },
      };
      if (this.timeline) {
        this.dbg.onNewScript = script => this._guard(() => script.setBreakpoint(script.mainOffset ?? 0, this.scriptBreakpoint));
      }
      // Event types whose listeners on a target were looked up, by target.
      this.listenedTypes = new WeakMap();
    }

    this.reflowObserver = {
      QueryInterface: ChromeUtils.generateQI(["nsIReflowObserver", "nsISupportsWeakReference"]),
      reflow: (start, end) => this._guard(() => this._onReflow(start, end)),
      reflowInterruptible: (start, end) => this._guard(() => this._onReflow(start, end)),
    };
    this.onPaint = event => this._guard(() => this._onPaint(event));
    this.onDocumentEvent = event => this._guard(() => this._onDocumentEvent(event));

    for (const win of this.session.domain("Runtime")._windows()) {
      this._watch(win);
    }
    this.frames = [...this.windows].map(win => this._frameInfo(win));
    Services.obs.addObserver(this, "document-element-inserted");
    // A page's MozAfterPaint goes to its chrome event handler (the tab's
    // <browser>), not to the page, unless dom.send_after_paint_to_content.
    this.paintTarget = this.target.browser;
    this.paintTarget?.addEventListener("MozAfterPaint", this.onPaint);
    if (this._enabled(CONSOLE) || this._enabled(TIMELINE)) {
      this.onConsoleAPI = message => this._guard(() => this._onConsoleAPI(message.wrappedJSObject ?? message));
      consoleStorage().addLogEventListener(this.onConsoleAPI, Services.scriptSecurityManager.getSystemPrincipal());
    }
  }

  stop() {
    const endTime = now();
    Services.obs.removeObserver(this, "document-element-inserted");
    this.paintTarget?.removeEventListener("MozAfterPaint", this.onPaint);
    if (this.onConsoleAPI) {
      consoleStorage().removeLogEventListener(this.onConsoleAPI);
    }
    if (this._enabled(USER_TIMING)) {
      for (const win of this.windows) {
        this._guard(() => this._userTiming(win, endTime));
      }
    }
    // Whatever is still open (stopped inside a listener) ends now.
    while (this.open.length) {
      this._end(endTime);
    }
    for (const win of this.windows) {
      this._unwatch(win);
    }
    this.windows.clear();
    if (this.dbg) {
      this.dbg.onEnterFrame = undefined;
      this.dbg.onNewScript = undefined;
      this.dbg.clearAllBreakpoints();
      this.dbg.removeAllDebuggees();
      this.dbg = null;
    }
    this.notifications = null;
    ChromeUtils.notifyDevToolsClosed();
    return [...this._metadata(), ...this.events, ...(this.profile ? this.profile.events(endTime) : [])];
  }

  // A hook that throws must not reach the page's code or Gecko's caller.
  _guard(callback) {
    try {
      callback();
    } catch (error) {
      console.error("FireDog DevTools: Tracing", error);
    }
  }

  observe(subject, topic) {
    if (topic !== "document-element-inserted") {
      return;
    }
    const win = subject.defaultView;
    if (win?.browsingContext?.top === this.target.browsingContext) {
      this._guard(() => this._watch(win));
    }
  }

  // A window (WindowProxy) stays the same across navigations of its frame,
  // while each document has its own global: the notifications, the Debugger
  // and the document's listeners attach per document, the reflow observer per
  // docshell.
  _watch(win) {
    const document = win.document;
    if (!document || this.documents.has(document)) {
      return;
    }
    const navigated = this.windows.has(win) && win.browsingContext === this.target.browsingContext;
    this.documents.add(document);
    if (navigated) {
      // The main frame loaded another document (Record and reload).
      this._push({
        name: "FrameCommittedInBrowser",
        cat: TIMELINE_TASKS,
        ph: "I",
        s: "t",
        pid: BROWSER_PID,
        tid: BROWSER_TID,
        ts: micros(now()),
        args: { data: this._frameInfo(win) },
      });
    }
    try {
      this.notifications.connect(win);
    } catch {
      // A window being torn down.
    }
    if (this.dbg) {
      try {
        this.dbg.addDebuggee(win);
      } catch {
        // A global the Debugger cannot observe (a chrome page).
      }
      if (this.listenerBreakpoint && this.timeline) {
        this._breakOnDocument(win);
      }
    }
    win.addEventListener("DOMContentLoaded", this.onDocumentEvent, { mozSystemGroup: true });
    win.addEventListener("load", this.onDocumentEvent, { mozSystemGroup: true });
    if (!this.windows.has(win)) {
      this.windows.add(win);
      win.docShell?.addWeakReflowObserver(this.reflowObserver);
    }
  }

  _unwatch(win) {
    try {
      this.notifications.disconnect(win);
    } catch {
      // A window that went away.
    }
    try {
      win.docShell?.removeWeakReflowObserver(this.reflowObserver);
      win.removeEventListener("DOMContentLoaded", this.onDocumentEvent, { mozSystemGroup: true });
      win.removeEventListener("load", this.onDocumentEvent, { mozSystemGroup: true });
    } catch {
      // A window that went away.
    }
  }

  _frameId(win) {
    try {
      return frameIdOf(this.target, win.browsingContext);
    } catch {
      return this.target.id;
    }
  }

  _frameInfo(win) {
    const main = win.browsingContext === this.target.browsingContext;
    return {
      frame: this._frameId(win),
      url: win.location?.href ?? "",
      name: win.name ?? "",
      processId: RENDERER_PID,
      isInPrimaryMainFrame: main,
      isOutermostMainFrame: main,
      ...(main ? {} : { parent: this._frameId(win.parent) }),
    };
  }

  // The metadata Chromium's trace starts with: which process and thread is
  // the page's main thread, and which frames the page has.
  _metadata() {
    const meta = (pid, tid, name, args) => ({ name, ph: "M", cat: "__metadata", pid, tid, ts: 0, args });
    return [
      meta(BROWSER_PID, BROWSER_TID, "process_name", { name: "Browser" }),
      meta(BROWSER_PID, BROWSER_TID, "thread_name", { name: "CrBrowserMain" }),
      meta(RENDERER_PID, RENDERER_TID, "process_name", { name: "Renderer" }),
      meta(RENDERER_PID, RENDERER_TID, "thread_name", { name: "CrRendererMain" }),
      {
        name: "TracingStartedInBrowser",
        ph: "I",
        s: "t",
        cat: TIMELINE_TASKS,
        pid: BROWSER_PID,
        tid: BROWSER_TID,
        ts: micros(this.startTime),
        args: { data: { frameTreeNodeId: 1, persistentIds: true, frames: this.frames } },
      },
    ];
  }

  _push(event) {
    this.events.push({ pid: RENDERER_PID, tid: RENDERER_TID, ...event });
  }

  // Begins a trace event that a later _end() closes, inside a RunTask when
  // nothing else is open. The event goes into the trace when it begins, so a
  // parent comes before its children: the front-end nests events that start
  // and end at the same microsecond in the order they come.
  _begin(name, category, data, time = now()) {
    if (!this.timeline) {
      return;
    }
    if (!this.open.length) {
      this.open.push(this._open("RunTask", TIMELINE_TASKS, {}, time));
    }
    this.open.push(this._open(name, category, { data }, time));
  }

  _open(name, cat, args, time) {
    const event = { pid: RENDERER_PID, tid: RENDERER_TID, name, cat, ph: "X", ts: micros(time), dur: 0, args };
    this.events.push(event);
    return event;
  }

  _end(time = now()) {
    if (!this.timeline || !this.open.length) {
      return;
    }
    const close = event => {
      event.dur = Math.max(0, micros(time) - event.ts);
    };
    close(this.open.pop());
    if (this.open.length === 1 && this.open[0].name === "RunTask") {
      close(this.open.pop());
    }
  }

  _complete({ name, cat, args, ts }, end) {
    this._push({ name, cat, ph: "X", ts: micros(ts), dur: Math.max(0, micros(end) - micros(ts)), args });
  }

  // A trace event with a duration that is already over (a layout, a paint),
  // in its own RunTask when it ran outside any other.
  _completed(name, category, args, start, end) {
    if (!this.timeline) {
      return;
    }
    const alone = !this.open.length;
    if (alone) {
      this._complete({ name: "RunTask", cat: TIMELINE_TASKS, args: {}, ts: start }, end);
    }
    this._complete({ name, cat: category, args, ts: start }, end);
  }

  _instant(name, category, data, time = now()) {
    if (this.timeline) {
      this._push({ name, cat: category, ph: "I", s: "t", ts: micros(time), args: { data } });
    }
  }

  _onNotification(notification) {
    const type = notification.type;
    const frame = notification.global ? this._frameId(notification.global) : this.target.id;
    if (type === "domEvent") {
      if (notification.phase === "pre") {
        let eventType = "";
        try {
          eventType = notification.event.type;
        } catch {
          // An event from another origin.
        }
        this._begin("EventDispatch", TIMELINE, { type: eventType, frame });
        if (this.listenerBreakpoint) {
          this._breakOnListeners(notification);
        }
      } else if (notification.phase === "post") {
        this._end();
      }
      return;
    }
    if (CALLBACKS[type]) {
      if (notification.phase === "pre") {
        this._begin(CALLBACKS[type], TIMELINE, { frame, timerId: this.nextTimerId++ });
      } else if (notification.phase === "post") {
        this._end();
      }
      return;
    }
    if (CALLS[type] && notification.phase !== "post") {
      // Gecko's notifications do not say which timer a call or callback is,
      // so each gets its own id and the front-end draws no initiator arrow.
      this._instant(CALLS[type], TIMELINE, { frame, timerId: this.nextTimerId++ });
    }
  }

  // Puts a breakpoint at the entry of each listener the event's current
  // target has for it, for a listener added after the recording started
  // (_breakOnDocument covers the rest). A breakpoint is set once per function
  // and stays for the recording, so later events cost nothing more.
  _breakOnListeners(notification) {
    let event, target;
    try {
      event = notification.event;
      target = event.currentTarget;
    } catch {
      return;
    }
    if (!target || !notification.global) {
      return;
    }
    let types = this.listenedTypes.get(target);
    if (!types) {
      types = new Set();
      this.listenedTypes.set(target, types);
    }
    if (!types.has(event.type)) {
      types.add(event.type);
      try {
        this._breakOnTarget(target, this.dbg.addDebuggee(notification.global), event.type);
      } catch {
        // A global the Debugger cannot observe.
      }
    }
  }

  // Setting a breakpoint compiles the function's code again, about 2ms for a
  // small listener; inside an event that time would show as the event's. So
  // the listeners already on the page get theirs when the recording starts.
  _breakOnDocument(win) {
    const document = win.document;
    let global;
    try {
      global = this.dbg.addDebuggee(win);
    } catch {
      return;
    }
    const targets = [win, document, ...document.querySelectorAll("*")].slice(0, MAX_TARGETS_AT_START);
    for (const target of targets) {
      this._breakOnTarget(target, global, null);
    }
  }

  _breakOnTarget(target, global, type) {
    let infos;
    try {
      infos = Services.els.getListenerInfoFor(target);
    } catch {
      return;
    }
    for (const info of infos) {
      if (type !== null && info.type !== type) {
        continue;
      }
      let listener = info.listenerObject;
      if (listener && typeof listener === "object" && typeof listener.handleEvent === "function") {
        listener = listener.handleEvent;
      }
      if (typeof listener !== "function") {
        continue;
      }
      let callee = global.makeDebuggeeValue(listener);
      while (callee?.isBoundFunction) {
        callee = callee.boundTargetFunction;
      }
      const script = callee?.script;
      if (script && !this.listenerScripts.has(script)) {
        this.listenerScripts.add(script);
        script.setBreakpoint(script.mainOffset ?? 0, this.listenerBreakpoint);
      }
    }
  }

  _callFrame(script) {
    let callFrame = this.callFrames.get(script);
    if (!callFrame) {
      const source = script.source;
      callFrame = {
        functionName: script.displayName ?? "",
        scriptId: source ? String(source.id) : "0",
        url: source?.url ?? script.url ?? "",
        lineNumber: script.startLine - 1,
        columnNumber: script.startColumn - 1,
      };
      this.callFrames.set(script, callFrame);
    }
    return callFrame;
  }

  // The outermost frame of a task (a listener, a timer, a script, a
  // microtask, an async function resuming) begins FunctionCall or
  // EvaluateScript, which ends when the frame leaves the stack.
  _enterTop(frame, time) {
    frame.onPop = this.onTopPop;
    if (!this.timeline || !frame.script) {
      return;
    }
    const callFrame = this._callFrame(frame.script);
    let win = null;
    try {
      win = frame.script.global?.unsafeDereference();
    } catch {
      // A global that went away.
    }
    const frameId = win ? this._frameId(win) : this.target.id;
    if (frame.type === "call") {
      this._begin("FunctionCall", TIMELINE, { ...callFrame, frame: frameId }, time);
    } else {
      const { url, lineNumber, columnNumber } = callFrame;
      this._begin("EvaluateScript", TIMELINE, { url, lineNumber, columnNumber, frame: frameId }, time);
    }
  }

  // The front-end nests the sampled calls under FunctionCall only when they
  // lie inside it, so a task's samples start a microsecond after it and end a
  // microsecond before.
  _leaveTop() {
    const time = now();
    this.profile?.sample(this.profile.idle, time);
    if (this.timeline && this.open.length) {
      this._end(time + ONE_MICROSECOND);
    }
  }

  // With samples on, every call comes here. Reading the clock costs about as
  // much as the hook itself, so it is read on a task's first frame and on
  // every eighth call after; the stack is walked only when a sample is due.
  _onSampledFrame(frame) {
    if (frame.older === null) {
      const time = now();
      this._enterTop(frame, time);
      this.profile.sample(this._stackNode(frame), time + ONE_MICROSECOND);
      return;
    }
    if (++this.calls & 7) {
      return;
    }
    const time = now();
    if (time - this.profile.lastSampleTime >= SAMPLING_INTERVAL_MS) {
      this.profile.sample(this._stackNode(frame), time);
    }
  }

  _stackNode(frame) {
    const scripts = [];
    for (let current = frame; current; current = current.older) {
      if (current.script) {
        scripts.push(current.script);
      }
    }
    let node = this.profile.root;
    for (let i = scripts.length - 1; i >= 0; i--) {
      node = this.profile.child(node, scripts[i], () => this._callFrame(scripts[i]));
    }
    return node;
  }

  // The reflow observer is called right after a layout ends, with start and
  // end on the document's performance clock; the call's own time stands for
  // the end, which keeps the layout inside the call that forced it.
  _onReflow(start, end) {
    const finished = now();
    this.laidOut = true;
    this._completed(
      "Layout",
      TIMELINE,
      {
        beginData: { frame: this.target.id, dirtyObjects: 0, totalObjects: 0, partialLayout: false },
        endData: { root: [0, 0, 0, 0, 0, 0, 0, 0], layoutRoots: [] },
      },
      finished - Math.max(0, end - start),
      finished
    );
  }

  _onPaint(event) {
    // Gecko also sends MozAfterPaint for composites that repainted nothing of
    // the page (about every 100ms while DevTools are docked), and in FireDog
    // its clientRects are always empty, so they cannot tell the two apart.
    // A paint counts when the page laid out since the last one counted.
    if (!this.laidOut) {
      return;
    }
    this.laidOut = false;
    const time = now();
    const win = event.target?.defaultView ?? this.target.contentWindow;
    this._completed(
      "Paint",
      TIMELINE,
      { data: { frame: win ? this._frameId(win) : this.target.id, clip: [0, 0, 0, 0, 0, 0, 0, 0], nodeId: 0, layerId: 0 } },
      time,
      time
    );
  }

  _ownsInnerWindow(innerID) {
    const win = Services.wm.getCurrentInnerWindowWithId?.(Number(innerID));
    return !!win && this.windows.has(win);
  }

  // console.timeEnd() logs the timer's duration; it ran from that long ago to
  // now. console.timeStamp() marks now.
  _onConsoleAPI(message) {
    if (!this._ownsInnerWindow(message.innerID)) {
      return;
    }
    const time = now();
    if (message.level === "timeEnd" && message.timer?.duration !== undefined && this._enabled(CONSOLE)) {
      this._async(CONSOLE, message.timer.name, time - message.timer.duration, time, {});
    } else if (message.level === "timeStamp" && this.timeline) {
      const label = message.arguments?.[0];
      this._push({ name: "TimeStamp", cat: TIMELINE, ph: "I", s: "t", ts: micros(time), args: { data: { message: label === undefined ? "" : String(label) } } });
    }
  }

  _async(category, name, start, end, args) {
    const id2 = { local: `0x${(this.nextAsyncId++).toString(16)}` };
    this._push({ name, cat: category, ph: "b", id2, ts: micros(start), args });
    this._push({ name, cat: category, ph: "e", id2, ts: micros(end), args: {} });
  }

  // The page's marks and measures since the recording started. Their times
  // are on the page's performance clock, which is mapped onto ours through
  // the two clocks' readings now (within the page clock's precision).
  _userTiming(win, endTime) {
    const performance = win.performance;
    if (!performance) {
      return;
    }
    const offset = endTime - performance.now();
    const since = this.startTime - offset;
    for (const entry of performance.getEntriesByType("mark")) {
      if (entry.startTime >= since) {
        this._push({ name: entry.name, cat: USER_TIMING, ph: "R", ts: micros(entry.startTime + offset), args: { data: { startTime: entry.startTime } } });
      }
    }
    for (const entry of performance.getEntriesByType("measure")) {
      if (entry.startTime >= since) {
        this._async(USER_TIMING, entry.name, entry.startTime + offset, entry.startTime + entry.duration + offset, {});
      }
    }
  }

  _onDocumentEvent(event) {
    const win = event.target?.defaultView ?? event.currentTarget;
    const main = win?.browsingContext === this.target.browsingContext;
    const name = event.type === "load" ? "MarkLoad" : "MarkDOMContent";
    this._push({
      name,
      cat: TIMELINE,
      ph: "R",
      ts: micros(now()),
      args: { data: { frame: win ? this._frameId(win) : this.target.id, isMainFrame: main, isOutermostMainFrame: main, page: this.target.id } },
    });
  }
}

// The page's call stacks as V8's CPU profile: a tree of call frames (nodes)
// and, about every SAMPLING_INTERVAL_MS, the node that was running. The front-end
// reads them from a Profile event and its ProfileChunk.
class CpuProfile {
  constructor(startTime) {
    this.startTime = startTime;
    this.nodes = [];
    // Children of each node by Debugger.Script.
    this.children = new Map();
    this.root = this._node(null, { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 });
    this.idle = this._node(this.root, { functionName: "(idle)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 });
    this.samples = [];
    this.timeDeltas = [];
    this.lastSampleTime = startTime;
    this.previousSampleTime = startTime;
    // The node running since lastSampleTime.
    this.running = this.idle;
  }

  _node(parent, callFrame) {
    const node = { id: this.nodes.length + 1, callFrame, ...(parent ? { parent: parent.id } : {}) };
    this.nodes.push(node);
    return node;
  }

  // The node for script called from parent, made on first use.
  child(parent, script, callFrame) {
    let children = this.children.get(parent);
    if (!children) {
      children = new Map();
      this.children.set(parent, children);
    }
    let node = children.get(script);
    if (!node) {
      node = this._node(parent, callFrame());
      children.set(script, node);
    }
    return node;
  }

  // A sample is the node that ran from its timestamp to the next sample's.
  _emit(node, time) {
    this.samples.push(node.id);
    this.timeDeltas.push(micros(time) - micros(this.previousSampleTime));
    this.previousSampleTime = time;
  }

  // From time on, node runs.
  sample(node, time) {
    if (time > this.lastSampleTime) {
      this._emit(this.running, this.lastSampleTime);
      this.lastSampleTime = time;
    }
    this.running = node;
  }

  events(endTime) {
    this._emit(this.running, this.lastSampleTime);
    this._emit(this.idle, endTime);
    const common = { cat: CPU_PROFILER, ph: "P", id: "0x1", pid: RENDERER_PID, tid: RENDERER_TID };
    return [
      { ...common, name: "Profile", ts: micros(this.startTime), args: { data: { startTime: micros(this.startTime) } } },
      {
        ...common,
        name: "ProfileChunk",
        ts: micros(endTime),
        args: {
          data: {
            cpuProfile: { nodes: this.nodes, samples: this.samples },
            timeDeltas: this.timeDeltas,
          },
        },
      },
    ];
  }
}
