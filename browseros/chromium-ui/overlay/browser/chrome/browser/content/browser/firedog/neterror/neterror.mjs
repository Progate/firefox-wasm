// Copyright 2013 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file (chromium/LICENSE).
//
// Chromium 158's error pages for Gecko's about:neterror and about:certerror,
// which both load this page in place of Firefox's aboutNetError.html (see
// repack.mjs). Network errors get the page of
// components/neterror/resources/neterror.ts, with the strings and suggestions
// components/error_page/common/localized_error.cc picks on macOS; certificate
// errors get the SSL interstitial of
// components/security_interstitials/core/browser/resources/interstitial_large.js
// with the strings of ssl_error_ui.cc and components/ssl_errors/error_info.cc.

import { STRINGS } from "./chromium/strings.mjs";

const BASE = "chrome://browser/content/firedog/neterror/";

// Chromium's error pages follow the UI language. SpiderMonkey's default
// locale is Gecko's app locale (intl.locale.requested), where
// navigator.language follows intl.accept_languages. Chromium's strings are
// embedded for ja and en.
const LANGUAGE = new Intl.DateTimeFormat()
  .resolvedOptions()
  .locale.startsWith("ja")
  ? "ja"
  : "en";

// webui::SetLoadTimeDataDefaults's fontfamily (the web font family of
// Chromium's macOS locale settings, as Chromium.app reports it) and fontsize.
const FONT_FAMILY = {
  en: "system-ui, sans-serif",
  ja: "system-ui,Hiragino Kaku Gothic ProN,sans-serif",
}[LANGUAGE];
const FONT_SIZE = "75%";

const params = new URLSearchParams(document.documentURI.split("?")[1]);
const failedUrl = params.get("u") ?? document.location.href;
// Null for a URL Gecko could not parse (malformedURI).
const parsedUrl = URL.parse(failedUrl);

/**
 * Gecko's failure -> Chromium's net error, the name localized_error.cc and
 * net::ErrorToShortString use. Keys are nsresult names from
 * getNetErrorInfo().errorCodeString, NSS names (TLS failures) and, as a
 * fallback, the `e=` keys of about:neterror (toolkit's errors/net-errors.mjs).
 * A name that is not in NET_ERRORS gets localized_error.cc's default page.
 */
const GECKO_TO_CHROMIUM = {
  NS_ERROR_CONNECTION_REFUSED: "ERR_CONNECTION_REFUSED",
  NS_ERROR_NET_TIMEOUT: "ERR_CONNECTION_TIMED_OUT",
  NS_ERROR_NET_TIMEOUT_EXTERNAL: "ERR_TIMED_OUT",
  // Chromium probes DNS after a failed lookup and shows the probe's result;
  // with a working network that is NXDOMAIN (see dnsProbeResult).
  NS_ERROR_UNKNOWN_HOST: "ERR_NAME_NOT_RESOLVED",
  NS_ERROR_NET_RESET: "ERR_CONNECTION_RESET",
  NS_ERROR_NET_INTERRUPT: "ERR_CONNECTION_CLOSED",
  NS_ERROR_NET_EMPTY_RESPONSE: "ERR_EMPTY_RESPONSE",
  NS_ERROR_NET_PARTIAL_TRANSFER: "ERR_CONTENT_LENGTH_MISMATCH",
  NS_ERROR_OFFLINE: "ERR_INTERNET_DISCONNECTED",
  NS_ERROR_REDIRECT_LOOP: "ERR_TOO_MANY_REDIRECTS",
  NS_ERROR_FILE_NOT_FOUND: "ERR_FILE_NOT_FOUND",
  NS_ERROR_FILE_TARGET_DOES_NOT_EXIST: "ERR_FILE_NOT_FOUND",
  NS_ERROR_FILE_ACCESS_DENIED: "ERR_ACCESS_DENIED",
  NS_ERROR_UNKNOWN_PROTOCOL: "ERR_UNKNOWN_URL_SCHEME",
  NS_ERROR_MALFORMED_URI: "ERR_INVALID_URL",
  NS_ERROR_UNKNOWN_PROXY_HOST: "ERR_PROXY_CONNECTION_FAILED",
  NS_ERROR_PROXY_CONNECTION_REFUSED: "ERR_PROXY_CONNECTION_FAILED",
  NS_ERROR_PROXY_FORBIDDEN: "ERR_PROXY_CONNECTION_FAILED",
  NS_ERROR_PROXY_BAD_GATEWAY: "ERR_PROXY_CONNECTION_FAILED",
  NS_ERROR_PROXY_GATEWAY_TIMEOUT: "ERR_PROXY_CONNECTION_FAILED",
  NS_ERROR_PROXY_AUTHENTICATION_FAILED: "ERR_PROXY_AUTH_UNSUPPORTED",
  NS_ERROR_INVALID_CONTENT_ENCODING: "ERR_CONTENT_DECODING_FAILED",
  NS_ERROR_CORRUPTED_CONTENT: "ERR_INVALID_RESPONSE",
  NS_ERROR_INTERCEPTION_FAILED: "ERR_INVALID_RESPONSE",
  NS_ERROR_UNSAFE_CONTENT_TYPE: "ERR_INVALID_RESPONSE",
  NS_ERROR_PORT_ACCESS_NOT_ALLOWED: "ERR_UNSAFE_PORT",
  NS_ERROR_DOCUMENT_NOT_CACHED: "ERR_CACHE_MISS",
  NS_ERROR_NET_INADEQUATE_SECURITY: "ERR_HTTP2_INADEQUATE_TRANSPORT_SECURITY",
  NS_ERROR_NET_HTTP2_SENT_GOAWAY: "ERR_HTTP2_PROTOCOL_ERROR",
  NS_ERROR_NET_HTTP3_PROTOCOL_ERROR: "ERR_QUIC_PROTOCOL_ERROR",
  NS_ERROR_BLOCKED_BY_POLICY: "ERR_BLOCKED_BY_ADMINISTRATOR",
  NS_ERROR_CSP_FRAME_ANCESTOR_VIOLATION: "ERR_BLOCKED_BY_RESPONSE",
  NS_ERROR_XFO_VIOLATION: "ERR_BLOCKED_BY_RESPONSE",
  NS_ERROR_DOM_COOP_FAILED: "ERR_BLOCKED_BY_RESPONSE",
  NS_ERROR_DOM_COEP_FAILED: "ERR_BLOCKED_BY_RESPONSE",
  NS_ERROR_UNKNOWN_SOCKET_TYPE: "ERR_SSL_PROTOCOL_ERROR",
  SSL_ERROR_NO_CYPHER_OVERLAP: "ERR_SSL_VERSION_OR_CIPHER_MISMATCH",
  SSL_ERROR_NO_CIPHERS_SUPPORTED: "ERR_SSL_VERSION_OR_CIPHER_MISMATCH",
  SSL_ERROR_UNSUPPORTED_VERSION: "ERR_SSL_VERSION_OR_CIPHER_MISMATCH",
  SSL_ERROR_PROTOCOL_VERSION_ALERT: "ERR_SSL_VERSION_OR_CIPHER_MISMATCH",
  SSL_ERROR_SSL_DISABLED: "ERR_SSL_VERSION_OR_CIPHER_MISMATCH",
  SSL_ERROR_UNSUPPORTED_SIGNATURE_ALGORITHM: "ERR_SSL_VERSION_OR_CIPHER_MISMATCH",
  connectionFailure: "ERR_CONNECTION_REFUSED",
  netTimeout: "ERR_CONNECTION_TIMED_OUT",
  dnsNotFound: "ERR_NAME_NOT_RESOLVED",
  netReset: "ERR_CONNECTION_RESET",
  netInterrupt: "ERR_CONNECTION_CLOSED",
  netOffline: "ERR_INTERNET_DISCONNECTED",
  redirectLoop: "ERR_TOO_MANY_REDIRECTS",
  fileNotFound: "ERR_FILE_NOT_FOUND",
  fileAccessDenied: "ERR_ACCESS_DENIED",
  unknownProtocolFound: "ERR_UNKNOWN_URL_SCHEME",
  malformedURI: "ERR_INVALID_URL",
  proxyConnectFailure: "ERR_PROXY_CONNECTION_FAILED",
  proxyResolveFailure: "ERR_PROXY_CONNECTION_FAILED",
  contentEncodingError: "ERR_CONTENT_DECODING_FAILED",
  corruptedContentErrorv2: "ERR_INVALID_RESPONSE",
  unsafeContentType: "ERR_INVALID_RESPONSE",
  deniedPortAccess: "ERR_UNSAFE_PORT",
  notCached: "ERR_CACHE_MISS",
  inadequateSecurityError: "ERR_HTTP2_INADEQUATE_TRANSPORT_SECURITY",
  networkProtocolError: "ERR_HTTP2_PROTOCOL_ERROR",
  blockedByPolicy: "ERR_BLOCKED_BY_ADMINISTRATOR",
  cspBlocked: "ERR_BLOCKED_BY_RESPONSE",
  xfoBlocked: "ERR_BLOCKED_BY_RESPONSE",
  sslv3Used: "ERR_SSL_VERSION_OR_CIPHER_MISMATCH",
  unknownSocketType: "ERR_SSL_PROTOCOL_ERROR",
  nssFailure2: "ERR_SSL_PROTOCOL_ERROR",
};

