/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Animation domain (the Animations panel): CSS animations, transitions
// and Web Animations of the page as Gecko runs them.
//
// Gecko reports animations coming and going to a chrome MutationObserver
// with the `animations` option (what Firefox's animation inspector uses).
// Blink's playback rate applies to the whole page; Gecko has no page-wide
// rate, so it is applied to each animation, and to new ones as they appear.

import { backendNodeIdOf } from "resource:///modules/firedog/devtools/domains/DOM.sys.mjs";
import { ProtocolError } from "resource:///modules/firedog/devtools/Session.sys.mjs";

function typeOf(animation) {
  switch (ChromeUtils.getClassName(animation)) {
    case "CSSAnimation":
      return "CSSAnimation";
    case "CSSTransition":
      return "CSSTransition";
    default:
      return "WebAnimation";
  }
}

function nameOf(animation) {
  switch (typeOf(animation)) {
    case "CSSAnimation":
      return animation.animationName;
    case "CSSTransition":
      return animation.transitionProperty;
    default:
      return animation.id;
  }
}

export class Animation {
  constructor(session) {
    this.session = session;
    this.target = session.target;
    this.enabled = false;
    this.playbackRate = 1;
    this.ids = new WeakMap();
    this.animations = new Map();
    this.nextId = 1;
    this.observers = new Map();
  }

  _id(animation) {
    let id = this.ids.get(animation);
    if (!id) {
      id = String(this.nextId++);
      this.ids.set(animation, id);
      this.animations.set(id, animation);
    }
    return id;
  }

  _animation(id) {
    const animation = this.animations.get(id);
    if (!animation || Cu.isDeadWrapper(animation)) {
      throw new ProtocolError("Could not find animation with given id");
    }
    return animation;
  }

  // Animation.Animation.
  _describe(animation) {
    const effect = animation.effect;
    const timing = effect?.getComputedTiming() ?? {};
    const specified = effect?.getTiming() ?? {};
    const result = {
      id: this._id(animation),
      name: nameOf(animation) ?? "",
      pausedState: animation.playState === "paused",
      playState: animation.playState,
      playbackRate: animation.playbackRate,
      startTime: animation.startTime ?? 0,
      currentTime: animation.currentTime ?? 0,
      type: typeOf(animation),
    };
    if (effect) {
      const target = effect.target;
      result.source = {
        delay: timing.delay ?? 0,
        endDelay: timing.endDelay ?? 0,
        iterationStart: timing.iterationStart ?? 0,
        iterations: timing.iterations === Infinity ? null : timing.iterations,
        duration: typeof timing.duration === "number" ? timing.duration : 0,
        direction: timing.direction,
        fill: specified.fill ?? timing.fill,
        easing: timing.easing,
        ...(target ? { backendNodeId: backendNodeIdOf(target) } : {}),
      };
      if (timing.iterations === Infinity) {
        delete result.source.iterations;
      }
      if (result.type === "CSSAnimation" || result.type === "WebAnimation") {
        try {
          result.source.keyframesRule = {
            ...(result.type === "CSSAnimation" ? { name: result.name } : {}),
            keyframes: effect.getKeyframes().map(frame => ({
              offset: `${Math.round((frame.computedOffset ?? frame.offset ?? 0) * 100)}%`,
              easing: frame.easing ?? "linear",
            })),
          };
        } catch {
          // Keyframes of a dead document.
        }
      }
    }
    return result;
  }

  _observe(win) {
    const document = win.document;
    if (this.observers.has(document)) {
      return;
    }
    const observer = new win.MutationObserver(records => this._onRecords(records));
    observer.observe(document, { animations: true, subtree: true });
    this.observers.set(document, observer);
  }

  _onRecords(records) {
    if (!this.enabled) {
      return;
    }
    for (const record of records) {
      for (const animation of record.addedAnimations ?? []) {
        if (this.playbackRate !== 1) {
          animation.updatePlaybackRate(animation.playbackRate * this.playbackRate);
        }
        const id = this._id(animation);
        this.session.emit("Animation.animationCreated", { id });
        this.session.emit("Animation.animationStarted", { animation: this._describe(animation) });
      }
      for (const animation of record.changedAnimations ?? []) {
        if (this.ids.has(animation)) {
          this.session.emit("Animation.animationUpdated", { animation: this._describe(animation) });
        }
      }
      for (const animation of record.removedAnimations ?? []) {
        const id = this.ids.get(animation);
        if (id && animation.playState === "idle") {
          this.session.emit("Animation.animationCanceled", { id });
        }
      }
    }
  }

  enable() {
    if (this.enabled) {
      return;
    }
    this.enabled = true;
    for (const win of this.session.domain("Runtime")._windows()) {
      this._observe(win);
      // Blink reports the animations already running when enabled.
      for (const animation of win.document.getAnimations()) {
        this.session.emit("Animation.animationCreated", { id: this._id(animation) });
        this.session.emit("Animation.animationStarted", { animation: this._describe(animation) });
      }
    }
    this.onNewDocument = {
      observe: subject => {
        const win = subject.defaultView;
        if (this.enabled && win?.browsingContext?.top === this.target.browsingContext) {
          this._observe(win);
        }
      },
    };
    Services.obs.addObserver(this.onNewDocument, "document-element-inserted");
  }

  disable() {
    if (!this.enabled) {
      return;
    }
    this.enabled = false;
    for (const observer of this.observers.values()) {
      try {
        observer.disconnect();
      } catch {
        // The document is gone.
      }
    }
    this.observers.clear();
    Services.obs.removeObserver(this.onNewDocument, "document-element-inserted");
  }

  getCurrentTime({ id }) {
    return { currentTime: this._animation(id).currentTime ?? 0 };
  }

  getPlaybackRate() {
    return { playbackRate: this.playbackRate };
  }

  setPlaybackRate({ playbackRate }) {
    const factor = playbackRate / this.playbackRate;
    this.playbackRate = playbackRate;
    for (const win of this.session.domain("Runtime")._windows()) {
      for (const animation of win.document.getAnimations()) {
        animation.updatePlaybackRate(animation.playbackRate * factor);
      }
    }
  }

  setPaused({ animations, paused }) {
    for (const id of animations) {
      const animation = this.animations.get(id);
      if (animation && !Cu.isDeadWrapper(animation)) {
        if (paused) {
          animation.pause();
        } else {
          animation.play();
        }
      }
    }
  }

  seekAnimations({ animations, currentTime }) {
    for (const id of animations) {
      const animation = this.animations.get(id);
      if (animation && !Cu.isDeadWrapper(animation)) {
        animation.currentTime = currentTime;
      }
    }
  }

  setTiming({ animationId, duration, delay }) {
    const animation = this._animation(animationId);
    if (!animation.effect) {
      throw new ProtocolError("The animation has no effect");
    }
    animation.effect.updateTiming({ duration, delay });
  }

  releaseAnimations({ animations }) {
    for (const id of animations) {
      const animation = this.animations.get(id);
      this.animations.delete(id);
      if (animation) {
        this.ids.delete(animation);
      }
    }
  }

  resolveAnimation({ animationId }) {
    const animation = this._animation(animationId);
    const runtime = this.session.domain("Runtime");
    const win = animation.effect?.target?.ownerDocument?.defaultView ?? this.target.contentWindow;
    runtime._contextForWindow(win);
    return { remoteObject: runtime._remoteForPageValue(win, animation, {}) };
  }

  _destroy() {
    this.disable();
  }
}
