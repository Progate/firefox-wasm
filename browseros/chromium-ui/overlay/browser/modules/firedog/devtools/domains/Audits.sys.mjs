/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Audits domain: issues found on the page, for the Issues panel.
//
// The issues Gecko reports in a form Chromium's issues can be built from are
// Content Security Policy violations: Gecko fires a
// "securitypolicyviolation" event for each, which reaches the tab's
// <browser> (single-process Gecko delivers the page's events to it). Issues
// are kept from Audits.enable on and sent again on a later enable, as
// Chromium does with the issues it stored.

import { winOf } from "resource:///modules/firedog/devtools/domains/DOM.sys.mjs";
import { frameIdOf } from "resource:///modules/firedog/devtools/domains/Runtime.sys.mjs";

// Chromium keeps at most this many issues per page.
const MAX_ISSUES = 1000;

function violationType(blockedURI) {
  switch (blockedURI) {
    case "inline":
      return "kInlineViolation";
    case "eval":
      return "kEvalViolation";
    case "wasm-eval":
      return "kWasmEvalViolation";
    case "trusted-types-policy":
      return "kTrustedTypesPolicyViolation";
    case "trusted-types-sink":
      return "kTrustedTypesSinkViolation";
  }
  return "kURLViolation";
}

export class Audits {
  constructor(session) {
    this.session = session;
    this.target = session.target;
    this.enabled = false;
    this.issues = [];
    this.listening = false;
  }

  _listen() {
    if (this.listening) {
      return;
    }
    this.listening = true;
    this.onViolation = event => this._onViolation(event);
    this.target.browser.addEventListener("securitypolicyviolation", this.onViolation, true);
  }

  _onViolation(event) {
    const win = event.target?.nodeType ? winOf(event.target) : event.target?.window;
    if (!win?.browsingContext || win.browsingContext.top !== this.target.browsingContext) {
      return;
    }
    const isURL = violationType(event.blockedURI) === "kURLViolation";
    const scriptId = event.sourceFile
      ? this.session.domains.get("Debugger")?._scriptIdForUrl?.(event.sourceFile)
      : undefined;
    const details = {
      ...(isURL && event.blockedURI ? { blockedURL: event.blockedURI } : {}),
      violatedDirective: event.effectiveDirective || event.violatedDirective,
      isReportOnly: event.disposition === "report",
      contentSecurityPolicyViolationType: violationType(event.blockedURI),
      frameAncestor: { frameId: frameIdOf(this.target, win.browsingContext) },
      ...(event.sourceFile
        ? {
            sourceCodeLocation: {
              ...(scriptId ? { scriptId } : {}),
              url: event.sourceFile,
              lineNumber: Math.max(0, event.lineNumber - 1),
              columnNumber: Math.max(0, event.columnNumber - 1),
            },
          }
        : {}),
    };
    this._add({
      code: "ContentSecurityPolicyIssue",
      details: { contentSecurityPolicyIssueDetails: details },
    });
  }

  _add(issue) {
    this.issues.push(issue);
    if (this.issues.length > MAX_ISSUES) {
      this.issues.shift();
    }
    if (this.enabled) {
      this.session.emit("Audits.issueAdded", { issue });
    }
  }

  enable() {
    this._listen();
    if (this.enabled) {
      return;
    }
    this.enabled = true;
    for (const issue of this.issues) {
      this.session.emit("Audits.issueAdded", { issue });
    }
  }

  disable() {
    this.enabled = false;
  }

  _destroy() {
    if (this.listening) {
      this.target.browser.removeEventListener("securitypolicyviolation", this.onViolation, true);
    }
  }
}
