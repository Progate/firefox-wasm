/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Runtime domain: execution contexts (one per document's global in the
// page and its frames), evaluation, objects and console messages.
//
// FireDog runs single-process, so the page's globals live in this process and
// are reached directly. Evaluation and object inspection go through a
// SpiderMonkey Debugger created in a separate, invisible compartment (the
// Debugger API refuses debuggees in its own compartment, and the DevTools
// server isolates its debugger the same way).

import {
  ObjectStore,
  describeNode,
  remoteObject,
} from "resource:///modules/firedog/devtools/RemoteObjects.sys.mjs";
import {
  InvalidParams,
  ProtocolError,
} from "resource:///modules/firedog/devtools/Session.sys.mjs";
import { evaluateWithoutSideEffects } from "resource:///modules/firedog/devtools/SideEffectFree.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  addDebuggerToGlobal: "resource://gre/modules/jsdebugger.sys.mjs",
});

const consoleStorage = () =>
  Cc["@mozilla.org/consoleAPI-storage;1"].getService(Ci.nsIConsoleAPIStorage);

// Gecko's console method names to Runtime.consoleAPICalled's type.
const CONSOLE_TYPES = {
  log: "log",
  debug: "debug",
  info: "info",
  error: "error",
  warn: "warning",
  dir: "dir",
  dirxml: "dirxml",
  table: "table",
  trace: "trace",
  clear: "clear",
  group: "startGroup",
  groupCollapsed: "startGroupCollapsed",
  groupEnd: "endGroup",
  assert: "assert",
  count: "count",
  countReset: "count",
  timeEnd: "timeEnd",
  timeLog: "timeLog",
  profile: "profile",
  profileEnd: "profileEnd",
};

let debuggerSandbox = null;
function newDebugger() {
  if (!debuggerSandbox) {
    debuggerSandbox = Cu.Sandbox(
      Services.scriptSecurityManager.getSystemPrincipal(),
      { freshCompartment: true, invisibleToDebugger: true }
    );
    lazy.addDebuggerToGlobal(debuggerSandbox);
  }
  return new debuggerSandbox.Debugger();
}

// Chromium's main frame id is its target id; other frames get an id of the
// same form from their browsing context.
export function frameIdOf(target, browsingContext) {
  if (browsingContext === target.browsingContext) {
    return target.id;
  }
  return browsingContext.id.toString(16).toUpperCase().padStart(32, "0");
}

export class Runtime {
  constructor(session) {
    this.session = session;
    this.target = session.target;
    this.enabled = false;
    this.dbg = newDebugger();
    this.objects = new ObjectStore();
    // Execution contexts by id, and the id of each global.
    this.contexts = new Map();
    this.contextOfGlobal = new WeakMap();
    this.nextContextId = 1;
    this.observing = false;
    this.lastResult = undefined;
  }

  // Calls to Runtime from other domains (DOM resolves nodes to objects,
  // Debugger evaluates on frames) go through these.

  _debuggee(win) {
    try {
      return this.dbg.addDebuggee(win);
    } catch {
      return this.dbg.makeGlobalObjectReference(win);
    }
  }

  _remote(value, options) {
    return remoteObject(value, this.objects, options);
  }

  _remoteForPageValue(win, value, options) {
    const global = this._debuggee(win);
    return this._remote(
      value !== null && (typeof value === "object" || typeof value === "function")
        ? global.makeDebuggeeValue(value)
        : value,
      options
    );
  }

  _object(objectId) {
    const object = this.objects.get(objectId);
    if (object === null) {
      throw new ProtocolError("Could not find object with given id");
    }
    return object;
  }

  _windows() {
    const windows = [];
    const visit = context => {
      const win = context.window;
      if (win) {
        windows.push(win);
      }
      for (const child of context.children) {
        visit(child);
      }
    };
    visit(this.target.browsingContext);
    return windows;
  }