/**
 * Gecko's certificate errors -> Chromium's (net/base/net_error_list.h). These
 * get the SSL interstitial, on about:certerror (nssBadCert) and also when
 * Gecko reports one as a TLS failure (nssFailure2), as it does for revoked
 * certificates and pinning failures, which Chromium does not let one bypass.
 */
const CERT_ERRORS = {
  SEC_ERROR_UNKNOWN_ISSUER: "ERR_CERT_AUTHORITY_INVALID",
  SEC_ERROR_UNTRUSTED_ISSUER: "ERR_CERT_AUTHORITY_INVALID",
  SEC_ERROR_UNTRUSTED_CERT: "ERR_CERT_AUTHORITY_INVALID",
  SEC_ERROR_CA_CERT_INVALID: "ERR_CERT_AUTHORITY_INVALID",
  MOZILLA_PKIX_ERROR_SELF_SIGNED_CERT: "ERR_CERT_AUTHORITY_INVALID",
  MOZILLA_PKIX_ERROR_MITM_DETECTED: "ERR_CERT_AUTHORITY_INVALID",
  MOZILLA_PKIX_ERROR_ISSUER_NO_LONGER_TRUSTED: "ERR_CERT_AUTHORITY_INVALID",
  MOZILLA_PKIX_ERROR_ADDITIONAL_POLICY_CONSTRAINT_FAILED:
    "ERR_CERT_AUTHORITY_INVALID",
  SSL_ERROR_BAD_CERT_DOMAIN: "ERR_CERT_COMMON_NAME_INVALID",
  SEC_ERROR_EXPIRED_CERTIFICATE: "ERR_CERT_DATE_INVALID",
  SEC_ERROR_EXPIRED_ISSUER_CERTIFICATE: "ERR_CERT_DATE_INVALID",
  SEC_ERROR_INVALID_TIME: "ERR_CERT_DATE_INVALID",
  MOZILLA_PKIX_ERROR_NOT_YET_VALID_CERTIFICATE: "ERR_CERT_DATE_INVALID",
  MOZILLA_PKIX_ERROR_NOT_YET_VALID_ISSUER_CERTIFICATE: "ERR_CERT_DATE_INVALID",
  SEC_ERROR_REVOKED_CERTIFICATE: "ERR_CERT_REVOKED",
  SEC_ERROR_CERT_SIGNATURE_ALGORITHM_DISABLED:
    "ERR_CERT_WEAK_SIGNATURE_ALGORITHM",
  MOZILLA_PKIX_ERROR_INADEQUATE_KEY_SIZE: "ERR_CERT_WEAK_KEY",
  SEC_ERROR_CERT_NOT_IN_NAME_SPACE: "ERR_CERT_NAME_CONSTRAINT_VIOLATION",
  MOZILLA_PKIX_ERROR_VALIDITY_TOO_LONG: "ERR_CERT_VALIDITY_TOO_LONG",
  MOZILLA_PKIX_ERROR_INSUFFICIENT_CERTIFICATE_TRANSPARENCY:
    "ERR_CERTIFICATE_TRANSPARENCY_REQUIRED",
  MOZILLA_PKIX_ERROR_KEY_PINNING_FAILURE:
    "ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN",
  SEC_ERROR_BAD_DER: "ERR_CERT_INVALID",
  SEC_ERROR_BAD_SIGNATURE: "ERR_CERT_INVALID",
  SEC_ERROR_EXTENSION_VALUE_INVALID: "ERR_CERT_INVALID",
  SEC_ERROR_INADEQUATE_CERT_TYPE: "ERR_CERT_INVALID",
  SEC_ERROR_INADEQUATE_KEY_USAGE: "ERR_CERT_INVALID",
  SEC_ERROR_INVALID_KEY: "ERR_CERT_INVALID",
  SEC_ERROR_PATH_LEN_CONSTRAINT_INVALID: "ERR_CERT_INVALID",
  SEC_ERROR_UNKNOWN_CRITICAL_EXTENSION: "ERR_CERT_INVALID",
  SEC_ERROR_UNSUPPORTED_EC_POINT_FORM: "ERR_CERT_INVALID",
  SEC_ERROR_UNSUPPORTED_ELLIPTIC_CURVE: "ERR_CERT_INVALID",
  SEC_ERROR_UNSUPPORTED_KEYALG: "ERR_CERT_INVALID",
  MOZILLA_PKIX_ERROR_INVALID_INTEGER_ENCODING: "ERR_CERT_INVALID",
  MOZILLA_PKIX_ERROR_SIGNATURE_ALGORITHM_MISMATCH: "ERR_CERT_INVALID",
  MOZILLA_PKIX_ERROR_EMPTY_ISSUER_NAME: "ERR_CERT_INVALID",
};

