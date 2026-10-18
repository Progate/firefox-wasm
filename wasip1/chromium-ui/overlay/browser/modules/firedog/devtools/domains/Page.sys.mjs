/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Page domain: the frame tree, navigation and the page's lifecycle.
//
// Single-process Gecko delivers the page's events to its <browser> element
// (the docshell's chrome event handler), so DOMContentLoaded and load are
// listened to there, and navigation comes from the browser's web progress.

import { frameIdOf } from "resource:///modules/firedog/devtools/domains/Runtime.sys.mjs";
import { ProtocolError } from "resource:///modules/firedog/devtools/Session.sys.mjs";

// CDP's MonotonicTime is seconds on a clock that never goes back; every
// domain uses ChromeUtils.now() so that Page and Network timestamps line up.
export const monotonicTime = () => ChromeUtils.now() / 1000;

// Chromium's loaderId is the id of the navigation request that loaded the
// document, so a document loaded by a channel takes its id from the
// channel's channelId (which Network also uses for the request's id; Gecko
// keeps it across redirects).
export function loaderIdOfChannelId(channelId) {
  return channelId.toString(16).toUpperCase().padStart(32, "0");
}

const loaderIds = new WeakMap();
export function loaderIdOf(document) {
  let id = loaderIds.get(document);
  if (!id) {
    let channelId = 0;
    try {
      // The docShell knows the channel of its current document only.
      const win = document.defaultView;
      const channel = win?.document === document ? win.docShell?.currentDocumentChannel : null;
      channelId = channel?.QueryInterface(Ci.nsIIdentChannel).channelId ?? 0;
    } catch {
      // Documents without a channel (the initial about:blank) get a fresh id.
    }
    id = channelId
      ? loaderIdOfChannelId(channelId)
      : Services.uuid.generateUUID().toString().replace(/[{}-]/g, "").toUpperCase();
    loaderIds.set(document, id);
  }
  return id;
}

// PerformanceResourceTiming's initiatorType to Page.ResourceType.
const RESOURCE_TYPES = {
  script: "Script",
  link: "Stylesheet",
  css: "Stylesheet",
  img: "Image",
  image: "Image",
  imageset: "Image",
  video: "Media",
  audio: "Media",
  track: "TextTrack",
  fetch: "Fetch",
  xmlhttprequest: "XHR",
  beacon: "Ping",
  iframe: "Document",
  frame: "Document",
};

const GUESSED_MIME = {
  Script: "text/javascript",
  Stylesheet: "text/css",
  Document: "text/html",
};

function secureContextType(win) {
  if (win.isSecureContext) {
    const host = win.location.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]"
      ? "SecureLocalhost"
      : "Secure";
  }
  const parent = win.parent !== win ? win.parent : null;
  return parent && !parent.isSecureContext ? "InsecureAncestor" : "InsecureScheme";
}

export class Page {
  constructor(session) {
    this.session = session;
    this.target = session.target;
    this.enabled = false;
    this.lifecycleEvents = false;
    this.scriptsOnNewDocument = new Map();
    this.nextScriptId = 1;
  }

  _frame(browsingContext) {
    const win = browsingContext.window;
    const document = win.document;
    const url = new URL(document.URL);
    const fragment = url.hash;
    url.hash = "";
    const principal = document.nodePrincipal;
    let domainAndRegistry = "";
    try {
      domainAndRegistry = Services.eTLD.getBaseDomainFromHost(url.hostname);
    } catch {
      // IP addresses and hosts without a public suffix have none.
    }
    const parent = browsingContext.parent;
    return {
      id: frameIdOf(this.target, browsingContext),
      ...(parent ? { parentId: frameIdOf(this.target, parent) } : {}),
      loaderId: loaderIdOf(document),
      name: browsingContext.name ?? "",
      url: url.href,
      ...(fragment ? { urlFragment: fragment } : {}),
      domainAndRegistry,
      securityOrigin: principal.isNullPrincipal ? "://" : principal.origin,
      mimeType: document.contentType,
      adFrameStatus: { adFrameType: "none" },
      secureContextType: secureContextType(win),
      crossOriginIsolatedContextType: win.crossOriginIsolated ? "Isolated" : "NotIsolated",
      gatedAPIFeatures: [],
    };
  }

  _frameTree(browsingContext, withResources) {
    const tree = { frame: this._frame(browsingContext) };
    if (withResources) {
      tree.resources = this._resources(browsingContext.window);
    }
    const children = browsingContext.children
      .filter(child => child.window)
      .map(child => this._frameTree(child, withResources));
    if (children.length) {
      tree.childFrames = children;
    }
    return tree;
  }

  // The subresources the document loaded, from its resource timing entries
  // (Chromium lists the frame's resources from its memory cache).
  _resources(win) {
    const seen = new Set();
    const resources = [];
    for (const entry of win.performance.getEntriesByType("resource")) {
      if (seen.has(entry.name)) {
        continue;
      }
      seen.add(entry.name);
      const type = RESOURCE_TYPES[entry.initiatorType] ?? "Other";
      resources.push({
        url: entry.name,
        type,
        mimeType: GUESSED_MIME[type] ?? "",
        ...(entry.decodedBodySize ? { contentSize: entry.decodedBodySize } : {}),
      });
    }
    return resources;
  }