  // Contexts are per document: a window object (the WindowProxy) stays the
  // same across navigations of its frame, its document does not.
  _contextForWindow(win, create = true) {
    const id = this.contextOfGlobal.get(win.document);
    if (id) {
      return this.contexts.get(id);
    }
    if (!create) {
      return null;
    }
    const context = {
      id: this.nextContextId++,
      window: win,
      document: win.document,
      origin: win.document.nodePrincipal.isNullPrincipal ? "://" : win.origin,
      name: "",
      uniqueId: `${Math.floor(Math.random() * 2 ** 52)}.${Math.floor(Math.random() * 2 ** 52)}`,
      frameId: frameIdOf(this.target, win.browsingContext),
    };
    this.contexts.set(context.id, context);
    this.contextOfGlobal.set(win.document, context.id);
    this._debuggee(win);
    return context;
  }

  _contextById(id) {
    const context = this.contexts.get(id);
    if (!context || context.window.closed) {
      throw new ProtocolError("Cannot find context with specified id");
    }
    return context;
  }

  _defaultContext() {
    const win = this.target.contentWindow;
    if (!win) {
      throw new ProtocolError("Cannot find default execution context");
    }
    return this._contextForWindow(win);
  }

  _describeContext(context) {
    return {
      id: context.id,
      origin: context.origin,
      name: context.name,
      uniqueId: context.uniqueId,
      auxData: {
        isDefault: true,
        type: "default",
        frameId: context.frameId,
      },
    };
  }

  _announce(context) {
    if (this.enabled) {
      this.session.emit("Runtime.executionContextCreated", {
        context: this._describeContext(context),
      });
    }
  }

  // A new document's global appeared in this page (navigation, a new frame).
  observe(subject, topic) {
    if (topic !== "document-element-inserted") {
      return;
    }
    const win = subject.defaultView;
    if (!win || win.browsingContext?.top !== this.target.browsingContext) {
      return;
    }
    if (this.contextOfGlobal.has(subject)) {
      return;
    }
    if (win.browsingContext === this.target.browsingContext) {
      // A navigation of the main frame destroys every context of the page.
      for (const [id, context] of this.contexts) {
        if (context.document !== subject) {
          this.contexts.delete(id);
        }
      }
      this.objects.clear();
      if (this.enabled) {
        this.session.emit("Runtime.executionContextsCleared");
      }
    }
    const context = this._contextForWindow(win);
    this._announce(context);
    this._installBindings(context);
  }

  _startObserving() {
    if (this.observing) {
      return;
    }
    this.observing = true;
    Services.obs.addObserver(this, "document-element-inserted");
    this.onConsoleAPI = message => this._consoleAPICalled(message.wrappedJSObject);
    consoleStorage().addLogEventListener(
      this.onConsoleAPI,
      Services.scriptSecurityManager.getSystemPrincipal()
    );
    this.onConsoleMessage = { observe: message => this._consoleMessage(message) };
    Services.console.registerListener(this.onConsoleMessage);
  }

  _stopObserving() {
    if (!this.observing) {
      return;
    }
    this.observing = false;
    Services.obs.removeObserver(this, "document-element-inserted");
    consoleStorage().removeLogEventListener(this.onConsoleAPI);
    Services.console.unregisterListener(this.onConsoleMessage);
  }

  _contextForInnerWindowId(innerWindowId) {
    const win = Services.wm.getCurrentInnerWindowWithId?.(innerWindowId);
    if (!win || win.browsingContext?.top !== this.target.browsingContext) {
      return null;
    }
    return this._contextForWindow(win);
  }