// localized_error.cc's NAV_SUGGESTIONS and SHOW_BUTTONS.
const SUGGEST_NONE = 0;
const SUGGEST_DIAGNOSE_TOOL = 1 << 0;
const SUGGEST_CHECK_CONNECTION = 1 << 1;
const SUGGEST_DNS_CONFIG = 1 << 2;
const SUGGEST_FIREWALL_CONFIG = 1 << 3;
const SUGGEST_PROXY_CONFIG = 1 << 4;
const SUGGEST_LEARNMORE = 1 << 6;
const SUGGEST_CONTACT_ADMINISTRATOR = 1 << 7;
const SUGGEST_UNSUPPORTED_CIPHER = 1 << 8;
const SUGGEST_ANTIVIRUS_CONFIG = 1 << 9;
const SUGGEST_OFFLINE_CHECKS = 1 << 10;
const SUGGEST_CAPTIVE_PORTAL_SIGNIN = 1 << 14;
const SHOW_NO_BUTTONS = 0;
const SHOW_BUTTON_RELOAD = 1;

/**
 * localized_error.cc's net_error_options and dns_probe_error_options, for the
 * errors GECKO_TO_CHROMIUM and dnsProbeResult produce:
 * name -> [heading, summary, suggestions, buttons].
 */
const NET_ERRORS = {
  ERR_TIMED_OUT: [
    "IDS_ERRORPAGES_HEADING_NOT_AVAILABLE",
    "IDS_ERRORPAGES_SUMMARY_TIMED_OUT",
    SUGGEST_CHECK_CONNECTION |
      SUGGEST_FIREWALL_CONFIG |
      SUGGEST_PROXY_CONFIG |
      SUGGEST_DIAGNOSE_TOOL |
      SUGGEST_CAPTIVE_PORTAL_SIGNIN,
    SHOW_BUTTON_RELOAD,
  ],
  ERR_CONNECTION_TIMED_OUT: [
    "IDS_ERRORPAGES_HEADING_NOT_AVAILABLE",
    "IDS_ERRORPAGES_SUMMARY_TIMED_OUT",
    SUGGEST_CHECK_CONNECTION |
      SUGGEST_FIREWALL_CONFIG |
      SUGGEST_PROXY_CONFIG |
      SUGGEST_DIAGNOSE_TOOL |
      SUGGEST_CAPTIVE_PORTAL_SIGNIN,
    SHOW_BUTTON_RELOAD,
  ],
  ERR_CONNECTION_CLOSED: [
    "IDS_ERRORPAGES_HEADING_NOT_AVAILABLE",
    "IDS_ERRORPAGES_SUMMARY_CONNECTION_CLOSED",
    SUGGEST_CHECK_CONNECTION |
      SUGGEST_FIREWALL_CONFIG |
      SUGGEST_PROXY_CONFIG |
      SUGGEST_DIAGNOSE_TOOL |
      SUGGEST_CAPTIVE_PORTAL_SIGNIN,
    SHOW_BUTTON_RELOAD,
  ],
  ERR_CONNECTION_RESET: [
    "IDS_ERRORPAGES_HEADING_NOT_AVAILABLE",
    "IDS_ERRORPAGES_SUMMARY_CONNECTION_RESET",
    SUGGEST_CHECK_CONNECTION |
      SUGGEST_FIREWALL_CONFIG |
      SUGGEST_PROXY_CONFIG |
      SUGGEST_DIAGNOSE_TOOL |
      SUGGEST_CAPTIVE_PORTAL_SIGNIN,
    SHOW_BUTTON_RELOAD,
  ],
  ERR_CONNECTION_REFUSED: [
    "IDS_ERRORPAGES_HEADING_NOT_AVAILABLE",
    "IDS_ERRORPAGES_SUMMARY_CONNECTION_REFUSED",
    SUGGEST_CHECK_CONNECTION |
      SUGGEST_FIREWALL_CONFIG |
      SUGGEST_PROXY_CONFIG |
      SUGGEST_CAPTIVE_PORTAL_SIGNIN,
    SHOW_BUTTON_RELOAD,
  ],
  ERR_PROXY_CONNECTION_FAILED: [
    "IDS_ERRORPAGES_HEADING_INTERNET_DISCONNECTED",
    "IDS_ERRORPAGES_SUMMARY_PROXY_CONNECTION_FAILED",
    SUGGEST_PROXY_CONFIG |
      SUGGEST_CONTACT_ADMINISTRATOR |
      SUGGEST_DIAGNOSE_TOOL |
      SUGGEST_CAPTIVE_PORTAL_SIGNIN,
    SHOW_NO_BUTTONS,
  ],
  ERR_INTERNET_DISCONNECTED: [
    "IDS_ERRORPAGES_HEADING_INTERNET_DISCONNECTED",
    "IDS_ERRORPAGES_HEADING_INTERNET_DISCONNECTED",
    SUGGEST_OFFLINE_CHECKS |
      SUGGEST_DIAGNOSE_TOOL |
      SUGGEST_CAPTIVE_PORTAL_SIGNIN,
    SHOW_NO_BUTTONS,
  ],
  ERR_FILE_NOT_FOUND: [
    "IDS_ERRORPAGES_HEADING_FILE_NOT_FOUND",
    "IDS_ERRORPAGES_SUMMARY_FILE_NOT_FOUND",
    SUGGEST_NONE,
    SHOW_NO_BUTTONS,
  ],
  ERR_CACHE_MISS: [
    "IDS_ERRORPAGES_HEADING_CACHE_READ_FAILURE",
    "IDS_ERRORPAGES_SUMMARY_CACHE_READ_FAILURE",
    SUGGEST_NONE,
    SHOW_BUTTON_RELOAD,
  ],
  ERR_TOO_MANY_REDIRECTS: [
    "IDS_ERRORPAGES_HEADING_PAGE_NOT_WORKING",
    "IDS_ERRORPAGES_SUMMARY_TOO_MANY_REDIRECTS",
    SUGGEST_LEARNMORE,
    SHOW_BUTTON_RELOAD,
  ],
  ERR_EMPTY_RESPONSE: [
    "IDS_ERRORPAGES_HEADING_PAGE_NOT_WORKING",
    "IDS_ERRORPAGES_SUMMARY_EMPTY_RESPONSE",
    SUGGEST_NONE,
    SHOW_BUTTON_RELOAD,
  ],
  ERR_CONTENT_LENGTH_MISMATCH: [
    "IDS_ERRORPAGES_HEADING_PAGE_NOT_WORKING",
    "IDS_ERRORPAGES_SUMMARY_CONNECTION_CLOSED",
    SUGGEST_NONE,
    SHOW_BUTTON_RELOAD,
  ],
  ERR_SSL_PROTOCOL_ERROR: [
    "IDS_ERRORPAGES_HEADING_INSECURE_CONNECTION",
    "IDS_ERRORPAGES_SUMMARY_INVALID_RESPONSE",
    SUGGEST_DIAGNOSE_TOOL,
    SHOW_BUTTON_RELOAD,
  ],
  ERR_BLOCKED_BY_ADMINISTRATOR: [
    "IDS_ERRORPAGES_HEADING_BLOCKED_BY_ADMINISTRATOR",
    "IDS_ERRORPAGES_SUMMARY_BLOCKED_BY_ADMINISTRATOR",
    SUGGEST_NONE,
    SHOW_NO_BUTTONS,
  ],
  ERR_SSL_VERSION_OR_CIPHER_MISMATCH: [
    "IDS_ERRORPAGES_HEADING_INSECURE_CONNECTION",
    "IDS_ERRORPAGES_SUMMARY_SSL_VERSION_OR_CIPHER_MISMATCH",
    SUGGEST_UNSUPPORTED_CIPHER,
    SHOW_NO_BUTTONS,
  ],
  ERR_BLOCKED_BY_RESPONSE: [
    "IDS_ERRORPAGES_HEADING_BLOCKED",
    "IDS_ERRORPAGES_SUMMARY_CONNECTION_REFUSED",
    SUGGEST_NONE,
    SHOW_NO_BUTTONS,
  ],
  DNS_PROBE_FINISHED_NO_INTERNET: [
    "IDS_ERRORPAGES_HEADING_INTERNET_DISCONNECTED",
    "IDS_ERRORPAGES_HEADING_INTERNET_DISCONNECTED",
    SUGGEST_OFFLINE_CHECKS | SUGGEST_DIAGNOSE_TOOL,
    SHOW_NO_BUTTONS,
  ],
  DNS_PROBE_FINISHED_NXDOMAIN: [
    "IDS_ERRORPAGES_HEADING_NOT_AVAILABLE",
    "IDS_ERRORPAGES_CHECK_TYPO_SUMMARY",
    SUGGEST_DIAGNOSE_TOOL | SUGGEST_CAPTIVE_PORTAL_SIGNIN,
    SHOW_BUTTON_RELOAD,
  ],
};

