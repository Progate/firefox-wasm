/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Evaluation that refuses side effects, for CDP's throwOnSideEffect (the
// front-end's hover popovers, watch completions and eager console
// previews). V8 proves an expression pure before running it; SpiderMonkey
// can't, so this runs it under a separate Debugger that stops it at the first
// effect instead, the way Firefox's own eager evaluation does
// (devtools/server/actors/webconsole/eval-with-debugger.js, whose allowlists
// of pure natives are reused here):
// - shouldAvoidSideEffects makes the engine refuse effectful operations it
//   knows about;
// - breakpoints on every effectful bytecode offset (stores to non-local
//   objects) of each script the evaluation enters terminate it;
// - a native call is let through only if it is a DOM getter or listed as
//   pure, anything else terminates the evaluation.
// A terminated evaluation is reported as V8 reports one it refuses.

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "pureNatives", () => {
  const { require } = ChromeUtils.importESModule(
    "resource://devtools/shared/loader/Loader.sys.mjs"
  );
  const ecma = require("resource://devtools/server/actors/webconsole/eager-ecma-allowlist.js");
  const { natives } = require("resource://devtools/server/actors/webconsole/eager-function-allowlist.js");
  const byName = new Map();
  for (const fn of [...ecma.functions, ...ecma.getters, ...natives]) {
    let list = byName.get(fn.name);
    if (!list) {
      list = [];
      byName.set(fn.name, list);
    }
    list.push(fn);
  }
  return byName;
});

// The time an evaluation may take before it is stopped, as V8's `timeout`
// parameter (the front-end passes 500 ms).
const DEFAULT_TIMEOUT = 500;

export const SIDE_EFFECT_MESSAGE = "EvalError: Possible side-effect in debug-evaluate";

function isPureNative(fn) {
  if (fn.isBoundFunction) {
    fn = fn.boundTargetFunction;
  }
  // WebIDL getters (with JitInfo) only read state.
  if (fn.isNativeGetterWithJitInfo()) {
    return true;
  }
  switch (fn.name) {
    case "toString":
    case "toLocaleString":
    case "valueOf":
      return true;
  }
  return !!lazy.pureNatives.get(fn.name)?.some(native => fn.isSameNativeWithJitInfo(native));
}

// Evaluates `expression` in `frame` (a Debugger.Frame of `dbg`) or, without a
// frame, in `global` (a Debugger.Object of `dbg`), refusing side effects.
// Returns the completion translated back to `dbg`, or { sideEffect: true }
// when the evaluation was stopped.
export function evaluateWithoutSideEffects(dbg, { frame, global, expression, bindings = {}, timeout = DEFAULT_TIMEOUT }) {
  const guard = new (Object.getPrototypeOf(dbg).constructor)();
  // Only this Debugger sees the evaluation: the main one's breakpoints and
  // pause hooks stay out of it.
  guard.exclusiveDebuggerOnEval = true;
  for (const debuggee of dbg.getDebuggees()) {
    try {
      guard.addDebuggee(debuggee.unsafeDereference());
    } catch {
      // A global that went away since.
    }
  }
  const deadline = Date.now() + (timeout || DEFAULT_TIMEOUT);
  let steps = 0;
  const tooLong = () => ++steps % 100 === 0 && Date.now() > deadline;
  const stop = { hit: () => null };
  const instrumented = new Set();
  guard.onEnterFrame = entered => {
    if (tooLong()) {
      return null;
    }
    entered.onStep = () => (tooLong() ? null : undefined);
    const script = entered.script;
    if (!instrumented.has(script)) {
      instrumented.add(script);
      for (const offset of script.getEffectfulOffsets()) {
        script.setBreakpoint(offset, stop);
      }
    }
    return undefined;
  };
  // onNativeCall only reaches the Debugger that started the evaluation.
  guard.onNativeCall = (callee, reason) => {
    try {
      if ((reason === "get" || reason === "call") && isPureNative(callee)) {
        return undefined;
      }
    } catch {
      // A callee the allowlist can't classify counts as effectful.
    }
    return null;
  };
  guard.shouldAvoidSideEffects = true;
  try {
    const adopted = {};
    for (const [name, value] of Object.entries(bindings)) {
      adopted[name] = guard.adoptDebuggeeValue(value);
    }
    const completion = frame
      ? guard.adoptFrame(frame).evalWithBindings(expression, adopted, { hideFromDebugger: true })
      : guard.adoptDebuggeeValue(global).executeInGlobalWithBindings(expression, adopted, {
          hideFromDebugger: true,
        });
    if (!completion) {
      return { sideEffect: true };
    }
    if ("return" in completion) {
      return { return: dbg.adoptDebuggeeValue(completion.return) };
    }
    return { throw: dbg.adoptDebuggeeValue(completion.throw), stack: completion.stack };
  } finally {
    guard.onNativeCall = undefined;
    guard.onEnterFrame = undefined;
    guard.shouldAvoidSideEffects = false;
    guard.removeAllDebuggees();
  }
}