  // Console stacks are flat; a frame with an asyncCause starts the part
  // that ran before an async boundary, which CDP nests as parent.
  _stackTrace(frames) {
    const debuggerDomain = this.session.domain("Debugger");
    const root = { callFrames: [] };
    let trace = root;
    for (const frame of frames ?? []) {
      if (frame.asyncCause && trace.callFrames.length) {
        if (!debuggerDomain.asyncCallStackDepth) {
          break;
        }
        trace = trace.parent = { description: frame.asyncCause, callFrames: [] };
      }
      trace.callFrames.push({
        functionName: frame.functionName ?? "",
        scriptId:
          debuggerDomain._scriptIdForUrl(frame.filename, frame.lineNumber, frame.sourceId) ?? "",
        url: frame.filename ?? "",
        lineNumber: Math.max(0, (frame.lineNumber ?? 1) - 1),
        columnNumber: Math.max(0, (frame.columnNumber ?? 1) - 1),
      });
    }
    return root;
  }

  _consoleAPICalled(message) {
    if (!this.enabled) {
      return;
    }
    const context = this._contextForInnerWindowId(message.innerID);
    if (!context) {
      return;
    }
    const type = CONSOLE_TYPES[message.level] ?? "log";
    let args;
    if (message.counter) {
      args = [
        message.counter.error
          ? { type: "string", value: message.counter.error }
          : { type: "string", value: `${message.counter.label}: ${message.counter.count}` },
      ];
    } else if (message.timer && (message.level === "timeEnd" || message.level === "timeLog")) {
      args = [
        {
          type: "string",
          value: `${message.timer.name}: ${message.timer.duration} ms`,
        },
        ...(message.arguments ?? [])
          .slice(1)
          .map(value => this._remoteForPageValue(context.window, value, { group: "console", generatePreview: true })),
      ];
    } else {
      args = (message.arguments ?? []).map(value =>
        this._remoteForPageValue(context.window, value, {
          group: "console",
          generatePreview: true,
        })
      );
    }
    this.session.emit("Runtime.consoleAPICalled", {
      type,
      args,
      executionContextId: context.id,
      timestamp: message.timeStamp,
      // Gecko keeps a whole stack only for trace, assert and errors; other
      // calls carry their caller's location, which V8 reports as the stack.
      stackTrace: this._stackTrace(message.stacktrace?.length ? message.stacktrace : message.filename ? [message] : []),
    });
  }

  // Uncaught exceptions of the page become Runtime.exceptionThrown, like
  // V8's; other errors and warnings (CSS, network, security) go to Log.
  _consoleMessage(message) {
    if (!(message instanceof Ci.nsIScriptError) || !message.innerWindowID) {
      return;
    }
    const context = this._contextForInnerWindowId(message.innerWindowID);
    if (!context) {
      return;
    }
    const isException =
      message.category === "content javascript" &&
      !(message.flags & Ci.nsIScriptError.warningFlag);
    if (isException && this.enabled) {
      this.session.emit("Runtime.exceptionThrown", {
        timestamp: message.timeStamp,
        exceptionDetails: this._exceptionDetailsOfError(message, context),
      });
    } else if (!isException) {
      this.session.domain("Log")._entry(message, context);
    }
  }

  _exceptionDetailsOfError(error, context) {
    const exception = error.hasException
      ? this._remoteForPageValue(context.window, error.exception, { group: "console" })
      : undefined;
    return {
      exceptionId: this.nextExceptionId = (this.nextExceptionId ?? 0) + 1,
      text: "Uncaught",
      lineNumber: Math.max(0, error.lineNumber - 1),
      columnNumber: Math.max(0, error.columnNumber - 1),
      url: error.sourceName,
      scriptId: this.session.domain("Debugger")._scriptIdForUrl(error.sourceName) ?? undefined,
      stackTrace: this._stackTraceOfSavedFrame(error.stack),
      exception: exception ?? { type: "string", value: error.errorMessage },
      executionContextId: context.id,
    };
  }

  _stackTraceOfSavedFrame(frame) {
    return (
      this.session.domain("Debugger")._stackTraceOfSaved(frame) ?? { callFrames: [] }
    );
  }


