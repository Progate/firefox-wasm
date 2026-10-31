/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Chrome DevTools docked in a tab, the way Chrome docks it
// (chrome/browser/devtools/devtools_window.cc and devtools_ui_bindings.cc).
//
// The front-end is Chromium's own build (repack.mjs puts it in
// devtools-frontend.zip next to omni.ja; it is read only when DevTools first
// opens). It is loaded into a content <browser> that covers the tab's whole
// content area, and, like Chrome, the front-end draws the split itself and
// tells the embedder where the inspected page goes (setInspectedPageBounds);
// the page's <browser> is placed there on top of it.
//
// The front-end talks to its embedder through `DevToolsHost`, a native object
// in Chrome, and Chrome's devtools_compatibility.js builds
// InspectorFrontendHost on top of it. Here DevToolsHost is defined in the
// front-end's window before its scripts run and devtools_compatibility.js is
// run after it, as Chrome does. Protocol messages go straight to a CDP
// Session (Session.sys.mjs) with no socket in between.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Session: "resource:///modules/firedog/devtools/Session.sys.mjs",
  Targets: "resource:///modules/firedog/devtools/Targets.sys.mjs",
});

const FRONTEND_HOST = "firedog-devtools";
// can_dock tells the front-end it can be docked, as Chrome's URL does;
// without it the front-end lays itself out as a separate window with no room
// for the page.
const FRONTEND_URL = `resource://${FRONTEND_HOST}/devtools_app.html?can_dock=true`;
// The front-end's settings, kept as Chrome keeps them in the profile's
// preferences: one JSON object of string values.
const PREFERENCES_PREF = "firedog.devtools.frontend-preferences";
// The dock side Chrome starts with when nothing is stored.
const DEFAULT_DOCK_SIDE = "right";

let substitutionReady = false;
function registerFrontend() {
  if (substitutionReady) {
    return;
  }
  const archive = Services.dirsvc.get("GreD", Ci.nsIFile);
  archive.append("devtools-frontend.zip");
  const handler = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler);
  handler.setSubstitution(
    FRONTEND_HOST,
    Services.io.newURI(`jar:${Services.io.newFileURI(archive).spec}!/`)
  );
  substitutionReady = true;
}

let compatibilitySource = null;
async function compatibilityScript() {
  if (compatibilitySource === null) {
    const response = await fetch(`resource://${FRONTEND_HOST}/devtools_compatibility.js`);
    compatibilitySource = await response.text();
  }
  return compatibilitySource;
}

function readPreferences() {
  try {
    return JSON.parse(Services.prefs.getStringPref(PREFERENCES_PREF, "{}"));
  } catch {
    return {};
  }
}

function writePreferences(preferences) {
  Services.prefs.setStringPref(PREFERENCES_PREF, JSON.stringify(preferences));
}

// The transport a Session reads and writes (the shape of a WebSocket's).
class EmbedderTransport {
  constructor(deliver) {
    this.deliver = deliver;
    this.listeners = { message: new Set(), close: new Set() };
  }

  addEventListener(type, listener) {
    this.listeners[type]?.add(listener);
  }

  send(text) {
    this.deliver(text);
  }

  receive(text) {
    for (const listener of this.listeners.message) {
      listener({ data: text });
    }
  }

  close() {
    for (const listener of this.listeners.close) {
      listener();
    }
  }
}

const windows = new WeakMap();

class DevToolsWindow {
  constructor(tab) {
    this.tab = tab;
    // ownerGlobal is not defined on chrome elements in this build.
    this.chromeWindow = tab.ownerDocument.defaultView;
    this.gBrowser = this.chromeWindow.gBrowser;
    this.pageBrowser = tab.linkedBrowser;
    this.ready = false;
    this.pending = [];
  }

  get frontendWindow() {
    return this.browser?.contentWindow ?? null;
  }

  // The front-end's DevToolsAPI, from the embedder's side.
  get api() {
    return Cu.waiveXrays(this.frontendWindow)?.DevToolsAPI;
  }

