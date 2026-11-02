/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// DOM breakpoints (DOMDebugger.setDOMBreakpoint): pausing the page's script
// when it changes a node's subtree or attributes or removes the node.
//
// Gecko notifies these changes synchronously, while the changing script is
// on the stack, as chrome-only "devtoolschildinserted",
// "devtoolschildremoved" and "devtoolsattrmodified" events once a document's
// devToolsWatchingDOMMutations is set (what Firefox's mutation breakpoints
// use). Gecko sends them after the change where Blink pauses just before it,
// so the paused page already shows the change.

import { parentOf } from "resource:///modules/firedog/devtools/domains/DOM.sys.mjs";
import { InvalidParams } from "resource:///modules/firedog/devtools/Session.sys.mjs";

const TYPES = ["subtree-modified", "attribute-modified", "node-removed"];
const EVENTS = ["devtoolschildinserted", "devtoolschildremoved", "devtoolsattrmodified"];

export class DOMBreakpoints {
  constructor(session) {
    this.session = session;
    this.target = session.target;
    // node -> Set of breakpoint types.
    this.breakpoints = new Map();
    this.listening = false;
    this.onEvent = event => this._onEvent(event);
  }

  get _dom() {
    return this.session.domain("DOM");
  }

  _types(node) {
    return this.breakpoints.get(node);
  }

  set({ nodeId, type }) {
    if (!TYPES.includes(type)) {
      throw new InvalidParams(`Unknown DOM breakpoint type: ${type}`);
    }
    const node = this._dom._node(nodeId);
    let types = this.breakpoints.get(node);
    if (!types) {
      types = new Set();
      this.breakpoints.set(node, types);
    }
    types.add(type);
    this._update();
  }

  remove({ nodeId, type }) {
    if (!TYPES.includes(type)) {
      throw new InvalidParams(`Unknown DOM breakpoint type: ${type}`);
    }
    const node = this._dom._node(nodeId);
    const types = this.breakpoints.get(node);
    types?.delete(type);
    if (!types?.size) {
      this.breakpoints.delete(node);
    }
    this._update();
  }

  _documents() {
    return this.session.domain("Runtime")._windows().map(win => win.document);
  }

  _update() {
    const wanted = this.breakpoints.size > 0;
    for (const document of this._documents()) {
      document.devToolsWatchingDOMMutations = wanted;
    }
    const browser = this.target.browser;
    if (wanted && !this.listening) {
      for (const type of EVENTS) {
        browser.addEventListener(type, this.onEvent, true);
      }
      this.listening = true;
    } else if (!wanted && this.listening) {
      for (const type of EVENTS) {
        browser?.removeEventListener(type, this.onEvent, true);
      }
      this.listening = false;
    }
  }

  // The nearest ancestor (or the node itself) with a breakpoint of a type.
  _owner(node, type) {
    for (let current = node; current; current = parentOf(current)) {
      if (this._types(current)?.has(type)) {
        return current;
      }
    }
    return null;
  }

  _onEvent(event) {
    const node = event.target;
    if (node.isNativeAnonymous) {
      return;
    }
    // The client must know the changed node before the pause names it.
    this._dom._flushMutations(node);
    let data = null;
    if (event.type === "devtoolsattrmodified") {
      if (this._types(node)?.has("attribute-modified")) {
        data = { type: "attribute-modified", nodeId: this._dom._pushPath(node) };
      }
    } else if (event.type === "devtoolschildremoved" && this._types(node)?.has("node-removed")) {
      data = { type: "node-removed", nodeId: this._dom._pushPath(node) };
    } else {
      // The node is already in (or still in) its parent when Gecko notifies.
      const insertion = event.type === "devtoolschildinserted";
      const owner = this._owner(parentOf(node), "subtree-modified");
      if (owner) {
        data = {
          type: "subtree-modified",
          nodeId: this._dom._pushPath(owner),
          targetNodeId: this._dom._pushPath(node),
          insertion,
        };
      }
    }
    if (event.type === "devtoolschildremoved") {
      // Blink drops the breakpoints of a removed subtree.
      for (const watched of [...this.breakpoints.keys()]) {
        if (watched === node || node.contains?.(watched)) {
          this.breakpoints.delete(watched);
        }
      }
    }
    if (data) {
      this.session.domain("Debugger")._pauseFor("DOM", data);
    }
    if (!this.breakpoints.size) {
      this._update();
    }
  }

  destroy() {
    this.breakpoints.clear();
    this._update();
  }
}