  _listen() {
    if (this.listening) {
      return;
    }
    this.listening = true;
    const browser = this.target.browser;
    this.onEvent = event => this._onEvent(event);
    browser.addEventListener("DOMContentLoaded", this.onEvent, true);
    browser.addEventListener("load", this.onEvent, true);
    this.progress = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
      onStateChange: (webProgress, request, flags) => {
        const isDocument = flags & Ci.nsIWebProgressListener.STATE_IS_DOCUMENT;
        if (!isDocument || !webProgress.browsingContext) {
          return;
        }
        const frameId = frameIdOf(this.target, webProgress.browsingContext);
        if (flags & Ci.nsIWebProgressListener.STATE_START) {
          this._emit("Page.frameStartedLoading", { frameId });
        } else if (flags & Ci.nsIWebProgressListener.STATE_STOP) {
          this._emit("Page.frameStoppedLoading", { frameId });
        }
      },
      onLocationChange: (webProgress, request, location, flags) => {
        const context = webProgress.browsingContext;
        if (!context?.window) {
          return;
        }
        if (flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) {
          this._emit("Page.navigatedWithinDocument", {
            frameId: frameIdOf(this.target, context),
            url: location.spec,
            navigationType: "other",
          });
          return;
        }
        this._emit("Page.frameNavigated", {
          frame: this._frame(context),
          type: "Navigation",
        });
      },
      onProgressChange() {},
      onStatusChange() {},
      onSecurityChange() {},
      onContentBlockingEvent() {},
    };
    browser.webProgress.addProgressListener(
      this.progress,
      Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT | Ci.nsIWebProgress.NOTIFY_LOCATION
    );
    Services.obs.addObserver(this, "document-element-inserted");
  }

  _emit(method, params) {
    if (this.enabled) {
      this.session.emit(method, params);
    }
  }

  _onEvent(event) {
    const document = event.target;
    if (!(document?.defaultView) || document.defaultView.browsingContext?.top !== this.target.browsingContext) {
      return;
    }
    const isMain = document.defaultView.browsingContext === this.target.browsingContext;
    const timestamp = monotonicTime();
    const frameId = frameIdOf(this.target, document.defaultView.browsingContext);
    if (event.type === "DOMContentLoaded") {
      if (isMain) {
        this._emit("Page.domContentEventFired", { timestamp });
      }
      this._lifecycle(frameId, document, "DOMContentLoaded", timestamp);
    } else if (event.type === "load" && event.target === document) {
      if (isMain) {
        this._emit("Page.loadEventFired", { timestamp });
      }
      this._lifecycle(frameId, document, "load", timestamp);
    }
  }

  _lifecycle(frameId, document, name, timestamp) {
    if (this.lifecycleEvents) {
      this._emit("Page.lifecycleEvent", {
        frameId,
        loaderId: loaderIdOf(document),
        name,
        timestamp,
      });
    }
  }

  // Scripts added with addScriptToEvaluateOnNewDocument run when a new
  // document of the page gets its root element, before its own scripts.
  observe(subject, topic) {
    if (topic !== "document-element-inserted") {
      return;
    }
    const win = subject.defaultView;
    if (!win || win.browsingContext?.top !== this.target.browsingContext) {
      return;
    }
    const frameId = frameIdOf(this.target, win.browsingContext);
    this._lifecycle(frameId, subject, "init", monotonicTime());
    if (!this.scriptsOnNewDocument.size) {
      return;
    }
    const runtime = this.session.domain("Runtime");
    const global = runtime._debuggee(win);
    for (const { source } of this.scriptsOnNewDocument.values()) {
      global.executeInGlobal(source, { url: "" });
    }
  }

  enable() {
    this.enabled = true;
    this._listen();
  }

  disable() {
    this.enabled = false;
  }

  getFrameTree() {
    return { frameTree: this._frameTree(this.target.browsingContext, false) };
  }

  getResourceTree() {
    return { frameTree: this._frameTree(this.target.browsingContext, true) };
  }

  getResourceContent({ frameId, url }) {
    // Served from the HTTP cache by Network, which has the bodies.
    return this.session.domain("Network")._resourceContent(frameId, url);
  }

  reload({ ignoreCache = false } = {}) {
    this.target.browser.reloadWithFlags(
      ignoreCache
        ? Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE |
            Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_PROXY
        : Ci.nsIWebNavigation.LOAD_FLAGS_NONE
    );
  }

  navigate({ url }) {
    let uri;
    try {
      uri = Services.io.newURI(url);
    } catch {
      throw new ProtocolError("Cannot navigate to invalid URL", -32000);
    }
    this.target.browser.loadURI(uri, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    return { frameId: this.target.id };
  }

  getNavigationHistory() {
    const history = this.target.browsingContext.sessionHistory;
    const entries = [];
    for (let i = 0; i < history.count; i++) {
      const entry = history.getEntryAtIndex(i);
      entries.push({
        id: entry.ID,
        url: entry.URI.spec,
        userTypedURL: entry.originalURI?.spec ?? entry.URI.spec,
        title: entry.title || entry.URI.spec,
        transitionType: "link",
      });
    }
    return { currentIndex: history.index, entries };
  }

  navigateToHistoryEntry({ entryId }) {
    const history = this.target.browsingContext.sessionHistory;
    for (let i = 0; i < history.count; i++) {
      if (history.getEntryAtIndex(i).ID === entryId) {
        this.target.browser.gotoIndex(i);
        return;
      }
    }
    throw new ProtocolError("No entry with passed id");
  }

  addScriptToEvaluateOnNewDocument({ source }) {
    const identifier = String(this.nextScriptId++);
    this.scriptsOnNewDocument.set(identifier, { source });
    this._listen();
    return { identifier };
  }

  removeScriptToEvaluateOnNewDocument({ identifier }) {
    this.scriptsOnNewDocument.delete(identifier);
  }

  setLifecycleEventsEnabled({ enabled }) {
    this.lifecycleEvents = enabled;
  }

  // FireDog has no ad filter, so it can only be off.
  setAdBlockingEnabled({ enabled }) {
    if (enabled) {
      throw new ProtocolError("Ad blocking is not available");
    }
  }

  bringToFront() {
    this.target.window.gBrowser.selectedTab = this.target.tab;
    this.target.window.focus();
  }

  getLayoutMetrics() {
    const win = this.target.contentWindow;
    const scale = win.devicePixelRatio;
    const viewport = win.visualViewport;
    const root = win.document.documentElement;
    const cssLayoutViewport = {
      pageX: Math.round(win.scrollX),
      pageY: Math.round(win.scrollY),
      clientWidth: root.clientWidth,
      clientHeight: root.clientHeight,
    };
    const cssVisualViewport = {
      offsetX: viewport.offsetLeft,
      offsetY: viewport.offsetTop,
      pageX: viewport.pageLeft,
      pageY: viewport.pageTop,
      clientWidth: viewport.width,
      clientHeight: viewport.height,
      scale: viewport.scale,
      zoom: 1,
    };
    const cssContentSize = {
      x: 0,
      y: 0,
      width: root.scrollWidth,
      height: root.scrollHeight,
    };
    return {
      layoutViewport: {
        ...cssLayoutViewport,
        clientWidth: Math.round(cssLayoutViewport.clientWidth * scale),
        clientHeight: Math.round(cssLayoutViewport.clientHeight * scale),
      },
      visualViewport: {
        ...cssVisualViewport,
        clientWidth: cssVisualViewport.clientWidth * scale,
        clientHeight: cssVisualViewport.clientHeight * scale,
      },
      contentSize: {
        ...cssContentSize,
        width: cssContentSize.width * scale,
        height: cssContentSize.height * scale,
      },
      cssLayoutViewport,
      cssVisualViewport,
      cssContentSize,
    };
  }

  // The page as it is on screen, overlay included (Gecko's drawWindow of the
  // view), as Chromium captures from its compositor surface.
  captureScreenshot({ format = "png", quality, clip, captureBeyondViewport = false } = {}) {
    if (!["png", "jpeg", "webp"].includes(format)) {
      throw new ProtocolError("Invalid format");
    }
    const win = this.target.contentWindow;
    let x = 0;
    let y = 0;
    let width = win.innerWidth;
    let height = win.innerHeight;
    let scale = 1;
    let flags = 0;
    if (clip) {
      ({ x, y, width, height } = clip);
      scale = clip.scale ?? 1;
      // A clip is in page coordinates.
      x -= win.scrollX;
      y -= win.scrollY;
    }
    if (captureBeyondViewport) {
      const root = win.document.documentElement;
      if (!clip) {
        width = root.scrollWidth;
        height = root.scrollHeight;
      }
      x += win.scrollX;
      y += win.scrollY;
    } else {
      // DRAWWINDOW_DRAW_VIEW: what the view shows, with the overlay.
      flags |= 0x04;
    }
    const ratio = win.devicePixelRatio * scale;
    const canvas = this.target.window.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    const context = canvas.getContext("2d");
    context.scale(ratio, ratio);
    context.drawWindow(win, x, y, width, height, "white", flags);
    const url = canvas.toDataURL(`image/${format}`, quality === undefined ? undefined : quality / 100);
    return { data: url.slice(url.indexOf(",") + 1) };
  }

  _destroy() {
    if (!this.listening) {
      return;
    }
    const browser = this.target.browser;
    browser.removeEventListener("DOMContentLoaded", this.onEvent, true);
    browser.removeEventListener("load", this.onEvent, true);
    browser.webProgress?.removeProgressListener(this.progress);
    Services.obs.removeObserver(this, "document-element-inserted");
  }
}