  _exceptionDetails(completion, context, text = "Uncaught") {
    const value = completion.throw;
    const details = {
      exceptionId: this.nextExceptionId = (this.nextExceptionId ?? 0) + 1,
      text,
      lineNumber: 0,
      columnNumber: 0,
      exception: this._remote(value, { group: "console" }),
      executionContextId: context.id,
    };
    if (value && typeof value === "object" && value.isError) {
      details.lineNumber = Math.max(0, (value.errorLineNumber ?? 1) - 1);
      details.columnNumber = Math.max(0, (value.errorColumnNumber ?? 1) - 1);
    }
    // Debugger completions of a throw carry the stack at the throw.
    if (completion.stack) {
      details.stackTrace = this._stackTraceOfSavedFrame(completion.stack);
    }
    return details;
  }

  // The Console's command line API (V8's V8Console::installCommandLineAPI):
  // $0..$4 are the last inspected nodes, $_ the last result.
  _commandLineBindings(context) {
    const win = context.window;
    const global = this._debuggee(win);
    const bindings = {};
    const dom = this.session.domains.get("DOM");
    const inspected = dom?._inspectedNodes ?? [];
    for (let i = 0; i < 5; i++) {
      const node = inspected[i];
      bindings[`$${i}`] = node ? global.makeDebuggeeValue(node) : undefined;
    }
    bindings.$_ = this.lastResult;
    const exported = (name, fn) => {
      bindings[name] = global.makeDebuggeeValue(
        Cu.exportFunction(fn, win, { allowCrossOriginArguments: true })
      );
    };
    exported("$", (selector, start) => (start ?? win.document).querySelector(selector));
    exported("$$", (selector, start) =>
      Cu.cloneInto([...(start ?? win.document).querySelectorAll(selector)], win, {
        wrapReflectors: true,
      })
    );
    exported("$x", (xpath, start) => {
      const result = win.document.evaluate(xpath, start ?? win.document, null, 0, null);
      const nodes = [];
      for (let node = result.iterateNext?.(); node; node = result.iterateNext()) {
        nodes.push(node);
      }
      return Cu.cloneInto(nodes, win, { wrapReflectors: true });
    });
    exported("keys", object => win.Object.keys(object));
    exported("values", object => win.Object.values(object));
    exported("clear", () => {
      this.session.emit("Runtime.consoleAPICalled", {
        type: "clear",
        args: [],
        executionContextId: context.id,
        timestamp: Date.now(),
      });
    });
    exported("inspect", value => {
      this.session.emit("Runtime.inspectRequested", {
        object: this._remoteForPageValue(win, value, { group: "console" }),
        hints: {},
        executionContextId: context.id,
      });
    });
    exported("copy", value => {
      this.session.emit("Runtime.inspectRequested", {
        object: this._remoteForPageValue(win, value, { group: "console" }),
        hints: { copyToClipboard: true },
        executionContextId: context.id,
      });
    });
    return bindings;
  }

  async _settle(completion, awaitPromise) {
    if (!awaitPromise || !completion || !("return" in completion)) {
      return completion;
    }
    const value = completion.return;
    if (!value || typeof value !== "object" || value.class !== "Promise") {
      return completion;
    }
    const promise = value.unsafeDereference();
    try {
      const settled = await promise;
      return { return: value.makeDebuggeeValue(settled) };
    } catch (error) {
      return { throw: value.makeDebuggeeValue(error) };
    }
  }

  // METHODS

  async enable() {
    if (this.enabled) {
      return;
    }
    this.enabled = true;
    this._startObserving();
    for (const win of this._windows()) {
      this._announce(this._contextForWindow(win));
    }
    // Messages logged before the client attached, as V8 replays them.
    for (const win of this._windows()) {
      const innerWindowID = win.windowGlobalChild?.innerWindowId;
      for (const message of consoleStorage().getEvents(innerWindowID)) {
        this._consoleAPICalled(message.wrappedJSObject ?? message);
      }
      for (const error of Services.console.getMessageArray() ?? []) {
        if (error instanceof Ci.nsIScriptError && error.innerWindowID === innerWindowID) {
          this._consoleMessage(error);
        }
      }
    }
  }

