/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Browser domain: the browser's version and its windows. Window ids are
// the windows' outer window ids, which stay the same for a window's life as
// Chromium's do.

import { InvalidParams } from "resource:///modules/firedog/devtools/Session.sys.mjs";
import { Targets } from "resource:///modules/firedog/devtools/Targets.sys.mjs";

// What /json/version reports as Protocol-Version (RemoteDebugging.sys.mjs).
const PROTOCOL_VERSION = "1.3";

function windowById(windowId) {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (win.docShell.outerWindowID === windowId) {
      return win;
    }
  }
  throw new InvalidParams(`Browser window not found`);
}

function boundsOf(win) {
  const state =
    win.windowState === win.STATE_MINIMIZED
      ? "minimized"
      : win.windowState === win.STATE_MAXIMIZED
        ? "maximized"
        : win.windowState === win.STATE_FULLSCREEN
          ? "fullscreen"
          : "normal";
  return {
    left: win.screenX,
    top: win.screenY,
    width: win.outerWidth,
    height: win.outerHeight,
    windowState: state,
  };
}

export class Browser {
  constructor(session) {
    this.session = session;
  }

  getVersion() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      product: `FireDog/${Services.appinfo.version}`,
      revision: Services.appinfo.sourceURL ?? "",
      userAgent: Cc["@mozilla.org/network/protocol;1?name=http"].getService(
        Ci.nsIHttpProtocolHandler
      ).userAgent,
      jsVersion: Services.appinfo.platformVersion,
    };
  }

  getWindowForTarget({ targetId } = {}) {
    const target = targetId ? Targets.byId(targetId) : this.session.target;
    const win = target?.window;
    if (!win) {
      throw new InvalidParams("No web contents for the given target id");
    }
    return { windowId: win.docShell.outerWindowID, bounds: boundsOf(win) };
  }

  getWindowBounds({ windowId }) {
    return { bounds: boundsOf(windowById(windowId)) };
  }

  close() {
    Services.tm.dispatchToMainThread(() =>
      Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit)
    );
  }
}