  async open() {
    registerFrontend();
    // devtools_compatibility.js must run before the front-end's modules, so
    // it is read before the front-end starts loading.
    this.compatibility = await compatibilityScript();
    const document = this.chromeWindow.document;
    const stack = this.gBrowser
      .getBrowserContainer(this.pageBrowser)
      .querySelector(".browserStack");
    const browser = document.createXULElement("browser");
    browser.setAttribute("type", "content");
    browser.setAttribute("disableglobalhistory", "true");
    browser.setAttribute("messagemanagergroup", "firedog-devtools");
    browser.className = "firedog-devtools-browser";
    stack.prepend(browser);
    this.browser = browser;
    this.stack = stack;
    // The page keeps the whole content area, covering the front-end's
    // browser, until the front-end has laid itself out and sends its first
    // setInspectedPageBounds; Chrome likewise shows docked DevTools only once
    // the front-end has loaded (DevToolsWindow::ScheduleShow). Taking the
    // page out of the layout here left the content area blank for the
    // seconds the front-end takes to load.
    this.observer = (subject, topic) => this.onDocument(subject, topic);
    Services.obs.addObserver(this.observer, "document-element-inserted");
    browser.loadURI(Services.io.newURI(FRONTEND_URL), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    this.transport = new EmbedderTransport(text => this.dispatchToFrontend(text));
    this.session = lazy.Session.attach(
      this.transport,
      lazy.Targets.forBrowser(this.pageBrowser)
    );
  }

  onDocument(document) {
    const win = document.defaultView;
    if (!win || win.browsingContext !== this.browser?.browsingContext) {
      return;
    }
    this.installHost(win);
  }

  installHost(win) {
    const host = Cu.createObjectIn(win, { defineAs: "DevToolsHost" });
    const define = (name, fn) =>
      Cu.exportFunction(fn, host, { defineAs: name });
    define("sendMessageToEmbedder", text => this.onEmbedderMessage(String(text)));
    define("copyText", text => {
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper)
        .copyString(String(text));
    });
    define("isHostedMode", () => false);
    // FireDog uses the Mac's modifier keys (⌘ as the accelerator), so the
    // front-end's shortcuts and labels are its Mac ones.
    define("platform", () => "mac");
    define("zoomFactor", () => this.browser.fullZoom);
    define("showContextMenuAtPoint", (x, y, items) =>
      this.showContextMenu(x, y, Cu.cloneInto(items, {}))
    );
    define("upgradeDraggedFileSystemPermissions", () => {});
    define("isolatedFileSystem", () => null);
    // devtools_compatibility.js runs in the front-end's own realm, before its
    // modules, so InspectorFrontendHost exists when they load.
    const sandbox = Cu.Sandbox(win, {
      sandboxPrototype: win,
      wantXrays: false,
      sameZoneAs: win,
    });
    Cu.evalInSandbox(
      this.compatibility,
      sandbox,
      "latest",
      `resource://${FRONTEND_HOST}/devtools_compatibility.js`,
      1
    );
  }

  // Protocol messages and embedder replies, delivered the way
  // DevToolsUIBindings delivers them.
  dispatchToFrontend(text) {
    const api = this.api;
    if (!api) {
      this.pending.push(text);
      return;
    }
    api.dispatchMessage(text);
  }

  ack(id, value) {
    if (!id) {
      return;
    }
    const win = this.frontendWindow;
    this.api?.embedderMessageAck(
      id,
      value === undefined ? undefined : Cu.cloneInto(value, win)
    );
  }

  onEmbedderMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const { id, method, params = [] } = message;
    const handler = this.embedder[method];
    if (!handler) {
      // Chrome ignores methods it does not know (and so does its
      // dispatcher for wrong arguments), replying nothing.
      this.ack(id);
      return;
    }
    Promise.resolve(handler.apply(this, params)).then(
      result => this.ack(id, result),
      error => {
        console.error(`FireDog DevTools: embedder ${method}`, error);
        this.ack(id);
      }
    );
  }

  // Runs `action` with the front-end's InspectorFrontendAPI once it has
  // loaded (Chrome queues the same calls in DevToolsWindow until then).
  whenLoaded(action) {
    if (this.ready) {
      action(Cu.waiveXrays(this.frontendWindow).InspectorFrontendAPI);
    } else {
      (this.onLoaded ??= []).push(action);
    }
  }

  // Chrome's "Inspect": the renderer reports the element as
  // Overlay.inspectNodeRequested, and the front-end selects it in Elements.
  inspectNode(node) {
    if (!node) {
      return;
    }
    this.whenLoaded(() => {
      this.session.domain("Overlay")?.whenEnabled(() => {
        const dom = this.session.domain("DOM");
        const backendNodeId = dom?._backendNodeIdFor?.(node);
        if (backendNodeId) {
          this.session.emit("Overlay.inspectNodeRequested", { backendNodeId });
        }
      });
    });
  }

  setInspectedPageBounds({ x, y, width, height }) {
    this.pageBrowser.classList.add("firedog-devtools-inspected");
    const style = this.pageBrowser.style;
    style.marginInlineStart = `${x}px`;
    style.marginTop = `${y}px`;
    style.width = `${width}px`;
    style.height = `${height}px`;
    style.flex = "none";
  }

  showContextMenu(x, y, items) {
    const document = this.chromeWindow.document;
    let popup = document.getElementById("firedog-devtools-context-menu");
    if (!popup) {
      popup = document.createXULElement("menupopup");
      popup.id = "firedog-devtools-context-menu";
      document.getElementById("mainPopupSet").append(popup);
    }
    popup.replaceChildren();
    const build = (parent, entries) => {
      for (const item of entries) {
        if (item.type === "separator") {
          parent.append(document.createXULElement("menuseparator"));
        } else if (item.type === "subMenu") {
          const menu = document.createXULElement("menu");
          menu.setAttribute("label", item.label ?? "");
          const sub = document.createXULElement("menupopup");
          build(sub, item.subItems ?? []);
          menu.append(sub);
          parent.append(menu);
        } else {
          const entry = document.createXULElement("menuitem");
          entry.setAttribute("label", item.label ?? "");
          if (item.type === "checkbox") {
            entry.setAttribute("type", "checkbox");
            if (item.checked) {
              entry.setAttribute("checked", "true");
            }
          }
          if (item.enabled === false) {
            entry.setAttribute("disabled", "true");
          }
          entry.addEventListener("command", () => this.api?.contextMenuItemSelected(item.id));
          parent.append(entry);
        }
      }
    };
    build(popup, items);
    popup.addEventListener("popuphidden", () => this.api?.contextMenuCleared(), { once: true });
    const rect = this.browser.getBoundingClientRect();
    popup.openPopupAtScreen(
      this.chromeWindow.mozInnerScreenX + rect.left + x,
      this.chromeWindow.mozInnerScreenY + rect.top + y,
      true
    );
  }

  close() {
    Services.obs.removeObserver(this.observer, "document-element-inserted");
    this.transport.close();
    this.browser.remove();
    const style = this.pageBrowser.style;
    for (const name of ["marginInlineStart", "marginTop", "width", "height", "flex"]) {
      style[name] = "";
    }
    this.pageBrowser.classList.remove("firedog-devtools-inspected");
    windows.delete(this.tab);
  }
}