const DEFAULT_ERROR = [
  "IDS_ERRORPAGES_HEADING_NOT_AVAILABLE",
  "IDS_ERRORPAGES_SUMMARY_NOT_AVAILABLE",
  SUGGEST_NONE,
  SHOW_NO_BUTTONS,
];

// GetStringWithPlaceholder: the messages whose $1 is the host, and those
// whose $1 is the whole URL.
const HOST_PLACEHOLDER = new Set([
  "IDS_ERRORPAGES_CHECK_TYPO_SUMMARY",
  "IDS_ERRORPAGES_HEADING_ACCESS_DENIED",
  "IDS_ERRORPAGES_HEADING_BLOCKED",
  "IDS_ERRORPAGES_HEADING_NOT_FOUND",
  "IDS_ERRORPAGES_SUMMARY_CONNECTION_CLOSED",
  "IDS_ERRORPAGES_SUMMARY_CONNECTION_REFUSED",
  "IDS_ERRORPAGES_SUMMARY_EMPTY_RESPONSE",
  "IDS_ERRORPAGES_SUMMARY_INVALID_RESPONSE",
  "IDS_ERRORPAGES_SUMMARY_SSL_VERSION_OR_CIPHER_MISMATCH",
  "IDS_ERRORPAGES_SUMMARY_TIMED_OUT",
  "IDS_ERRORPAGES_SUMMARY_TOO_MANY_REDIRECTS",
]);
const URL_PLACEHOLDER = new Set([
  "IDS_ERRORPAGES_SUMMARY_FILE_ACCESS_DENIED",
  "IDS_ERRORPAGES_SUMMARY_NOT_AVAILABLE",
]);

const REDIRECT_LOOP_LEARN_MORE_URL =
  "https://support.google.com/chrome?p=rl_error";
// ssl_error_ui.cc's kHelpPath on Chromium's default support URL.
const SSL_HELP_URL = "https://support.google.com/chrome/answer/6098869";

const escapeHtml = text =>
  String(text).replace(
    /[&<>"']/g,
    c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]
  );

/**
 * l10n_util::GetStringFUTF16: the message for the page's language with $1,
 * $2... replaced.
 *
 * @param {string} id the message's IDS_ name
 * @param {...string} args the replacements, already escaped where needed
 * @returns {string} the message, which may hold markup
 */
function getString(id, ...args) {
  const text = STRINGS[LANGUAGE][id] ?? STRINGS.en[id];
  return text.replace(/\$(\d)/g, (_, n) => args[n - 1] ?? "");
}

/**
 * base::i18n::MessageFormatter for the ICU messages error_info.cc formats: a
 * top-level plural with =1 and other, `{N}` and `{N, date, full}`.
 *
 * @param {string} id the message's IDS_ name
 * @param {Array} args the arguments by number
 * @returns {string} the formatted message
 */
