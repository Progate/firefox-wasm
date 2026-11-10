/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The DOMDebugger domain: event listeners of a target, and the breakpoints
// that pause on events (a DOM event reaching a listener, a timer, an
// animation frame) and on XHR/fetch requests. The pauses themselves are the
// Debugger domain's.
//
// Gecko reports listener invocations and timer calls to a
// DebuggerNotificationObserver connected to the page's globals (the
// mechanism of Firefox's event breakpoints): "pre" before a listener or
// callback runs, "post" after, and a single notification for a call such as
// setTimeout(). A pause before a listener is a pause at the first frame that
// enters, as in Firefox's ThreadActor.

import { DOMBreakpoints } from "resource:///modules/firedog/devtools/DOMBreakpoints.sys.mjs";
import {
  InvalidParams,
  ProtocolError,
} from "resource:///modules/firedog/devtools/Session.sys.mjs";

// Blink's instrumentation breakpoint names (EventBreakpoints and the
// deprecated DOMDebugger.setInstrumentationBreakpoint) for Gecko's
// notification types.
const INSTRUMENTATION = {
  setTimeout: "setTimeout",
  clearTimeout: "clearTimeout",
  setTimeoutCallback: "setTimeout.callback",
  setInterval: "setInterval",
  clearInterval: "clearInterval",
  setIntervalCallback: "setInterval.callback",
  requestAnimationFrame: "requestAnimationFrame",
  cancelAnimationFrame: "cancelAnimationFrame",
  requestAnimationFrameCallback: "requestAnimationFrame.callback",
};
const SUPPORTED_INSTRUMENTATION = new Set(Object.values(INSTRUMENTATION));

// The targetName the front-end uses for event breakpoints on a kind of
// target, for Gecko's targetType of a domEvent notification.
const TARGET_NAMES = {
  xhr: ["xmlhttprequest", "xmlhttprequestupload"],
  websocket: ["websocket"],
  worker: ["worker"],
};

export class DOMDebugger {
  constructor(session) {
    this.session = session;
    // eventName -> Set of targetNames ("*" for any target).
    this.eventBreakpoints = new Map();
    this.instrumentationBreakpoints = new Set();
    this.xhrBreakpoints = new Set();
    this.observer = null;
    this.connected = new Set();
    this.observingDocuments = false;
    this.observingRequests = false;
  }

  get _debugger() {
    return this.session.domain("Debugger");
  }

  get _runtime() {
    return this.session.domain("Runtime");
  }

  // Notifications are only needed while some event breakpoint is set.
  _updateObserver() {
    const wanted = this.eventBreakpoints.size > 0 || this.instrumentationBreakpoints.size > 0;
    if (wanted && !this.observer) {
      // Gecko reports listener invocations only while it knows DevTools are
      // open (ChromeUtils.isDevToolsOpened), as Firefox's toolbox tells it.
      ChromeUtils.notifyDevToolsOpened();
      this.observer = new DebuggerNotificationObserver();
      this.observer.addListener(notification => this._onNotification(notification));
      for (const win of this._runtime._windows()) {
        this._connect(win);
      }
      Services.obs.addObserver(this, "document-element-inserted");
      this.observingDocuments = true;
    } else if (!wanted && this.observer) {
      for (const win of this.connected) {
        try {
          this.observer.disconnect(win);
        } catch {
          // A window that went away.
        }
      }
      this.connected.clear();
      this.observer = null;
      ChromeUtils.notifyDevToolsClosed();
      if (this.observingDocuments) {
        Services.obs.removeObserver(this, "document-element-inserted");
        this.observingDocuments = false;
      }
    }
  }

  _connect(win) {
    if (this.connected.has(win)) {
      return;
    }
    try {
      this.observer.connect(win);
      this.connected.add(win);
    } catch (error) {
      console.error("FireDog DevTools: event breakpoints", error);
    }
  }

  observe(subject, topic) {
    if (topic === "document-element-inserted") {
      const win = subject.defaultView;
      if (this.observer && win?.browsingContext?.top === this.session.target.browsingContext) {
        this._connect(win);
      }
    } else if (topic === "http-on-opening-request") {
      this._onRequest(subject);
    }
  }

  _matchEvent(type, targetType) {
    const targets = this.eventBreakpoints.get(type);
    if (!targets) {
      return null;
    }
    if (targets.has("*")) {
      return "*";
    }
    return (TARGET_NAMES[targetType] ?? []).find(name => targets.has(name)) ?? null;
  }