  disable() {
    this.enabled = false;
    // Bindings outlive Runtime.disable, as in Chromium: keep finding the
    // documents they go into.
    if (!this.bindings?.size) {
      this._stopObserving();
    }
  }

  async evaluate({
    expression,
    objectGroup,
    includeCommandLineAPI = false,
    contextId,
    uniqueContextId,
    returnByValue = false,
    generatePreview = false,
    awaitPromise = false,
    throwOnSideEffect = false,
    silent = false,
    timeout,
  }) {
    if (typeof expression !== "string") {
      throw new InvalidParams("Invalid parameters\nFailed to deserialize params.expression - BINDINGS: string value expected");
    }
    const context = uniqueContextId
      ? [...this.contexts.values()].find(entry => entry.uniqueId === uniqueContextId) ??
        this._defaultContext()
      : contextId
        ? this._contextById(contextId)
        : this._defaultContext();
    const global = this._debuggee(context.window);
    const bindings = includeCommandLineAPI ? this._commandLineBindings(context) : {};
    if (throwOnSideEffect) {
      // Eager evaluation (the Console's preview while typing): run under a
      // Debugger that stops at the first side effect, refused as V8 refuses.
      const debuggerDomain = this.session.domain("Debugger");
      const guarded = evaluateWithoutSideEffects(this.dbg, { global, expression, bindings, timeout });
      if (guarded.sideEffect) {
        return debuggerDomain._sideEffectResult(context, objectGroup);
      }
      if ("throw" in guarded) {
        return {
          result: this._remote(guarded.throw, { group: objectGroup, generatePreview }),
          exceptionDetails: this._exceptionDetails(guarded, context),
        };
      }
      return {
        result: this._remote(guarded.return, { group: objectGroup, generatePreview, returnByValue }),
      };
    }
    let completion = global.executeInGlobalWithBindings(expression, bindings, {
      url: "",
    });
    completion = await this._settle(completion, awaitPromise);
    if (!completion) {
      throw new ProtocolError("Execution was terminated");
    }
    if ("throw" in completion) {
      return {
        result: this._remote(completion.throw, { group: objectGroup, generatePreview }),
        exceptionDetails: this._exceptionDetails(completion, context),
      };
    }
    if (objectGroup === "console" && !silent) {
      this.lastResult = completion.return;
    }
    return {
      result: this._remote(completion.return, {
        group: objectGroup,
        generatePreview,
        returnByValue,
      }),
    };
  }

  async callFunctionOn({
    functionDeclaration,
    objectId,
    arguments: args = [],
    returnByValue = false,
    generatePreview = false,
    awaitPromise = false,
    executionContextId,
    objectGroup,
    uniqueContextId,
  }) {
    let context;
    let thisValue;
    if (objectId) {
      thisValue = this._object(objectId);
      const win =
        typeof thisValue === "object" && thisValue?.unsafeDereference
          ? Cu.getGlobalForObject(thisValue.unsafeDereference())
          : null;
      context = (win && this._contextForWindow(win)) || this._defaultContext();
      objectGroup ??= [...this.objects.groups].find(([, ids]) => ids.has(objectId))?.[0];
    } else if (uniqueContextId) {
      context = [...this.contexts.values()].find(entry => entry.uniqueId === uniqueContextId);
    } else {
      context = executionContextId ? this._contextById(executionContextId) : this._defaultContext();
    }
    if (!context) {
      throw new ProtocolError("Either ObjectId or executionContextId or uniqueContextId must be specified");
    }
    const global = this._debuggee(context.window);
    const fn = global.executeInGlobal(`(${functionDeclaration})`, { url: "" });
    if (!fn || "throw" in fn) {
      return {
        result: this._remote(fn?.throw, { group: objectGroup }),
        exceptionDetails: this._exceptionDetails(fn ?? { throw: undefined }, context),
      };
    }
    const argValues = args.map(arg => {
      if ("objectId" in arg) {
        return this._object(arg.objectId);
      }
      if ("unserializableValue" in arg) {
        return global.executeInGlobal(arg.unserializableValue).return;
      }
      if (arg.value !== null && typeof arg.value === "object") {
        return global.makeDebuggeeValue(Cu.cloneInto(arg.value, context.window));
      }
      return arg.value;
    });
    let completion = fn.return.apply(thisValue ?? global, argValues);
    completion = await this._settle(completion, awaitPromise);
    if (!completion) {
      throw new ProtocolError("Execution was terminated");
    }
    if ("throw" in completion) {
      return {
        result: this._remote(completion.throw, { group: objectGroup }),
        exceptionDetails: this._exceptionDetails(completion, context),
      };
    }
    return {
      result: this._remote(completion.return, {
        group: objectGroup,
        generatePreview,
        returnByValue,
      }),
    };
  }

