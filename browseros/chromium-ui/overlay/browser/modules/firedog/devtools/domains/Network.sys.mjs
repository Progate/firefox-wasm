/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Network domain: the page's requests, as Chromium's network agent
// reports them, observed with the Firefox DevTools NetworkObserver.
//
// FireDog runs single-process, so the page's channels are opened in this
// process and NetworkObserver sees all of them (headers on the wire, timings,
// bodies through a stream tee, cache hits, failures). Each observed request
// becomes a NetworkRequest that turns NetworkObserver's callbacks into
// Chromium's event sequence: requestWillBeSent, requestWillBeSentExtraInfo,
// responseReceivedExtraInfo, responseReceived, dataReceived and
// loadingFinished or loadingFailed. Redirects keep the requestId, as in
// Chromium, because Gecko keeps the channelId across redirects.

import {
  loaderIdOf,
  loaderIdOfChannelId,
  monotonicTime,
} from "resource:///modules/firedog/devtools/domains/Page.sys.mjs";
import { frameIdOf } from "resource:///modules/firedog/devtools/domains/Runtime.sys.mjs";
import {
  InvalidParams,
  ProtocolError,
} from "resource:///modules/firedog/devtools/Session.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  NetworkHelper: "resource://devtools/shared/network-observer/NetworkHelper.sys.mjs",
  NetworkObserver: "resource://devtools/shared/network-observer/NetworkObserver.sys.mjs",
  NetworkUtils: "resource://devtools/shared/network-observer/NetworkUtils.sys.mjs",
  wildcardToRegExp: "resource://devtools/shared/network-observer/WildcardToRegexp.sys.mjs",
});

// Chromium keeps bodies up to these sizes when Network.enable does not say.
const DEFAULT_TOTAL_BUFFER = 100 * 1024 * 1024;
const DEFAULT_RESOURCE_BUFFER = 10 * 1024 * 1024;
// Requests remembered for getResponseBody and Page.getResourceContent after
// they finished; the oldest are forgotten first.
const MAX_REQUESTS = 3000;

// Wall-clock milliseconds (PRTime / 1000, Date.now()) to CDP MonotonicTime.
const epochToMonotonic = ms => monotonicTime() - (Date.now() - ms) / 1000;

const CP = Ci.nsIContentPolicy;

// nsIContentPolicy types to Network.ResourceType. Internal types are checked
// first because they tell apart loads that share an external type.
const INTERNAL_TYPES = new Map([
  [CP.TYPE_INTERNAL_EVENTSOURCE, "EventSource"],
  [CP.TYPE_INTERNAL_TRACK, "TextTrack"],
]);
const EXTERNAL_TYPES = new Map([
  [CP.TYPE_DOCUMENT, "Document"],
  [CP.TYPE_SUBDOCUMENT, "Document"],
  [CP.TYPE_STYLESHEET, "Stylesheet"],
  [CP.TYPE_SCRIPT, "Script"],
  [CP.TYPE_IMAGE, "Image"],
  [CP.TYPE_IMAGESET, "Image"],
  [CP.TYPE_FONT, "Font"],
  [CP.TYPE_MEDIA, "Media"],
  [CP.TYPE_XMLHTTPREQUEST, "XHR"],
  [CP.TYPE_FETCH, "Fetch"],
  [CP.TYPE_PING, "Ping"],
  [CP.TYPE_BEACON, "Ping"],
  [CP.TYPE_WEB_MANIFEST, "Manifest"],
  [CP.TYPE_WEBSOCKET, "WebSocket"],
  [CP.TYPE_CSP_REPORT, "CSPViolationReport"],
  [CP.TYPE_WEB_IDENTITY, "FedCM"],
]);

function resourceTypeOf(loadInfo) {
  return (
    INTERNAL_TYPES.get(loadInfo.internalContentPolicyType) ??
    EXTERNAL_TYPES.get(loadInfo.externalContentPolicyType) ??
    "Other"
  );
}

function isDocumentLoad(loadInfo) {
  const type = loadInfo.externalContentPolicyType;
  return type === CP.TYPE_DOCUMENT || type === CP.TYPE_SUBDOCUMENT;
}

// nsISupportsPriority (-20 highest .. 20 lowest) to Network.ResourcePriority.
function priorityOf(channel) {
  const priority = lazy.NetworkUtils.getChannelPriority(channel);
  if (priority === null || priority === undefined) {
    return "Medium";
  }
  if (priority <= Ci.nsISupportsPriority.PRIORITY_HIGHEST) {
    return "VeryHigh";
  }
  if (priority < Ci.nsISupportsPriority.PRIORITY_NORMAL) {
    return "High";
  }
  if (priority === Ci.nsISupportsPriority.PRIORITY_NORMAL) {
    return "Medium";
  }
  if (priority < Ci.nsISupportsPriority.PRIORITY_LOWEST) {
    return "Low";
  }
  return "VeryLow";
}

// Gecko's network.http.referer.defaultPolicy values, used when a request has
// no explicit policy.
const DEFAULT_REFERRER_POLICIES = [
  "no-referrer",
  "same-origin",
  "strict-origin-when-cross-origin",
  "no-referrer-when-downgrade",
];

function referrerPolicyOf(channel) {
  const policy = lazy.NetworkUtils.getReferrerPolicy(channel);
  if (policy) {
    return policy;
  }
  const pref = Services.prefs.getIntPref("network.http.referer.defaultPolicy", 2);
  return DEFAULT_REFERRER_POLICIES[pref] ?? "strict-origin-when-cross-origin";
}

// Gecko's failure statuses to Chromium's net error names, which the
// front-end shows as "(failed) net::ERR_...". Unlisted failures are
// net::ERR_FAILED, Chromium's generic error.
const NET_ERRORS = {
  NS_BINDING_ABORTED: "net::ERR_ABORTED",
  NS_ERROR_ABORT: "net::ERR_ABORTED",
  NS_BINDING_FAILED: "net::ERR_FAILED",
  NS_ERROR_CONNECTION_REFUSED: "net::ERR_CONNECTION_REFUSED",
  NS_ERROR_PROXY_CONNECTION_REFUSED: "net::ERR_PROXY_CONNECTION_FAILED",
  NS_ERROR_UNKNOWN_HOST: "net::ERR_NAME_NOT_RESOLVED",
  NS_ERROR_UNKNOWN_PROXY_HOST: "net::ERR_PROXY_CONNECTION_FAILED",
  NS_ERROR_OFFLINE: "net::ERR_INTERNET_DISCONNECTED",
  NS_ERROR_NET_TIMEOUT: "net::ERR_TIMED_OUT",
  NS_ERROR_NET_RESET: "net::ERR_CONNECTION_RESET",
  NS_ERROR_NET_INTERRUPT: "net::ERR_CONNECTION_CLOSED",
  NS_ERROR_NET_PARTIAL_TRANSFER: "net::ERR_CONNECTION_CLOSED",
  NS_ERROR_NET_EMPTY_RESPONSE: "net::ERR_EMPTY_RESPONSE",
  NS_ERROR_PORT_ACCESS_NOT_ALLOWED: "net::ERR_UNSAFE_PORT",
  NS_ERROR_MALFORMED_URI: "net::ERR_INVALID_URL",
  NS_ERROR_UNKNOWN_PROTOCOL: "net::ERR_UNKNOWN_URL_SCHEME",
  NS_ERROR_REDIRECT_LOOP: "net::ERR_TOO_MANY_REDIRECTS",
  NS_ERROR_CORRUPTED_CONTENT: "net::ERR_INVALID_RESPONSE",
  NS_ERROR_INVALID_CONTENT_ENCODING: "net::ERR_CONTENT_DECODING_FAILED",
  NS_ERROR_FILE_NOT_FOUND: "net::ERR_FILE_NOT_FOUND",
  NS_ERROR_DOCUMENT_NOT_CACHED: "net::ERR_CACHE_MISS",
  NS_ERROR_CONTENT_BLOCKED: "net::ERR_BLOCKED_BY_CLIENT",
  NS_ERROR_TRACKING_URI: "net::ERR_BLOCKED_BY_CLIENT",
  NS_ERROR_DOM_BAD_URI: "net::ERR_FAILED",
};

