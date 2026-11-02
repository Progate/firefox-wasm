/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Log domain: browser-side messages that are not the page's own console
// calls or uncaught exceptions (those are Runtime's), such as CSS parse
// warnings, mixed content and network errors. Gecko reports them as
// nsIScriptError with a category; Chromium's LogEntry has a source.

// Gecko's error categories to Log.LogEntry.source.
const SOURCES = [
  [/^CSS/, "rendering"],
  [/^(Mixed Content|Security|SSL|CSP|Content Security Policy|Cross-Origin|CORS)/i, "security"],
  [/^(DOM:HTML|HTML)/, "rendering"],
  [/^(Network|HTTP|Image|Media)/i, "network"],
  [/^DOM:? ?Storage|IndexedDB|Cookie/i, "storage"],
  [/Deprecat/i, "deprecation"],
  [/^XML/, "xml"],
  [/javascript/i, "javascript"],
];

function sourceOf(category) {
  for (const [pattern, source] of SOURCES) {
    if (pattern.test(category ?? "")) {
      return source;
    }
  }
  return "other";
}

export class Log {
  constructor(session) {
    this.session = session;
    this.enabled = false;
  }

  _entry(error, context) {
    if (!this.enabled) {
      return;
    }
    const isWarning = error.flags & Ci.nsIScriptError.warningFlag;
    const isInfo = error.flags & Ci.nsIScriptError.infoFlag;
    this.session.emit("Log.entryAdded", {
      entry: {
        source: sourceOf(error.category),
        level: isInfo ? "info" : isWarning ? "warning" : "error",
        text: error.errorMessage,
        timestamp: error.timeStamp,
        ...(error.sourceName ? { url: error.sourceName } : {}),
        ...(error.lineNumber ? { lineNumber: error.lineNumber - 1 } : {}),
      },
    });
  }

  enable() {
    this.enabled = true;
    // Runtime listens to the console service for both domains.
    this.session.domain("Runtime")._startObserving();
  }

  disable() {
    this.enabled = false;
  }

  clear() {}

  // Chromium's violation reports (long tasks, forced layouts) have no
  // equivalent measurement in Gecko; the front-end asks for them only to show
  // them, so there is nothing to start.
  startViolationsReport() {}

  stopViolationsReport() {}
}