  getProperties({
    objectId,
    ownProperties = false,
    accessorPropertiesOnly = false,
    generatePreview = false,
    nonIndexedPropertiesOnly = false,
  }) {
    const object = this._object(objectId);
    // Objects that are not page objects (Debugger's scope objects) list
    // their own properties.
    if (typeof object?._cdpGetProperties === "function") {
      const group = [...this.objects.groups].find(([, ids]) => ids.has(objectId))?.[0];
      return object._cdpGetProperties({ ownProperties, accessorPropertiesOnly, generatePreview, group });
    }
    if (typeof object !== "object") {
      return { result: [] };
    }
    const group = [...this.objects.groups].find(([, ids]) => ids.has(objectId))?.[0];
    const result = [];
    const internalProperties = [];
    const describeOwn = (target, isOwn) => {
      for (const name of target.getOwnPropertyNames()) {
        if (nonIndexedPropertiesOnly && /^\d+$/.test(name)) {
          continue;
        }
        const descriptor = target.getOwnPropertyDescriptor(name);
        if (!descriptor) {
          continue;
        }
        const isAccessor = "get" in descriptor || "set" in descriptor;
        if (accessorPropertiesOnly && !isAccessor) {
          continue;
        }
        const property = {
          name,
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          isOwn,
        };
        if (isAccessor) {
          if (descriptor.get) {
            property.get = this._remote(descriptor.get, { group });
          } else {
            property.get = { type: "undefined" };
          }
          if (descriptor.set) {
            property.set = this._remote(descriptor.set, { group });
          } else {
            property.set = { type: "undefined" };
          }
        } else {
          property.value = this._remote(descriptor.value, { group, generatePreview });
          property.writable = descriptor.writable;
        }
        result.push(property);
      }
      for (const symbol of target.getOwnPropertySymbols()) {
        const descriptor = target.getOwnPropertyDescriptor(symbol);
        if (!descriptor) {
          continue;
        }
        result.push({
          name: symbol.toString(),
          symbol: this._remote(symbol, { group }),
          value: "value" in descriptor ? this._remote(descriptor.value, { group, generatePreview }) : undefined,
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          writable: descriptor.writable,
          isOwn,
        });
      }
    };
    describeOwn(object, true);
    if (!ownProperties) {
      // V8 walks the prototype chain for accessors only.
      for (let proto = object.proto; proto; proto = proto.proto) {
        const before = result.length;
        describeOwn(proto, false);
        for (let i = result.length - 1; i >= before; i--) {
          if (!result[i].get && !result[i].set) {
            result.splice(i, 1);
          }
        }
      }
    }
    if (!accessorPropertiesOnly) {
      if (object.proto) {
        internalProperties.push({
          name: "[[Prototype]]",
          value: this._remote(object.proto, { group }),
        });
      }
      if (object.class === "Promise") {
        internalProperties.push({
          name: "[[PromiseState]]",
          value: { type: "string", value: object.promiseState },
        });
        if (object.promiseState !== "pending") {
          internalProperties.push({
            name: "[[PromiseResult]]",
            value: this._remote(
              object.promiseState === "fulfilled" ? object.promiseValue : object.promiseReason,
              { group }
            ),
          });
        }
      }
      if (object.callable && object.script) {
        const debuggerDomain = this.session.domain("Debugger");
        internalProperties.push({
          name: "[[FunctionLocation]]",
          value: {
            type: "object",
            subtype: "internal#location",
            value: {
              scriptId: debuggerDomain._scriptIdOf(object.script) ?? "",
              lineNumber: object.script.startLine - 1,
              columnNumber: object.script.startColumn - 1,
            },
            description: "Object",
          },
        });
      }
      if (object.isBoundFunction) {
        internalProperties.push({
          name: "[[TargetFunction]]",
          value: this._remote(object.boundTargetFunction, { group }),
        });
      }
    }
    return {
      result,
      ...(internalProperties.length ? { internalProperties } : {}),
    };
  }