// Chromium's net error codes, for Network.loadNetworkResource.
const NET_ERROR_CODES = {
  "net::ERR_FAILED": -2,
  "net::ERR_ABORTED": -3,
  "net::ERR_FILE_NOT_FOUND": -6,
  "net::ERR_TIMED_OUT": -7,
  "net::ERR_BLOCKED_BY_CLIENT": -20,
  "net::ERR_BLOCKED_BY_CSP": -30,
  "net::ERR_CONNECTION_CLOSED": -100,
  "net::ERR_CONNECTION_RESET": -101,
  "net::ERR_CONNECTION_REFUSED": -102,
  "net::ERR_NAME_NOT_RESOLVED": -105,
  "net::ERR_INTERNET_DISCONNECTED": -106,
  "net::ERR_PROXY_CONNECTION_FAILED": -130,
  "net::ERR_INVALID_URL": -300,
  "net::ERR_UNKNOWN_URL_SCHEME": -302,
  "net::ERR_TOO_MANY_REDIRECTS": -310,
  "net::ERR_UNSAFE_PORT": -312,
  "net::ERR_INVALID_RESPONSE": -320,
  "net::ERR_EMPTY_RESPONSE": -324,
  "net::ERR_CONTENT_DECODING_FAILED": -330,
  "net::ERR_HTTP_RESPONSE_CODE_FAILURE": -379,
  "net::ERR_CACHE_MISS": -400,
};

// nsILoadInfo.BLOCKING_REASON_CORS* to Network.CorsError.
const CORS_ERRORS = {
  BLOCKING_REASON_CORSDISABLED: "DisallowedByMode",
  BLOCKING_REASON_CORSREQUESTNOTHTTP: "CorsDisabledScheme",
  BLOCKING_REASON_CORSMULTIPLEALLOWORIGINNOTALLOWED: "MultipleAllowOriginValues",
  BLOCKING_REASON_CORSMISSINGALLOWORIGIN: "MissingAllowOriginHeader",
  BLOCKING_REASON_CORSNOTSUPPORTINGCREDENTIALS: "WildcardOriginNotAllowed",
  BLOCKING_REASON_CORSALLOWORIGINNOTMATCHINGORIGIN: "AllowOriginMismatch",
  BLOCKING_REASON_CORSMISSINGALLOWCREDENTIALS: "InvalidAllowCredentials",
  BLOCKING_REASON_CORSORIGINHEADERNOTADDED: "InvalidResponse",
  BLOCKING_REASON_CORSEXTERNALREDIRECTNOTALLOWED: "RedirectContainsCredentials",
  BLOCKING_REASON_CORSPREFLIGHTDIDNOTSUCCEED: "PreflightInvalidStatus",
  BLOCKING_REASON_CORSINVALIDALLOWMETHOD: "InvalidAllowMethodsPreflightResponse",
  BLOCKING_REASON_CORSMETHODNOTFOUND: "MethodDisallowedByPreflightResponse",
  BLOCKING_REASON_CORSINVALIDALLOWHEADER: "InvalidAllowHeadersPreflightResponse",
  BLOCKING_REASON_CORSMISSINGALLOWHEADERFROMPREFLIGHT: "HeaderDisallowedByPreflightResponse",
};

// Whether the loading document's Content Security Policy is what refuses a
// channel (content policies other than CSP refuse with the same reason).
function blockedByCSP(channel) {
  const loadInfo = channel.loadInfo;
  try {
    const csp = loadInfo.loadingDocument?.policyContainer?.csp;
    if (!csp) {
      return false;
    }
    const decision = csp.shouldLoad(
      loadInfo.externalContentPolicyType,
      null,
      loadInfo,
      channel.URI,
      null,
      false
    );
    return decision !== Ci.nsIContentPolicy.ACCEPT;
  } catch {
    return false;
  }
}

let blockingReasonNames = null;
function blockingReasonName(value) {
  if (!blockingReasonNames) {
    blockingReasonNames = new Map();
    for (const name in Ci.nsILoadInfo) {
      if (name.startsWith("BLOCKING_REASON_")) {
        blockingReasonNames.set(Ci.nsILoadInfo[name], name);
      }
    }
  }
  return blockingReasonNames.get(value) ?? "";
}

// What loadingFailed says about a request Gecko stopped: NetworkObserver's
// blockedReason is either a nsILoadInfo blocking reason (CORS, CSP, content
// policies) or the name of the failure status. networkStatus is the status
// the channel had before CORS handling replaced it (see
// NetworkRequest._listenAsPage).
function failureOf(blockedReason, channel, networkStatus) {
  if (typeof blockedReason === "number" && blockedReason) {
    const name = blockingReasonName(blockedReason);
    // Gecko reports a cross-origin request that failed in the network (no
    // response at all) as a CORS failure; Chromium reports the network error.
    if (name === "BLOCKING_REASON_CORSDIDNOTSUCCEED") {
      return failureOf(
        networkStatus && !Components.isSuccessCode(networkStatus)
          ? ChromeUtils.getXPCOMErrorName(networkStatus)
          : "NS_BINDING_FAILED"
      );
    }
    if (CORS_ERRORS[name]) {
      return {
        errorText: "net::ERR_FAILED",
        corsErrorStatus: { corsError: CORS_ERRORS[name], failedParameter: "" },
      };
    }
    if (name === "BLOCKING_REASON_MIXED_BLOCKED") {
      return { errorText: "net::ERR_BLOCKED_BY_CLIENT", blockedReason: "mixed-content" };
    }
    if (name === "BLOCKING_REASON_NOT_SAME_ORIGIN") {
      return { errorText: "net::ERR_BLOCKED_BY_RESPONSE", blockedReason: "corp-not-same-origin" };
    }
    if (name.startsWith("BLOCKING_REASON_CONTENT_POLICY") && channel && blockedByCSP(channel)) {
      return { errorText: "net::ERR_BLOCKED_BY_CSP", blockedReason: "csp" };
    }
    return { errorText: "net::ERR_BLOCKED_BY_CLIENT", blockedReason: "other" };
  }
  let name = typeof blockedReason === "string" ? blockedReason : "";
  if (!name && channel) {
    try {
      name = ChromeUtils.getXPCOMErrorName(channel.status);
    } catch {
      // The channel is gone; report a generic failure.
    }
  }
  const errorText = NET_ERRORS[name] ?? "net::ERR_FAILED";
  return errorText === "net::ERR_ABORTED" ? { errorText, canceled: true } : { errorText };
}

// "Name: value" lines of a raw HTTP head to Network.Headers; repeated names
// are joined with "\n" as Chromium does.
function parseRawHeaders(raw) {
  const headers = {};
  const lines = (raw ?? "").split("\r\n");
  lines.shift();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    headers[name] = name in headers ? `${headers[name]}\n${value}` : value;
  }
  return headers;
}

function addHeader(headers, name, value) {
  headers[name] = name in headers ? `${headers[name]}\n${value}` : value;
}

function requestHeadersOf(channel) {
  const headers = {};
  try {
    channel.QueryInterface(Ci.nsIHttpChannel).visitRequestHeaders({
      visitHeader: (name, value) => addHeader(headers, name, value),
    });
  } catch {
    // Not an HTTP channel (data:).
  }
  return headers;
}

function responseHeadersOf(channel) {
  const headers = {};
  try {
    channel.QueryInterface(Ci.nsIHttpChannel).visitOriginalResponseHeaders({
      visitHeader: (name, value) => addHeader(headers, name, value),
    });
  } catch {
    try {
      channel.visitResponseHeaders({
        visitHeader: (name, value) => addHeader(headers, name, value),
      });
    } catch {
      // No response headers (data:, or the response never arrived).
    }
  }
  return headers;
}

function isTextMimeType(mimeType) {
  return !!mimeType && lazy.NetworkHelper.isTextMimeType(mimeType);
}