function formatIcu(id, args) {
  let text = STRINGS[LANGUAGE][id] ?? STRINGS.en[id];
  const plural = text.match(/^\s*\{(\d+),\s*plural,([\s\S]*)\}\s*$/);
  if (plural) {
    const value = args[plural[1]];
    const cases = {};
    for (const [, key, body] of plural[2].matchAll(
      /(=\d+|\w+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g
    )) {
      cases[key] = body;
    }
    text = (cases[`=${value}`] ?? cases.other).replace(
      /#/g,
      new Intl.NumberFormat(LANGUAGE).format(value)
    );
  }
  return text.replace(/\{(\d+)(, date, full)?\}/g, (_, n, date) =>
    date
      ? new Intl.DateTimeFormat(LANGUAGE, { dateStyle: "full" }).format(
          args[n]
        )
      : args[n]
  );
}

/**
 * The failed URL's host as Chromium shows it (IDNToUnicode of the host, no
 * port). Gecko's display host decodes IDN the same way but keeps the port.
 */
function hostForDisplay() {
  const { hostname = "", port = "" } = parsedUrl ?? {};
  try {
    const host = RPMGetHostForDisplay(document);
    return port && host.endsWith(`:${port}`)
      ? host.slice(0, -port.length - 1)
      : host;
  } catch (e) {
    return hostname;
  }
}

/**
 * Which Chromium page Gecko's failure gets.
 *
 * @param {object|null} failedCertInfo Gecko's certificate info on
 *   about:certerror
 * @returns {{ssl: boolean, error: string}} `ssl` for the SSL interstitial;
 *   `error` is the Chromium net error's name
 */
function classifyFailure(failedCertInfo) {
  const key = params.get("e");
  let code = failedCertInfo?.errorCodeString;
  if (key != "nssBadCert") {
    try {
      code = document.getNetErrorInfo().errorCodeString;
    } catch (e) {}
  }
  if (CERT_ERRORS[code]) {
    return { ssl: true, error: CERT_ERRORS[code] };
  }
  if (key == "nssBadCert") {
    return { ssl: true, error: "ERR_CERT_INVALID" };
  }
  const error =
    GECKO_TO_CHROMIUM[code] ?? GECKO_TO_CHROMIUM[key] ?? "ERR_FAILED";
  return {
    ssl: false,
    error: error == "ERR_NAME_NOT_RESOLVED" ? dnsProbeResult() : error,
  };
}

/**
 * NetErrorHelper replaces a failed lookup with the result of its DNS probe:
 * NXDOMAIN when the network works, NO_INTERNET when it does not. Gecko's
 * connectivity service stands in for the probe.
 */
function dnsProbeResult() {
  let connected = true;
  try {
    connected = RPMHasConnectivity();
  } catch (e) {}
  return connected
    ? "DNS_PROBE_FINISHED_NXDOMAIN"
    : "DNS_PROBE_FINISHED_NO_INTERNET";
}

function isOnlySuggestion(suggestions, suggestion) {
  return !!(suggestions & suggestion) && !(suggestions & ~suggestion);
}

/**
 * GetSuggestionsSummaryList for macOS, which has no network diagnostics
 * dialog any more (Chromium.app never offers it) and no captive portal state
 * Gecko could tell this page about.
 */
function getSuggestionsSummaryList(suggestions, data) {
  const list = [];
  suggestions &= ~(SUGGEST_DIAGNOSE_TOOL | SUGGEST_CAPTIVE_PORTAL_SIGNIN);
  if (suggestions == SUGGEST_NONE) {
    return list;
  }
  if (isOnlySuggestion(suggestions, SUGGEST_CONTACT_ADMINISTRATOR)) {
    list.push(
      getString("IDS_ERRORPAGES_SUGGESTION_CONTACT_ADMIN_SUMMARY_STANDALONE")
    );
    return list;
  }
  if (suggestions & SUGGEST_CONTACT_ADMINISTRATOR) {
    list.push(getString("IDS_ERRORPAGES_SUGGESTION_CONTACT_ADMIN_SUMMARY"));
  }
  if (suggestions & SUGGEST_LEARNMORE) {
    const url = `${REDIRECT_LOOP_LEARN_MORE_URL}&hl=${LANGUAGE}`;
    list.push(
      getString(
        "IDS_ERRORPAGES_SUGGESTION_DELETE_COOKIES_SUMMARY",
        escapeHtml(url)
      )
    );
    if (isOnlySuggestion(suggestions, SUGGEST_LEARNMORE)) {
      return list;
    }
  }
  if (suggestions & SUGGEST_CHECK_CONNECTION) {
    list.push(getString("IDS_ERRORPAGES_SUGGESTION_CHECK_CONNECTION_SUMMARY"));
  }
  const dns = suggestions & SUGGEST_DNS_CONFIG;
  const firewall = suggestions & SUGGEST_FIREWALL_CONFIG;
  const proxy = suggestions & SUGGEST_PROXY_CONFIG;
  if (dns && firewall && proxy) {
    list.push(
      getString("IDS_ERRORPAGES_SUGGESTION_CHECK_PROXY_FIREWALL_DNS_SUMMARY")
    );
  } else if (firewall && suggestions & SUGGEST_ANTIVIRUS_CONFIG) {
    list.push(
      getString("IDS_ERRORPAGES_SUGGESTION_CHECK_FIREWALL_ANTIVIRUS_SUMMARY")
    );
  } else if (proxy && firewall) {
    list.push(
      getString("IDS_ERRORPAGES_SUGGESTION_CHECK_PROXY_FIREWALL_SUMMARY")
    );
  } else if (proxy) {
    list.push(getString("IDS_ERRORPAGES_SUGGESTION_CHECK_PROXY_ADDRESS_SUMMARY"));
  }
  if (suggestions & SUGGEST_OFFLINE_CHECKS) {
    list.push(getString("IDS_ERRORPAGES_SUGGESTION_CHECK_HARDWARE_SUMMARY"));
    list.push(getString("IDS_ERRORPAGES_SUGGESTION_CHECK_WIFI_SUMMARY"));
  }
  data.suggestionsSummaryListHeader = getString(
    "IDS_ERRORPAGES_SUGGESTION_LIST_HEADER"
  );
  return list;
}

/** AddSuggestionsDetails for macOS: the panel under the Details button. */
function getSuggestionsDetails(suggestions) {
  const details = [];
  const add = (header, body) =>
    details.push({ header: getString(header), body: getString(body) });
  if (suggestions & SUGGEST_CHECK_CONNECTION) {
    add(
      "IDS_ERRORPAGES_SUGGESTION_CHECK_CONNECTION_HEADER",
      "IDS_ERRORPAGES_SUGGESTION_CHECK_CONNECTION_BODY"
    );
  }
  if (suggestions & SUGGEST_DNS_CONFIG) {
    add(
      "IDS_ERRORPAGES_SUGGESTION_DNS_CONFIG_HEADER",
      "IDS_ERRORPAGES_SUGGESTION_DNS_CONFIG_BODY"
    );
  }
  if (suggestions & SUGGEST_FIREWALL_CONFIG) {
    add(
      "IDS_ERRORPAGES_SUGGESTION_FIREWALL_CONFIG_HEADER",
      "IDS_ERRORPAGES_SUGGESTION_FIREWALL_CONFIG_BODY"
    );
  }
  if (suggestions & SUGGEST_PROXY_CONFIG) {
    add(
      "IDS_ERRORPAGES_SUGGESTION_PROXY_CONFIG_HEADER",
      "IDS_ERRORPAGES_SUGGESTION_PROXY_DISABLE_PLATFORM"
    );
  }
  if (suggestions & SUGGEST_UNSUPPORTED_CIPHER) {
    add(
      "IDS_ERRORPAGES_SUGGESTION_UNSUPPORTED_CIPHER_HEADER",
      "IDS_ERRORPAGES_SUGGESTION_UNSUPPORTED_CIPHER_BODY"
    );
  }
  return details;
}

/**
 * LocalizedError::GetPageState: the template data neterror.ts renders.
 *
 * @param {string} error the Chromium error's name
 */
function getPageState(error) {
  const protocol = parsedUrl?.protocol;
  const isHttp = protocol == "http:" || protocol == "https:";
  const hostName = escapeHtml(hostForDisplay());
  const failedUrlString = escapeHtml(failedUrl);
  let [heading, summary, suggestions, buttons] =
    NET_ERRORS[error] ?? DEFAULT_ERROR;
  // Access denied on a file: URL says so instead of the generic message.
  if (error == "ERR_ACCESS_DENIED" && protocol == "file:") {
    heading = "IDS_ERRORPAGES_HEADING_FILE_ACCESS_DENIED";
    summary = "IDS_ERRORPAGES_SUMMARY_FILE_ACCESS_DENIED";
    suggestions = SUGGEST_NONE;
    buttons = SHOW_BUTTON_RELOAD;
  }
  const withPlaceholder = id =>
    HOST_PLACEHOLDER.has(id)
      ? getString(id, hostName)
      : getString(id, URL_PLACEHOLDER.has(id) ? failedUrlString : undefined);
  const blockedByAdministrator = error == "ERR_BLOCKED_BY_ADMINISTRATOR";
  const offline =
    error == "ERR_INTERNET_DISCONNECTED" ||
    error == "DNS_PROBE_FINISHED_NO_INTERNET";
  const data = {
    title: isHttp ? hostForDisplay() : failedUrl,
    iconClass: offline
      ? "icon-offline"
      : blockedByAdministrator
        ? "icon-info"
        : "icon-generic",
    heading: { msg: withPlaceholder(heading) },
    summary: { msg: withPlaceholder(summary) },
    details: getString("IDS_ERRORPAGE_NET_BUTTON_DETAILS"),
    hideDetails: getString("IDS_ERRORPAGE_NET_BUTTON_HIDE_DETAILS"),
    errorCode: blockedByAdministrator ? "" : error,
  };
  if (buttons & SHOW_BUTTON_RELOAD) {
    data.reloadButton = { msg: getString("IDS_ERRORPAGES_BUTTON_RELOAD") };
  }
  data.suggestionsSummaryList = getSuggestionsSummaryList(suggestions, data);
  data.suggestionsDetails = getSuggestionsDetails(suggestions);
  return data;
}

let showingDetails = false;
let lastData = null;
const isSubFrame = window.top !== window;

/** neterror.ts's getHtml, for the macOS desktop (buttons suggested-right). */
function getHtml(data) {
  const list = data.suggestionsSummaryList;
  const showControlButtons = !!data.reloadButton;
  const showDetailsButton = data.suggestionsDetails.length > 0;
  return `
    <div id="main-frame-error" class="interstitial-wrapper ${showingDetails ? "showing-details" : ""}">
      <div id="main-content">
        <div class="icon ${isSubFrame ? "" : data.iconClass}"></div>
        <div id="main-message">
          <h1>
            <span>${data.heading.msg}</span>
          </h1>
          <p>${data.summary.msg}</p>
          ${
            list.length
              ? `<div id="suggestions-list">
              <p>${escapeHtml(data.suggestionsSummaryListHeader ?? "")}</p>
              <ul class="${list.length == 1 ? "single-suggestion" : ""}">
                ${list.map(item => `<li>${item}</li>`).join("")}
              </ul>
            </div>`
              : ""
          }
          <div class="error-code">${escapeHtml(data.errorCode)}</div>
        </div>
      </div>
      <div id="buttons" class="nav-wrapper suggested-right">
        <div id="control-buttons" ${showControlButtons ? "" : "hidden"}>
          ${
            data.reloadButton
              ? `<button id="reload-button" class="blue-button text-button">
              ${escapeHtml(data.reloadButton.msg)}
            </button>`
              : ""
          }
        </div>
        ${
          showDetailsButton
            ? `<button id="details-button" class="secondary-button text-button small-link ${showControlButtons ? "" : "singular"}">
            ${escapeHtml(showingDetails ? data.hideDetails : data.details)}
          </button>`
            : ""
        }
      </div>
      <div id="details">
        ${data.suggestionsDetails
          .map(
            item => `<div class="suggestions">
              <div class="suggestion-header">${item.header}</div>
              <div class="suggestion-body">${item.body}</div>
            </div>`
          )
          .join("")}
      </div>
    </div>
    <div id="sub-frame-error">
      <div class="icon ${isSubFrame ? data.iconClass : ""}"></div>
      <div id="sub-frame-error-details">${data.summary.msg}</div>
    </div>
  `;
}

function render() {
  const content = document.getElementById("content");
  content.innerHTML = getHtml(lastData);
  content
    .querySelector("#reload-button")
    ?.addEventListener("click", () => document.location.reload());
  content
    .querySelector("#details-button")
    ?.addEventListener("click", toggleHelpBox);
}

function toggleHelpBox() {
  showingDetails = !showingDetails;
  render();
}

function addStylesheet(name) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = BASE + name;
  document.head.append(link);
}

