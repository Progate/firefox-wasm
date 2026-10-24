/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The EventBreakpoints domain: Chromium's front-end sets its instrumentation
// breakpoints (timers, animation frames) here. They are DOMDebugger's
// instrumentation breakpoints, which this domain shares.

export class EventBreakpoints {
  constructor(session) {
    this.session = session;
    this.names = new Set();
  }

  get _domDebugger() {
    return this.session.domain("DOMDebugger");
  }

  setInstrumentationBreakpoint({ eventName }) {
    this._domDebugger._setInstrumentationBreakpoint(eventName, true);
    this.names.add(eventName);
  }

  removeInstrumentationBreakpoint({ eventName }) {
    this._domDebugger._setInstrumentationBreakpoint(eventName, false);
    this.names.delete(eventName);
  }

  disable() {
    for (const name of this.names) {
      this._domDebugger._setInstrumentationBreakpoint(name, false);
    }
    this.names.clear();
  }

  _destroy() {}
}