function concatChunks(chunks, length) {
  const bytes = new Uint8Array(length ?? chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    const view = new Uint8Array(chunk);
    bytes.set(view.subarray(0, bytes.length - offset), offset);
    offset += view.length;
    if (offset >= bytes.length) {
      break;
    }
  }
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function decodeText(bytes, charset) {
  let decoder;
  try {
    decoder = new TextDecoder(charset || "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}

// A body as getResponseBody returns it: text for textual types, like
// Chromium, and base64 for everything else.
export function bodyResult(bytes, mimeType, charset) {
  if (isTextMimeType(mimeType)) {
    return { body: decodeText(bytes, charset), base64Encoded: false };
  }
  return { body: bytesToBase64(bytes), base64Encoded: true };
}

// The bytes of a data: URL, which Gecko's data channel does not hand to
// NetworkObserver.
function dataURLBytes(url) {
  const comma = url.indexOf(",");
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  if (/;base64$/i.test(meta)) {
    const binary = atob(decodeURIComponent(payload).replace(/\s/g, ""));
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  }
  return new TextEncoder().encode(decodeURIComponent(payload));
}

function cookieSameSite(cookie) {
  switch (cookie.sameSite) {
    case Ci.nsICookie.SAMESITE_STRICT:
      return "Strict";
    case Ci.nsICookie.SAMESITE_LAX:
      return "Lax";
    case Ci.nsICookie.SAMESITE_NONE:
      return "None";
  }
  return undefined;
}

// An nsICookie as Network.Cookie. Gecko does not record the port that set a
// cookie, so sourcePort is -1 (unspecified).
export function cookieToCDP(cookie) {
  const sameSite = cookieSameSite(cookie);
  const scheme = cookie.schemeMap;
  const result = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.host,
    path: cookie.path,
    expires: cookie.isSession ? -1 : cookie.expires / 1000,
    size: cookie.name.length + cookie.value.length,
    httpOnly: cookie.isHttpOnly,
    secure: cookie.isSecure,
    session: cookie.isSession,
    ...(sameSite ? { sameSite } : {}),
    priority: "Medium",
    sourceScheme:
      scheme & Ci.nsICookie.SCHEME_HTTPS
        ? "Secure"
        : scheme & Ci.nsICookie.SCHEME_HTTP
          ? "NonSecure"
          : "Unset",
    sourcePort: -1,
  };
  const partitionKey = cookie.isPartitioned ? cookie.originAttributes.partitionKey : "";
  if (partitionKey) {
    // Gecko's partition key is "(scheme,baseDomain[,port][,ancestorBit])".
    const [scheme_, baseDomain, ...rest] = partitionKey.replace(/^\(|\)$/g, "").split(",");
    const port = rest.find(part => /^\d+$/.test(part));
    result.partitionKey = {
      topLevelSite: `${scheme_}://${baseDomain}${port ? ":" + port : ""}`,
      hasCrossSiteAncestor: rest.includes("f"),
    };
  }
  return result;
}

// Whether a cookie would be sent to a URL (RFC 6265 domain and path match,
// Secure only over https).
function cookieMatchesURL(cookie, url) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const domain = cookie.host.startsWith(".") ? cookie.host.slice(1) : cookie.host;
  const domainMatches = cookie.host.startsWith(".")
    ? host === domain || host.endsWith("." + domain)
    : host === domain;
  if (!domainMatches) {
    return false;
  }
  const path = url.pathname || "/";
  const pathMatches =
    path === cookie.path ||
    (path.startsWith(cookie.path) &&
      (cookie.path.endsWith("/") || path[cookie.path.length] === "/"));
  if (!pathMatches) {
    return false;
  }
  return !cookie.isSecure || url.protocol === "https:" || url.protocol === "wss:";
}

// The cookies of the given origin attributes that would be sent to a URL.
export function cookiesForURL(url, originAttributes = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (!parsed.hostname) {
    return [];
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return Services.cookies
    .getCookiesFromHost(host, originAttributes)
    .filter(cookie => cookieMatchesURL(cookie, parsed));
}

// Network.BlockPattern's urlPattern is URLPattern syntax. URLPattern is a DOM
// API, so it comes from a content window's global (Xray-wrapped, so a page
// cannot replace it).
function urlPatternMatcher(pattern, win) {
  const URLPatternCtor = globalThis.URLPattern ?? win?.URLPattern;
  if (!URLPatternCtor) {
    throw new ProtocolError("URLPattern is not available");
  }
  let compiled;
  try {
    compiled = new URLPatternCtor(pattern);
  } catch {
    throw new InvalidParams(`Pattern "${pattern}" failed to parse as a URLPattern.`);
  }
  return url => {
    try {
      return compiled.test(url);
    } catch {
      return false;
    }
  };
}

class NetworkRequest {
  constructor(network, networkEvent, channel) {
    this.network = network;
    this.channel = channel;
    this.loadInfo = channel.loadInfo;
    this.isDocument = isDocumentLoad(this.loadInfo);
    this.type = resourceTypeOf(this.loadInfo);
    this.url = channel.URI.spec;
    this.chunks = null;
    this.bodyBytes = null;
    this.decodedSize = 0;
    this.wireSize = 0;
    this.responseEmitted = false;
    this.done = false;
    this.hasExtraInfo = false;
    this.mimeType = "";
    this.charset = "";
    this.isDataChannel = channel instanceof Ci.nsIDataChannel;

    const browsingContext = network._browsingContextOf(channel);
    this.frameId = browsingContext ? frameIdOf(network.target, browsingContext) : undefined;
    const loadingDocument = this.loadInfo.loadingDocument;
    if (this.isDocument) {
      this.id = loaderIdOfChannelId(channel.channelId);
      this.loaderId = this.id;
      this.documentURL = this.url;
    } else {
      this.id = String(channel.channelId);
      this.loaderId = loadingDocument ? loaderIdOf(loadingDocument) : "";
      this.documentURL = loadingDocument?.documentURI ?? "";
    }

    const previous = network.requests.get(this.id);
    if (previous && previous.channel !== channel) {
      this._continueRedirect(previous);
    } else {
      network._remember(this);
      this._sendRequestWillBeSent(null);
    }

    if (this.done) {
      return;
    }
    if (networkEvent.blockedReason) {
      this._fail(networkEvent.blockedReason);
      return;
    }
    if (!this.isDataChannel && channel instanceof Ci.nsITraceableChannel) {
      this._listenAsPage();
    }
    // Requests matching Network.setBlockedURLs are cancelled before they are
    // sent; Chromium reports them as blocked by the inspector.
    if (network._isBlocked(this.url)) {
      channel.cancel(Cr.NS_BINDING_ABORTED);
      this._finish("loadingFailed", {
        type: this.type,
        errorText: "net::ERR_BLOCKED_BY_CLIENT",
        blockedReason: "inspector",
      });
    }
  }

  // A redirect: Gecko opened a new channel with the same channelId. The
  // previous channel's response becomes requestWillBeSent's redirectResponse.
  _continueRedirect(previous) {
    previous.redirected = true;
    previous.done = true;
    this.redirectCount = (previous.redirectCount ?? 0) + 1;
    this.network._remember(this);
    if (!previous.response) {
      // An internal redirect (e.g. an upgrade to https) without a response of
      // its own: the request continues on the new channel unannounced.
      this.initiator = previous.initiator;
      this.requestHeaders = previous.requestHeaders;
      return;
    }
    this._sendRequestWillBeSent(previous);
  }

  _initiator() {
    const stack = this.network._takeStack(this.channel.channelId);
    if (stack?.length) {
      return {
        type: "script",
        stack: this.network.session.domain("Runtime")._stackTrace(stack),
      };
    }
    if (this.loadInfo.externalContentPolicyType === CP.TYPE_DOCUMENT) {
      return { type: "other" };
    }
    // A frame's document is requested by the parser of the document that
    // has the frame element (Gecko's document channel has no loading
    // document of its own, so it is found through the frame's parent).
    if (this.isDocument) {
      const parent = this.network._browsingContextOf(this.channel)?.parent?.window?.document;
      return parent ? { type: "parser", url: parent.documentURI } : { type: "other" };
    }
    if (!this.loadInfo.loadingDocument) {
      return { type: "other" };
    }
    if (this.type === "XHR" || this.type === "Fetch" || this.type === "EventSource") {
      return { type: "other" };
    }
    // Resources referenced from a stylesheet have it as their referrer, and
    // Chromium names the stylesheet as their initiator.
    const referrer = this.channel.referrerInfo?.originalReferrer?.spec;
    if (referrer && this.network.stylesheetURLs.has(referrer)) {
      return { type: "parser", url: referrer };
    }
    // Everything else the document references, including what Gecko's
    // speculative parser preloads (as Chromium's preload scanner does), is
    // the parser's request. Gecko does not record the line of the element.
    return { type: "parser", url: this.documentURL };
  }

  _sendRequestWillBeSent(previous) {
    const channel = this.channel;
    const url = new URL(this.url);
    const fragment = url.hash;
    url.hash = "";
    this.initiator = previous?.initiator ?? this._initiator();
    this.requestHeaders = requestHeadersOf(channel);
    const request = {
      url: url.href,
      ...(fragment ? { urlFragment: fragment } : {}),
      method: channel instanceof Ci.nsIHttpChannel ? channel.requestMethod : "GET",
      headers: this.requestHeaders,
    };
    const postData = this._readPostData();
    if (postData) {
      this.postData = postData;
      request.hasPostData = true;
      if (postData.length <= this.network.maxPostDataSize) {
        request.postData = decodeText(postData, "utf-8");
        request.postDataEntries = [{ bytes: bytesToBase64(postData) }];
      }
    }
    request.mixedContentType = "none";
    request.initialPriority = priorityOf(channel);
    request.referrerPolicy = referrerPolicyOf(channel);
    if (this.type === "Stylesheet") {
      this.network.stylesheetURLs.add(url.href);
    }
    // The request was issued when the channel was opened, which is earlier
    // than NetworkObserver reports it (just before connecting).
    const openedAt =
      channel instanceof Ci.nsITimedChannel && channel.asyncOpenTime
        ? channel.asyncOpenTime / 1000
        : Date.now();
    const params = {
      requestId: this.id,
      loaderId: this.loaderId,
      documentURL: this.documentURL,
      request,
      timestamp: epochToMonotonic(openedAt),
      wallTime: openedAt / 1000,
      initiator: this.initiator,
      redirectHasExtraInfo: !!previous?.hasExtraInfo,
      ...(previous ? { redirectResponse: previous.response } : {}),
      type: this.type,
      ...(this.frameId ? { frameId: this.frameId } : {}),
      hasUserGesture: !!this.loadInfo.hasValidUserGestureActivation,
    };
    this.network._emit("Network.requestWillBeSent", params);
  }

  _readPostData() {
    if (!(this.channel instanceof Ci.nsIUploadChannel)) {
      return null;
    }
    const stream = this.channel.uploadStream;
    if (!stream || !(stream instanceof Ci.nsISeekableStream)) {
      return null;
    }
    try {
      const position = stream.tell();
      stream.seek(Ci.nsISeekableStream.NS_SEEK_SET, 0);
      const binary = lazy.NetUtil.readInputStreamToString(stream, stream.available());
      stream.seek(Ci.nsISeekableStream.NS_SEEK_SET, position);
      const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      return bytes.length ? bytes : null;
    } catch {
      return null;
    }
  }

  _timing(receivedAt) {
    const timed = this.channel.QueryInterface(Ci.nsITimedChannel);
    const start = timed.asyncOpenTime || timed.channelCreationTime;
    const rel = value => (value && start ? (value - start) / 1000 : -1);
    const connectEnd = rel(timed.connectEndTime);
    const sslStart = rel(timed.secureConnectionStartTime);
    const sendStart = rel(timed.requestStartTime || timed.cacheReadStartTime);
    return {
      requestTime: epochToMonotonic(start / 1000),
      proxyStart: -1,
      proxyEnd: -1,
      dnsStart: rel(timed.domainLookupStartTime),
      dnsEnd: rel(timed.domainLookupEndTime),
      connectStart: rel(timed.connectStartTime),
      connectEnd,
      sslStart,
      sslEnd: sslStart >= 0 ? connectEnd : -1,
      workerStart: rel(timed.launchServiceWorkerStartTime),
      workerReady: rel(timed.launchServiceWorkerEndTime),
      workerFetchStart: rel(timed.dispatchFetchEventStartTime),
      workerRespondWithSettled: rel(timed.handleFetchEventEndTime),
      // Gecko records when the request started going out, not when the last
      // byte left, so the send phase has no duration.
      sendStart: Math.max(sendStart, 0),
      sendEnd: Math.max(sendStart, 0),
      pushStart: 0,
      pushEnd: 0,
      receiveHeadersStart: Math.max(rel(timed.responseStartTime || timed.cacheReadStartTime), 0),
      receiveHeadersEnd: Math.max((receivedAt * 1000 - start) / 1000, 0),
    };
  }

  _securityState(uri) {
    if (uri.schemeIs("data") || uri.schemeIs("blob")) {
      return "neutral";
    }
    const principal = Services.scriptSecurityManager.createContentPrincipal(uri, {});
    return principal.isOriginPotentiallyTrustworthy ? "secure" : "insecure";
  }

  _securityDetails() {
    const info = this.channel.securityInfo;
    if (!info) {
      return undefined;
    }
    try {
      const cert = info.serverCert;
      if (!cert) {
        return undefined;
      }
      const tls = { 1: "TLS 1.0", 2: "TLS 1.1", 3: "TLS 1.2", 4: "TLS 1.3" }[
        info.protocolVersion + 1
      ];
      const sans = [];
      try {
        for (const name of cert.getAllTokenNames?.() ?? []) {
          sans.push(name);
        }
      } catch {
        // Older certificates without SAN.
      }
      return {
        protocol: lazy.NetworkHelper.formatSecurityProtocol(info.protocolVersion) || tls || "",
        keyExchange: info.keaGroupName && info.protocolVersion < 4 ? "ECDHE_RSA" : "",
        ...(info.keaGroupName ? { keyExchangeGroup: info.keaGroupName } : {}),
        cipher: info.cipherName ?? "",
        certificateId: 0,
        subjectName: cert.commonName,
        sanList: sans,
        issuer: cert.issuerCommonName || cert.issuerOrganization,
        validFrom: cert.validity.notBefore / 1e6,
        validTo: cert.validity.notAfter / 1e6,
        signedCertificateTimestampList: [],
        certificateTransparencyCompliance: "unknown",
        encryptedClientHello: !!info.isAcceptedEch,
      };
    } catch {
      return undefined;
    }
  }

  _buildResponse(fromCache, fromServiceWorker, rawHeaders) {
    const channel = this.channel;
    const now = Date.now();
    const url = new URL(channel.URI.spec);
    url.hash = "";
    let status = 200;
    let statusText = "OK";
    let headers;
    if (channel instanceof Ci.nsIHttpChannel) {
      try {
        status = channel.responseStatus;
        statusText = channel.responseStatusText;
      } catch {
        // No response yet.
      }
      headers = responseHeadersOf(channel);
    } else {
      headers = { "Content-Type": channel.contentType };
    }
    try {
      this.mimeType = channel.contentType;
      this.charset = channel.contentCharset;
    } catch {
      // Not available on failed channels.
    }
    let remoteIPAddress;
    let remotePort;
    try {
      const internal = channel.QueryInterface(Ci.nsIHttpChannelInternal);
      remoteIPAddress = internal.remoteAddress;
      remotePort = internal.remotePort;
    } catch {
      // Cached and data responses have no peer.
    }
    let timing;
    let connectionReused = false;
    if (channel instanceof Ci.nsITimedChannel && !this.isDataChannel) {
      timing = this._timing(now);
      connectionReused = !fromCache && timing.connectStart < 0;
    }
    let protocol = channel.URI.scheme;
    if (channel instanceof Ci.nsIHttpChannel) {
      try {
        protocol = lazy.NetworkUtils.getProtocol(channel);
      } catch {
        // The response version is gone once a channel failed.
      }
    }
    const securityDetails = channel.URI.schemeIs("https") ? this._securityDetails() : undefined;
    return {
      url: url.href,
      status,
      statusText,
      headers,
      mimeType: this.mimeType,
      charset: this.charset,
      connectionReused,
      connectionId: 0,
      ...(remoteIPAddress ? { remoteIPAddress, remotePort } : {}),
      fromDiskCache: !!fromCache,
      fromServiceWorker: !!fromServiceWorker,
      fromPrefetchCache: false,
      encodedDataLength: rawHeaders ? rawHeaders.length : 0,
      ...(timing ? { timing } : {}),
      responseTime: now,
      ...(protocol ? { protocol } : {}),
      securityState: this._securityState(channel.URI),
      ...(securityDetails ? { securityDetails } : {}),
    };
  }

  // NetworkObserver's owner interface.

  addCacheDetails({ fromCache }) {
    this.fromCache = fromCache;
  }

  addRawHeaders({ rawHeaders }) {
    if (this.done || !rawHeaders) {
      return;
    }
    this.hasExtraInfo = true;
    const headers = parseRawHeaders(rawHeaders);
    const sentCookies = new Map();
    const cookieHeader = Object.entries(headers).find(([name]) => /^cookie$/i.test(name))?.[1];
    for (const pair of (cookieHeader ?? "").split(/;\s*/)) {
      const eq = pair.indexOf("=");
      if (eq > 0) {
        sentCookies.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    }
    const associatedCookies = [];
    if (sentCookies.size) {
      const originAttributes = this.channel.loadInfo.originAttributes;
      for (const cookie of cookiesForURL(this.url, originAttributes)) {
        if (sentCookies.get(cookie.name) === cookie.value) {
          associatedCookies.push({ cookie: cookieToCDP(cookie), blockedReasons: [] });
        }
      }
    }
    const timed = this.channel.QueryInterface(Ci.nsITimedChannel);
    const start = timed.asyncOpenTime || timed.channelCreationTime;
    this.network._emit("Network.requestWillBeSentExtraInfo", {
      requestId: this.id,
      associatedCookies,
      headers,
      connectTiming: { requestTime: epochToMonotonic(start / 1000) },
      ...(this.network.conditionsId ? { appliedNetworkConditionsId: this.network.conditionsId } : {}),
    });
  }

  addRequestPostData() {}

  addResponseStart({ fromCache, fromServiceWorker, rawHeaders }) {
    if (this.done || this.responseEmitted) {
      return;
    }
    this.rawResponseHeaders = rawHeaders;
    this.response = this._buildResponse(fromCache || this.fromCache, fromServiceWorker, rawHeaders);
    if (rawHeaders && !this.isDataChannel) {
      this.network._emit("Network.responseReceivedExtraInfo", {
        requestId: this.id,
        blockedCookies: [],
        headers: parseRawHeaders(rawHeaders),
        resourceIPAddressSpace: this._addressSpace(),
        statusCode: this.response.status,
        headersText: rawHeaders,
      });
    }
    // With a page-side listener, responseReceived goes out when the page
    // gets the response (see _listenAsPage).
    if (!this.pageListener && !this._isRedirect()) {
      this._sendResponseReceived();
    }
  }

  // A redirect's response goes out with the next requestWillBeSent.
  _isRedirect() {
    if (!lazy.NetworkUtils.isRedirect(this.response?.status) || this.channel.status !== Cr.NS_OK) {
      return false;
    }
    try {
      return !!this.channel.getResponseHeader("Location");
    } catch {
      return false;
    }
  }

  _addressSpace() {
    const address = this.response?.remoteIPAddress;
    if (!address) {
      return "Unknown";
    }
    if (/^127\.|^::1$|^localhost$/.test(address)) {
      return "Loopback";
    }
    if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^f[cd]|^fe80/i.test(address)) {
      return "Local";
    }
    return "Public";
  }

  _sendResponseReceived() {
    if (this.responseEmitted) {
      return;
    }
    if (!this.response) {
      this.response = this._buildResponse(this.fromCache, false, null);
    } else if (this.response.timing) {
      // The response reached the page now (later than the network delivered
      // it when throttling holds it back).
      this.response.timing = this._timing(Date.now());
    }
    this.responseEmitted = true;
    this.contentEncoded = Object.keys(this.response.headers).some(name =>
      /^content-encoding$/i.test(name)
    );
    this.network._emit("Network.responseReceived", {
      requestId: this.id,
      loaderId: this.loaderId,
      timestamp: monotonicTime(),
      type: this.type,
      response: this.response,
      hasExtraInfo: this.hasExtraInfo,
      ...(this.frameId ? { frameId: this.frameId } : {}),
    });
  }

  addSecurityInfo() {}

  addEventTimings() {}

  addResponseCache() {}

  addServerTimings() {}

  addServiceWorkerTimings() {}

  // Called for each chunk with the totals so far. The chunks are the
  // response body as NetworkObserver's stream tee copied it.
  addResponseContent(content) {
    if (this.done) {
      return;
    }
    if (this.isDataChannel) {
      try {
        this.bodyBytes = dataURLBytes(this.url);
      } catch {
        this.bodyBytes = new Uint8Array();
      }
      this.decodedSize = this.bodyBytes.length;
      return;
    }
    // NetworkResponseListener reports content once even for a channel that
    // failed before any response; that one ends in loadingFailed.
    if (!Components.isSuccessCode(this.channel.status)) {
      return;
    }
    let decoded;
    if (content.isContentEncoded) {
      this.chunks = content.encodedData;
      decoded = content.encodedBodySize ?? 0;
    } else {
      // A 304 revalidation: the body was read back from the cache as text.
      this.cachedText = content.text ?? "";
      decoded = content.decodedBodySize ?? this.cachedText.length;
    }
    const wire = content.bodySize ?? 0;
    const dataLength = decoded - this.decodedSize;
    const encodedDataLength = Math.max(wire - this.wireSize, 0);
    this.decodedSize = decoded;
    this.wireSize = Math.max(wire, this.wireSize);
    if (!this.pageListener && dataLength > 0) {
      this._sendResponseReceived();
      this.network._emit("Network.dataReceived", {
        requestId: this.id,
        timestamp: monotonicTime(),
        dataLength,
        encodedDataLength,
      });
    }
  }

  addResponseContentComplete({ blockedReason, truncated }) {
    if (this.done || this.bodyComplete) {
      return;
    }
    const channel = this.channel;
    if (this.redirected || channel.status === Cr.NS_BINDING_REDIRECTED) {
      // The next channel of this request carries on.
      return;
    }
    if (blockedReason) {
      this._fail(blockedReason);
      return;
    }
    if (truncated) {
      // Larger than maxResourceBufferSize: not kept, as in Chromium.
      this.evicted = true;
    } else if (this.isDataChannel) {
      this.network._storeBody(this, this.bodyBytes ?? new Uint8Array());
    } else if (this.chunks) {
      this.network._storeBody(this, concatChunks(this.chunks, this.decodedSize));
    } else if (this.cachedText !== undefined) {
      this.network._storeBody(this, new TextEncoder().encode(this.cachedText), "utf-8");
    } else {
      this.network._storeBody(this, new Uint8Array());
    }
    this.bodyComplete = true;
    this.chunks = null;
    if (!this.pageListener || this.pageStopped) {
      this._loadingFinished();
    }
  }

  _loadingFinished() {
    lazy.clearTimeout(this.bodyTimer);
    this._sendResponseReceived();
    const channel = this.channel;
    let encodedDataLength = (this.rawResponseHeaders?.length ?? 0) + this.wireSize;
    let encodedBodyLength = this.wireSize;
    if (channel instanceof Ci.nsIHttpChannel) {
      try {
        encodedDataLength = channel.transferSize || encodedDataLength;
        encodedBodyLength = channel.encodedBodySize || encodedBodyLength;
      } catch {
        // Keep the counted sizes.
      }
    }
    if (this.response?.fromDiskCache) {
      encodedDataLength = 0;
    }
    this._finish("loadingFinished", { encodedDataLength, encodedBodyLength });
  }

  _fail(blockedReason) {
    this._finish("loadingFailed", {
      type: this.type,
      ...failureOf(blockedReason, this.channel, this.networkStatus),
    });
  }

  // Puts a listener right in front of the page's own listener, so the
  // response, its data and its end are reported when the page gets them:
  // NetworkObserver's tee sees them as they come off the network, ahead of
  // throttling. The listener also sees the network's status before Gecko's
  // CORS listener (which is part of the page's listener) replaces a network
  // failure with NS_ERROR_DOM_BAD_URI.
  _listenAsPage() {
    const request = this;
    const channel = this.channel;
    let next = null;
    // The page's listener fails a call to cancel the channel (an image it
    // does not want, a CORS check). That result is handed back as the
    // listener's own, rather than thrown, which would be reported as an
    // error of this module.
    const forward = call => {
      try {
        call();
      } catch (error) {
        Components.returnCode = error.result ?? Cr.NS_ERROR_FAILURE;
      }
    };
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
      onStartRequest(req) {
        // After a redirect the page's listener chain, this listener included,
        // moves to the next channel, whose own request reports it.
        if (req === channel && !request.done) {
          request.networkStatus = channel.status;
          if (Components.isSuccessCode(channel.status)) {
            request._sendResponseReceived();
          }
        }
        forward(() => next.onStartRequest(req));
      },
      onDataAvailable(req, stream, offset, count) {
        if (req === channel && !request.done && count) {
          request.network._emit("Network.dataReceived", {
            requestId: request.id,
            timestamp: monotonicTime(),
            dataLength: count,
            // Chunks reach the page decoded; their size on the wire is
            // only known for responses without a content encoding.
            encodedDataLength: request.contentEncoded ? 0 : count,
          });
        }
        forward(() => next.onDataAvailable(req, stream, offset, count));
      },
      onStopRequest(req, status) {
        forward(() => next.onStopRequest(req, status));
        if (req !== channel || request.done) {
          return;
        }
        request.pageStopped = true;
        if (!Components.isSuccessCode(status)) {
          const { blockedReason } = lazy.NetworkUtils.getBlockedReason(channel, request.fromCache);
          if (status !== Cr.NS_BINDING_REDIRECTED && blockedReason) {
            request._fail(blockedReason);
          }
          return;
        }
        if (request.bodyComplete) {
          request._loadingFinished();
        } else {
          // NetworkObserver reads its copy of the body asynchronously; finish
          // without a body if it never completes.
          request.bodyTimer = lazy.setTimeout(() => request._loadingFinished(), 3000);
        }
      },
    };
    try {
      next = channel.QueryInterface(Ci.nsITraceableChannel).setNewListener(listener);
      this.pageListener = listener;
    } catch {
      // The channel already started delivering; NetworkObserver's callbacks
      // report it instead.
    }
  }

  _finish(method, params) {
    if (this.done) {
      return;
    }
    this.done = true;
    lazy.clearTimeout(this.bodyTimer);
    this.network._emit(`Network.${method}`, {
      requestId: this.id,
      timestamp: monotonicTime(),
      ...params,
    });
  }
}

export class Network {
  constructor(session) {
    this.session = session;
    this.target = session.target;
    this.enabled = false;
    this.requests = new Map();
    this.stacks = new Map();
    this.stylesheetURLs = new Set();
    this.bodyBytes = 0;
    this.maxTotalBufferSize = DEFAULT_TOTAL_BUFFER;
    this.maxResourceBufferSize = DEFAULT_RESOURCE_BUFFER;
    this.maxPostDataSize = 0;
    this.blockedMatchers = [];
    this.offline = false;
    this.throttle = null;
    this.conditionsId = null;
  }

  _emit(method, params) {
    if (this.enabled) {
      this.session.emit(method, params);
    }
  }

  _browsingContextOf(channel) {
    const id = lazy.NetworkUtils.getChannelBrowsingContextID(channel);
    return id ? BrowsingContext.get(id) : null;
  }

  // Whether a channel is one of the page's requests. Loads the browser makes
  // for itself (the tab's favicon, DevTools' own fetches, chrome resources)
  // are not, as in Chromium.
  _ignoreChannel(channel) {
    if (channel instanceof Ci.nsIFileChannel) {
      return true;
    }
    const loadInfo = channel.loadInfo;
    if (!loadInfo || loadInfo.isInDevToolsContext) {
      return true;
    }
    if (loadInfo.internalContentPolicyType === CP.TYPE_INTERNAL_IMAGE_FAVICON) {
      return true;
    }
    const browsingContext = this._browsingContextOf(channel);
    if (!browsingContext || browsingContext.top !== this.target.browsingContext) {
      return true;
    }
    if (!isDocumentLoad(loadInfo) && loadInfo.triggeringPrincipal?.isSystemPrincipal) {
      return true;
    }
    return false;
  }

  _remember(request) {
    this.requests.delete(request.id);
    this.requests.set(request.id, request);
    if (this.requests.size > MAX_REQUESTS) {
      const [oldestId, oldest] = this.requests.entries().next().value;
      this._dropBody(oldest);
      this.requests.delete(oldestId);
    }
  }

  _storeBody(request, bytes, charset) {
    if (charset) {
      request.charset = charset;
    }
    if (bytes.length > this.maxResourceBufferSize) {
      request.evicted = true;
      return;
    }
    request.body = bytes;
    this.bodyBytes += bytes.length;
    // Evict the oldest bodies past the total budget, as Chromium's
    // NetworkResourcesData does.
    for (const other of this.requests.values()) {
      if (this.bodyBytes <= this.maxTotalBufferSize) {
        break;
      }
      if (other !== request && other.body) {
        this._dropBody(other);
        other.evicted = true;
      }
    }
  }

  _dropBody(request) {
    if (request.body) {
      this.bodyBytes -= request.body.length;
      request.body = null;
    }
  }

  // JavaScript stacks of channels opened by page scripts, recorded when the
  // channel opens (that is still on the script's stack, as fetch(), XHR and
  // element insertions open their channels synchronously).
  observe(subject, topic) {
    let channel;
    try {
      channel = subject.QueryInterface(Ci.nsIChannel);
      channel.QueryInterface(Ci.nsIIdentChannel);
    } catch {
      return;
    }
    if (this._ignoreChannel(channel)) {
      return;
    }
    if (topic === "http-on-failed-opening-request") {
      this._failedOpening(channel);
      return;
    }
    const frames = [];
    for (let frame = Components.stack; frame; frame = frame.caller || frame.asyncCaller) {
      const file = frame.filename ?? "";
      if (!file || /^(resource|chrome|moz-src|jar):/.test(file)) {
        continue;
      }
      frames.push({
        filename: file,
        lineNumber: frame.lineNumber,
        columnNumber: frame.columnNumber,
        functionName: frame.name ?? "",
      });
    }
    if (frames.length && !this.stacks.has(channel.channelId)) {
      this.stacks.set(channel.channelId, frames);
      // Channels that never become requests (refused before
      // NetworkObserver sees them) would otherwise keep their stacks.
      if (this.stacks.size > MAX_REQUESTS) {
        this.stacks.delete(this.stacks.keys().next().value);
      }
    }
  }

  // A channel refused when it was opened (a content policy such as CSP,
  // mixed content): Chromium reports such requests as blocked. In the parent
  // process NetworkObserver does not watch for these.
  _failedOpening(channel) {
    if (lazy.NetworkUtils.isPreloadRequest(channel)) {
      return;
    }
    const { blockedReason } = lazy.NetworkUtils.getBlockedReason(channel);
    new NetworkRequest(this, { blockedReason: blockedReason || "NS_BINDING_FAILED" }, channel);
  }

  _takeStack(channelId) {
    const stack = this.stacks.get(channelId);
    this.stacks.delete(channelId);
    return stack;
  }

  _startObserving() {
    if (this.observer) {
      return;
    }
    this.observer = new lazy.NetworkObserver({
      // Bodies are kept as received bytes and decoded on request, so that
      // binary responses survive intact.
      decodeResponseBodies: false,
      responseBodyLimit: this.maxResourceBufferSize,
      ignoreChannelFunction: channel => this._ignoreChannel(channel),
      onNetworkEvent: (networkEvent, channel) =>
        new NetworkRequest(this, networkEvent, channel),
    });
    this.observer.setThrottleData(this.throttle);
    Services.obs.addObserver(this, "http-on-opening-request");
    Services.obs.addObserver(this, "http-on-failed-opening-request");
    Services.obs.addObserver(this, "document-on-opening-request");
  }

  _stopObserving() {
    if (!this.observer) {
      return;
    }
    this.observer.destroy();
    this.observer = null;
    Services.obs.removeObserver(this, "http-on-opening-request");
    Services.obs.removeObserver(this, "http-on-failed-opening-request");
    Services.obs.removeObserver(this, "document-on-opening-request");
    this.stacks.clear();
  }

  enable({ maxTotalBufferSize, maxResourceBufferSize, maxPostDataSize } = {}) {
    if (maxTotalBufferSize > 0) {
      this.maxTotalBufferSize = maxTotalBufferSize;
    }
    if (maxResourceBufferSize > 0) {
      this.maxResourceBufferSize = maxResourceBufferSize;
    }
    this.maxPostDataSize = maxPostDataSize ?? 0;
    this.enabled = true;
    this._startObserving();
  }

  disable() {
    this.enabled = false;
    this._stopObserving();
    this.requests.clear();
    this.bodyBytes = 0;
  }

  // Stacks are always taken from the opening channel (see observe()), which
  // is what Chromium attaches with this switch on.
  setAttachDebugStack({ enabled }) {
    if (enabled && !this.enabled) {
      throw new InvalidParams("Domain must be enabled");
    }
  }

  _request(requestId) {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new ProtocolError("No resource with given identifier found");
    }
    return request;
  }

  async getResponseBody({ requestId }) {
    const request = this._request(requestId);
    if (request.body?.length === 0 && this._expectsBody(request)) {
      // Gecko's image loader cancels a channel whose image it already has
      // (or one it cannot use), so the body never passed by; the HTTP cache
      // still holds the response.
      const cached = await this._readFromCache(request.response.url, this._frameWindow(request.frameId)).catch(
        () => null
      );
      if (cached?.bytes.length) {
        return bodyResult(cached.bytes, request.mimeType || cached.mimeType, request.charset || cached.charset);
      }
    }
    if (request.body) {
      return bodyResult(request.body, request.mimeType, request.charset);
    }
    if (request.evicted) {
      throw new ProtocolError("Request content was evicted from inspector cache");
    }
    throw new ProtocolError("No data found for resource with given identifier");
  }

  _expectsBody(request) {
    const headers = request.response?.headers ?? {};
    const length = Object.entries(headers).find(([name]) => /^content-length$/i.test(name))?.[1];
    return request.response && request.response.status !== 204 && request.response.status !== 304 &&
      (length === undefined || Number(length) > 0);
  }

  getRequestPostData({ requestId }) {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new ProtocolError("No resource with given id was found");
    }
    if (!request.postData) {
      throw new ProtocolError("No post data available for the request");
    }
    return { postData: decodeText(request.postData, "utf-8"), base64Encoded: false };
  }

  searchInResponseBody({ requestId, query, caseSensitive = false, isRegex = false }) {
    const request = this._request(requestId);
    if (!request.body) {
      throw new ProtocolError("No data found for resource with given identifier");
    }
    const { body, base64Encoded } = bodyResult(request.body, request.mimeType, request.charset);
    if (base64Encoded) {
      return { result: [] };
    }
    const source = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(source, caseSensitive ? "" : "i");
    const result = [];
    body.split(/\r?\n/).forEach((lineContent, lineNumber) => {
      if (regex.test(lineContent)) {
        result.push({ lineNumber, lineContent });
      }
    });
    return { result };
  }

  // Page.getResourceContent: the body of the frame's latest request for the
  // URL, else the HTTP cache's copy, else (for scripts) the source the
  // JavaScript engine compiled.
  async _resourceContent(frameId, url) {
    const requests = [...this.requests.values()].reverse();
    const request =
      requests.find(r => r.body && r.response?.url === url && r.frameId === frameId) ??
      requests.find(r => r.body && r.response?.url === url);
    if (request) {
      const { body, base64Encoded } = bodyResult(request.body, request.mimeType, request.charset);
      return { content: body, base64Encoded };
    }
    const win = this._frameWindow(frameId);
    const cached = await this._readFromCache(url, win).catch(() => null);
    if (cached) {
      const { body, base64Encoded } = bodyResult(cached.bytes, cached.mimeType, cached.charset);
      return { content: body, base64Encoded };
    }
    const debuggerDomain = this.session.domains.get("Debugger");
    const scriptId = debuggerDomain?._scriptIdForUrl?.(url);
    const source = scriptId && debuggerDomain.sources?.get(scriptId);
    if (source?.text !== undefined) {
      return { content: source.text, base64Encoded: false };
    }
    throw new ProtocolError("No resource with given URL found");
  }

  _frameWindow(frameId) {
    const visit = context => {
      if (frameIdOf(this.target, context) === frameId) {
        return context.window;
      }
      for (const child of context.children) {
        const found = visit(child);
        if (found) {
          return found;
        }
      }
      return null;
    };
    return frameId ? visit(this.target.browsingContext) : this.target.contentWindow;
  }

  // Reads a URL from the HTTP cache only, as the frame's document would.
  _readFromCache(url, win) {
    return this._fetch(url, win, {
      loadFlags:
        Ci.nsIRequest.LOAD_FROM_CACHE |
        Ci.nsICachingChannel.LOAD_ONLY_FROM_CACHE |
        Ci.nsICachingChannel.LOAD_BYPASS_LOCAL_CACHE_IF_BUSY,
    }).then(result => (result.ok ? result : null));
  }

  // Loads a URL for DevTools itself, as the given window's document: the
  // channel is marked as DevTools', so it is not reported as a page request.
  _fetch(url, win, { loadFlags = Ci.nsIRequest.LOAD_NORMAL, anonymous = false } = {}) {
    return new Promise((resolve, reject) => {
      let channel;
      try {
        const uri = Services.io.newURI(url);
        channel = lazy.NetUtil.newChannel({
          uri,
          ...(win?.document
            ? { loadingNode: win.document }
            : { loadingPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, {}) }),
          securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
          contentPolicyType: CP.TYPE_OTHER,
        });
      } catch (error) {
        reject(error);
        return;
      }
      channel.loadInfo.isInDevToolsContext = true;
      channel.loadFlags |= loadFlags | (anonymous ? Ci.nsIRequest.LOAD_ANONYMOUS : 0);
      if (win?.docShell) {
        channel.loadGroup = win.docShell.QueryInterface(Ci.nsIDocumentLoader).loadGroup;
      }
      lazy.NetUtil.asyncFetch(channel, (stream, status, request) => {
        let bytes = new Uint8Array();
        if (Components.isSuccessCode(status)) {
          try {
            const binary = lazy.NetUtil.readInputStreamToString(stream, stream.available());
            bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
          } catch {
            // An empty body closes the stream.
          }
        }
        const http = request instanceof Ci.nsIHttpChannel ? request : null;
        let httpStatus;
        const headers = {};
        if (http) {
          try {
            httpStatus = http.responseStatus;
            http.visitResponseHeaders({
              visitHeader: (name, value) => addHeader(headers, name, value),
            });
          } catch {
            // No response.
          }
        }
        let mimeType = "";
        let charset = "";
        try {
          mimeType = request.contentType;
          charset = request.contentCharset;
        } catch {
          // Failed requests have no content type.
        }
        resolve({
          ok: Components.isSuccessCode(status) && (!httpStatus || httpStatus < 400),
          status,
          httpStatus,
          headers,
          bytes,
          mimeType,
          charset,
        });
      });
    });
  }

  async loadNetworkResource({ frameId, url, options = {} }) {
    let uri;
    try {
      uri = Services.io.newURI(url);
    } catch {
      throw new InvalidParams("The url must be valid");
    }
    if (!["http", "https", "file", "data"].includes(uri.scheme)) {
      throw new InvalidParams("Unsupported URL scheme");
    }
    const win = this._frameWindow(frameId);
    if (frameId && !win) {
      throw new InvalidParams("Frame not found");
    }
    const result = await this._fetch(url, win, {
      loadFlags: options.disableCache ? Ci.nsIRequest.LOAD_BYPASS_CACHE : 0,
      anonymous: options.includeCredentials === false,
    });
    const resource = { success: false };
    if (!Components.isSuccessCode(result.status)) {
      const { errorText } = failureOf(ChromeUtils.getXPCOMErrorName(result.status));
      resource.netError = NET_ERROR_CODES[errorText] ?? -2;
      resource.netErrorName = errorText;
    } else if (result.httpStatus && (result.httpStatus < 200 || result.httpStatus >= 300)) {
      resource.netError = NET_ERROR_CODES["net::ERR_HTTP_RESPONSE_CODE_FAILURE"];
      resource.netErrorName = "net::ERR_HTTP_RESPONSE_CODE_FAILURE";
    } else {
      resource.success = true;
      resource.stream = this.session.domain("IO")._open(result.bytes);
    }
    if (result.httpStatus) {
      resource.httpStatusCode = result.httpStatus;
      resource.headers = result.headers;
    }
    return { resource };
  }

  _isBlocked(url) {
    for (const { matches, block } of this.blockedMatchers) {
      if (matches(url)) {
        return block;
      }
    }
    return false;
  }

  setBlockedURLs({ urlPatterns, urls } = {}) {
    const win = this.target.contentWindow;
    const matchers = [];
    for (const { urlPattern, block } of urlPatterns ?? []) {
      matchers.push({ matches: urlPatternMatcher(urlPattern, win), block });
    }
    for (const url of urls ?? []) {
      const regexp = lazy.wildcardToRegExp(url);
      matchers.push({ matches: value => regexp.test(value), block: true });
    }
    this.blockedMatchers = matchers;
  }

  // Disabling the cache and bypassing service workers are the browsing
  // context's default load flags (as Firefox DevTools disables the cache),
  // which every load of the page and its frames takes; Gecko's in-memory
  // caches (images, stylesheets) honor them too.
  _applyLoadFlags() {
    const context = this.target.browsingContext;
    if (this.savedLoadFlags === undefined) {
      this.savedLoadFlags = context.defaultLoadFlags;
    }
    let flags = this.savedLoadFlags;
    if (this.cacheDisabled) {
      flags |= Ci.nsIRequest.LOAD_BYPASS_CACHE;
    }
    if (this.bypassServiceWorker) {
      flags |= Ci.nsIChannel.LOAD_BYPASS_SERVICE_WORKER;
    }
    context.defaultLoadFlags = flags;
  }

  setCacheDisabled({ cacheDisabled }) {
    this.cacheDisabled = cacheDisabled;
    this._applyLoadFlags();
  }

  setBypassServiceWorker({ bypass }) {
    this.bypassServiceWorker = bypass;
    this._applyLoadFlags();
  }

  // Going offline is the browsing context's forceOffline: its requests fail
  // with NS_ERROR_OFFLINE (net::ERR_INTERNET_DISCONNECTED) and
  // navigator.onLine is false.
  _setOffline(offline) {
    this.offline = offline;
    this.target.browsingContext.forceOffline = offline;
  }

  _setThrottle({ latency = 0, downloadThroughput = -1, uploadThroughput = -1 }) {
    const throttling = latency > 0 || downloadThroughput > 0 || uploadThroughput > 0;
    // NetworkThrottleManager takes bytes per second and milliseconds; values
    // <= 0 leave that direction unthrottled, like Chromium's -1.
    this.throttle = throttling
      ? {
          latencyMean: latency,
          latencyMax: latency,
          downloadBPSMean: downloadThroughput,
          downloadBPSMax: downloadThroughput,
          uploadBPSMean: uploadThroughput,
          uploadBPSMax: uploadThroughput,
        }
      : null;
    this.observer?.setThrottleData(this.throttle);
  }

  emulateNetworkConditions({ offline, latency, downloadThroughput, uploadThroughput }) {
    this._setOffline(!!offline);
    this._setThrottle({ latency, downloadThroughput, uploadThroughput });
    this.conditionsId = null;
  }

  // Gecko throttles all of a page's requests alike, so only conditions for
  // every request (an empty urlPattern) can be applied.
  emulateNetworkConditionsByRule({ offline, matchedNetworkConditions = [] }) {
    if (matchedNetworkConditions.some(conditions => conditions.urlPattern)) {
      throw new ProtocolError("Network conditions for specific URL patterns are not supported");
    }
    const global = matchedNetworkConditions[0];
    this._setOffline(!!(offline || global?.offline));
    this._setThrottle(global ?? {});
    const ruleIds = matchedNetworkConditions.map(() =>
      Services.uuid.generateUUID().toString().replace(/[{}-]/g, "").toUpperCase()
    );
    this.conditionsId = global && (this.throttle || this.offline) ? ruleIds[0] : null;
    return { ruleIds };
  }

  // navigator.onLine follows forceOffline, so it can only agree with the
  // emulated network state; navigator.connection is not exposed by Gecko, so
  // the connection figures have nothing to override.
  overrideNetworkState({ offline }) {
    if (!!offline !== this.offline) {
      throw new ProtocolError(
        "navigator.onLine can only be overridden together with offline network emulation"
      );
    }
  }

  setExtraHTTPHeaders({ headers }) {
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (typeof value !== "string") {
        throw new InvalidParams("Invalid header value, string expected");
      }
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
        throw new InvalidParams("Invalid header name");
      }
    }
    this.extraHeaders = headers;
    if (Object.keys(headers ?? {}).length && !this.headerObserver) {
      this.headerObserver = subject => {
        const channel = subject.QueryInterface(Ci.nsIHttpChannel);
        if (this._ignoreChannel(channel)) {
          return;
        }
        for (const [name, value] of Object.entries(this.extraHeaders ?? {})) {
          channel.setRequestHeader(name, value, false);
        }
      };
      Services.obs.addObserver(this.headerObserver, "http-on-modify-request");
    }
  }

  getSecurityIsolationStatus({ frameId } = {}) {
    const win = this._frameWindow(frameId);
    if (!win) {
      throw new ProtocolError("Frame not found");
    }
    // The policies come from the response headers of the channel that loaded
    // the frame's current document.
    let channel = null;
    try {
      channel = win.docShell?.currentDocumentChannel?.QueryInterface(Ci.nsIHttpChannel) ?? null;
    } catch {
      // Not loaded over HTTP.
    }
    const header = name => {
      try {
        return channel?.getResponseHeader(name) ?? null;
      } catch {
        return null;
      }
    };
    const coopValue = value =>
      ({
        "same-origin": "SameOrigin",
        "same-origin-allow-popups": "SameOriginAllowPopups",
        "restrict-properties": "RestrictProperties",
        "noopener-allow-popups": "NoopenerAllowPopups",
      })[value?.split(";")[0].trim()] ?? "UnsafeNone";
    const coepValue = value =>
      ({ "require-corp": "RequireCorp", credentialless: "Credentialless" })[
        value?.split(";")[0].trim()
      ] ?? "None";
    return {
      status: {
        coop: {
          value: coopValue(header("Cross-Origin-Opener-Policy")),
          reportOnlyValue: coopValue(header("Cross-Origin-Opener-Policy-Report-Only")),
        },
        coep: {
          value: coepValue(header("Cross-Origin-Embedder-Policy")),
          reportOnlyValue: coepValue(header("Cross-Origin-Embedder-Policy-Report-Only")),
        },
        csp: this._cspStatus(win, header),
      },
    };
  }

  // The document's Content Security Policies. Gecko applies the policies of
  // the response headers before those of <meta> elements, so the first ones
  // (as many as the headers carry) came over HTTP.
  _cspStatus(win, header) {
    const csp = win.document.policyContainer?.csp;
    if (!csp?.policyCount) {
      return [];
    }
    const count = value => (value ? value.split(",").filter(part => part.trim()).length : 0);
    const fromHeaders =
      count(header("Content-Security-Policy")) + count(header("Content-Security-Policy-Report-Only"));
    let reportOnly = [];
    try {
      reportOnly = JSON.parse(csp.toJSON())["csp-policies"].map(policy => !!policy["report-only"]);
    } catch {
      // Without the flags every policy counts as enforced.
    }
    const policies = [];
    for (let i = 0; i < csp.policyCount; i++) {
      policies.push({
        effectiveDirectives: csp.getPolicy(i),
        isEnforced: !reportOnly[i],
        source: i < fromHeaders ? "HTTP" : "Meta",
      });
    }
    return policies;
  }

  getCookies({ urls } = {}) {
    let targets = urls;
    if (!targets?.length) {
      targets = [];
      const visit = context => {
        if (context.window) {
          targets.push(context.window.location.href);
        }
        context.children.forEach(visit);
      };
      visit(this.target.browsingContext);
    }
    const originAttributes =
      this.target.contentWindow?.document.effectiveStoragePrincipal.originAttributes ?? {};
    const seen = new Set();
    const cookies = [];
    for (const url of targets) {
      for (const cookie of cookiesForURL(url, originAttributes)) {
        const key = `${cookie.host}\t${cookie.path}\t${cookie.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          cookies.push(cookieToCDP(cookie));
        }
      }
    }
    return { cookies };
  }

  getAllCookies() {
    return { cookies: Services.cookies.cookies.map(cookieToCDP) };
  }

  setCookie(params) {
    setCookie(params, this._originAttributes());
    return { success: true };
  }

  setCookies({ cookies }) {
    for (const cookie of cookies) {
      setCookie(cookie, this._originAttributes());
    }
  }

  deleteCookies({ name, url, domain, path }) {
    if (!url && !domain) {
      throw new InvalidParams("At least one of the url and domain needs to be specified");
    }
    const host = domain ?? new URL(url).hostname;
    const originAttributes = this._originAttributes();
    const bare = host.replace(/^\./, "");
    for (const cookie of Services.cookies.getCookiesFromHost(bare, originAttributes)) {
      if (cookie.name !== name) {
        continue;
      }
      if (domain !== undefined && cookie.host !== domain && cookie.host !== "." + bare) {
        continue;
      }
      if (url && domain === undefined && !cookieMatchesURL(cookie, new URL(url))) {
        continue;
      }
      if (path !== undefined && cookie.path !== path) {
        continue;
      }
      Services.cookies.remove(cookie.host, cookie.name, cookie.path, cookie.originAttributes);
    }
  }

  clearBrowserCookies() {
    Services.cookies.removeAll();
  }

  clearBrowserCache() {
    Services.cache2.clear();
    ChromeUtils.clearResourceCache();
  }

  canClearBrowserCache() {
    return { result: true };
  }

  canClearBrowserCookies() {
    return { result: true };
  }

  canEmulateNetworkConditions() {
    return { result: true };
  }

  _originAttributes() {
    return this.target.contentWindow?.document.effectiveStoragePrincipal.originAttributes ?? {};
  }

  _destroy() {
    this._stopObserving();
    if (this.headerObserver) {
      Services.obs.removeObserver(this.headerObserver, "http-on-modify-request");
      this.headerObserver = null;
    }
    const context = this.target.browsingContext;
    if (!context || context.isDiscarded) {
      return;
    }
    if (this.savedLoadFlags !== undefined) {
      context.defaultLoadFlags = this.savedLoadFlags;
    }
    if (this.offline) {
      context.forceOffline = false;
    }
  }
}

// Network.CookieParam into the cookie service. Gecko stores the scheme that
// set a cookie, not the port.
export function setCookie(params, originAttributes = {}) {
  const { name, value, url, domain, path, secure, httpOnly, sameSite, expires, partitionKey } =
    params;
  let host = domain;
  let cookiePath = path;
  let isSecure = secure;
  let scheme = Ci.nsICookie.SCHEME_HTTP;
  if (url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new InvalidParams("Invalid cookie fields");
    }
    if (!/^(https?|wss?):$/.test(parsed.protocol)) {
      throw new InvalidParams("URL must have scheme http or https");
    }
    host ??= parsed.hostname;
    cookiePath ??= parsed.pathname.replace(/\/[^/]*$/, "") || "/";
    isSecure ??= parsed.protocol === "https:" || parsed.protocol === "wss:";
    if (isSecure) {
      scheme = Ci.nsICookie.SCHEME_HTTPS;
    }
  } else if (params.sourceScheme === "Secure") {
    scheme = Ci.nsICookie.SCHEME_HTTPS;
  }
  if (!host) {
    throw new InvalidParams("At least one of the url and domain needs to be specified");
  }
  const sameSiteValue =
    { Strict: Ci.nsICookie.SAMESITE_STRICT, Lax: Ci.nsICookie.SAMESITE_LAX, None: Ci.nsICookie.SAMESITE_NONE }[
      sameSite
    ] ?? Ci.nsICookie.SAMESITE_UNSET;
  const isSession = expires === undefined || expires <= 0;
  const attributes = { ...originAttributes };
  if (partitionKey) {
    const site = new URL(partitionKey.topLevelSite);
    attributes.partitionKey = `(${site.protocol.slice(0, -1)},${site.hostname}${
      partitionKey.hasCrossSiteAncestor ? ",f" : ""
    })`;
  }
  const result = Services.cookies.add(
    host,
    cookiePath || "/",
    name,
    value,
    !!isSecure,
    !!httpOnly,
    isSession,
    isSession ? Number.MAX_SAFE_INTEGER : Math.round(expires * 1000),
    attributes,
    sameSiteValue,
    scheme,
    !!partitionKey
  );
  if (result && result.result !== Ci.nsICookieValidation.eOK) {
    throw new InvalidParams("Sanitizing cookie failed");
  }
}
