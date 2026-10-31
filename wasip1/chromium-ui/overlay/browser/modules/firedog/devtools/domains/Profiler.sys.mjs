/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Profiler domain. Precise coverage comes from SpiderMonkey's own
// execution counts (Debugger.collectCoverageInfo and
// Debugger.Script.getOffsetsCoverage), reported per function as V8 reports
// function-granularity coverage. CPU profiles are not available: Gecko's
// sampling profiler needs a sampler thread, which FireDog's single-threaded
// build does not have.

import { ProtocolError } from "resource:///modules/firedog/devtools/Session.sys.mjs";

export class Profiler {
  constructor(session) {
    this.session = session;
    this.enabled = false;
    this.coverage = null;
  }

  get _debugger() {
    return this.session.domain("Debugger");
  }

  // Coverage has its own Debugger: SpiderMonkey refuses onEnterFrame (which
  // stepping into calls and Debugger.pause use) on a Debugger that collects
  // coverage.
  get dbg() {
    if (!this._dbg) {
      const main = this.session.domain("Runtime").dbg;
      this._dbg = new (Object.getPrototypeOf(main).constructor)();
      for (const debuggee of main.getDebuggees()) {
        try {
          this._dbg.addDebuggee(debuggee.unsafeDereference());
        } catch {
          // A global that went away.
        }
      }
    }
    return this._dbg;
  }

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
    if (this.coverage) {
      this.stopPreciseCoverage();
    }
  }

  setSamplingInterval() {
    throw new ProtocolError("CPU profiling is not supported");
  }

  start() {
    throw new ProtocolError("CPU profiling is not supported");
  }

  stop() {
    throw new ProtocolError("CPU profiling is not supported");
  }

  _timestamp() {
    // Monotonic, like V8's: milliseconds since the process started.
    return ChromeUtils.now() / 1000;
  }

  // `detailed` (block coverage) would need SpiderMonkey's per-offset counts
  // mapped to V8's nested ranges; function coverage is reported either way,
  // marked isBlockCoverage: false as V8 marks it.
  startPreciseCoverage({ callCount = false } = {}) {
    try {
      // Globals of documents loaded since the last start.
      const main = this.session.domain("Runtime").dbg;
      for (const debuggee of main.getDebuggees()) {
        if (!this.dbg.hasDebuggee(debuggee.unsafeDereference())) {
          this.dbg.addDebuggee(debuggee.unsafeDereference());
        }
      }
      // A document loaded while coverage runs (the front-end reloads to
      // record startup) is counted from its first script.
      this.dbg.onNewGlobalObject = global => {
        try {
          const win = global.unsafeDereference();
          if (win.browsingContext?.top === this.session.target.browsingContext) {
            this.dbg.addDebuggee(win);
          }
        } catch {
          // Not a window of this page.
        }
      };
      this.dbg.collectCoverageInfo = true;
    } catch (error) {
      throw new ProtocolError(`Coverage could not be started: ${error.message}`);
    }
    // Counts are cumulative in SpiderMonkey; V8 resets them on each take, so
    // each take reports the difference to the previous one.
    this.coverage = { callCount, previous: new WeakMap() };
    return { timestamp: this._timestamp() };
  }

  stopPreciseCoverage() {
    this.coverage = null;
    this.dbg.onNewGlobalObject = undefined;
    try {
      this.dbg.collectCoverageInfo = false;
    } catch {
      // Page frames on the stack: SpiderMonkey keeps counting until they are
      // gone, which no one reads.
    }
  }

  takePreciseCoverage() {
    if (!this.coverage) {
      throw new ProtocolError("Precise coverage has not been started.");
    }
    const debuggerDomain = this._debugger;
    const byScript = new Map();
    for (const script of this.dbg.findScripts()) {
      if (script.format !== "js") {
        continue;
      }
      const scriptId = String(script.source.id);
      const info = debuggerDomain.scripts.get(scriptId);
      // Top-level code usually ran once and was collected; what findScripts
      // still sees of it can be the Debugger domain's reparsed copy (which
      // lists breakpoint positions and never runs), so it is not reported.
      if (!info?.announced || !script.isFunction) {
        continue;
      }
      let total = 0;
      try {
        const counts = script.getOffsetsCoverage();
        // The first counter is the script's entry: how often it ran.
        total = counts?.length ? counts[0].count : 0;
      } catch {
        total = 0;
      }
      const before = this.coverage.previous.get(script) ?? 0;
      this.coverage.previous.set(script, total);
      const count = this.coverage.callCount ? total - before : Math.min(total - before, 1);
      let entry = byScript.get(scriptId);
      if (!entry) {
        entry = { scriptId, url: info.url, functions: new Map() };
        byScript.set(scriptId, entry);
      }
      // A reparsed copy of a function has the same range and never runs;
      // the count is the page's function's.
      const key = `${script.sourceStart}:${script.sourceLength}`;
      const known = entry.functions.get(key);
      if (!known || known.ranges[0].count < count) {
        entry.functions.set(key, {
          functionName: script.displayName ?? "",
          ranges: [{ startOffset: script.sourceStart, endOffset: script.sourceStart + script.sourceLength, count }],
          isBlockCoverage: false,
        });
      }
    }
    const result = [];
    for (const entry of byScript.values()) {
      const functions = [...entry.functions.values()].sort((a, b) => a.ranges[0].startOffset - b.ranges[0].startOffset);
      result.push({ ...entry, functions });
    }
    return { result, timestamp: this._timestamp() };
  }

  getBestEffortCoverage() {
    // Without collectCoverageInfo SpiderMonkey keeps no execution counts.
    throw new ProtocolError("Best-effort coverage is not supported; use precise coverage");
  }

  _destroy() {
    if (this.coverage) {
      this.stopPreciseCoverage();
    }
    this._dbg?.removeAllDebuggees();
  }
}