// The embedder messages of Chrome's DevToolsEmbedderMessageDispatcher that
// FireDog answers. Usage metrics (record*) are acknowledged without being
// recorded: FireDog collects none.
DevToolsWindow.prototype.embedder = {
  dispatchProtocolMessage(message) {
    this.transport.receive(message);
  },
  loadCompleted() {
    this.ready = true;
    for (const text of this.pending.splice(0)) {
      this.dispatchToFrontend(text);
    }
    for (const action of this.onLoaded?.splice(0) ?? []) {
      action(Cu.waiveXrays(this.frontendWindow).InspectorFrontendAPI);
    }
  },
  setInspectedPageBounds(bounds) {
    this.setInspectedPageBounds(bounds);
  },
  setIsDocked() {},
  bringToFront() {
    this.gBrowser.selectedTab = this.tab;
  },
  closeWindow() {
    this.close();
  },
  inspectedURLChanged() {},
  inspectElementCompleted() {},
  openInNewTab(url) {
    this.gBrowser.addTab(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      relatedToCurrent: true,
      inBackground: false,
    });
  },
  setWhitelistedShortcuts() {},
  zoomIn() {
    this.browser.fullZoom = Math.min(this.browser.fullZoom * 1.1, 5);
  },
  zoomOut() {
    this.browser.fullZoom = Math.max(this.browser.fullZoom / 1.1, 0.25);
  },
  resetZoom() {
    this.browser.fullZoom = 1;
  },
  registerPreference() {},
  getPreferences() {
    const preferences = readPreferences();
    preferences.currentDockState ??= JSON.stringify(DEFAULT_DOCK_SIDE);
    // The front-end starts in English and offers the browser's language in an
    // infobar. FireDog's own UI is in the browser's language, and a learner's
    // profile may not outlive the session, so DevTools starts the way "Always
    // match Chrome's language" leaves it.
    preferences.language ??= JSON.stringify("browserLanguage");
    return preferences;
  },
  getPreference(name) {
    return readPreferences()[name];
  },
  setPreference(name, value) {
    const preferences = readPreferences();
    preferences[name] = value;
    writePreferences(preferences);
  },
  removePreference(name) {
    const preferences = readPreferences();
    delete preferences[name];
    writePreferences(preferences);
  },
  clearPreferences() {
    writePreferences({});
  },
  getHostConfig() {
    return {};
  },
  // FireDog has no browser account, as Chrome without one signed in.
  getSyncInformation() {
    return { isSyncActive: false, arePreferencesSynced: false };
  },
  // What the front-end reads besides the protocol (source maps, a script's
  // original file), fetched by the browser as Chrome's DevToolsUIBindings
  // does and written to the front-end's stream before the reply.
  async loadNetworkResource(url, headers, streamId) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { statusCode: 404, urlValid: false };
    }
    const requestHeaders = new Headers();
    for (const line of String(headers ?? "").split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon > 0) {
        requestHeaders.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }
    }
    let response;
    try {
      response = await fetch(parsed.href, { headers: requestHeaders, credentials: "include" });
    } catch {
      return { statusCode: 404, netError: -2, netErrorName: "net::ERR_FAILED", urlValid: true };
    }
    const text = await response.text();
    if (text) {
      this.api?.streamWrite(streamId, text, false);
    }
    return {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers),
      urlValid: true,
    };
  },
  // The workspace's folders: FireDog keeps none, so the list is empty.
  requestFileSystems() {
    this.whenLoaded(api => api.fileSystemsLoaded?.(Cu.cloneInto([], this.frontendWindow)));
  },
  connectAutomaticFileSystem() {
    return { success: false };
  },
  disconnectAutomaticFileSystem() {},
  reattach() {},
  showSurvey() {
    return { surveyShown: false };
  },
  // The AI assistance and the Google services behind it are Chrome's own.
  doAidaConversation() {
    return { error: "Not implemented" };
  },
  aidaCodeComplete() {
    return { error: "Not implemented" };
  },
  registerAidaClientEvent() {
    return { error: "Not implemented" };
  },
  dispatchHttpRequest() {
    return { error: "Not implemented" };
  },
  connectionReady() {},
  readyForTest() {},
  canShowSurvey() {
    return { canShowSurvey: false };
  },
  recordCountHistogram() {},
  recordEnumeratedHistogram() {},
  recordPerformanceHistogram() {},
  recordPerformanceHistogramMedium() {},
  recordUserMetricsAction() {},
  recordNewBadgeUsage() {},
  recordImpression() {},
  recordResize() {},
  recordClick() {},
  recordHover() {},
  recordDrag() {},
  recordChange() {},
  recordKeyDown() {},
  recordSettingAccess() {},
  recordFunctionCall() {},
};

export const DevTools = {
  // Opens DevTools for a tab, or closes it if open (F12, ⌥⌘I).
  toggle(tab) {
    const open = windows.get(tab);
    if (open) {
      open.close();
      return null;
    }
    return this.open(tab);
  },

  open(tab) {
    let devtools = windows.get(tab);
    if (!devtools) {
      devtools = new DevToolsWindow(tab);
      windows.set(tab, devtools);
      devtools.open().catch(error => {
        console.error("FireDog DevTools: open", error);
        windows.delete(tab);
      });
    }
    return devtools;
  },

  isOpen(tab) {
    return windows.has(tab);
  },
};