function showNetError(error) {
  addStylesheet("chromium/neterror.css");
  addStylesheet("firedog.css");
  if (isSubFrame) {
    document.documentElement.setAttribute("subframe", "");
  }
  lastData = getPageState(error);
  document.title = lastData.title;
  document.body.className = "neterror";
  document.body.style.fontFamily = FONT_FAMILY;
  document.body.style.fontSize = FONT_SIZE;
  const content = document.createElement("div");
  content.id = "content";
  document.body.replaceChildren(content);
  render();
  if (!isSubFrame && lastData.iconClass == "icon-offline") {
    document.documentElement.classList.add("offline");
  }
  // The suggestion links call toggleHelpBox() from an onclick attribute,
  // which the page's CSP does not run.
  document.addEventListener("click", event => {
    const link = event.target.closest?.('a[onclick="toggleHelpBox()"]');
    if (link) {
      event.preventDefault();
      toggleHelpBox();
      document.getElementById("buttons").scrollIntoView();
    }
  });
}

/**
 * The certificate's subject alternative DNS names, subject and issuer display
 * names and PEM chain, from Gecko's failed certificate info. Gecko only has
 * the DER chain; the names come from Firefox's own certificate decoder, as on
 * Firefox's certificate error page.
 */
async function getCertificate(failedCertInfo) {
  const chain = failedCertInfo?.certChainStrings ?? [];
  const certificate = { dnsNames: [], subject: "", issuer: "", pem: "" };
  certificate.pem = chain
    .map(
      der64 =>
        `-----BEGIN CERTIFICATE-----\n${der64.replace(/(\S{64}(?!$))/g, "$1\n")}\n-----END CERTIFICATE-----\n`
    )
    .join("");
  if (!chain.length) {
    return certificate;
  }
  try {
    const { parse, pemToDER } = await import(
      "chrome://global/content/certviewer/certDecoder.mjs"
    );
    const parsed = await parse(pemToDER(chain[0]));
    for (const [key, value] of parsed.ext.san?.altNames ?? []) {
      if (key == "DNS Name" && value.length) {
        certificate.dnsNames.push(value);
      }
    }
    // X509Certificate::GetDisplayName: the common name, else the organization.
    const displayName = name =>
      name.cn ||
      name.entries.find(([field]) => field == "Organization")?.[1] ||
      "";
    certificate.subject = displayName(parsed.subject);
    certificate.issuer = displayName(parsed.issuer);
    certificate.commonName = parsed.subject.cn;
  } catch (e) {}
  return certificate;
}

