/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The parts of FireDog's window that Firefox's markup does not have or has
// too much of: Chrome DevTools on Chromium's keys, and none of the keyboard
// shortcuts of the features FireDog leaves out. chromium.css lays out and
// paints the window and hides the menu items of those features.
//
// FireDog runs inside a tab of a learning page, so it draws no window frame
// (no traffic lights) and no profile button: there is no window to close and
// no account to sign in to.

"use strict";

var FireDogChromium = {
  init() {
    this.removeUnusedKeys();
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

  // The keyboard shortcuts of what FireDog leaves out: downloads and saving
  // files, printing, private windows, Firefox's Library window and sidebars,
  // Reader View, Picture-in-Picture, screenshots, split view, page info,
  // about:processes, the clear-history dialog and quitting (FireDog's window
  // lives in the learning page's tab, so quitting only leaves it empty). The
  // menu items of the same features are hidden in chromium.css; a shortcut
  // left behind would still open Firefox's own UI.
  removeUnusedKeys() {
    for (const id of [
      "key_openDownloads",
      "openFileKb",
      "key_savePage",
      "printKb",
      "key_privatebrowsing",
      "showAllHistoryKb",
      "manBookmarkKb",
      "key_gotoHistory",
      "viewBookmarksSidebarKb",
      "viewBookmarksToolbarKb",
      "viewGenaiChatSidebarKb",
      "viewOpenTabsSidebarKb",
      "toggleSidebarKb",
      "key_toggleReaderMode",
      "key_togglePictureInPicture",
      "key_screenshot",
      "key_addTabSplitView",
      "key_separateTabSplitView",
      "key_viewInfo",
      "key_aboutProcesses",
      "key_sanitize",
      "key_quitApplication",
    ]) {
      document.getElementById(id)?.remove();
    }
  },

  // Chrome DevTools (devtools/DevToolsWindow.sys.mjs) on Chromium's keys:
  // F12 and ⌥⌘I open or close it, ⌥⌘J opens the Console, ⌥⌘C picks an
  // element, and "検証" (Inspect) at the end of the page's context menu opens
  // it on the clicked element. Where the shortcuts use Ctrl (ui.key.accelKey,
  // see wasip1/main.cpp) the keys are Ctrl+Shift+I, J and C, as in Chrome on
  // Windows and Linux.
  //
  // App menu > More tools has a Developer Tools item too, as Chrome's menu
  // does. When FireDog runs in a page of a host browser, that browser takes
  // F12 and the DevTools shortcuts before the page sees them, so the menus are
  // the only way in.
  addDevTools() {
    const { DevTools } = ChromeUtils.importESModule(
      "resource:///modules/firedog/devtools/DevToolsWindow.sys.mjs"
    );
    const frontendAction = (devtools, action) =>
      devtools?.whenLoaded(api => action(Cu.waiveXrays(api)));
    const ctrlKeys =
      Services.prefs.getIntPref("ui.key.accelKey", KeyEvent.DOM_VK_META) ==
      KeyEvent.DOM_VK_CONTROL;
    window.addEventListener(
      "keydown",
      event => {
        const tab = gBrowser.selectedTab;
        const command = ctrlKeys
          ? event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
          : event.metaKey && event.altKey && !event.ctrlKey;
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
    // The More tools view is built from a template when it first opens, so
    // the item goes in then.
    window.addEventListener(
      "ViewShowing",
      event => {
        if (
          event.target.id != "appmenu-moreTools" ||
          document.getElementById("firedog-appmenu-devtools")
        ) {
          return;
        }
        const button = document.createXULElement("toolbarbutton");
        button.id = "firedog-appmenu-devtools";
        button.className = "subviewbutton";
        document.l10n.setAttributes(button, "firedog-appmenu-devtools");
        // FireDog's fonts (Liberation Sans, Noto Sans JP) have no ⌥, so the
        // Option key is spelled out, as Firefox's own labels spell out Shift.
        button.setAttribute("shortcut", ctrlKeys ? "Ctrl+Shift+I" : "Option+⌘I");
        button.addEventListener("command", () => {
          PanelUI.hide();
          DevTools.toggle(gBrowser.selectedTab);
        });
        document.getElementById("appmenu-developer-tools-view")?.append(button);
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
      // The menu's data comes from the ContextMenu actor as a structured
      // clone, so gContextMenu.target is not the node itself. Resolve it the
      // way Firefox's own Inspect does (nsContextMenu.inspectNode).
      const { ContentDOMReference } = ChromeUtils.importESModule(
        "resource://gre/modules/ContentDOMReference.sys.mjs"
      );
      const node =
        gContextMenu?.targetIdentifier &&
        ContentDOMReference.resolve(gContextMenu.targetIdentifier);
      DevTools.open(gBrowser.selectedTab).inspectNode(node);
    });
    menu.append(separator, item);
  },

  // FireDog's tabs are not remote: the page is a subdocument of browser.xhtml.
  // While it loads, its document has painting suppressed, hit testing stops at
  // the tab's <browser>, and a right-click arrives as a contextmenu event on
  // the <browser> itself. Its contextmenu="contentAreaContextMenu" attribute
  // then opens the menu through the XUL popup listener, without the data the
  // ContextMenu actor collects about the page: nsContextMenu throws in its
  // constructor before it hides anything, and the menu shows every item
  // (spelling, link, image and media items, undo/cut/paste, ...). In Firefox
  // tabs are remote; that listener ignores remote browsers
  // (nsXULPopupListener::HandleEvent, IsTopLevelRemoteTarget) and the page's
  // process targets the event in the page, where ContextMenuChild builds the
  // menu. Do the same: take the event off the <browser> and dispatch it at
  // the page's element under the pointer. elementFromPoint ignores painting
  // suppression, so it finds that element while the page is still loading.
  forwardContextMenuToPage() {
    window.addEventListener(
      "contextmenu",
      event => {
        const browser = event.originalTarget;
        if (
          browser.localName != "browser" ||
          browser.getAttribute("contextmenu") != "contentAreaContextMenu" ||
          browser.isRemoteBrowser
        ) {
          return;
        }
        event.stopPropagation();
        event.preventDefault();
        const page = browser.contentDocument;
        if (!page?.documentElement) {
          return;
        }
        const box = browser.getBoundingClientRect();
        const x = event.clientX - box.left;
        const y = event.clientY - box.top;
        const view = page.defaultView;
        const target = page.elementFromPoint(x, y) ?? page.documentElement;
        target.dispatchEvent(
          new view.MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            composed: true,
            view,
            button: event.button,
            buttons: event.buttons,
            clientX: x,
            clientY: y,
            screenX: event.screenX,
            screenY: event.screenY,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
          })
        );
      },
      true
    );
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

// A right-click can come before the window's load event (the first tab is
// there from the start), so this listens from the start too.
FireDogChromium.forwardContextMenuToPage();
window.addEventListener("load", () => FireDogChromium.init(), { once: true });
