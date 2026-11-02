/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The CSS domain: style sheets, the rules matching a node (the Styles pane),
// computed style (the Computed pane) and editing.
//
// Matched rules come from Gecko's style system (InspectorUtils, as Firefox's
// own rule view gets them), so the cascade, the user agent rules and the
// values are Gecko's. What CDP adds is source ranges: every selector,
// declaration and at-rule prelude is located in its style sheet's text,
// which is where the front-end shows "(index):12" and where its edits are
// applied. Rule positions come from Gecko (the line and column it parsed the
// rule at); the text inside a rule is split with DevTools' CSS declaration
// parser, the one Firefox's rule view edits with.
//
// Edits replace a range of the sheet's text and reparse the sheet in place
// (InspectorUtils.parseStyleSheet), like Blink's InspectorStyleSheet; inline
// styles are edited through the style attribute. Both go through the DOM
// domain's undo history.

import {
  backendNodeIdOf,
  parentOf,
  styledElementOf,
  winOf,
} from "resource:///modules/firedog/devtools/domains/DOM.sys.mjs";
import { frameIdOf } from "resource:///modules/firedog/devtools/domains/Runtime.sys.mjs";
import {
  InvalidParams,
  ProtocolError,
} from "resource:///modules/firedog/devtools/Session.sys.mjs";

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "devtools", () => {
  const { require } = ChromeUtils.importESModule(
    "resource://devtools/shared/loader/Loader.sys.mjs"
  );
  return {
    parsing: require("resource://devtools/shared/css/parsing-utils.js"),
    sheets: require("resource://devtools/server/actors/stylesheets/stylesheet-utils.js"),
  };
});

const XHTML_NS = "http://www.w3.org/1999/xhtml";

// Pseudo-elements whose rules the Styles pane lists for an element, as
// DOM.PseudoType names.
const MATCHED_PSEUDOS = [
  ["::before", "before"],
  ["::after", "after"],
  ["::marker", "marker"],
  ["::first-line", "first-line"],
  ["::first-letter", "first-letter"],
  ["::placeholder", "placeholder"],
  ["::file-selector-button", "file-selector-button"],
  ["::backdrop", "backdrop"],
  ["::selection", "selection"],
  ["::target-text", "target-text"],
];

// Highlight pseudos inherit from ancestors (inheritedPseudoElements).
const INHERITED_PSEUDOS = [
  ["::selection", "selection"],
  ["::target-text", "target-text"],
];

// The env() variables Blink reports.
const ENVIRONMENT_VARIABLES = [
  "safe-area-inset-top",
  "safe-area-inset-left",
  "safe-area-inset-bottom",
  "safe-area-inset-right",
  "safe-area-max-inset-top",
  "safe-area-max-inset-left",
  "safe-area-max-inset-bottom",
  "safe-area-max-inset-right",
  "keyboard-inset-top",
  "keyboard-inset-left",
  "keyboard-inset-bottom",
  "keyboard-inset-right",
  "keyboard-inset-width",
  "keyboard-inset-height",
];

function isPropertyKnown(name) {
  if (name.startsWith("--")) {
    return true;
  }
  try {
    InspectorUtils.cssPropertyIsShorthand(name);
    return true;
  } catch {
    return false;
  }
}

function isShorthand(name) {
  try {
    return InspectorUtils.cssPropertyIsShorthand(name);
  } catch {
    return false;
  }
}

let shorthandsBySize = null;
// All shorthands with their longhands, largest first: Blink's
// shorthandEntries for a style list the shorthands its longhands complete.
function shorthands() {
  if (!shorthandsBySize) {
    shorthandsBySize = InspectorUtils.getCSSPropertyNames({ includeShorthands: true })
      .filter(name => !name.startsWith("-") && isShorthand(name))
      .map(name => [name, InspectorUtils.getSubpropertiesForCSSProperty(name)])
      .sort((a, b) => b[1].length - a[1].length);
  }
  return shorthandsBySize;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

function positionOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { line: low, column: offset - starts[low] };
}

function rangeOf(starts, start, end) {
  const from = positionOf(starts, start);
  const to = positionOf(starts, end);
  return {
    startLine: from.line,
    startColumn: from.column,
    endLine: to.line,
    endColumn: to.column,
  };
}

function offsetOfPosition(starts, line, column) {
  if (line >= starts.length) {
    return null;
  }
  return starts[line] + column;
}

// Skips a string or comment starting at text[i]; returns the index after it,
// or i when there is none.
function skipToken(text, i) {
  const char = text[i];
  if (char === '"' || char === "'") {
    let j = i + 1;
    while (j < text.length && text[j] !== char && text[j] !== "\n") {
      j += text[j] === "\\" ? 2 : 1;
    }
    return j + 1;
  }
  if (char === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end < 0 ? text.length : end + 2;
  }
  if (char === "\\") {
    return i + 2;
  }
  return i;
}