  _onNotification(notification) {
    const debuggerDomain = this._debugger;
    if (!debuggerDomain.enabled || debuggerDomain.paused) {
      return;
    }
    let data;
    if (notification.type === "domEvent") {
      let type;
      try {
        type = notification.event.type;
      } catch {
        return;
      }
      const targetName = this._matchEvent(type, notification.targetType);
      if (targetName === null) {
        return;
      }
      // Blink names the listening target: a node by its nodeName, anything
      // else by its interface.
      let current = null;
      try {
        current = notification.event.currentTarget;
      } catch {
        // A target from another origin.
      }
      let name = targetName === "*" ? "" : targetName;
      if (current) {
        name = typeof current.nodeName === "string" ? current.nodeName : ChromeUtils.getClassName(current);
      }
      data = { eventName: `listener:${type}`, ...(name ? { targetName: name } : {}) };
    } else {
      const name = INSTRUMENTATION[notification.type];
      if (!name || !this.instrumentationBreakpoints.has(name)) {
        return;
      }
      data = { eventName: `instrumentation:${name}` };
    }
    if (notification.phase === "pre") {
      debuggerDomain._pauseAtNextFrame("event", "EventListener", data);
    } else if (notification.phase === "post") {
      debuggerDomain._setEnterFrameHook("event", null);
    } else {
      // A call (setTimeout(), requestAnimationFrame()): pause in its caller.
      debuggerDomain._pauseFor("EventListener", data);
    }
  }

  _updateRequestObserver() {
    const wanted = this.xhrBreakpoints.size > 0;
    if (wanted && !this.observingRequests) {
      Services.obs.addObserver(this, "http-on-opening-request");
      this.observingRequests = true;
    } else if (!wanted && this.observingRequests) {
      Services.obs.removeObserver(this, "http-on-opening-request");
      this.observingRequests = false;
    }
  }

  // XHR and fetch() open their channel synchronously from the page's call,
  // so the page's script is on the stack and pauses there.
  _onRequest(subject) {
    const debuggerDomain = this._debugger;
    if (!debuggerDomain.enabled || debuggerDomain.paused) {
      return;
    }
    let channel;
    try {
      channel = subject.QueryInterface(Ci.nsIHttpChannel);
    } catch {
      return;
    }
    const type = channel.loadInfo?.externalContentPolicyType;
    if (type !== Ci.nsIContentPolicy.TYPE_XMLHTTPREQUEST && type !== Ci.nsIContentPolicy.TYPE_FETCH) {
      return;
    }
    const url = channel.URI.spec;
    const breakpointURL = [...this.xhrBreakpoints].find(part => url.includes(part));
    if (breakpointURL === undefined) {
      return;
    }
    const frame = debuggerDomain.dbg.getNewestFrame();
    const win = frame?.script?.global?.unsafeDereference();
    if (!win || win.browsingContext?.top !== this.session.target.browsingContext) {
      return;
    }
    debuggerDomain._pause(frame, "XHR", { data: { breakpointURL, url } });
  }

  setEventListenerBreakpoint({ eventName, targetName = "*" }) {
    if (typeof eventName !== "string" || !eventName) {
      throw new InvalidParams("Event name is empty");
    }
    let targets = this.eventBreakpoints.get(eventName);
    if (!targets) {
      targets = new Set();
      this.eventBreakpoints.set(eventName, targets);
    }
    targets.add((targetName || "*").toLowerCase());
    this._updateObserver();
  }

  removeEventListenerBreakpoint({ eventName, targetName = "*" }) {
    const targets = this.eventBreakpoints.get(eventName);
    targets?.delete((targetName || "*").toLowerCase());
    if (targets && !targets.size) {
      this.eventBreakpoints.delete(eventName);
    }
    this._updateObserver();
  }

  _setInstrumentationBreakpoint(eventName, enabled) {
    if (!SUPPORTED_INSTRUMENTATION.has(eventName)) {
      throw new ProtocolError(`Instrumentation breakpoint ${eventName} is not supported`);
    }
    if (enabled) {
      this.instrumentationBreakpoints.add(eventName);
    } else {
      this.instrumentationBreakpoints.delete(eventName);
    }
    this._updateObserver();
  }

  setInstrumentationBreakpoint({ eventName }) {
    this._setInstrumentationBreakpoint(eventName, true);
  }

  removeInstrumentationBreakpoint({ eventName }) {
    this._setInstrumentationBreakpoint(eventName, false);
  }

  setXHRBreakpoint({ url = "" }) {
    this.xhrBreakpoints.add(url);
    this._updateRequestObserver();
  }

  removeXHRBreakpoint({ url = "" }) {
    this.xhrBreakpoints.delete(url);
    this._updateRequestObserver();
  }

