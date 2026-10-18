/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Debugger domain. A CDP "script" is one compiled source: a script
// element's text, an external file, an eval. SpiderMonkey's Debugger.Source
// is the same unit; its process-wide id (the one SavedFrames and console
// stacks carry as sourceId) is the scriptId.
//
// FireDog is single-process: the page's JavaScript runs on the thread that
// serves this protocol. Pausing therefore spins a nested event loop inside
// the Debugger hook that stopped the page (as Firefox's ThreadActor does),
// with the page's event handling and timers suspended, so the client's
// messages keep being served until it resumes.
//
// Positions: SpiderMonkey's lines and columns are 1-based and, for inline
// scripts, already in the coordinates of the HTML document, which is what CDP
// uses 0-based.

import {
  InvalidParams,
  ProtocolError,
} from "resource:///modules/firedog/devtools/Session.sys.mjs";
import {
  SIDE_EFFECT_MESSAGE,
  evaluateWithoutSideEffects,
} from "resource:///modules/firedog/devtools/SideEffectFree.sys.mjs";

const xpcInspector = Cc["@mozilla.org/jsinspector;1"].getService(Ci.nsIJSInspector);

// Debugger.paused reasons, as V8 names them; other domains pass theirs
// (EventListener, XHR, instrumentation) through.
const REASON = {
  breakpoint: "other",
  debuggerStatement: "other",
  pause: "other",
  step: "step",
  exception: "exception",
};

const PAUSE_ON_EXCEPTIONS = new Set(["none", "caught", "uncaught", "all"]);

