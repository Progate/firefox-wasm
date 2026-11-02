/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Inspector domain: tells the client when its target goes away. A
// FireDog page target ends when its tab is closed (Blink's "target_closed");
// it never crashes separately since everything runs in one process.

export class Inspector {
  constructor(session) {
    this.session = session;
    this.enabled = false;
  }

  enable() {
    if (this.enabled) {
      return;
    }
    this.enabled = true;
    const tab = this.session.target.tab;
    this.tabContainer = tab?.container ?? tab?.parentNode;
    this.onTabClose = event => {
      if (event.target === this.tab) {
        this.session.emit("Inspector.detached", { reason: "target_closed" });
      }
    };
    this.tab = tab;
    this.tabContainer?.addEventListener("TabClose", this.onTabClose);
  }

  disable() {
    this.enabled = false;
    this.tabContainer?.removeEventListener("TabClose", this.onTabClose);
  }

  _destroy() {
    this.disable();
  }
}