/** ssl_errors::ErrorInfo::CreateError's details for a Chromium cert error. */
function getCertErrorDetails(error, host, failedCertInfo, certificate) {
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  switch (error) {
    case "ERR_CERT_COMMON_NAME_INVALID": {
      const names = certificate.dnsNames;
      if (!names.length) {
        return getString(
          "IDS_CERT_ERROR_NO_SUBJECT_ALTERNATIVE_NAMES_DETAILS",
          host
        );
      }
      const name = names.includes(certificate.commonName)
        ? certificate.commonName
        : names[0];
      return getString(
        "IDS_CERT_ERROR_COMMON_NAME_INVALID_DETAILS",
        host,
        escapeHtml(name)
      );
    }
    case "ERR_CERT_DATE_INVALID": {
      const notBefore = failedCertInfo?.validNotBefore;
      const notAfter = failedCertInfo?.validNotAfter;
      if (notAfter && now > notAfter) {
        // Rounded up so that "expired in the last day" is 1 (crbug.com/476758).
        const days = Math.floor((now - notAfter) / day) + 1;
        return formatIcu("IDS_CERT_ERROR_EXPIRED_DETAILS", [host, days, now]);
      }
      if (notBefore && now < notBefore) {
        const days = Math.floor((notBefore - now) / day);
        return formatIcu("IDS_CERT_ERROR_NOT_YET_VALID_DETAILS", [host, days]);
      }
      return getString("IDS_CERT_ERROR_NOT_VALID_AT_THIS_TIME_DETAILS", host);
    }
    case "ERR_CERT_AUTHORITY_INVALID":
      return getString("IDS_CERT_ERROR_AUTHORITY_INVALID_DETAILS", host);
    case "ERR_CERT_REVOKED":
      return getString("IDS_CERT_ERROR_REVOKED_CERT_DETAILS", host);
    case "ERR_CERT_WEAK_SIGNATURE_ALGORITHM":
      return getString("IDS_CERT_ERROR_WEAK_SIGNATURE_ALGORITHM_DETAILS", host);
    case "ERR_CERT_WEAK_KEY":
      return getString("IDS_CERT_ERROR_WEAK_KEY_DETAILS", host);
    case "ERR_CERT_NAME_CONSTRAINT_VIOLATION":
      return getString("IDS_CERT_ERROR_NAME_CONSTRAINT_VIOLATION_DETAILS", host);
    case "ERR_CERT_VALIDITY_TOO_LONG":
      return getString("IDS_CERT_ERROR_VALIDITY_TOO_LONG_DETAILS", host);
    case "ERR_CERTIFICATE_TRANSPARENCY_REQUIRED":
      return getString(
        "IDS_CERT_ERROR_CERTIFICATE_TRANSPARENCY_REQUIRED_DETAILS"
      );
    case "ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN":
      return getString("IDS_CERT_ERROR_SUMMARY_PINNING_FAILURE_DETAILS");
    default:
      return getString("IDS_CERT_ERROR_INVALID_CERT_DETAILS", host);
  }
}

/**
 * Gecko's certificate info on about:certerror, which the parent may fill in
 * a moment after the page loads (aboutNetError.mjs's ensureCertErrorCode).
 */
async function getFailedCertSecurityInfo() {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const info = document.getFailedCertSecurityInfo();
      if (info.errorCodeString) {
        return info;
      }
    } catch (e) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

/**
 * The SSL interstitial: interstitial_large.html as interstitial_large.js and
 * ssl.js set it up for type SSL, with ssl_error_ui.cc's strings. Gecko decides
 * whether the error may be bypassed (never for HSTS hosts, in frames, or
 * without failedCertInfo, as for a TLS failure on about:neterror), and
 * proceeding adds Gecko's certificate exception the way aboutNetError.mjs
 * does.
 */