function hashOf(text) {
  // Chromium sends a SHA-256 of the source so the front-end can match edited
  // files.
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
  hash.init(Ci.nsICryptoHash.SHA256);
  const data = new TextEncoder().encode(text);
  hash.update(data, data.length);
  return [...hash.finish(false)].map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

// Gecko's names for async boundaries ("setTimeout handler", "promise
// callback") as V8 describes them.
export function asyncDescription(cause) {
  if (!cause) {
    return "";
  }
  if (cause === "promise callback") {
    return "Promise.then";
  }
  if (cause === "async") {
    return "await";
  }
  return cause.replace(/ handler$/, "");
}

function compare(a, b) {
  return a.lineNumber - b.lineNumber || a.columnNumber - b.columnNumber;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Scripts compiled by Debugger.Source.reparse() only to list breakpoint
// positions. They share their source with the page's code but never run, so
// they are left out wherever the page's scripts are looked for.
export const reparsedScripts = new WeakSet();

// One script as the client knows it.
class ScriptInfo {
  constructor(source, id, global) {
    this.source = source;
    this.id = id;
    this.global = global;
    this.announced = false;
    this._lineStarts = null;
    this._positions = null;
  }

  get text() {
    try {
      return this.source.text ?? "";
    } catch {
      return "";
    }
  }

  // The URL the client sees: a //# sourceURL wins, eval'd code has none, and
  // inline scripts and event handler attributes carry their document's.
  get url() {
    const { source } = this;
    if (source.displayURL) {
      return source.displayURL;
    }
    switch (source.introductionType) {
      case "eval":
      case "debugger eval":
      case "Function":
      case "GeneratorFunction":
      case "AsyncFunction":
      case "AsyncGenerator":
      case "domTimer":
      case "javascriptURL":
      // Gecko compiles an event handler attribute as a whole function
      // ("function onclick(event) {...}"), text the document does not have,
      // so it can't be shown as part of it.
      case "eventHandler":
        return "";
    }
    return source.url ?? "";
  }

  get startLine() {
    return Math.max(0, (this.source.startLine ?? 1) - 1);
  }

  get startColumn() {
    return Math.max(0, (this.source.startColumn ?? 1) - 1);
  }

  get lineStarts() {
    if (!this._lineStarts) {
      const starts = [0];
      const text = this.text;
      for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
        starts.push(i + 1);
      }
      this._lineStarts = starts;
    }
    return this._lineStarts;
  }

  get endLine() {
    return this.startLine + this.lineStarts.length - 1;
  }

  get endColumn() {
    const starts = this.lineStarts;
    const last = this.text.length - starts.at(-1);
    return starts.length > 1 ? last : this.startColumn + last;
  }

  // A character offset into the source text, as a CDP location.
  positionOf(offset) {
    const starts = this.lineStarts;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return {
      scriptId: this.id,
      lineNumber: this.startLine + low,
      columnNumber: (low === 0 ? this.startColumn : 0) + offset - starts[low],
    };
  }

  contains(lineNumber) {
    return lineNumber >= this.startLine && lineNumber <= this.endLine;
  }

  // Every breakpoint position of the source, sorted, as CDP locations. The
  // top-level script of an inline or external script is usually collected
  // once it ran, so like Firefox's SourceActor this reparses the text to see
  // all of them (reparsing compiles, it does not run).
  positions(dbg) {
    if (this._positions) {
      return this._positions;
    }
    let scripts = null;
    let complete = false;
    for (const asModule of [false, true]) {
      try {
        scripts = [this.source.reparse(asModule)];
        complete = true;
        break;
      } catch {
        // Not valid as a classic script (a module) or not reparseable.
      }
    }
    if (!complete) {
      scripts = dbg.findScripts({ source: this.source });
    }
    const seen = new Set();
    const positions = [];
    const visit = script => {
      if (seen.has(script)) {
        return;
      }
      seen.add(script);
      if (complete) {
        reparsedScripts.add(script);
      }
      for (const { lineNumber, columnNumber } of script.getPossibleBreakpoints()) {
        positions.push({ scriptId: this.id, lineNumber: lineNumber - 1, columnNumber: columnNumber - 1 });
      }
      if (complete) {
        for (const child of script.getChildScripts()) {
          visit(child);
        }
      }
    };
    scripts.forEach(visit);
    positions.sort(compare);
    const unique = positions.filter((p, i) => i === 0 || compare(p, positions[i - 1]) !== 0);
    if (complete) {
      this._positions = unique;
    }
    return unique;
  }
}

// The variables of declarative environments (several merged, as V8 merges a
// function's parameters and its body's lexical declarations into one Local
// scope), handed out as a scope object. Runtime.getProperties asks it for
// its properties through _cdpGetProperties.
export class ScopeObject {
  constructor(runtime, environments) {
    this.runtime = runtime;
    this.environments = environments;
  }

  get class() {
    return "Object";
  }

  _names() {
    const names = [];
    const seen = new Set();
    for (const env of this.environments) {
      for (const name of env.names()) {
        // SpiderMonkey's internal bindings (.this, .generator, ...) are not
        // variables. V8 does not list `arguments` either.
        if (!name.startsWith(".") && name !== "arguments" && !seen.has(name)) {
          seen.add(name);
          names.push({ name, env });
        }
      }
    }
    return names;
  }

  get isEmpty() {
    return this._names().length === 0;
  }

  find(name) {
    return this._names().find(entry => entry.name === name)?.env ?? null;
  }

  _cdpGetProperties({ accessorPropertiesOnly, generatePreview, group }) {
    if (accessorPropertiesOnly) {
      return { result: [] };
    }
    const result = [];
    for (const { name, env } of this._names()) {
      let value;
      try {
        value = env.getVariable(name);
      } catch {
        // A with-environment's accessor would run page code.
        value = { optimizedOut: true };
      }
      const property = { name, configurable: true, enumerable: true, isOwn: true };
      if (value && typeof value === "object" && (value.optimizedOut || value.uninitialized)) {
        // V8 lists bindings it can't read, or still in their temporal dead
        // zone, without a value; the front-end shows <value unavailable>.
        result.push(property);
        continue;
      }
      if (value && typeof value === "object" && value.missingArgument) {
        value = undefined;
      }
      property.value = this.runtime._remote(value, { group, generatePreview });
      property.writable = true;
      result.push(property);
    }
    return { result };
  }
}

export class Debugger {
  constructor(session) {
    this.session = session;
    this.enabled = false;
    // scriptId -> ScriptInfo; announced ones by URL.
    this.scripts = new Map();
    this.byUrl = new Map();
    this.breakpoints = new Map();
    // "scriptId:line:column" -> { location, ids, handler, installed }.
    this.locations = new Map();
    this.active = true;
    this.skipAllPauses = false;
    this.pauseOnExceptions = "none";
    this.asyncCallStackDepth = 0;
    this.blackboxPatterns = [];
    this.blackboxAnonymous = false;
    this.blackboxedRanges = new Map();
    this.blackboxedContexts = new Set();
    this.paused = null;
    this.pauseCount = 0;
    this.priorPause = null;
    this.evaluating = 0;
    this.handledExceptions = new WeakMap();
    this.steppingFrames = new Set();
    this.enterFrameHooks = new Map();
    this.instrumentation = new Map();
    this.instrumented = new WeakSet();
    this.restartedFrames = new WeakSet();
  }

  get _runtime() {
    return this.session.domain("Runtime");
  }

  get dbg() {
    return this._runtime.dbg;
  }

  // Ids for Runtime: stacks name a source by its process-wide id, which is
  // the scriptId; a URL (and line, for a document's inline scripts) is the
  // fallback for stacks without one.
  _scriptIdOf(script) {
    return script?.source ? this._register(script.source, script.global).id : null;
  }

  _scriptIdForUrl(url, lineNumber, sourceId) {
    if (sourceId) {
      return String(sourceId);
    }
    if (!url) {
      return null;
    }
    const candidates = this.byUrl.get(url) ?? [];
    const line = typeof lineNumber === "number" ? lineNumber - 1 : null;
    // After a reload the URL names the new document's scripts, the latest.
    const match = candidates.findLast(info => line === null || info.contains(line)) ?? candidates.at(-1);
    return match?.id ?? null;
  }

  _register(source, global = null) {
    const id = String(source.id);
    let info = this.scripts.get(id);
    if (!info) {
      info = new ScriptInfo(source, id, global);
      this.scripts.set(id, info);
    }
    if (!info.global && global) {
      info.global = global;
    }
    return info;
  }

  _info(scriptId) {
    const info = this.scripts.get(String(scriptId));
    if (!info) {
      throw new ProtocolError("No script for id: " + scriptId);
    }
    return info;
  }

  _contextOfGlobal(global) {
    let win;
    try {
      win = global?.unsafeDereference?.();
      if (!win || Cu.isDeadWrapper(win) || win.browsingContext?.top !== this.session.target.browsingContext) {
        return null;
      }
    } catch {
      // A sandbox or another global this Debugger happens to see.
      return null;
    }
    return this._runtime._contextForWindow(win);
  }

  _announce(info) {
    if (!this.enabled || info.announced || info.source.introductionType === "self-hosted") {
      return;
    }
    if (!info.global) {
      info.global = this._globalOfSource(info.source);
    }
    const context = this._contextOfGlobal(info.global);
    if (!context) {
      return;
    }
    info.announced = true;
    const text = info.text;
    const url = info.url;
    if (url) {
      let list = this.byUrl.get(url);
      if (!list) {
        list = [];
        this.byUrl.set(url, list);
      }
      list.push(info);
    }
    this.session.emit("Debugger.scriptParsed", {
      scriptId: info.id,
      url,
      startLine: info.startLine,
      startColumn: info.startColumn,
      endLine: info.endLine,
      endColumn: info.endColumn,
      executionContextId: context.id,
      hash: hashOf(text),
      buildId: "",
      executionContextAuxData: {
        isDefault: true,
        type: "default",
        frameId: context.frameId,
      },
      isLiveEdit: false,
      sourceMapURL: info.source.sourceMapURL ?? "",
      hasSourceURL: !!info.source.displayURL,
      isModule: info.source.introductionType === "importedModule",
      length: text.length,
      scriptLanguage: "JavaScript",
      embedderName: url,
    });
  }

  _globalOfSource(source) {
    for (const script of this.dbg.findScripts({ source })) {
      if (script.global) {
        return script.global;
      }
    }
    return null;
  }

  _onNewScript(script) {
    if (this.reparsing) {
      return;
    }
    const info = this._register(script.source, script.global);
    const known = info.announced;
    this._announce(info);
    // Breakpoints by URL resolve in scripts that load after them, and
    // locations already set in this source apply to its new code.
    for (const breakpoint of this.breakpoints.values()) {
      if (breakpoint.matches && !breakpoint.resolved.has(info.id) && info.announced && breakpoint.matches(info)) {
        breakpoint.resolved.add(info.id);
        const location = this._resolve(info, breakpoint.lineNumber, breakpoint.columnNumber);
        if (location) {
          this._addLocation(breakpoint, location);
          this.session.emit("Debugger.breakpointResolved", {
            breakpointId: breakpoint.id,
            location,
          });
        }
      }
    }
    if (known) {
      for (const entry of this.locations.values()) {
        if (entry.location.scriptId === info.id) {
          this._install(entry, [script]);
        }
      }
    }
    if (this.instrumentation.size) {
      this._instrumentScript(script);
    }
  }

  _positions(info) {
    // Reparsing compiles new scripts, which are not page code.
    this.reparsing = true;
    try {
      return info.positions(this.dbg);
    } finally {
      this.reparsing = false;
    }
  }

  // The first breakpoint position at or after the line and column, within
  // the script, as V8 resolves breakpoints.
  _resolve(info, lineNumber, columnNumber = 0) {
    if (!info.contains(lineNumber)) {
      return null;
    }
    const wanted = { lineNumber, columnNumber };
    return this._positions(info).find(position => compare(position, wanted) >= 0) ?? null;
  }

  // FireDog's engine runs a function in its portable baseline interpreter
  // once it has run often enough, and that interpreter, as built for WASI,
  // has no per-instruction debug checks: breakpoints and single steps in
  // such a function are never reached (frame entry and exit hooks still
  // are). Discarding the engine's JIT data sends functions back to the
  // bytecode interpreter, which checks every instruction, until they warm
  // up again; frames already on the stack keep their interpreter. So it is
  // done when the client sets a breakpoint or steps.
  _dropWarmCode() {
    const now = ChromeUtils.now();
    if (now - (this.droppedWarmCodeAt ?? -Infinity) < 50) {
      return;
    }
    Cu.forceShrinkingGC();
    this.droppedWarmCodeAt = ChromeUtils.now();
  }

  _locationKey(location) {
    return `${location.scriptId}:${location.lineNumber}:${location.columnNumber}`;
  }

  _addLocation(breakpoint, location) {
    const key = this._locationKey(location);
    let entry = this.locations.get(key);
    if (!entry) {
      entry = {
        location,
        ids: new Set(),
        installed: new Set(),
        handler: { hit: frame => this._onBreakpoint(entry, frame) },
      };
      this.locations.set(key, entry);
      const info = this.scripts.get(location.scriptId);
      if (info) {
        this._dropWarmCode();
        this._install(entry, this.dbg.findScripts({ source: info.source, line: location.lineNumber + 1 }));
      }
    }
    entry.ids.add(breakpoint.id);
    breakpoint.locations.push(location);
  }

  // Sets the location's handler on the scripts (and their nested functions)
  // that have code at it.
  _install(entry, scripts) {
    const line = entry.location.lineNumber + 1;
    const column = entry.location.columnNumber + 1;
    const visit = script => {
      if (entry.installed.has(script) || reparsedScripts.has(script)) {
        return;
      }
      let lineCount;
      try {
        lineCount = script.lineCount;
      } catch {
        return;
      }
      if (script.startLine > line || script.startLine + lineCount <= line) {
        return;
      }
      entry.installed.add(script);
      for (const { offset } of script.getPossibleBreakpoints({ line, minColumn: column, maxColumn: column + 1 })) {
        script.setBreakpoint(offset, entry.handler);
      }
      for (const child of script.getChildScripts()) {
        visit(child);
      }
    };
    scripts.forEach(visit);
  }

  _removeLocation(breakpoint, location) {
    const key = this._locationKey(location);
    const entry = this.locations.get(key);
    if (!entry) {
      return;
    }
    entry.ids.delete(breakpoint.id);
    if (!entry.ids.size) {
      for (const script of entry.installed) {
        try {
          script.clearBreakpoint(entry.handler);
        } catch {
          // A script that was collected.
        }
      }
      this.locations.delete(key);
    }
  }

  _onBreakpoint(entry, frame) {
    if (this.skipAllPauses || this.paused || this.evaluating) {
      return undefined;
    }
    if (!this._hasMoved(frame, "breakpoint")) {
      return undefined;
    }
    const hit = [];
    let continued = false;
    for (const id of [...entry.ids]) {
      const breakpoint = this.breakpoints.get(id);
      if (!breakpoint) {
        continue;
      }
      if (breakpoint.oneShot) {
        // continueToLocation's target: a pause without a breakpoint id.
        this._removeBreakpoint(id);
        continued = true;
        continue;
      }
      if (!this.active || (breakpoint.condition && !this._conditionHolds(frame, breakpoint.condition))) {
        continue;
      }
      hit.push(id);
    }
    if (!hit.length && !continued) {
      return undefined;
    }
    return this._pause(frame, "breakpoint", { hitBreakpoints: hit });
  }

  _conditionHolds(frame, condition) {
    this.evaluating++;
    try {
      const completion = frame.eval(condition, { hideFromDebugger: true });
      // A condition that throws pauses, as in V8.
      return !completion || "throw" in completion || !!completion.return;
    } finally {
      this.evaluating--;
    }
  }

  // Whether the frame is somewhere else than where the last pause was, so
  // that a breakpoint or debugger statement at a location just stepped to
  // does not pause a second time (Firefox's ThreadActor.hasMoved).
  _hasMoved(frame, kind) {
    const prior = this.priorPause;
    if (!prior || (prior.kind === kind && kind !== "step")) {
      return true;
    }
    const location = this._locationOf(frame);
    return (
      prior.scriptId !== location.scriptId ||
      prior.lineNumber !== location.lineNumber ||
      prior.columnNumber !== location.columnNumber
    );
  }

  _locationOf(frame, offset = frame.offset) {
    const script = frame.script;
    const meta = script.getOffsetMetadata(offset);
    return {
      scriptId: this._scriptIdOf(script),
      lineNumber: meta.lineNumber - 1,
      columnNumber: meta.columnNumber - 1,
    };
  }

  _isBlackboxed(frame) {
    if (!frame?.script) {
      return false;
    }
    const scriptId = this._scriptIdOf(frame.script);
    const url = this.scripts.get(scriptId)?.url ?? "";
    if (this.blackboxAnonymous && !url) {
      return true;
    }
    if (url && this.blackboxPatterns.some(pattern => pattern.test(url))) {
      return true;
    }
    if (this.blackboxedContexts.size) {
      const context = this._contextOfGlobal(frame.script.global);
      if (context && this.blackboxedContexts.has(context.uniqueId)) {
        return true;
      }
    }
    const ranges = this.blackboxedRanges.get(scriptId);
    if (ranges) {
      const location = this._locationOf(frame);
      // The positions toggle the state, starting outside a range.
      let inside = false;
      for (const position of ranges) {
        if (compare(position, location) > 0) {
          break;
        }
        inside = !inside;
      }
      return inside;
    }
    return false;
  }

  _onDebuggerStatement(frame) {
    if (!this.active || this.skipAllPauses || this.paused || this.evaluating) {
      return undefined;
    }
    if (!this._hasMoved(frame, "debuggerStatement") || this._isBlackboxed(frame)) {
      return undefined;
    }
    // A breakpoint at the same place pauses instead, with its id.
    if (this.locations.has(this._locationKey(this._locationOf(frame)))) {
      return undefined;
    }
    return this._pause(frame, "debuggerStatement");
  }

  _onExceptionUnwind(frame, value) {
    if (this.pauseOnExceptions === "none" || this.skipAllPauses || this.paused || this.evaluating) {
      return undefined;
    }
    // The hook runs again for each frame the exception unwinds through.
    if (this.handledExceptions.has(frame) && this.handledExceptions.get(frame) === value) {
      return undefined;
    }
    for (let older = frame.older; older; older = older.older) {
      this.handledExceptions.set(older, value);
    }
    let caught = false;
    for (let current = frame; current; current = current.older) {
      try {
        if (current.script?.isInCatchScope(current.offset)) {
          caught = true;
          break;
        }
      } catch {
        // A frame without bytecode offsets.
      }
    }
    if (
      (caught && this.pauseOnExceptions === "uncaught") ||
      (!caught && this.pauseOnExceptions === "caught") ||
      this._isBlackboxed(frame)
    ) {
      return undefined;
    }
    return this._pause(frame, "exception", { exception: value, uncaught: !caught });
  }

  _setHooks() {
    const dbg = this.dbg;
    dbg.onNewScript = script => this._onNewScript(script);
    dbg.onDebuggerStatement = frame => this._onDebuggerStatement(frame);
    dbg.onExceptionUnwind =
      this.pauseOnExceptions === "none" ? undefined : (frame, value) => this._onExceptionUnwind(frame, value);
    this._updateEnterFrame();
  }

  // onEnterFrame costs every call, so it is set only while something waits
  // for the next frame: Debugger.pause, a step into, an event breakpoint.
  _updateEnterFrame() {
    this.dbg.onEnterFrame = this.enterFrameHooks.size
      ? frame => {
          for (const hook of [...this.enterFrameHooks.values()]) {
            const resumption = hook(frame);
            if (resumption !== undefined) {
              return resumption;
            }
          }
          return undefined;
        }
      : undefined;
  }

  _setEnterFrameHook(key, hook) {
    if (hook) {
      this.enterFrameHooks.set(key, hook);
    } else if (this.enterFrameHooks.has(key)) {
      this.enterFrameHooks.delete(key);
    } else {
      return;
    }
    this._updateEnterFrame();
  }

  _scopeChain(frame, group) {
    const runtime = this._runtime;
    const scopes = [];
    let env;
    try {
      env = frame.environment;
    } catch {
      env = null;
    }
    const info = this.scripts.get(this._scriptIdOf(frame.script));
    const range = script => {
      try {
        return {
          startLocation: info.positionOf(script.sourceStart),
          endLocation: info.positionOf(script.sourceStart + script.sourceLength),
        };
      } catch {
        return {};
      }
    };
    const handle = object => ({
      type: "object",
      className: "Object",
      description: "Object",
      objectId: runtime.objects.add(object, group),
    });
    let localFound = false;
    let carried = [];
    const flushCarried = () => {
      for (const pending of carried) {
        const object = new ScopeObject(runtime, [pending]);
        if (!object.isEmpty) {
          scopes.push({ type: "block", object: handle(object) });
        }
      }
      carried = [];
    };
    for (; env; env = env.parent) {
      if (env.type === "object" || env.type === "with") {
        flushCarried();
        let object;
        try {
          object = env.object;
        } catch {
          continue;
        }
        scopes.push({ type: env.parent ? "with" : "global", object: runtime._remote(object, { group }) });
        continue;
      }
      if (env.calleeScript) {
        const object = new ScopeObject(runtime, [...carried, env]);
        carried = [];
        const isLocal = !localFound && env.calleeScript === frame.script;
        if (isLocal) {
          localFound = true;
        } else if (object.isEmpty) {
          continue;
        }
        const name = env.calleeScript.displayName ?? "";
        scopes.push({
          type: isLocal ? "local" : "closure",
          object: handle(object),
          ...(name ? { name } : {}),
          ...(info && env.calleeScript.source === info.source ? range(env.calleeScript) : {}),
        });
        continue;
      }
      if (env.scopeKind === "function lexical") {
        carried.push(env);
        continue;
      }
      flushCarried();
      const object = new ScopeObject(runtime, [env]);
      if (env.parent?.type === "object" && !env.parent.parent) {
        // The global lexical environment: top-level let, const and class.
        scopes.push({ type: "script", object: handle(object) });
      } else if (env.scopeKind === "module") {
        scopes.push({ type: "module", object: handle(object) });
      } else if (!object.isEmpty) {
        scopes.push({ type: env.scopeKind === "catch" ? "catch" : "block", object: handle(object) });
      }
    }
    return scopes;
  }

  _callFrame(frame, index, group, completion) {
    const runtime = this._runtime;
    const script = frame.script;
    const scriptId = this._scriptIdOf(script);
    const info = this.scripts.get(scriptId);
    let functionLocation = { scriptId, lineNumber: script.startLine - 1, columnNumber: script.startColumn - 1 };
    if (info && script.isFunction) {
      try {
        functionLocation = info.positionOf(script.sourceStart);
      } catch {
        // Keep the script's start.
      }
    }
    let thisValue;
    try {
      thisValue = runtime._remote(frame.this, { group });
    } catch {
      thisValue = { type: "undefined" };
    }
    const callee = frame.callee;
    const result = {
      callFrameId: `${runtime.objects.prefix}.${this.pauseCount}.${index}`,
      functionName: callee ? callee.displayName ?? callee.name ?? "" : "",
      functionLocation,
      location: this._locationOf(frame),
      url: "",
      scopeChain: this._scopeChain(frame, group),
      this: thisValue,
      canBeRestarted: frame.type === "call" && !script.isGeneratorFunction && !script.isAsyncFunction,
    };
    if (completion && "return" in completion) {
      result.returnValue = runtime._remote(completion.return, { group });
    }
    return result;
  }

  // A CDP StackTrace from a SavedFrame chain, split where it crosses an
  // async boundary (asyncCause names the operation, as V8's description
  // does). Runtime uses it for console and exception stacks.
  _stackTraceOfSaved(saved, description = undefined, depth = 32) {
    if (!saved) {
      return undefined;
    }
    const callFrames = [];
    let next = null;
    for (let current = saved; current; ) {
      // Frames of FireDog's own code (this server calling the page for a
      // console evaluation) are not the page's.
      if (/^(resource|chrome):/.test(current.source)) {
        if (current.parent) {
          current = current.parent;
          continue;
        }
        next = current.asyncParent;
        break;
      }
      callFrames.push({
        functionName: current.functionDisplayName ?? "",
        scriptId: this._scriptIdForUrl(current.source, current.line, current.sourceId) ?? "",
        url: current.source ?? "",
        lineNumber: Math.max(0, current.line - 1),
        columnNumber: Math.max(0, current.column - 1),
      });
      if (current.parent) {
        current = current.parent;
      } else {
        next = current.asyncParent;
        break;
      }
    }
    const parent =
      next && depth > 1 && this.asyncCallStackDepth > 0
        ? this._stackTraceOfSaved(next, asyncDescription(next.asyncCause), depth - 1)
        : undefined;
    if (!callFrames.length && description !== undefined) {
      return parent;
    }
    const trace = { callFrames };
    if (description !== undefined) {
      trace.description = description;
    }
    if (parent) {
      trace.parent = parent;
    }
    return trace;
  }

  _pause(frame, kind, { hitBreakpoints = [], exception, uncaught, completion, data } = {}) {
    if (this.paused || this.evaluating || this.skipAllPauses || this.session.closed || !this.enabled) {
      return undefined;
    }
    this._clearStepping();
    const runtime = this._runtime;
    const frames = [];
    for (let current = frame; current; current = current.older) {
      // A restarted frame stays on the stack under its new call (see
      // restartFrame); V8's restart replaces it.
      if (current.script && !this.restartedFrames.has(current)) {
        frames.push(current);
      }
    }
    if (!frames.length) {
      return undefined;
    }
    this.pauseCount++;
    const group = "backtrace";
    const state = {
      kind,
      frames,
      completion,
      resumption: undefined,
      requestor: { debuggerDomain: this },
    };
    this.paused = state;
    let params;
    try {
      params = {
        callFrames: frames.map((current, index) =>
          this._callFrame(current, index, group, index === 0 ? completion : undefined)
        ),
        reason: REASON[kind] ?? kind,
        hitBreakpoints,
      };
      if (kind === "exception") {
        params.data = { ...runtime._remote(exception, { group }), uncaught };
      } else if (data) {
        params.data = data;
      }
      if (this.asyncCallStackDepth > 0) {
        const saved = frames.at(-1).olderSavedFrame;
        if (saved) {
          params.asyncStackTrace = this._stackTraceOfSaved(saved, asyncDescription(saved.asyncCause));
        }
      }
    } catch (error) {
      console.error("FireDog DevTools: describing the pause", error);
      this.paused = null;
      return undefined;
    }
    this.session.emit("Debugger.paused", params);
    this._enterNestedLoop(state);
    this.paused = null;
    this.priorPause = { kind, ...params.callFrames[0].location };
    runtime.objects.releaseGroup(group);
    if (!this.session.closed) {
      this.session.emit("Debugger.resumed", {});
    }
    return state.resumption;
  }

  // Runs the event loop until the client resumes, with the page's event
  // handling and timers suspended, as Firefox's EventLoop.preEnter does.
  _enterNestedLoop(state) {
    const suspended = [];
    for (const win of this._runtime._windows()) {
      try {
        const { windowUtils, document } = win;
        suspended.push({ win, wasPaused: !!document?.pausedByDevTools });
        if (document) {
          document.pausedByDevTools = true;
        }
        windowUtils.suppressEventHandling(true);
        windowUtils.suspendTimeouts();
      } catch (error) {
        console.error("FireDog DevTools: suspending the page", error);
      }
    }
    try {
      xpcInspector.enterNestedEventLoop(state.requestor);
    } finally {
      for (const { win, wasPaused } of suspended) {
        try {
          if (win.closed || win.docShell?.isBeingDestroyed()) {
            continue;
          }
          const { windowUtils, document } = win;
          if (document) {
            document.pausedByDevTools = wasPaused;
          }
          windowUtils.resumeTimeouts();
          windowUtils.suppressEventHandling(false);
        } catch (error) {
          console.error("FireDog DevTools: resuming the page", error);
        }
      }
    }
  }

  _requirePaused() {
    if (!this.paused) {
      throw new ProtocolError("Can only perform operation while paused.");
    }
    return this.paused;
  }

  // Leaves the pause. The resumption value is what the Debugger hook that
  // paused returns: undefined continues, null terminates, { return } replaces
  // the frame's result.
  _resume(resumption) {
    const state = this._requirePaused();
    if (state.exited) {
      return;
    }
    state.exited = true;
    state.resumption =
      resumption === undefined && state.returnOverride ? { return: state.returnOverride.value } : resumption;
    // Pausing again while paused is refused, so this pause's loop is the
    // innermost one.
    if (xpcInspector.lastNestRequestor === state.requestor) {
      xpcInspector.exitNestedEventLoop();
    }
  }

  // Stepping, as Firefox's ThreadActor steps: onStep/onPop hooks on the
  // frame, and onEnterFrame for stepping into calls. A step pauses on the
  // next step position (isStepStart) after moving; leaving a function pauses
  // once at its end with the return value, then in the caller.

  _clearStepping() {
    for (const frame of this.steppingFrames) {
      try {
        frame.onStep = undefined;
        frame.onPop = undefined;
      } catch {
        // A frame that finished.
      }
    }
    this.steppingFrames.clear();
    this._setEnterFrameHook("step", null);
  }

  _validStepOffset(frame, startFrame) {
    const meta = frame.script.getOffsetMetadata(frame.offset);
    if (!meta.isBreakpoint || this._isBlackboxed(frame) || !this._hasMoved(frame, "step")) {
      return false;
    }
    return frame !== startFrame || meta.isStepStart;
  }

  _steppingHooks(type, startFrame, completion, kind = "step", data = undefined) {
    const domain = this;
    const onStep = function () {
      if (domain._validStepOffset(this, startFrame)) {
        return domain._pause(this, kind, { data });
      }
      return undefined;
    };
    const onPop = function (popCompletion) {
      if (type !== "finish" && popCompletion && (popCompletion.await || popCompletion.yield)) {
        // Leaving an async function or generator for now; its hooks stay
        // and fire when it resumes.
        domain._setEnterFrameHook("step", null);
        return undefined;
      }
      this.reportedPop = true;
      if (type !== "finish" && !domain._isBlackboxed(this)) {
        return domain._pause(this, "step", { completion: popCompletion });
      }
      domain._attachStepping(this, "next", popCompletion);
      return undefined;
    };
    const onEnterFrame = frame => {
      if (!this._isBlackboxed(frame)) {
        this._hook(frame, onStep, onPop);
      }
      return undefined;
    };
    return { onStep, onPop, onEnterFrame };
  }

  _hook(frame, onStep, onPop) {
    if (onStep) {
      frame.onStep = onStep;
    }
    frame.onPop = onPop;
    this.steppingFrames.add(frame);
  }

  _attachStepping(frame, type, completion) {
    if (type === "finish" && frame.reportedPop) {
      type = "next";
    }
    let stepFrame = frame.reportedPop ? frame.older : frame;
    if (!stepFrame?.script) {
      stepFrame = null;
      type = "step";
    }
    const hooks = this._steppingHooks(type, frame, completion);
    if (type === "step") {
      this._setEnterFrameHook("step", hooks.onEnterFrame);
    }
    if (stepFrame) {
      const onStep = type !== "finish" && !this._isBlackboxed(stepFrame) ? hooks.onStep : undefined;
      this._hook(stepFrame, onStep, hooks.onPop);
    }
  }

  _step(type) {
    const state = this._requirePaused();
    const frame = state.frames[0];
    if (state.completion) {
      // Paused in onPop: the frame is leaving.
      frame.reportedPop = true;
    }
    this._attachStepping(frame, type, state.completion);
    this._dropWarmCode();
    this._resume(undefined);
  }

  _frameOf(callFrameId) {
    const state = this._requirePaused();
    const [, pause, index] = /\.(\d+)\.(\d+)$/.exec(callFrameId ?? "") ?? [];
    const frame = Number(pause) === this.pauseCount ? state.frames[Number(index)] : null;
    if (!frame) {
      throw new ProtocolError("Invalid call frame id");
    }
    return frame;
  }

  _contextOfFrame(frame) {
    return this._contextOfGlobal(frame.script?.global) ?? this._runtime._defaultContext();
  }

  _callArgument(frame, argument) {
    const runtime = this._runtime;
    const global = frame.script.global;
    if (!argument) {
      return undefined;
    }
    if ("objectId" in argument) {
      return runtime._object(argument.objectId);
    }
    if ("unserializableValue" in argument) {
      return global.executeInGlobal(argument.unserializableValue, { hideFromDebugger: true })?.return;
    }
    if (argument.value !== null && typeof argument.value === "object") {
      return global.makeDebuggeeValue(Cu.cloneInto(argument.value, global.unsafeDereference()));
    }
    return argument.value;
  }

  enable() {
    if (!this.enabled) {
      this.enabled = true;
      const runtime = this._runtime;
      // Contexts (and so debuggees) exist once Runtime knows the page's
      // globals.
      for (const win of runtime._windows()) {
        runtime._contextForWindow(win);
      }
      this._setHooks();
      const sources = this.dbg.findSources().sort((a, b) => a.id - b.id);
      for (const source of sources) {
        this._announce(this._register(source));
      }
    }
    return { debuggerId: `${this._runtime.objects.prefix}.${this.session.target.id}` };
  }

  disable() {
    if (!this.enabled) {
      return;
    }
    if (this.paused) {
      this._clearStepping();
      this._resume(undefined);
    }
    this.enabled = false;
    for (const id of [...this.breakpoints.keys()]) {
      this._removeBreakpoint(id);
    }
    this.enterFrameHooks.clear();
    this.instrumentation.clear();
    const dbg = this.dbg;
    dbg.onNewScript = undefined;
    dbg.onDebuggerStatement = undefined;
    dbg.onExceptionUnwind = undefined;
    dbg.onEnterFrame = undefined;
    this.pauseOnExceptions = "none";
    this.byUrl.clear();
    for (const info of this.scripts.values()) {
      info.announced = false;
    }
  }

  getScriptSource({ scriptId }) {
    return { scriptSource: this._info(scriptId).text };
  }

  searchInContent({ scriptId, query, caseSensitive = false, isRegex = false }) {
    const text = this._info(scriptId).text;
    let regex;
    try {
      regex = new RegExp(isRegex ? query : escapeRegExp(query), caseSensitive ? "" : "i");
    } catch {
      return { result: [] };
    }
    const result = [];
    text.split("\n").forEach((line, lineNumber) => {
      const content = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (regex.test(content)) {
        result.push({ lineNumber, lineContent: content });
      }
    });
    return { result };
  }

  setScriptSource() {
    // SpiderMonkey compiles a source once; it has no way to replace the code
    // of functions that already exist.
    throw new ProtocolError("Editing scripts is not supported by FireDog's JavaScript engine");
  }

  setBreakpointsActive({ active }) {
    this.active = !!active;
  }

  setSkipAllPauses({ skip }) {
    this.skipAllPauses = !!skip;
  }

  setBreakpointByUrl({ lineNumber, url, urlRegex, scriptHash, columnNumber, condition = "" }) {
    if (typeof lineNumber !== "number") {
      throw new InvalidParams("Invalid parameters\nFailed to deserialize params.lineNumber - BINDINGS: int32 value expected");
    }
    const column = columnNumber ?? 0;
    let id;
    let matches;
    if (url !== undefined) {
      id = `br:1:${lineNumber}:${column}:${url}`;
      matches = info => info.url === url;
    } else if (urlRegex !== undefined) {
      let regex;
      try {
        regex = new RegExp(urlRegex);
      } catch {
        throw new ProtocolError("Incorrect regex");
      }
      id = `br:2:${lineNumber}:${column}:${urlRegex}`;
      matches = info => regex.test(info.url);
    } else if (scriptHash !== undefined) {
      id = `br:3:${lineNumber}:${column}:${scriptHash}`;
      matches = info => hashOf(info.text) === scriptHash;
    } else {
      throw new ProtocolError("Either url or urlRegex or scriptHash must be specified.");
    }
    if (condition) {
      id += `:${condition}`;
    }
    if (this.breakpoints.has(id)) {
      throw new ProtocolError("Breakpoint at specified location already exists.");
    }
    const breakpoint = {
      id,
      matches,
      lineNumber,
      columnNumber: column,
      condition,
      locations: [],
      resolved: new Set(),
    };
    this.breakpoints.set(id, breakpoint);
    for (const info of this.scripts.values()) {
      if (!info.announced || !matches(info)) {
        continue;
      }
      breakpoint.resolved.add(info.id);
      const location = this._resolve(info, lineNumber, column);
      if (location) {
        this._addLocation(breakpoint, location);
      }
    }
    return { breakpointId: id, locations: [...breakpoint.locations] };
  }

  setBreakpoint({ location, condition = "" }) {
    const info = this._info(location?.scriptId);
    const resolved = this._resolve(info, location.lineNumber, location.columnNumber ?? 0);
    if (!resolved) {
      throw new ProtocolError("Could not resolve breakpoint");
    }
    const id = `${resolved.scriptId}:${resolved.lineNumber}:${resolved.columnNumber}${condition ? ":" + condition : ""}`;
    if (this.breakpoints.has(id)) {
      throw new ProtocolError("Breakpoint at specified location already exists.");
    }
    const breakpoint = { id, condition, locations: [], resolved: new Set([info.id]) };
    this.breakpoints.set(id, breakpoint);
    this._addLocation(breakpoint, resolved);
    return { breakpointId: id, actualLocation: resolved };
  }

  _removeBreakpoint(id) {
    const breakpoint = this.breakpoints.get(id);
    if (!breakpoint) {
      return;
    }
    this.breakpoints.delete(id);
    for (const location of breakpoint.locations) {
      this._removeLocation(breakpoint, location);
    }
  }

  removeBreakpoint({ breakpointId }) {
    this.instrumentation.delete(breakpointId);
    this._removeBreakpoint(breakpointId);
  }

  getPossibleBreakpoints({ start, end, restrictToFunction = false }) {
    const info = this._info(start?.scriptId);
    const from = { lineNumber: start.lineNumber, columnNumber: start.columnNumber ?? 0 };
    let locations = this._positions(info).filter(
      position => compare(position, from) >= 0 && (!end || compare(position, end) < 0)
    );
    if (restrictToFunction) {
      // Only the innermost function containing start, without the functions
      // nested in it.
      const containing = this.dbg
        .findScripts({ source: info.source, line: from.lineNumber + 1 })
        .filter(script => {
          const begin = info.positionOf(script.sourceStart);
          const finish = info.positionOf(script.sourceStart + script.sourceLength);
          return compare(begin, from) <= 0 && compare(from, finish) < 0;
        })
        .sort((a, b) => a.sourceLength - b.sourceLength)[0];
      if (containing) {
        const own = new Set(
          containing.getPossibleBreakpoints().map(p => `${p.lineNumber - 1}:${p.columnNumber - 1}`)
        );
        locations = locations.filter(p => own.has(`${p.lineNumber}:${p.columnNumber}`));
      }
    }
    return { locations };
  }

  continueToLocation({ location }) {
    this._requirePaused();
    const info = this._info(location?.scriptId);
    const resolved = this._resolve(info, location.lineNumber, location.columnNumber ?? 0);
    if (!resolved) {
      throw new ProtocolError("Cannot continue to specified location");
    }
    const id = `continueToLocation:${this.pauseCount}`;
    const breakpoint = { id, oneShot: true, locations: [], resolved: new Set([info.id]) };
    this.breakpoints.set(id, breakpoint);
    this._addLocation(breakpoint, resolved);
    this._clearStepping();
    this._resume(undefined);
  }

  pause() {
    if (this.paused) {
      return;
    }
    // The page runs no script while this message is handled (it is the
    // same thread), so the pause happens when script next runs, at its
    // first statement, as V8's scheduled pause does.
    this._dropWarmCode();
    this._pauseAtNextFrame("pause", "pause");
  }

  resume({ terminateOnResume = false } = {}) {
    this._requirePaused();
    this._clearStepping();
    this._setEnterFrameHook("pause", null);
    this._resume(terminateOnResume ? null : undefined);
  }

  stepInto() {
    this._step("step");
  }

  stepOver() {
    this._step("next");
  }

  stepOut() {
    this._step("finish");
  }

  restartFrame({ callFrameId, mode }) {
    const frame = this._frameOf(callFrameId);
    if (mode !== "StepInto") {
      throw new InvalidParams("Restarting frame is only supported with 'StepInto' mode");
    }
    if (frame.type !== "call" || frame.script.isGeneratorFunction || frame.script.isAsyncFunction) {
      throw new ProtocolError("Restarting frame failed");
    }
    // Resuming with termination unwinds every frame newer than this one;
    // this frame's onPop then replaces the termination with a new call of
    // the function with the same this and arguments, and the step-into hook
    // pauses at its first statement, as V8's restart does.
    this._clearStepping();
    const domain = this;
    this._hook(frame, undefined, function () {
      domain._clearStepping();
      domain.restartedFrames.add(this);
      domain._attachStepping(this, "step");
      const callee = this.callee;
      try {
        return callee.apply(this.this, this.arguments);
      } catch {
        return undefined;
      }
    });
    this._resume(null);
    return { callFrames: [] };
  }

  setReturnValue({ newValue }) {
    const state = this._requirePaused();
    if (!state.completion || !("return" in state.completion)) {
      throw new ProtocolError("Could not set return value, current frame is not a return frame");
    }
    // The pause is in the frame's onPop, whose resumption value replaces the
    // result.
    state.returnOverride = { value: this._callArgument(state.frames[0], newValue) };
  }

  setVariableValue({ scopeNumber, variableName, newValue, callFrameId }) {
    const frame = this._frameOf(callFrameId);
    const scope = this._scopeChain(frame, "backtrace")[scopeNumber];
    if (!scope) {
      throw new ProtocolError("Could not find scope with given number");
    }
    const value = this._callArgument(frame, newValue);
    const target = this._runtime.objects.get(scope.object.objectId);
    try {
      if (target instanceof ScopeObject) {
        const env = target.find(variableName);
        if (!env) {
          throw new Error(`${variableName} is not defined`);
        }
        env.setVariable(variableName, value);
      } else {
        const completion = target.setProperty(variableName, value);
        if (!completion || "throw" in completion) {
          throw new Error(`Cannot set ${variableName}`);
        }
      }
    } catch (error) {
      throw new ProtocolError(String(error?.message ?? error));
    }
  }

  // The error V8 throws when it refuses an evaluation with side effects, as
  // a real EvalError of the page.
  _sideEffectResult(context, objectGroup) {
    const runtime = this._runtime;
    const win = context.window;
    const error = new (Cu.waiveXrays(win).EvalError)(SIDE_EFFECT_MESSAGE.replace(/^EvalError: /, ""));
    // Constructed here, it would carry the paused page's frames as its stack;
    // V8's has none.
    Object.defineProperty(Cu.waiveXrays(error), "stack", { value: "", configurable: true, writable: true });
    const remote = runtime._remote(this.dbg.makeGlobalObjectReference(win).makeDebuggeeValue(error), {
      group: objectGroup,
    });
    return {
      result: remote,
      exceptionDetails: {
        exceptionId: (runtime.nextExceptionId = (runtime.nextExceptionId ?? 0) + 1),
        text: "Uncaught",
        lineNumber: -1,
        columnNumber: -1,
        exception: remote,
      },
    };
  }

  evaluateOnCallFrame({
    callFrameId,
    expression,
    objectGroup,
    includeCommandLineAPI = false,
    silent = false,
    returnByValue = false,
    generatePreview = false,
    throwOnSideEffect = false,
    timeout,
  }) {
    const frame = this._frameOf(callFrameId);
    const runtime = this._runtime;
    const context = this._contextOfFrame(frame);
    const bindings = includeCommandLineAPI ? runtime._commandLineBindings(context) : {};
    let completion;
    this.evaluating++;
    try {
      if (throwOnSideEffect) {
        completion = evaluateWithoutSideEffects(this.dbg, { frame, expression, bindings, timeout });
        if (completion.sideEffect) {
          return this._sideEffectResult(context, objectGroup);
        }
      } else {
        completion = frame.evalWithBindings(expression, bindings);
      }
    } finally {
      this.evaluating--;
    }
    if (!completion) {
      throw new ProtocolError("Execution was terminated");
    }
    if ("throw" in completion) {
      return {
        result: runtime._remote(completion.throw, { group: objectGroup, generatePreview }),
        exceptionDetails: runtime._exceptionDetails(completion, context),
      };
    }
    if (objectGroup === "console" && !silent) {
      runtime.lastResult = completion.return;
    }
    return {
      result: runtime._remote(completion.return, { group: objectGroup, generatePreview, returnByValue }),
    };
  }

  setPauseOnExceptions({ state }) {
    if (!PAUSE_ON_EXCEPTIONS.has(state)) {
      throw new InvalidParams(`Unknown pause on exceptions mode: ${state}`);
    }
    this.pauseOnExceptions = state;
    if (this.enabled) {
      this._setHooks();
    }
  }

  setAsyncCallStackDepth({ maxDepth }) {
    this.asyncCallStackDepth = maxDepth;
  }

  setBlackboxPatterns({ patterns = [], skipAnonymous = false }) {
    const compiled = [];
    for (const pattern of patterns) {
      try {
        compiled.push(new RegExp(pattern));
      } catch {
        throw new ProtocolError(`Pattern parser error: ${pattern}`);
      }
    }
    this.blackboxPatterns = compiled;
    this.blackboxAnonymous = !!skipAnonymous;
  }

  setBlackboxExecutionContexts({ uniqueIds = [] }) {
    this.blackboxedContexts = new Set(uniqueIds);
  }

  setBlackboxedRanges({ scriptId, positions = [] }) {
    this._info(scriptId);
    for (let i = 1; i < positions.length; i++) {
      if (compare(positions[i - 1], positions[i]) >= 0) {
        throw new InvalidParams("Input positions array is not sorted or contains duplicate values.");
      }
    }
    if (positions.length) {
      this.blackboxedRanges.set(String(scriptId), positions);
    } else {
      this.blackboxedRanges.delete(String(scriptId));
    }
  }

  // beforeScriptExecution: a pause at the first statement of every script
  // that runs from now on, by a breakpoint on each new top-level script (as
  // Firefox's "script first statement" event breakpoint).
  setInstrumentationBreakpoint({ instrumentation }) {
    if (instrumentation !== "beforeScriptExecution") {
      throw new ProtocolError(`Instrumentation ${instrumentation} is not supported`);
    }
    const id = `instrumentation:${instrumentation}`;
    this.instrumentation.set(id, instrumentation);
    return { breakpointId: id };
  }

  _instrumentScript(script) {
    if (script.isFunction || script.format !== "js" || this.instrumented.has(script)) {
      return;
    }
    this.instrumented.add(script);
    const positions = script.getPossibleBreakpoints();
    const first = positions.find(bp => bp.isStepStart) ?? positions[0];
    if (!first) {
      return;
    }
    script.setBreakpoint(first.offset, {
      hit: frame => {
        if (!this.instrumentation.size || this._isBlackboxed(frame)) {
          return undefined;
        }
        const info = this.scripts.get(this._scriptIdOf(script));
        return this._pause(frame, "instrumentation", {
          data: { scriptId: info?.id ?? "", url: info?.url ?? "" },
          hitBreakpoints: [...this.instrumentation.keys()],
        });
      },
    });
  }

  // The names declared in the global lexical scope (top-level let, const,
  // class) of a document, for Runtime.globalLexicalScopeNames. The Debugger
  // API reaches that environment only from a frame, so this runs an empty
  // statement in the global under a throwaway Debugger and reads the scope
  // chain of its frame.
  _globalLexicalNames(win) {
    const probe = new (Object.getPrototypeOf(this.dbg).constructor)();
    // Only the probe sees the evaluation: no scriptParsed, no pause.
    probe.exclusiveDebuggerOnEval = true;
    let names = [];
    try {
      const global = probe.addDebuggee(win);
      probe.onDebuggerStatement = frame => {
        for (let env = frame.environment; env; env = env.parent) {
          if (env.type === "declarative" && env.parent?.type === "object" && !env.parent.parent) {
            names = env.names();
            break;
          }
        }
        return undefined;
      };
      global.executeInGlobal("debugger;");
    } finally {
      probe.removeAllDebuggees();
    }
    return names;
  }

  // Pauses for another domain (DOMDebugger, EventBreakpoints) in the newest
  // frame of the page's script, or at the next one if none is running.
  _pauseFor(reason, data) {
    const frame = this.dbg.getNewestFrame();
    if (frame) {
      return this._pause(frame, reason, { data });
    }
    return undefined;
  }

  // Pauses at the first statement of the next frame that enters (V8 pauses
  // on the first statement, not on the function's entry).
  _pauseAtNextFrame(key, reason, data) {
    this._setEnterFrameHook(key, frame => {
      if (this._isBlackboxed(frame)) {
        return undefined;
      }
      this._setEnterFrameHook(key, null);
      const { onStep, onPop } = this._steppingHooks("step", null, undefined, reason, data);
      this._hook(frame, onStep, onPop);
      return undefined;
    });
  }

  _destroy() {
    try {
      this.disable();
    } catch (error) {
      console.error("FireDog DevTools: Debugger", error);
    }
  }
}
