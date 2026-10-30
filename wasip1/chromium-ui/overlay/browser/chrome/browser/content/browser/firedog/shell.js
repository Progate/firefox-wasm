/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox's front-end inside FireDog's window.
//
// The firedog command (@progate/browser-gecko's shell/, in Rust) opens the
// window and draws the tabs and the toolbar itself, at once, while this
// program (Gecko) is still starting. Gecko then draws only below them, in a
// surface inside that window (FIREDOG_EMBED, see wasip1/windowserver.cpp), so
// Firefox's own tab strip and toolbar are hidden (chromium.css,
// :root[firedog-shell]). The rest of the front-end stays: the tabs' pages, the
// context menus, the app menu's panel, dialogs, the find bar, DevTools.
//
// What the person does with the window's tabs and toolbar comes here as
// commands, and what they show (the tabs, their titles and addresses) goes
// back as events. Both are lines that wasip1/main.cpp carries over the
// observer service: "firedog-shell-command" in, "firedog-shell-event" out.
// Arguments are percent-encoded so that a line splits on spaces.

"use strict";

var FireDogShell = {
  // The event has been asked for and will go out once the current task is done,
  // so a burst of tab changes (a page load sets the title, the icon, busy, ...)
  // costs one event.
  scheduled: false,
  // The last tabs event sent; an unchanged state is not sent again.
  lastTabs: "",

  init() {
    Services.obs.addObserver(this, "firedog-shell-command");
    window.addEventListener(
      "unload",
      () => Services.obs.removeObserver(this, "firedog-shell-command"),
      { once: true }
    );
    for (const type of [
      "TabOpen",
      "TabClose",
      "TabSelect",
      "TabMove",
      "TabAttrModified",
      "TabPinned",
      "TabUnpinned",
    ]) {
      gBrowser.tabContainer.addEventListener(type, () => this.schedule());
    }
    gBrowser.addTabsProgressListener({
      onLocationChange: () => this.schedule(),
      onStateChange: () => this.schedule(),
      onSecurityChange: () => this.schedule(),
    });
    this.takeLocationFocus();
    this.send("ready");
    this.schedule();
  },

  // The address bar is the window's. Firefox focuses its own (hidden) one when
  // a new tab opens or on ⌘L; the window focuses its address bar instead.
  takeLocationFocus() {
    for (const name of ["select", "focus"]) {
      gURLBar[name] = () => this.send("focus-location");
    }
  },

  send(event, ...args) {
    Services.obs.notifyObservers(
      null,
      "firedog-shell-event",
      [event, ...args.map(arg => encodeURIComponent(arg))].join(" ")
    );
  },

  schedule() {
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    Services.tm.dispatchToMainThread(() => {
      this.scheduled = false;
      this.sendTabs();
    });
  },

  // The address the window's address bar shows for a page: none for a blank
  // page (the bar then shows its placeholder), Firefox's own readable form
  // otherwise, as its address bar would show it.
  displayAddress(browser) {
    const uri = browser.currentURI;
    if (!uri || isBlankPageURL(uri.spec)) {
      return "";
    }
    let spec = uri.displaySpec;
    try {
      spec = losslessDecodeURI(uri);
    } catch (error) {}
    return BrowserUIUtils.trimURL(spec);
  },

  // What the address bar's icon says about the selected page's connection.
  security(browser) {
    const uri = browser.currentURI;
    if (!uri || isBlankPageURL(uri.spec)) {
      return "none";
    }
    if (!["http", "https"].includes(uri.scheme)) {
      return "internal";
    }
    const state = browser.securityUI?.state ?? 0;
    if (state & Ci.nsIWebProgressListener.STATE_IS_SECURE) {
      return "secure";
    }
    return uri.scheme == "https" ? "warning" : "insecure";
  },

  sendTabs() {
    const tabs = gBrowser.visibleTabs;
    const selected = gBrowser.selectedTab;
    const browser = gBrowser.selectedBrowser;
    const state = {
      selected: tabs.indexOf(selected),
      tabs: tabs.map(tab => ({
        title: tab.label,
        url: this.displayAddress(tab.linkedBrowser),
        busy: tab.hasAttribute("busy"),
        pinned: tab.pinned,
      })),
      back: browser.canGoBack,
      forward: browser.canGoForward,
      security: this.security(browser),
    };
    const json = JSON.stringify(state);
    if (json == this.lastTabs) {
      return;
    }
    this.lastTabs = json;
    this.send("tabs", json);
  },

  observe(subject, topic, data) {
    const [command, ...args] = data.split(" ").map(word => decodeURIComponent(word));
    const tab = index => gBrowser.visibleTabs[Number(index)];
    switch (command) {
      case "navigate":
        // As Enter in Firefox's address bar does: fix the text up into an
        // address, or search for it with the default engine.
        gBrowser.selectedBrowser.fixupAndLoadURIString(args[0], {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
          loadFlags:
            Ci.nsIWebNavigation.LOAD_FLAGS_ALLOW_THIRD_PARTY_FIXUP |
            Ci.nsIWebNavigation.LOAD_FLAGS_FIXUP_SCHEME_TYPOS,
        });
        gBrowser.selectedBrowser.focus();
        break;
      case "new-tab":
        BrowserCommands.openTab();
        break;
      case "select":
        if (tab(args[0])) {
          gBrowser.selectedTab = tab(args[0]);
        }
        break;
      case "close":
        if (tab(args[0])) {
          gBrowser.removeTab(tab(args[0]), { animate: false });
        }
        break;
      case "back":
        goDoCommand("Browser:Back");
        break;
      case "forward":
        goDoCommand("Browser:Forward");
        break;
      case "reload":
        goDoCommand("Browser:Reload");
        break;
      case "stop":
        goDoCommand("Browser:Stop");
        break;
      case "focus-page":
        gBrowser.selectedBrowser.focus();
        break;
      case "menu": {
        // The app menu, under the window's ⋮ button: its right edge at x and
        // its top at y, in this window's CSS pixels.
        const [x, y] = args.map(Number);
        PanelUI.ensureReady?.();
        PanelMultiView.openPopup(PanelUI.panel, null, {
          x: Math.max(0, x - 344),
          y,
          isContextMenu: false,
        }).catch(console.error);
        break;
      }
    }
  },
};

window.addEventListener("load", () => FireDogShell.init(), { once: true });
