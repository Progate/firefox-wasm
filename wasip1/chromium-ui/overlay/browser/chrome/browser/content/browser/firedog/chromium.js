/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Chromium-style parts of FireDog's window that Firefox's markup does not
// have: the window's traffic lights at the start of the tab strip and the
// profile button before the app menu. chromium.css lays out and paints the
// rest of the window.

"use strict";

var FireDogChromium = {
  init() {
    this.addTrafficLights();
    this.addProfileButton();
    this.replayFirstLocation();
    this.addDevTools();
    // The Chrome DevTools Protocol endpoint, when its pref sets a port.
    ChromeUtils.importESModule(
      "resource:///modules/firedog/devtools/RemoteDebugging.sys.mjs"
    ).RemoteDebugging.startFromPrefs();
    if (Services.prefs.getBoolPref("firedog.chromium.debug", false)) {
      // The parity tooling (browser-gecko's scripts/ui-parity.ts) compares
      // pixels; these rects tell which element a difference belongs to.
      setTimeout(() => this.dumpLayout(), 4000);
    }
  },

  // The close, minimize and zoom buttons macOS draws at the start of a
  // Chromium window's tab strip. Close closes the window; the windowserver has
  // no minimized or zoomed state for a window yet, so the other two only show.
  addTrafficLights() {
    const toolbar = document.getElementById("TabsToolbar");
    if (!toolbar || document.getElementById("firedog-traffic-lights")) {
      return;
    }
    const box = document.createXULElement("hbox");
    box.id = "firedog-traffic-lights";
    for (const kind of ["close", "minimize", "zoom"]) {
      const button = document.createXULElement("toolbarbutton");
      button.className = `firedog-traffic-light firedog-traffic-light-${kind}`;
      if (kind === "close") {
        button.addEventListener("command", () => window.close());
      }
      box.append(button);
    }
    toolbar.prepend(box);
  },

  // Chrome DevTools (devtools/DevToolsWindow.sys.mjs) on Chromium's keys:
  // F12 and ⌥⌘I open or close it, ⌥⌘J opens the Console, ⌥⌘C picks an
  // element, and "検証" (Inspect) at the end of the page's context menu opens
  // it on the clicked element.
  addDevTools() {
    const { DevTools } = ChromeUtils.importESModule(
      "resource:///modules/firedog/devtools/DevToolsWindow.sys.mjs"
    );
    const frontendAction = (devtools, action) =>
      devtools?.whenLoaded(api => action(Cu.waiveXrays(api)));
    window.addEventListener(
      "keydown",
      event => {
        const tab = gBrowser.selectedTab;
        const command = event.metaKey && event.altKey && !event.ctrlKey;
        if (event.key === "F12" || (command && event.code === "KeyI")) {
          DevTools.toggle(tab);
        } else if (command && event.code === "KeyJ") {
          frontendAction(DevTools.open(tab), api => api.showPanel("console"));
        } else if (command && event.code === "KeyC") {
          frontendAction(DevTools.open(tab), api => api.enterInspectElementMode());
        } else {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      },
      true
    );
    const menu = document.getElementById("contentAreaContextMenu");
    if (!menu || document.getElementById("firedog-context-inspect")) {
      return;
    }
    const separator = document.createXULElement("menuseparator");
    const item = document.createXULElement("menuitem");
    item.id = "firedog-context-inspect";
    document.l10n.setAttributes(item, "firedog-context-inspect");
    item.addEventListener("command", () => {
      const node = gContextMenu?.target;
      DevTools.open(gBrowser.selectedTab).inspectNode(node);
    });
    menu.append(separator, item);
  },

  // Chromium shows the profile's avatar between the address bar and the app
  // menu. FireDog has no accounts, so this is the signed-out avatar.
  addProfileButton() {
    const menuButton = document.getElementById("PanelUI-button");
    if (!menuButton || document.getElementById("firedog-profile-button")) {
      return;
    }
    const button = document.createXULElement("toolbarbutton");
    button.id = "firedog-profile-button";
    button.className = "toolbarbutton-1";
    document.l10n.setAttributes(button, "firedog-profile-button");
    menuButton.before(button);
  },

  // FireDog's embedder opens the first page in a tab as soon as browser.xhtml
  // is parsed, before gBrowserInit registers XULBrowserWindow as a progress
  // listener. That page's location change then reaches nobody: the address
  // bar stays empty and reload stays disabled. Once startup has finished,
  // replay the selected browser's state the way a tab switch does.
  replayFirstLocation() {
    const replay = () => {
      if (gBrowser.selectedBrowser.currentURI.spec != "about:blank") {
        gBrowser.updateCurrentBrowser(true);
      }
    };
    if (gBrowserInit.delayedStartupFinished) {
      replay();
      return;
    }
    const observer = subject => {
      if (subject != window) {
        return;
      }
      Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
      replay();
    };
    Services.obs.addObserver(observer, "browser-delayed-startup-finished");
  },

  dumpLayout() {
    const selectors = [
      "#navigator-toolbox",
      "#TabsToolbar",
      "#firedog-traffic-lights",
      ".firedog-traffic-light-close",
      "#alltabs-button",
      "#alltabs-button .toolbarbutton-badge-stack",
      "#tabbrowser-tabs",
      "#tabbrowser-arrowscrollbox",
      ".tabbrowser-tab[selected]",
      ".tabbrowser-tab[selected] .tab-background",
      ".tabbrowser-tab[selected] .tab-icon-image",
      ".tabbrowser-tab[selected] .tab-label",
      ".tabbrowser-tab[selected] .tab-close-button",
      "#tabs-newtab-button",
      "#nav-bar",
      "#back-button",
      "#forward-button",
      "#reload-button",
      "#urlbar-container",
      "#urlbar",
      ".urlbar-background",
      ".urlbar-input-container",
      "#trust-icon-container",
      "#trust-icon",
      "#identity-box",
      "#urlbar-input",
      "#star-button-box",
      "#firedog-profile-button",
      "#PanelUI-menu-button",
      "#browser",
    ];
    const layout = {};
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) {
        layout[selector] = null;
        continue;
      }
      const rect = element.getBoundingClientRect();
      layout[selector] = [rect.x, rect.y, rect.width, rect.height].map(v => Math.round(v * 100) / 100);
    }
    dump(`firedog-chromium-layout ${JSON.stringify(layout)}\n`);
    const state = {
      urlbarValue: gURLBar.value,
      pageproxystate: gURLBar.getAttribute("pageproxystate"),
      currentURI: gBrowser.currentURI.spec,
      appLocales: Services.locale.appLocales,
      acceptLanguages: Services.prefs.getCharPref("intl.accept_languages"),
    };
    dump(`firedog-chromium-state ${JSON.stringify(state)}\n`);
  },
};

window.addEventListener("load", () => FireDogChromium.init(), { once: true });