async function showSslInterstitial(error, failedCertInfo) {
  addStylesheet("chromium/interstitial_ssl.css");
  addStylesheet("firedog.css");
  const certificate = await getCertificate(failedCertInfo);
  const host = escapeHtml(hostForDisplay());
  const asciiHost = escapeHtml(parsedUrl?.hostname ?? "");
  const hsts = params.get("s") == "badStsCert";
  const overridable =
    !!failedCertInfo?.errorIsOverridable && !hsts && !isSubFrame;
  const data = {
    tabTitle: getString("IDS_SSL_V2_TITLE"),
    heading: getString("IDS_SSL_V2_HEADING"),
    primaryParagraph: getString("IDS_SSL_V2_PRIMARY_PARAGRAPH", host),
    errorCode: `net::${error}`,
    openDetails: getString("IDS_SSL_OPEN_DETAILS_BUTTON"),
    closeDetails: getString("IDS_SSL_CLOSE_DETAILS_BUTTON"),
  };
  if (overridable) {
    data.explanationParagraph = getCertErrorDetails(
      error,
      asciiHost,
      failedCertInfo,
      certificate
    );
    data.primaryButtonText = getString("IDS_SSL_OVERRIDABLE_SAFETY_BUTTON");
    data.finalParagraph = getString(
      "IDS_SSL_OVERRIDABLE_PROCEED_PARAGRAPH",
      host
    );
  } else {
    data.explanationParagraph = getString("IDS_SSL_NONOVERRIDABLE_MORE", host);
    data.primaryButtonText = getString("IDS_SSL_RELOAD");
    const helpString =
      {
        ERR_CERT_REVOKED: "IDS_SSL_NONOVERRIDABLE_REVOKED",
        ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN: "IDS_SSL_NONOVERRIDABLE_PINNED",
        ERR_CERT_INVALID: "IDS_SSL_NONOVERRIDABLE_INVALID",
      }[error] ??
      (hsts ? "IDS_SSL_NONOVERRIDABLE_HSTS" : "IDS_SSL_NONOVERRIDABLE_INVALID");
    data.finalParagraph = getString(helpString, host);
  }

  document.title = data.tabTitle;
  document.body.id = "body";
  document.body.className = "ssl";
  // text_defaults.css, which Chromium appends to interstitial pages.
  document.body.style.fontFamily = FONT_FAMILY;
  document.body.style.fontSize = FONT_SIZE;
  document.body.innerHTML = `
  <div class="interstitial-wrapper">
    <div id="main-content">
      <div class="icon" id="icon"></div>
      <div id="main-message">
        <h1>${data.heading}</h1>
        <p>${data.primaryParagraph}</p>
        <div id="debugging">
          <div id="error-code" class="error-code"></div>
          <div id="error-debugging-info" class="hidden"></div>
        </div>
      </div>
    </div>
    <div class="nav-wrapper">
      <button id="primary-button">${escapeHtml(data.primaryButtonText)}</button>
      <button id="proceed-button" class="secondary-button small-link hidden"></button>
      <button id="details-button" class="secondary-button small-link">
        ${escapeHtml(data.openDetails)}
      </button>
    </div>
    <div id="details" class="hidden">
      <p>${data.explanationParagraph}</p>
      <p id="final-paragraph">${data.finalParagraph}</p>
    </div>
  </div>
`;
  for (const button of document.querySelectorAll("button")) {
    button.style.fontFamily = FONT_FAMILY;
  }
  const errorCode = document.getElementById("error-code");
  errorCode.textContent = data.errorCode;
  document.getElementById("icon").classList.add("icon", "new-icon");

  // Chromium goes back, or to the new tab page without history; Firefox's
  // parent does the same with its home page.
  const goBack = () => RPMSendAsyncMessage("Browser:SSLErrorGoBack");
  const proceed = () => {
    if (!overridable) {
      return;
    }
    const isPermanent =
      !RPMIsWindowPrivate() &&
      RPMGetBoolPref("security.certerrors.permanentOverride");
    document.addCertException(!isPermanent).then(
      () => location.reload(),
      () => {}
    );
  };
  document
    .getElementById("primary-button")
    .addEventListener("click", () =>
      overridable ? goBack() : location.reload()
    );
  if (overridable) {
    const proceedLink = document.getElementById("proceed-link");
    proceedLink.classList.add("small-link");
    proceedLink.addEventListener("click", event => {
      event.preventDefault();
      proceed();
    });
  }
  document
    .getElementById("learn-more-link")
    ?.addEventListener("click", event => {
      event.preventDefault();
      location.href = SSL_HELP_URL;
    });

  const detailsButton = document.getElementById("details-button");
  detailsButton.setAttribute("aria-expanded", "false");
  detailsButton.addEventListener("click", () => {
    const hiddenDetails = document
      .getElementById("details")
      .classList.toggle("hidden");
    detailsButton.setAttribute("aria-expanded", String(!hiddenDetails));
    detailsButton.innerText = hiddenDetails
      ? data.openDetails
      : data.closeDetails;
  });

  // ssl.js: the error code toggles certificate details, titled in English
  // as Chromium leaves them for bug reports.
  const debuggingInfo = document.getElementById("error-debugging-info");
  const shortDate = new Intl.DateTimeFormat(LANGUAGE, { dateStyle: "short" });
  const fields = [
    ["Subject", certificate.subject],
    ["Issuer", certificate.issuer],
    [
      "Expires on",
      failedCertInfo?.validNotAfter
        ? shortDate.format(failedCertInfo.validNotAfter)
        : "",
    ],
    ["Current date", shortDate.format(new Date())],
    ["PEM encoded chain", certificate.pem, true],
  ];
  for (const [title, value, fixedWidth] of fields) {
    const spanTitle = document.createElement("span");
    spanTitle.classList.add("debugging-title");
    spanTitle.innerText = `${title}: `;
    const spanValue = document.createElement("span");
    spanValue.classList.add("debugging-content");
    if (fixedWidth) {
      spanValue.classList.add("debugging-content-fixed-width");
    }
    spanValue.innerText = value;
    const paragraph = document.createElement("p");
    paragraph.classList.add("debugging-content");
    paragraph.append(spanTitle, spanValue);
    debuggingInfo.append(paragraph);
  }
  errorCode.setAttribute("role", "button");
  errorCode.setAttribute("aria-expanded", "false");
  errorCode.addEventListener("click", () => {
    const hiddenDebug = debuggingInfo.classList.toggle("hidden");
    errorCode.setAttribute("aria-expanded", String(!hiddenDebug));
  });

  // interstitial_large.js's typed bypass; Gecko can only add the exception
  // for errors it considers overridable.
  const bypass = atob("dGhpc2lzdW5zYWZl");
  let keyPressState = 0;
  document.addEventListener("keypress", event => {
    if (bypass.charCodeAt(keyPressState) == event.keyCode) {
      keyPressState++;
      if (keyPressState == bypass.length) {
        proceed();
        keyPressState = 0;
      }
    } else {
      keyPressState = 0;
    }
  });
}

document.documentElement.lang = LANGUAGE;
const failedCertInfo =
  params.get("e") == "nssBadCert" ? await getFailedCertSecurityInfo() : null;
const failure = classifyFailure(failedCertInfo);
if (failure.ssl) {
  await showSslInterstitial(failure.error, failedCertInfo);
} else {
  showNetError(failure.error);
}