// The block of the rule starting at `start`: the offsets of its "{" and of
// its matching "}" (the text's end when the sheet is unterminated).
function blockOf(text, start) {
  let i = start;
  let depth = 0;
  let open = -1;
  while (i < text.length) {
    const skipped = skipToken(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const char = text[i];
    if (open < 0) {
      if (char === "(" || char === "[") {
        depth++;
      } else if (char === ")" || char === "]") {
        depth--;
      } else if (char === "{" && depth <= 0) {
        open = i;
        depth = 0;
      } else if (char === ";" && depth <= 0) {
        // A statement at-rule (@import, @layer a;) has no block.
        return null;
      }
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      if (depth === 0) {
        return { open, close: i };
      }
      depth--;
    }
    i++;
  }
  return open < 0 ? null : { open, close: text.length };
}

// Offsets of the selectors of a selector list (split at top-level commas),
// without surrounding whitespace and comments.
function selectorRanges(text, start, end) {
  const pieces = [];
  let pieceStart = start;
  let depth = 0;
  for (let i = start; i < end; ) {
    const skipped = skipToken(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const char = text[i];
    if (char === "(" || char === "[") {
      depth++;
    } else if (char === ")" || char === "]") {
      depth--;
    } else if (char === "," && depth === 0) {
      pieces.push([pieceStart, i]);
      pieceStart = i + 1;
    }
    i++;
  }
  pieces.push([pieceStart, end]);
  return pieces.map(([from, to]) => trimRange(text, from, to));
}

function trimRange(text, from, to) {
  for (;;) {
    while (from < to && /\s/.test(text[from])) {
      from++;
    }
    if (text.startsWith("/*", from)) {
      const end = text.indexOf("*/", from + 2);
      from = end < 0 || end + 2 > to ? to : end + 2;
      continue;
    }
    break;
  }
  for (;;) {
    while (to > from && /\s/.test(text[to - 1])) {
      to--;
    }
    if (to - from >= 4 && text.endsWith("*/", to)) {
      const begin = text.lastIndexOf("/*", to - 2);
      if (begin >= from) {
        to = begin;
        continue;
      }
    }
    break;
  }
  return [from, to];
}

function className(object) {
  try {
    return ChromeUtils.getClassName(object);
  } catch {
    return "";
  }
}

function specificityOf(value) {
  return {
    a: Math.floor(value / (1024 * 1024)),
    b: Math.floor((value % (1024 * 1024)) / 1024),
    c: value % 1024,
  };
}

// Gecko's internal properties never appear in authored styles.
function isInternalProperty(name) {
  return name.startsWith("-x-");
}

export class CSS {
  constructor(session) {
    this.session = session;
    this.target = session.target;
    this.enabled = false;
    // Style sheets by id, and each sheet's id.
    this.sheets = new Map();
    this.sheetIds = new WeakMap();
    this.nextSheetId = 1;
    this.prefix = Math.floor(Math.random() * 1e5);
    // Texts set through this domain, which Gecko does not keep.
    this.texts = new WeakMap();
    // Inline styles: one id per element, like Blink's "<n>.<n>" ids.
    this.inlineIds = new WeakMap();
    this.inlineElements = new Map();
    this.nextInlineId = 1;
    this.trackedProperties = [];
    this.trackedValues = new Map();
    this.pendingUpdates = new Set();
    this.takeResolver = null;
    this.trackedNode = null;
  }

  get _dom() {
    return this.session.domain("DOM");
  }

  // Style sheets.

  _styleSheetId(sheet) {
    let id = this.sheetIds.get(sheet);
    if (!id) {
      id = `style-sheet-${this.prefix}-${this.nextSheetId++}`;
      this.sheetIds.set(sheet, id);
      this.sheets.set(id, { id, sheet });
    }
    return id;
  }

  _sheet(styleSheetId) {
    const info = this.sheets.get(styleSheetId);
    if (!info || Cu.isDeadWrapper(info.sheet)) {
      throw new ProtocolError(`No style sheet with given id found`);
    }
    return info;
  }

  _origin(sheet) {
    if (sheet.parsingMode === "agent") {
      return "user-agent";
    }
    if (sheet.parsingMode === "user") {
      return "injected";
    }
    return this.inspectorSheets?.has(sheet) ? "inspector" : "regular";
  }

  // The document a sheet belongs to (imported sheets: their importer's).
  _ownerNodeOf(sheet) {
    let top = sheet;
    while (top.parentStyleSheet && top.parentStyleSheet !== top) {
      top = top.parentStyleSheet;
    }
    return top.ownerNode ?? null;
  }

  _documentOf(sheet) {
    return this._ownerNodeOf(sheet)?.ownerDocument ?? sheet.associatedDocument ?? null;
  }

  // The sheet's text: what DevTools set, the <style> element's text, the
  // fetched file; or, once scripts changed its rules through CSSOM (or for
  // a constructed sheet, whose text Gecko does not keep), the rules'
  // serialization, which is what Blink then shows too.
  async _text(info) {
    const sheet = info.sheet;
    const set = this.texts.get(sheet);
    if (set !== undefined) {
      info.generated = null;
      return set;
    }
    if (sheet.constructed || InspectorUtils.hasRulesModifiedByCSSOM(sheet)) {
      return this._generatedText(info);
    }
    info.generated = null;
    if (!sheet.href) {
      return this._ownerNodeOf(sheet)?.textContent ?? "";
    }
    if (info.fetched === undefined) {
      try {
        info.fetched = await lazy.devtools.sheets.getStyleSheetText(sheet);
      } catch {
        info.fetched = null;
      }
    }
    return info.fetched ?? this._generatedText(info);
  }

  _generatedText(info) {
    const offsets = new Map();
    const parts = [];
    let length = 0;
    for (const rule of info.sheet.cssRules) {
      offsets.set(rule, length);
      const text = rule.cssText;
      this._nestedOffsets(rule, text, length, offsets);
      parts.push(text);
      length += text.length + 1;
    }
    info.generated = offsets;
    return parts.join("\n");
  }

  _nestedOffsets(rule, text, base, offsets) {
    let cursor = 0;
    for (const child of rule.cssRules ?? []) {
      const childText = child.cssText;
      const at = text.indexOf(childText, cursor);
      if (at < 0) {
        continue;
      }
      offsets.set(child, base + at);
      this._nestedOffsets(child, childText, base + at, offsets);
      cursor = at + childText.length;
    }
  }

  // Where a rule starts in its sheet's text.
  _ruleStart(info, text, starts, rule) {
    if (info.generated) {
      return info.generated.get(rule) ?? null;
    }
    const line = InspectorUtils.getRelativeRuleLine(rule);
    const column = InspectorUtils.getRuleColumn(rule);
    if (!line) {
      return null;
    }
    return offsetOfPosition(starts, line - 1, Math.max(0, column - 1));
  }

  // Where an inline <style>'s text starts in its document's source. Gecko
  // knows the line (rule lines relative to the document and to the sheet
  // differ by it) but not the column, so the text is found in the source.
  async _inlineStart(info) {
    if (info.start !== undefined) {
      return info.start;
    }
    info.start = { line: 0, column: 0 };
    const sheet = info.sheet;
    const owner = sheet.ownerNode;
    if (sheet.href || !owner || owner.localName !== "style") {
      return info.start;
    }
    let line = null;
    for (const rule of sheet.cssRules) {
      const absolute = InspectorUtils.getRuleLine(rule);
      const relative = InspectorUtils.getRelativeRuleLine(rule);
      if (absolute && relative) {
        line = absolute - relative;
        break;
      }
    }
    const source = await this._documentSource(owner.ownerDocument);
    const text = owner.textContent;
    if (source !== null && text) {
      const sourceStarts = lineStarts(source);
      let at = source.indexOf(text);
      let best = null;
      while (at >= 0) {
        const position = positionOf(sourceStarts, at);
        if (line === null || position.line === line) {
          best = position;
          break;
        }
        at = source.indexOf(text, at + 1);
      }
      if (best) {
        info.start = best;
        return info.start;
      }
    }
    if (line !== null) {
      info.start = { line, column: 0 };
    }
    return info.start;
  }

  async _documentSource(document) {
    this.sources ??= new WeakMap();
    if (this.sources.has(document)) {
      return this.sources.get(document);
    }
    let source = null;
    try {
      if (document.URL === "about:srcdoc") {
        source = document.defaultView.browsingContext.embedderElement?.getAttribute("srcdoc") ?? null;
      } else {
        const { require } = ChromeUtils.importESModule(
          "resource://devtools/shared/loader/Loader.sys.mjs"
        );
        const { fetch } = require("resource://devtools/shared/DevToolsUtils.js");
        const result = await fetch(document.URL, {
          loadFromCache: true,
          window: document.defaultView,
          principal: document.nodePrincipal,
          charset: document.characterSet,
        });
        source = result.content;
      }
    } catch {
      source = null;
    }
    this.sources.set(document, source);
    return source;
  }

  async _header(info) {
    const sheet = info.sheet;
    const text = await this._text(info);
    const owner = this._ownerNodeOf(sheet);
    const document = this._documentOf(sheet);
    const isInline = !sheet.href && !!owner && owner.localName === "style" && !sheet.constructed;
    const start = isInline ? await this._inlineStart(info) : { line: 0, column: 0 };
    const starts = lineStarts(text);
    const end = positionOf(starts, text.length);
    const header = {
      styleSheetId: info.id,
      frameId: document?.defaultView ? frameIdOf(this.target, document.defaultView.browsingContext) : this.target.id,
      sourceURL: sheet.href ?? (sheet.constructed ? "" : document?.URL ?? ""),
      origin: this._origin(sheet),
      title: sheet.title ?? "",
      disabled: sheet.disabled,
      isInline,
      isMutable: this.texts.has(sheet) || sheet.constructed || InspectorUtils.hasRulesModifiedByCSSOM(sheet),
      isConstructed: !!sheet.constructed,
      startLine: start.line,
      startColumn: start.column,
      length: text.length,
      endLine: start.line + end.line,
      endColumn: end.line ? end.column : start.column + end.column,
    };
    if (owner) {
      header.ownerNode = backendNodeIdOf(owner);
    }
    if (sheet.sourceMapURL) {
      header.sourceMapURL = sheet.sourceMapURL;
    }
    return header;
  }

  // Every author sheet of the page: documents, shadow roots, imports.
  _allSheets() {
    const sheets = [];
    const seen = new Set();
    const add = sheet => {
      if (!sheet || seen.has(sheet) || sheet.parsingMode === "agent") {
        return;
      }
      seen.add(sheet);
      sheets.push(sheet);
      let rules = [];
      try {
        rules = sheet.cssRules;
      } catch {
        return;
      }
      for (const rule of rules) {
        if (className(rule) === "CSSImportRule") {
          add(rule.styleSheet);
        }
      }
    };
    const visitRoot = root => {
      for (const sheet of root.styleSheets) {
        add(sheet);
      }
      for (const sheet of root.adoptedStyleSheets ?? []) {
        add(sheet);
      }
    };
    for (const win of this.session.domain("Runtime")._windows()) {
      const document = win.document;
      visitRoot(document);
      const walker = document.createTreeWalker(document, 1);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const root = node.openOrClosedShadowRoot;
        if (root && !root.isUAWidget()) {
          visitRoot(root);
          const inner = document.createTreeWalker(root, 1);
          for (let child = inner.nextNode(); child; child = inner.nextNode()) {
            const nested = child.openOrClosedShadowRoot;
            if (nested && !nested.isUAWidget()) {
              visitRoot(nested);
            }
          }
        }
      }
    }
    return sheets;
  }

  async _announce(sheet) {
    if (!this.enabled || sheet.parsingMode === "agent") {
      return;
    }
    const id = this._styleSheetId(sheet);
    const info = this.sheets.get(id);
    if (info.announced) {
      return;
    }
    info.announced = true;
    this.session.emit("CSS.styleSheetAdded", { header: await this._header(info) });
  }

  _onSheetEvent(event) {
    const sheet = event.stylesheet;
    const document = sheet && this._documentOf(sheet);
    if (!document?.defaultView || document.defaultView.browsingContext?.top !== this.target.browsingContext) {
      return;
    }
    if (event.type === "StyleSheetApplicableStateChanged" && event.applicable) {
      this._announce(sheet);
    } else if (event.type === "StyleSheetRemoved") {
      const id = this.sheetIds.get(sheet);
      const info = id && this.sheets.get(id);
      if (info?.announced) {
        info.announced = false;
        this.session.emit("CSS.styleSheetRemoved", { styleSheetId: id });
      }
    }
  }

  observe(subject, topic) {
    if (topic === "document-element-inserted" && subject.defaultView?.browsingContext?.top === this.target.browsingContext) {
      subject.styleSheetChangeEventsEnabled = true;
    }
  }

  _listen() {
    if (this.listening) {
      return;
    }
    this.listening = true;
    this.onSheetEvent = event => this._onSheetEvent(event);
    this.target.browser.addEventListener("StyleSheetApplicableStateChanged", this.onSheetEvent, true);
    this.target.browser.addEventListener("StyleSheetRemoved", this.onSheetEvent, true);
    Services.obs.addObserver(this, "document-element-inserted");
    for (const win of this.session.domain("Runtime")._windows()) {
      win.document.styleSheetChangeEventsEnabled = true;
    }
    this.onResize = () => this._mediaMaybeChanged();
    this.target.contentWindow?.addEventListener("resize", this.onResize, { mozSystemGroup: true });
    this.resizeWindow = this.target.contentWindow;
  }

  _stopListening() {
    if (!this.listening) {
      return;
    }
    this.listening = false;
    this.target.browser?.removeEventListener("StyleSheetApplicableStateChanged", this.onSheetEvent, true);
    this.target.browser?.removeEventListener("StyleSheetRemoved", this.onSheetEvent, true);
    Services.obs.removeObserver(this, "document-element-inserted");
    try {
      this.resizeWindow?.removeEventListener("resize", this.onResize, { mozSystemGroup: true });
    } catch {
      // The window is gone.
    }
  }

  // Blink reports mediaQueryResultChanged when a media query of the page
  // starts or stops matching.
  _mediaMaybeChanged() {
    const state = this._mediaState();
    if (this.lastMediaState !== undefined && state !== this.lastMediaState) {
      this.session.emit("CSS.mediaQueryResultChanged");
    }
    this.lastMediaState = state;
    this._domChanged();
  }

  _mediaState() {
    const results = [];
    const visit = (rules, win) => {
      for (const rule of rules) {
        if (className(rule) === "CSSMediaRule") {
          results.push(win.matchMedia(rule.media.mediaText).matches ? 1 : 0);
        }
        if (rule.cssRules) {
          visit(rule.cssRules, win);
        }
      }
    };
    for (const sheet of this._allSheets()) {
      const win = this._documentOf(sheet)?.defaultView;
      if (win) {
        try {
          visit(sheet.cssRules, win);
        } catch {
          // A cross-origin sheet.
        }
      }
    }
    return results.join("");
  }

  // Styles.

  _scratchStyle() {
    if (!this.scratch || Cu.isDeadWrapper(this.scratch)) {
      this.scratch = this.target.window.document.createElementNS(XHTML_NS, "div");
    }
    return this.scratch.style;
  }

  // Longhands of a shorthand value, as Gecko parses it.
  _longhands(name, value, important) {
    const style = this._scratchStyle();
    style.cssText = "";
    style.setProperty(name, value, important ? "important" : "");
    const longhands = [];
    for (let i = 0; i < style.length; i++) {
      const longhand = style.item(i);
      longhands.push({ name: longhand, value: style.getPropertyValue(longhand) });
    }
    style.cssText = "";
    return longhands;
  }

  // CSS.CSSStyle of a declaration block: the declarations as written (with
  // ranges, comments as disabled declarations) followed by the longhands
  // Gecko parsed them into, as Blink lists them.
  _style(declaration, { styleSheetId, text, bodyStart, bodyEnd, starts, win }) {
    const cssProperties = [];
    const shorthandEntries = [];
    const authored = new Set();
    if (text !== undefined) {
      const body = text.slice(bodyStart, bodyEnd);
      const declarations = lazy.devtools.parsing.parseDeclarations(isPropertyKnown, body, true);
      for (const parsed of declarations) {
        if (!parsed.name) {
          continue;
        }
        const disabled = !!parsed.commentOffsets;
        const [from, to] = disabled ? parsed.commentOffsets : parsed.offsets;
        const important = parsed.priority === "important";
        // Blink's value keeps the !important.
        const property = {
          name: parsed.name,
          value: important ? `${parsed.value} !important` : parsed.value,
          ...(important ? { important: true } : {}),
          implicit: false,
          text: body.slice(from, to),
          disabled,
          range: rangeOf(starts, bodyStart + from, bodyStart + to),
        };
        const known = isPropertyKnown(parsed.name);
        let parsedOk = known;
        if (known && !parsed.name.startsWith("--") && win) {
          try {
            parsedOk = win.CSS.supports(parsed.name, parsed.value);
          } catch {
            parsedOk = false;
          }
        }
        if (!parsedOk) {
          property.parsedOk = false;
        }
        if (!disabled && parsedOk && isShorthand(parsed.name)) {
          property.longhandProperties = this._longhands(parsed.name, parsed.value, important);
          shorthandEntries.push({
            name: parsed.name,
            value: declaration.getPropertyValue(parsed.name) || parsed.value,
            ...(important ? { important: true } : {}),
          });
        }
        if (!disabled) {
          authored.add(parsed.name);
        }
        cssProperties.push(property);
      }
    }
    const longhands = new Set();
    for (let i = 0; i < declaration.length; i++) {
      const name = declaration.item(i);
      if (isInternalProperty(name)) {
        continue;
      }
      longhands.add(name);
      const important = declaration.getPropertyPriority(name) === "important";
      const value = declaration.getPropertyValue(name);
      cssProperties.push({
        name,
        value: important ? `${value} !important` : value,
        ...(important ? { important: true } : {}),
      });
    }
    if (text === undefined) {
      // No source: the shorthands its longhands make up.
      const covered = new Set();
      for (const [name, subproperties] of shorthands()) {
        if (subproperties.every(sub => longhands.has(sub) && !covered.has(sub))) {
          const value = declaration.getPropertyValue(name);
          if (value) {
            subproperties.forEach(sub => covered.add(sub));
            const important = declaration.getPropertyPriority(name) === "important";
            shorthandEntries.push({ name, value, ...(important ? { important: true } : {}) });
          }
        }
      }
    }
    const style = { cssProperties, shorthandEntries };
    if (styleSheetId) {
      style.styleSheetId = styleSheetId;
    }
    if (text !== undefined) {
      style.cssText = text.slice(bodyStart, bodyEnd);
      style.range = rangeOf(starts, bodyStart, bodyEnd);
    }
    return style;
  }

  _inlineStyleId(element) {
    let id = this.inlineIds.get(element);
    if (!id) {
      id = `${this.prefix}.${this.nextInlineId++}`;
      this.inlineIds.set(element, id);
      this.inlineElements.set(id, Cu.getWeakReference(element));
    }
    return id;
  }

  _inlineStyle(element) {
    const text = element.getAttribute("style") ?? "";
    const starts = lineStarts(text);
    return this._style(element.style, {
      styleSheetId: this._inlineStyleId(element),
      text,
      bodyStart: 0,
      bodyEnd: text.length,
      starts,
      win: winOf(element),
    });
  }

  // CSS.CSSRule for one of Gecko's rules.
  async _rule(rule, element, pseudo) {
    const sheet = rule.parentStyleSheet;
    const origin = sheet ? this._origin(sheet) : "user-agent";
    const selectorTexts = [];
    const specificities = [];
    const count = rule.selectorCount ?? 0;
    for (let i = 0; i < count; i++) {
      selectorTexts.push(rule.selectorTextAt(i));
      specificities.push(specificityOf(rule.selectorSpecificityAt(i, true)));
    }
    const result = {
      selectorList: {
        selectors: selectorTexts.map((text, i) => ({ text, specificity: specificities[i] })),
        text: rule.selectorText ?? "",
      },
      origin,
      style: null,
      media: [],
      containerQueries: [],
      supports: [],
      layers: [],
      scopes: [],
      ruleTypes: [],
      startingStyles: [],
      navigations: [],
    };
    if (origin === "user-agent" || !sheet) {
      result.style = this._style(rule.style, {});
      return result;
    }
    const styleSheetId = this._styleSheetId(sheet);
    const info = this.sheets.get(styleSheetId);
    const text = await this._text(info);
    const starts = lineStarts(text);
    const win = element ? winOf(element) : this._documentOf(sheet)?.defaultView;
    result.styleSheetId = styleSheetId;
    const owner = this._ownerNodeOf(sheet);
    if (owner) {
      result.originTreeScopeNodeId = backendNodeIdOf(owner.getRootNode());
    }
    const start = this._ruleStart(info, text, starts, rule);
    const block = start === null ? null : blockOf(text, start);
    if (block) {
      const ranges = selectorRanges(text, start, block.open);
      const [listStart, listEnd] = trimRange(text, start, block.open);
      result.selectorList.text = text.slice(listStart, listEnd);
      if (ranges.length === count) {
        result.selectorList.selectors = ranges.map(([from, to], i) => ({
          text: text.slice(from, to),
          range: rangeOf(starts, from, to),
          specificity: specificities[i],
        }));
      }
      result.style = this._style(rule.style, {
        styleSheetId,
        text,
        bodyStart: block.open + 1,
        bodyEnd: block.close,
        starts,
        win,
      });
    } else {
      result.style = this._style(rule.style, { styleSheetId });
    }
    this._ancestors(rule, info, text, starts, result, win);
    return result;
  }

  // The at-rules and nesting rules around a rule, innermost first.
  _ancestors(rule, info, text, starts, result, win) {
    const preludeRange = ancestor => {
      const start = this._ruleStart(info, text, starts, ancestor);
      if (start === null) {
        return undefined;
      }
      const block = blockOf(text, start);
      if (!block) {
        return undefined;
      }
      // Skip the "@keyword".
      let from = start;
      if (text[from] === "@") {
        from++;
        while (from < block.open && /[\w-]/.test(text[from])) {
          from++;
        }
      }
      const [begin, end] = trimRange(text, from, block.open);
      return rangeOf(starts, begin, end);
    };
    const styleSheetId = info.id;
    for (let ancestor = rule.parentRule; ancestor; ancestor = ancestor.parentRule) {
      const kind = className(ancestor);
      const range = preludeRange(ancestor);
      const located = range ? { range, styleSheetId } : { styleSheetId };
      switch (kind) {
        case "CSSMediaRule":
          result.media.push({
            text: ancestor.media.mediaText,
            source: "mediaRule",
            ...located,
            mediaList: [{ expressions: [], active: !!win?.matchMedia(ancestor.media.mediaText).matches }],
          });
          result.ruleTypes.push("MediaRule");
          break;
        case "CSSSupportsRule":
          result.supports.push({
            text: ancestor.conditionText,
            active: !!win?.CSS.supports(ancestor.conditionText),
            ...located,
          });
          result.ruleTypes.push("SupportsRule");
          break;
        case "CSSContainerRule":
          result.containerQueries.push({
            text: ancestor.containerQuery,
            conditionText: ancestor.conditionText,
            ...(ancestor.containerName ? { name: ancestor.containerName } : {}),
            ...located,
          });
          result.ruleTypes.push("ContainerRule");
          break;
        case "CSSLayerBlockRule":
          result.layers.push({ text: ancestor.name, ...located });
          result.ruleTypes.push("LayerRule");
          break;
        case "CSSScopeRule":
          result.scopes.push({
            text: [ancestor.start && `(${ancestor.start})`, ancestor.end && `to (${ancestor.end})`]
              .filter(Boolean)
              .join(" "),
            ...located,
          });
          result.ruleTypes.push("ScopeRule");
          break;
        case "CSSStartingStyleRule":
          result.startingStyles.push({ ...located });
          result.ruleTypes.push("StartingStyleRule");
          break;
        case "CSSStyleRule":
          (result.nestingSelectors ??= []).push(ancestor.selectorText);
          result.ruleTypes.push("StyleRule");
          break;
      }
    }
    // The media attribute of the sheet's <style> or <link>.
    for (let sheet = rule.parentStyleSheet; sheet; sheet = sheet.parentStyleSheet) {
      const mediaText = sheet.media?.mediaText;
      const owner = sheet.ownerNode;
      if (mediaText && owner) {
        result.media.push({
          text: mediaText,
          source: owner.localName === "link" ? "linkedSheet" : "inlineSheet",
          sourceURL: sheet.href ?? owner.ownerDocument.URL,
          mediaList: [{ expressions: [], active: !!win?.matchMedia(mediaText).matches }],
        });
      }
      if (sheet.parentStyleSheet === sheet) {
        break;
      }
    }
  }

  _matchingSelectors(rule, element, pseudo) {
    const indices = [];
    const visited = !!(InspectorUtils.getContentState(element) & (1 << 18));
    for (let i = 0; i < (rule.selectorCount ?? 0); i++) {
      try {
        if (rule.selectorMatchesElement(i, element, pseudo ?? "", visited)) {
          indices.push(i);
        }
      } catch {
        // Not matchable (nested declarations).
      }
    }
    return indices;
  }

  // The rules matching an element (or one of its pseudo-elements), least
  // specific first like Blink's, and the presentational hints separately.
  async _matches(element, pseudo, { authorOnly = false } = {}) {
    const rules = InspectorUtils.getMatchingCSSRules(element, pseudo ?? "", false, true) ?? [];
    const matches = [];
    let attributesStyle = null;
    // Gecko lists a rule with !important declarations a second time at the
    // important level of the cascade; Blink lists each rule once.
    const seen = new Set();
    for (const rule of rules) {
      if (seen.has(rule)) {
        continue;
      }
      seen.add(rule);
      if (rule.declarationOrigin) {
        if (rule.declarationOrigin === "pres-hints") {
          attributesStyle = this._style(rule.style, {});
        }
        continue;
      }
      if (className(rule) !== "CSSStyleRule") {
        continue;
      }
      if (authorOnly && rule.parentStyleSheet?.parsingMode === "agent") {
        continue;
      }
      if (this._isAppearanceBaseOnly(rule, element)) {
        continue;
      }
      matches.push({
        rule: await this._rule(rule, element, pseudo),
        matchingSelectors: this._matchingSelectors(rule, element, pseudo),
      });
    }
    return { matches, attributesStyle };
  }

  // UA rules inside @appearance-base apply only to elements rendered with
  // base appearance; Gecko lists them anyway (Firefox's rule view filters
  // them the same way).
  _isAppearanceBaseOnly(rule, element) {
    let inside = false;
    for (let ancestor = rule.parentRule; ancestor; ancestor = ancestor.parentRule) {
      if (className(ancestor) === "CSSAppearanceBaseRule") {
        inside = true;
        break;
      }
    }
    if (!inside) {
      return false;
    }
    for (let node = element; node; node = node.parentElement) {
      const appearance = winOf(node).getComputedStyle(node).getPropertyValue("appearance");
      if (appearance === "base" || appearance === "base-select") {
        return false;
      }
    }
    return true;
  }

  async _pseudoMatches(element, list) {
    const result = [];
    const listItem = winOf(element).getComputedStyle(element).display.includes("list-item");
    for (const [pseudo, pseudoType] of list) {
      if (pseudo === "::placeholder" && !["input", "textarea"].includes(element.localName)) {
        continue;
      }
      if (pseudo === "::file-selector-button" && !(element.localName === "input" && element.type === "file")) {
        continue;
      }
      if (pseudo === "::marker" && !listItem) {
        continue;
      }
      const { matches } = await this._matches(element, pseudo);
      // User agent rules apply to every element for most pseudos; Blink
      // lists a pseudo when it has rules of its own kind (a list item's
      // marker, a field's placeholder) or rules from the page.
      const uaPseudo = ["::marker", "::placeholder", "::file-selector-button"].includes(pseudo);
      if (matches.length && (uaPseudo || matches.some(match => match.rule.origin !== "user-agent"))) {
        result.push({ pseudoType, matches });
      }
    }
    return result;
  }

  _parentLayoutNodeId(element) {
    for (let parent = parentOf(element); parent; parent = parentOf(parent)) {
      if (parent.nodeType !== 1) {
        continue;
      }
      if (winOf(parent).getComputedStyle(parent).display !== "contents") {
        return this._dom._pushPath(parent) || undefined;
      }
    }
    return undefined;
  }

  // Keyframes of the animations running on an element (Blink's
  // cssKeyframesRules).
  async _keyframes(element, pseudo) {
    const names = winOf(element)
      .getComputedStyle(element, pseudo)
      .animationName.split(",")
      .map(name => name.trim())
      .filter(name => name && name !== "none");
    if (!names.length) {
      return [];
    }
    const wanted = new Set(names);
    const found = [];
    const visit = async (rules, info, text, starts) => {
      for (const rule of rules) {
        const kind = className(rule);
        if (kind === "CSSKeyframesRule" && wanted.has(rule.name)) {
          found.push(await this._keyframesRule(rule, info, text, starts));
        } else if (rule.cssRules && kind !== "CSSKeyframesRule") {
          await visit(rule.cssRules, info, text, starts);
        }
      }
    };
    for (const sheet of this._allSheets()) {
      const info = this.sheets.get(this._styleSheetId(sheet));
      const text = await this._text(info);
      try {
        await visit(sheet.cssRules, info, text, lineStarts(text));
      } catch {
        // A cross-origin sheet.
      }
    }
    return found;
  }

  async _keyframesRule(rule, info, text, starts) {
    const located = (inner, makeStyle) => {
      const start = this._ruleStart(info, text, starts, inner);
      const block = start === null ? null : blockOf(text, start);
      return { start, block, style: makeStyle(block) };
    };
    const outer = located(rule, () => null);
    let nameRange;
    if (outer.block) {
      const [from, to] = trimRange(text, outer.start + "@keyframes".length, outer.block.open);
      nameRange = rangeOf(starts, from, to);
    }
    const keyframes = [];
    for (const keyframe of rule.cssRules) {
      const { start, block } = located(keyframe, () => null);
      const entry = {
        styleSheetId: info.id,
        origin: this._origin(info.sheet),
        keyText: { text: keyframe.keyText },
        style: block
          ? this._style(keyframe.style, {
              styleSheetId: info.id,
              text,
              bodyStart: block.open + 1,
              bodyEnd: block.close,
              starts,
            })
          : this._style(keyframe.style, { styleSheetId: info.id }),
      };
      if (block) {
        const [from, to] = trimRange(text, start, block.open);
        entry.keyText.range = rangeOf(starts, from, to);
      }
      keyframes.push(entry);
    }
    return {
      animationName: { text: rule.name, ...(nameRange ? { range: nameRange } : {}) },
      keyframes,
    };
  }

  _elementForComputed(node) {
    if (node.nodeType === 1) {
      return styledElementOf(node);
    }
    const parent = node.parentElement;
    if (!parent) {
      throw new ProtocolError("Node is not an element and does not have a parent element");
    }
    return { element: parent, pseudo: null };
  }

  _computed(node) {
    const { element, pseudo } = this._elementForComputed(node);
    const style = winOf(element).getComputedStyle(element, pseudo);
    const computedStyle = [];
    for (let i = 0; i < style.length; i++) {
      const name = style.item(i);
      if (!isInternalProperty(name)) {
        computedStyle.push({ name, value: style.getPropertyValue(name) });
      }
    }
    return { computedStyle, style };
  }

  // Changes to watched computed styles.

  _trackedValue(element) {
    if (!this.trackedProperties.length || Cu.isDeadWrapper(element) || !element.isConnected) {
      return "";
    }
    const style = winOf(element).getComputedStyle(element);
    return this.trackedProperties
      .map(({ name, value }) => (style.getPropertyValue(name) === value ? "1" : "0"))
      .join("");
  }

  // Called by DOM after mutations and here after edits: Blink re-resolves
  // style and reports nodes whose tracked properties changed.
  _domChanged() {
    if (this.changeScheduled) {
      return;
    }
    this.changeScheduled = true;
    Services.tm.dispatchToMainThread(() => {
      this.changeScheduled = false;
      this._checkTracked();
    });
  }

  _nodeChanged() {
    this._domChanged();
  }

  _checkTracked() {
    if (this.trackedProperties.length) {
      for (const [id, node] of this._dom.ids) {
        if (node.nodeType !== 1 || node.implementedPseudoElement) {
          continue;
        }
        const value = this._trackedValue(node);
        const previous = this.trackedValues.get(node);
        this.trackedValues.set(node, value);
        if (previous !== undefined && previous !== value) {
          this.pendingUpdates.add(id);
        }
      }
      this._flushUpdates();
    }
    if (this.trackedNode) {
      const { nodeId, node, snapshot } = this.trackedNode;
      if (Cu.isDeadWrapper(node) || !node.isConnected) {
        return;
      }
      const current = this._snapshot(node);
      if (current !== snapshot) {
        this.trackedNode.snapshot = current;
        this.session.emit("CSS.computedStyleUpdated", { nodeId });
      }
    }
  }

  _flushUpdates() {
    if (this.takeResolver && this.pendingUpdates.size) {
      const nodeIds = [...this.pendingUpdates];
      this.pendingUpdates.clear();
      this.takeResolver({ nodeIds });
      this.takeResolver = null;
    }
  }

  _snapshot(node) {
    try {
      return JSON.stringify(this._computed(node).computedStyle);
    } catch {
      return "";
    }
  }

  // METHODS

  async enable() {
    if (!this.session.domain("DOM").enabled) {
      throw new ProtocolError("DOM agent needs to be enabled first.");
    }
    if (this.enabled) {
      return;
    }
    this.enabled = true;
    this._listen();
    this.lastMediaState = this._mediaState();
    for (const sheet of this._allSheets()) {
      await this._announce(sheet);
    }
  }

  disable() {
    this.enabled = false;
    this._stopListening();
    for (const info of this.sheets.values()) {
      info.announced = false;
    }
  }

  async getMatchedStylesForNode({ nodeId }) {
    const node = this._dom._node(nodeId);
    const { element, pseudo } = styledElementOf(node);
    if (!element) {
      throw new ProtocolError("Node is not an Element");
    }
    const result = {};
    if (!pseudo) {
      result.inlineStyle = this._inlineStyle(element);
    }
    const { matches, attributesStyle } = await this._matches(element, pseudo);
    if (attributesStyle) {
      result.attributesStyle = attributesStyle;
    }
    result.matchedCSSRules = matches;
    result.pseudoElements = pseudo ? [] : await this._pseudoMatches(element, MATCHED_PSEUDOS);
    result.inherited = [];
    result.inheritedPseudoElements = [];
    // A pseudo-element inherits from its element; an element from its
    // flat tree parent.
    let ancestor = pseudo ? element : element.flattenedTreeParentNode;
    for (; ancestor; ancestor = ancestor.flattenedTreeParentNode) {
      if (ancestor.nodeType !== 1) {
        continue;
      }
      const entry = { matchedCSSRules: (await this._matches(ancestor, null)).matches };
      if (ancestor.hasAttribute("style")) {
        entry.inlineStyle = this._inlineStyle(ancestor);
      }
      result.inherited.push(entry);
      result.inheritedPseudoElements.push({
        pseudoElements: await this._pseudoMatches(ancestor, INHERITED_PSEUDOS),
      });
    }
    result.cssKeyframesRules = await this._keyframes(element, pseudo);
    result.cssPropertyRules = [];
    result.cssPropertyRegistrations = [];
    result.cssAtRules = [];
    const parentLayoutNodeId = this._parentLayoutNodeId(node);
    if (parentLayoutNodeId) {
      result.parentLayoutNodeId = parentLayoutNodeId;
    }
    return result;
  }

  getInlineStylesForNode({ nodeId }) {
    const node = this._dom._node(nodeId);
    if (node.nodeType !== 1) {
      throw new ProtocolError("Node is not an Element");
    }
    const { element, pseudo } = styledElementOf(node);
    if (pseudo) {
      return {};
    }
    const result = { inlineStyle: this._inlineStyle(element) };
    const hints = (InspectorUtils.getMatchingCSSRules(element, "", false, false) ?? []).find(
      rule => rule.declarationOrigin === "pres-hints"
    );
    if (hints) {
      result.attributesStyle = this._style(hints.style, {});
    }
    return result;
  }

  getComputedStyleForNode({ nodeId }) {
    const node = this._dom._node(nodeId);
    const { computedStyle, style } = this._computed(node);
    const appearance = style.getPropertyValue("appearance");
    return {
      computedStyle,
      extraFields: { isAppearanceBase: appearance === "base" || appearance === "base-select" },
    };
  }

  getPlatformFontsForNode({ nodeId }) {
    const node = this._dom._node(nodeId);
    const { element, pseudo } = styledElementOf(node);
    if (!element && node.nodeType !== 3) {
      return { fonts: [] };
    }
    const fonts = new Map();
    // Blink counts the glyphs of the node's own text.
    const texts = node.nodeType === 3 ? [node] : pseudo ? [node] : [...node.childNodes].filter(child => child.nodeType === 3);
    for (const text of texts) {
      const range = text.ownerDocument.createRange();
      if (pseudo) {
        range.selectNodeContents(text);
      } else {
        range.selectNode(text);
      }
      for (const face of InspectorUtils.getUsedFontFaces(range, 10000)) {
        let glyphs = 0;
        for (const used of face.ranges ?? []) {
          glyphs += [...used.toString()].filter(char => !/\s/.test(char)).length;
        }
        const key = face.name;
        const entry = fonts.get(key) ?? {
          familyName: face.CSSFamilyName || face.name,
          postScriptName: face.name,
          isCustomFont: face.fromFontGroup === false || !!face.URI,
          glyphCount: 0,
        };
        entry.glyphCount += glyphs;
        fonts.set(key, entry);
      }
    }
    return { fonts: [...fonts.values()] };
  }

  // env() values of the page, read by resolving each in the overlay's
  // anonymous content, which belongs to the page's document. A fallback that
  // no real value has tells names Gecko does not define.
  getEnvironmentVariables() {
    const root = this.session.domain("Overlay")._root();
    if (!root) {
      throw new ProtocolError("Document is not available");
    }
    const probe = root.ownerDocument.createElementNS(XHTML_NS, "div");
    root.append(probe);
    const win = root.ownerDocument.defaultView;
    const environmentVariables = {};
    for (const name of ENVIRONMENT_VARIABLES) {
      probe.style.setProperty("margin-top", `env(${name}, -12345px)`);
      const value = win.getComputedStyle(probe).marginTop;
      if (value !== "-12345px") {
        environmentVariables[name] = value;
      }
    }
    probe.remove();
    return { environmentVariables };
  }

  getBackgroundColors({ nodeId }) {
    const element = this._dom._element(nodeId);
    const style = winOf(element).getComputedStyle(element);
    const result = {
      computedFontSize: style.fontSize,
      computedFontWeight: style.fontWeight,
    };
    // Blink samples what is painted behind the element's text and gives up
    // on images and gradients. Gecko does not expose painted layers, so the
    // backgrounds of the element and its ancestors are composited until an
    // opaque one; overlapping positioned content is not taken into account.
    const hasText = [...element.childNodes].some(child => child.nodeType === 3 && /\S/.test(child.data));
    if (!hasText) {
      return result;
    }
    const layers = [];
    let opaque = false;
    for (let node = element; node; node = node.flattenedTreeParentNode) {
      if (node.nodeType !== 1) {
        continue;
      }
      const nodeStyle = winOf(node).getComputedStyle(node);
      if (nodeStyle.backgroundImage !== "none") {
        return result;
      }
      const rgba = InspectorUtils.colorToRGBA(nodeStyle.backgroundColor);
      if (rgba && rgba.a > 0) {
        layers.push(rgba);
        if (rgba.a >= 1) {
          opaque = true;
          break;
        }
      }
    }
    if (!opaque) {
      // The canvas behind the page is white.
      layers.push({ r: 255, g: 255, b: 255, a: 1 });
    }
    let color = layers.pop();
    while (layers.length) {
      const top = layers.pop();
      color = {
        r: top.r * top.a + color.r * (1 - top.a),
        g: top.g * top.a + color.g * (1 - top.a),
        b: top.b * top.a + color.b * (1 - top.a),
        a: 1,
      };
    }
    result.backgroundColors = [`rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`];
    return result;
  }

  trackComputedStyleUpdates({ propertiesToTrack }) {
    this.trackedProperties = propertiesToTrack;
    this.trackedValues = new Map();
    this.pendingUpdates.clear();
    if (!propertiesToTrack.length) {
      // Blink answers a waiting takeComputedStyleUpdates when tracking stops.
      this.takeResolver?.({ nodeIds: [] });
      this.takeResolver = null;
      return;
    }
    for (const node of this._dom.ids.values()) {
      if (node.nodeType === 1 && !node.implementedPseudoElement) {
        this.trackedValues.set(node, this._trackedValue(node));
      }
    }
  }

  takeComputedStyleUpdates() {
    if (!this.trackedProperties.length) {
      return { nodeIds: [] };
    }
    if (this.takeResolver) {
      throw new ProtocolError("A previous request has not been resolved yet.");
    }
    return new Promise(resolve => {
      this.takeResolver = resolve;
      this._flushUpdates();
    });
  }

  trackComputedStyleUpdatesForNode({ nodeId } = {}) {
    if (nodeId === undefined) {
      this.trackedNode = null;
      return;
    }
    const node = this._dom._node(nodeId);
    this.trackedNode = { nodeId, node, snapshot: this._snapshot(node) };
  }

  getStyleSheetText({ styleSheetId }) {
    const inline = this._inlineElement(styleSheetId);
    if (inline) {
      return { text: inline.getAttribute("style") ?? "" };
    }
    return this._text(this._sheet(styleSheetId)).then(text => ({ text }));
  }

  _inlineElement(styleSheetId) {
    const element = this.inlineElements.get(styleSheetId)?.get();
    return element && !Cu.isDeadWrapper(element) ? element : null;
  }

  // Replaces a sheet's text, recording it in the undo history.
  _setSheetText(info, text, previous) {
    const sheet = info.sheet;
    const apply = value => {
      InspectorUtils.parseStyleSheet(sheet, value);
      this.texts.set(sheet, value);
      info.generated = null;
      this.session.emit("CSS.styleSheetChanged", { styleSheetId: info.id });
      this._domChanged();
    };
    this._dom.history.perform({
      perform: () => apply(text),
      undo: () => apply(previous),
      redo: () => apply(text),
    });
  }

  _offsets(text, range) {
    const starts = lineStarts(text);
    const from = offsetOfPosition(starts, range.startLine, range.startColumn);
    const to = offsetOfPosition(starts, range.endLine, range.endColumn);
    if (from === null || to === null || from > to || to > text.length) {
      throw new ProtocolError("Specified range is out of bounds");
    }
    return [from, to];
  }

  async setStyleSheetText({ styleSheetId, text }) {
    const inline = this._inlineElement(styleSheetId);
    if (inline) {
      this._dom.setAttributeValue({ nodeId: this._dom._pushPath(inline), name: "style", value: text });
      return {};
    }
    const info = this._sheet(styleSheetId);
    this._setSheetText(info, text, await this._text(info));
    return {};
  }

  async setStyleTexts({ edits, nodeForPropertySyntaxValidation }) {
    const styles = [];
    for (const { styleSheetId, range, text } of edits) {
      const element = this._inlineElement(styleSheetId);
      if (element) {
        const current = element.getAttribute("style") ?? "";
        const [from, to] = this._offsets(current, range);
        const value = current.slice(0, from) + text + current.slice(to);
        const nodeId = this._dom._boundId(element);
        if (nodeId) {
          this._dom.setAttributeValue({ nodeId, name: "style", value });
        } else {
          element.setAttribute("style", value);
        }
        styles.push(this._inlineStyle(element));
        continue;
      }
      const info = this._sheet(styleSheetId);
      const current = await this._text(info);
      const [from, to] = this._offsets(current, range);
      const updated = current.slice(0, from) + text + current.slice(to);
      this._setSheetText(info, updated, current);
      const rule = this._ruleWithBodyAt(info, updated, from);
      if (!rule) {
        throw new ProtocolError("Failed to locate the edited style");
      }
      styles.push((await this._rule(rule, null, null)).style);
    }
    return { styles };
  }

  // After a reparse, the rule whose block (or selector) starts at an offset.
  _ruleWithBodyAt(info, text, offset, selector = false) {
    const starts = lineStarts(text);
    let found = null;
    const visit = rules => {
      for (const rule of rules) {
        if (found) {
          return;
        }
        const start = this._ruleStart(info, text, starts, rule);
        if (start !== null) {
          const block = blockOf(text, start);
          if (block && (selector ? trimRange(text, start, block.open)[0] === offset || start === offset : block.open + 1 === offset)) {
            found = rule;
            return;
          }
        }
        if (rule.cssRules) {
          visit(rule.cssRules);
        }
      }
    };
    visit(info.sheet.cssRules);
    return found;
  }

  async setRuleSelector({ styleSheetId, range, selector }) {
    const info = this._sheet(styleSheetId);
    const current = await this._text(info);
    const [from, to] = this._offsets(current, range);
    const updated = current.slice(0, from) + selector + current.slice(to);
    this._setSheetText(info, updated, current);
    const rule = this._ruleWithBodyAt(info, updated, from, true);
    if (!rule) {
      throw new ProtocolError("Failed to locate the edited rule");
    }
    return { selectorList: (await this._rule(rule, null, null)).selectorList };
  }

  async setMediaText({ styleSheetId, range, text }) {
    const info = this._sheet(styleSheetId);
    const current = await this._text(info);
    const [from, to] = this._offsets(current, range);
    const updated = current.slice(0, from) + text + current.slice(to);
    this._setSheetText(info, updated, current);
    const starts = lineStarts(updated);
    let media = null;
    const visit = rules => {
      for (const rule of rules) {
        if (className(rule) === "CSSMediaRule") {
          const start = this._ruleStart(info, updated, starts, rule);
          if (start !== null && start < from && from <= (blockOf(updated, start)?.open ?? -1)) {
            media = rule;
          }
        }
        if (rule.cssRules && !media) {
          visit(rule.cssRules);
        }
      }
    };
    visit(info.sheet.cssRules);
    if (!media) {
      throw new ProtocolError("Failed to locate the edited media rule");
    }
    const [begin, end] = trimRange(updated, from, from + text.length);
    return {
      media: {
        text: media.media.mediaText,
        source: "mediaRule",
        styleSheetId,
        range: rangeOf(starts, begin, end),
      },
    };
  }

  async addRule({ styleSheetId, ruleText, location }) {
    const info = this._sheet(styleSheetId);
    const current = await this._text(info);
    const [at] = this._offsets(current, location);
    const updated = current.slice(0, at) + ruleText + current.slice(at);
    this._setSheetText(info, updated, current);
    const [ruleStart] = trimRange(updated, at, at + ruleText.length);
    const rule = this._ruleWithBodyAt(info, updated, ruleStart, true);
    if (!rule) {
      throw new ProtocolError("Failed to add the rule");
    }
    return { rule: await this._rule(rule, null, null) };
  }

  // The inspector style sheet holding "via inspector" rules: a <style>
  // element in the frame's document, as Firefox's rule view adds one.
  async createStyleSheet({ frameId, force = false }) {
    const win = this.session
      .domain("Runtime")
      ._windows()
      .find(candidate => frameIdOf(this.target, candidate.browsingContext) === frameId);
    if (!win) {
      throw new ProtocolError("Frame not found");
    }
    const document = win.document;
    this.inspectorSheets ??= new Set();
    if (!force) {
      for (const sheet of this.inspectorSheets) {
        if (!Cu.isDeadWrapper(sheet) && this._documentOf(sheet) === document) {
          return { styleSheetId: this._styleSheetId(sheet) };
        }
      }
    }
    const style = document.createElementNS(XHTML_NS, "style");
    style.setDevtoolsAsTriggeringPrincipal?.();
    (document.head ?? document.documentElement).append(style);
    this.inspectorSheets.add(style.sheet);
    this.texts.set(style.sheet, "");
    const styleSheetId = this._styleSheetId(style.sheet);
    await this._announce(style.sheet);
    return { styleSheetId };
  }

  forcePseudoState({ nodeId, forcedPseudoClasses }) {
    const element = this._dom._element(nodeId);
    this.forced ??= new Map();
    const previous = this.forced.get(element) ?? [];
    for (const name of previous) {
      InspectorUtils.removePseudoClassLock(element, `:${name}`);
    }
    const applied = [];
    for (const name of forcedPseudoClasses) {
      try {
        InspectorUtils.addPseudoClassLock(element, `:${name}`);
        applied.push(name);
      } catch {
        throw new InvalidParams(`Forcing :${name} is not supported`);
      }
    }
    this.forced.set(element, applied);
    this._domChanged();
  }

  collectClassNames({ styleSheetId }) {
    const info = this._sheet(styleSheetId);
    const names = new Set();
    const visit = rules => {
      for (const rule of rules) {
        for (const match of (rule.selectorText ?? "").matchAll(/\.(-?[_a-zA-Z -￿][\w -￿-]*)/g)) {
          names.add(match[1]);
        }
        if (rule.cssRules) {
          visit(rule.cssRules);
        }
      }
    };
    visit(info.sheet.cssRules);
    return { classNames: [...names] };
  }

  getLonghandProperties({ shorthandName, value }) {
    if (!isShorthand(shorthandName)) {
      throw new InvalidParams("Invalid shorthand property name");
    }
    return { longhandProperties: this._longhands(shorthandName, value, false) };
  }

  async getMediaQueries() {
    const medias = [];
    for (const sheet of this._allSheets()) {
      const info = this.sheets.get(this._styleSheetId(sheet));
      const text = await this._text(info);
      const starts = lineStarts(text);
      const win = this._documentOf(sheet)?.defaultView;
      const visit = rules => {
        for (const rule of rules) {
          if (className(rule) === "CSSMediaRule") {
            const result = { media: [], containerQueries: [], supports: [], layers: [], scopes: [], ruleTypes: [], startingStyles: [] };
            // The rule's own prelude is reported like an ancestor's.
            this._ancestors({ parentRule: rule, parentStyleSheet: null }, info, text, starts, result, win);
            medias.push(...result.media);
          }
          if (rule.cssRules) {
            visit(rule.cssRules);
          }
        }
      };
      try {
        visit(sheet.cssRules);
      } catch {
        // A cross-origin sheet.
      }
    }
    return { medias };
  }

  _destroy() {
    this._stopListening();
    this.takeResolver?.({ nodeIds: [] });
    for (const [element, names] of this.forced ?? []) {
      for (const name of names) {
        try {
          InspectorUtils.removePseudoClassLock(element, `:${name}`);
        } catch {
          // The element is gone.
        }
      }
    }
  }
}