  releaseObject({ objectId }) {
    this.objects.release(objectId);
  }

  releaseObjectGroup({ objectGroup }) {
    this.objects.releaseGroup(objectGroup);
  }

  runIfWaitingForDebugger() {}

  getIsolateId() {
    return { id: this.objects.prefix };
  }

  addBinding({ name, executionContextId, executionContextName }) {
    // A function on the page's global that reports calls back as
    // Runtime.bindingCalled (the front-end uses one for its own helpers).
    // Without an executionContextId, Chromium also adds it to every context
    // created later (a navigation, a new frame), before the document's own
    // scripts run, until removeBinding.
    if (!executionContextId) {
      this.bindings ??= new Map();
      this.bindings.set(name, executionContextName ?? null);
      this._startObserving();
    }
    for (const context of this.contexts.values()) {
      if (
        (!executionContextId || context.id === executionContextId) &&
        (!executionContextName || context.name === executionContextName)
      ) {
        this._installBinding(name, context);
      }
    }
  }

  _installBinding(name, context) {
    const win = context.window;
    const fn = Cu.exportFunction(
      payload =>
        this.session.emit("Runtime.bindingCalled", {
          name,
          payload: String(payload),
          executionContextId: context.id,
        }),
      win,
      { allowCrossOriginArguments: true }
    );
    Cu.waiveXrays(win)[name] = fn;
  }

  // The bindings added for every context, into a context just created.
  _installBindings(context) {
    for (const [name, contextName] of this.bindings ?? []) {
      if (!contextName || context.name === contextName) {
        this._installBinding(name, context);
      }
    }
  }

  removeBinding({ name }) {
    this.bindings?.delete(name);
    if (!this.enabled && !this.bindings?.size) {
      this._stopObserving();
    }
  }

  compileScript({ expression, sourceURL = "", persistScript, executionContextId }) {
    const context = executionContextId ? this._contextById(executionContextId) : this._defaultContext();
    const global = this._debuggee(context.window);
    // Compiling without running: wrap the source in a function body, which
    // reports the same syntax errors.
    const completion = global.executeInGlobal(
      `(function(){${expression}\n})`,
      { url: sourceURL }
    );
    if (completion && "throw" in completion) {
      return { exceptionDetails: this._exceptionDetails(completion, context) };
    }
    return persistScript ? { scriptId: "" } : {};
  }

  globalLexicalScopeNames({ executionContextId } = {}) {
    const context = executionContextId ? this._contextById(executionContextId) : this._defaultContext();
    return { names: this.session.domain("Debugger")._globalLexicalNames(context.window) };
  }

  discardConsoleEntries() {}

  setAsyncCallStackDepth() {}

  setCustomObjectFormatterEnabled() {}

  setMaxCallStackSizeToCapture() {}

  _destroy() {
    this._stopObserving();
    this.dbg.removeAllDebuggees();
    this.objects.clear();
  }
}

export { describeNode };