  setBreakOnCSPViolation({ violationTypes = [] }) {
    if (violationTypes.length) {
      throw new ProtocolError("Breaking on CSP violations is not supported");
    }
  }

  // Listeners of the object and, for a node, of its descendants down to
  // depth (-1: all), as Blink collects them.
  getEventListeners({ objectId, depth = 1, pierce = false }) {
    const runtime = this._runtime;
    const object = runtime._object(objectId);
    if (typeof object !== "object" || !object?.unsafeDereference) {
      throw new ProtocolError("Object is not an event target");
    }
    const group = [...runtime.objects.groups].find(([, ids]) => ids.has(objectId))?.[0];
    const target = object.unsafeDereference();
    const targets = [[target, false]];
    if (depth !== 1 && typeof target.nodeType === "number") {
      const visit = (node, level) => {
        if (depth !== -1 && level >= depth) {
          return;
        }
        const children = [...(node.childNodes ?? [])];
        if (pierce) {
          if (node.shadowRoot) {
            children.push(node.shadowRoot);
          }
          if (node.contentDocument) {
            children.push(node.contentDocument);
          }
        }
        for (const child of children) {
          targets.push([child, true]);
          visit(child, level + 1);
        }
      };
      visit(target, 1);
    }
    const listeners = [];
    for (const [current, descendant] of targets) {
      let infos;
      try {
        infos = Services.els.getListenerInfoFor(current);
      } catch {
        continue;
      }
      for (const info of infos) {
        // Gecko's own listeners (system group, chrome code) are not the
        // page's.
        if (info.inSystemEventGroup) {
          continue;
        }
        const listener = this._describeListener(info, object, group);
        if (!listener) {
          continue;
        }
        if (descendant) {
          try {
            const { backendNodeIdOf } = ChromeUtils.importESModule(
              "resource:///modules/firedog/devtools/domains/DOM.sys.mjs"
            );
            listener.backendNodeId = backendNodeIdOf(current);
          } catch {
            // Without the DOM domain, descendants' listeners can't be told
            // apart; leave them out.
            continue;
          }
        }
        listeners.push(listener);
      }
    }
    return { listeners };
  }

  _describeListener(info, anchor, group) {
    const runtime = this._runtime;
    const debuggerDomain = this._debugger;
    let value;
    try {
      value = info.listenerObject;
    } catch {
      return null;
    }
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return null;
    }
    // Listeners FireDog's own code (actors, the UI) put on the page's
    // targets are not the page's; Chromium has none of them to show.
    try {
      if (Cu.getObjectPrincipal(value).isSystemPrincipal) {
        return null;
      }
    } catch {
      return null;
    }
    const original = anchor.makeDebuggeeValue(value);
    let handler = original;
    if (!original.callable) {
      // A listener object: its handleEvent is what runs.
      const descriptor = original.getOwnPropertyDescriptor("handleEvent");
      if (descriptor?.value?.callable) {
        handler = descriptor.value;
      }
    }
    let target = handler;
    while (target?.isBoundFunction) {
      target = target.boundTargetFunction;
    }
    let location = { scriptId: "", lineNumber: 0, columnNumber: 0 };
    const script = target?.script;
    if (script) {
      const scriptId = debuggerDomain._scriptIdOf(script);
      const scriptInfo = debuggerDomain.scripts.get(scriptId);
      try {
        location = scriptInfo.positionOf(script.sourceStart);
      } catch {
        location = { scriptId, lineNumber: script.startLine - 1, columnNumber: script.startColumn - 1 };
      }
    }
    return {
      type: info.type,
      useCapture: info.capturing,
      // Gecko's nsIEventListenerInfo does not expose these flags.
      passive: false,
      once: false,
      scriptId: location.scriptId,
      lineNumber: location.lineNumber,
      columnNumber: location.columnNumber,
      handler: runtime._remote(handler, { group }),
      originalHandler: runtime._remote(original, { group }),
    };
  }

  // DOM breakpoints live in DOMBreakpoints.sys.mjs.
  get _domBreakpoints() {
    this.domBreakpoints ??= new DOMBreakpoints(this.session);
    return this.domBreakpoints;
  }

  setDOMBreakpoint(params) {
    this._domBreakpoints.set(params);
  }

  removeDOMBreakpoint(params) {
    this._domBreakpoints.remove(params);
  }

  _destroy() {
    this.domBreakpoints?.destroy();
    this.eventBreakpoints.clear();
    this.instrumentationBreakpoints.clear();
    this.xhrBreakpoints.clear();
    this._updateObserver();
    this._updateRequestObserver();
  }
}
