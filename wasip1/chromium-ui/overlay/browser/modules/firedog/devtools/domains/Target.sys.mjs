/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Target domain. FireDog's pages have no out-of-process frames or
// workers to attach to (Gecko runs single-process and its workers are not
// exposed as targets yet), so auto-attach has nothing to report; discovery
// lists the tabs.

import { Targets } from "resource:///modules/firedog/devtools/Targets.sys.mjs";
import { ProtocolError } from "resource:///modules/firedog/devtools/Session.sys.mjs";

export class Target {
  constructor(session) {
    this.session = session;
    this.discovering = false;
  }

  setAutoAttach() {}

  setRemoteLocations() {}

  setDiscoverTargets({ discover }) {
    const wasDiscovering = this.discovering;
    this.discovering = discover;
    if (discover && !wasDiscovering) {
      for (const page of Targets.pages()) {
        this.session.emit("Target.targetCreated", { targetInfo: page.info() });
      }
    }
  }

  getTargets() {
    return { targetInfos: Targets.pages().map(page => page.info()) };
  }

  getTargetInfo({ targetId } = {}) {
    const target = targetId ? Targets.byId(targetId) : this.session.target;
    if (!target) {
      throw new ProtocolError("No target with given id found");
    }
    return { targetInfo: target.info() };
  }

  activateTarget({ targetId }) {
    const target = Targets.byId(targetId);
    if (!target) {
      throw new ProtocolError("No target with given id found");
    }
    target.window.gBrowser.selectedTab = target.tab;
    target.window.focus();
  }

  closeTarget({ targetId }) {
    const target = Targets.byId(targetId);
    if (!target) {
      throw new ProtocolError("No target with given id found");
    }
    target.window.gBrowser.removeTab(target.tab);
    return { success: true };
  }
}
