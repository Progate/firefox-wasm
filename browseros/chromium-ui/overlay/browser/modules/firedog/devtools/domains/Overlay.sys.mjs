/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Overlay domain: what DevTools draws over the page (the highlighted
// node's boxes and its info tooltip, inspect mode, the viewport size while
// resizing, the paused-in-debugger banner).
//
// Blink paints its overlay in a separate layer of the top frame. Gecko's
// equivalent is the document's anonymous content (what Firefox's own
// highlighters use): elements in a shadow root above the page that the
// page's scripts and styles cannot see. Boxes come from getBoxQuads relative
// to the top document, so nodes in frames are drawn where they appear.

import {
  backendNodeIdOf,
  boxModelOf,
  winOf,
} from "resource:///modules/firedog/devtools/domains/DOM.sys.mjs";
import { ProtocolError } from "resource:///modules/firedog/devtools/Session.sys.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

// Blink's overlay styles (inspect_tool and highlight_common), light theme.
const STYLE = `
  :host { all: initial; }
  .root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; overflow: hidden; }
  svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .tooltip {
    position: absolute; box-sizing: border-box; padding: 8px 10px; max-width: 320px;
    background: #fff; color: #222; border-radius: 3px; white-space: nowrap;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.35); filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.2));
    font: 12px system-ui, sans-serif; line-height: 16px;
  }
  .tooltip .title { display: flex; gap: 12px; justify-content: space-between; }
  .tooltip .name { color: rgb(136, 18, 128); font-weight: bold; overflow: hidden; text-overflow: ellipsis; }
  .tooltip .selector { color: rgb(26, 26, 166); }
  .tooltip .size { color: rgb(128, 128, 128); }
  .tooltip .row { display: flex; gap: 12px; justify-content: space-between; margin-top: 4px; }
  .tooltip .label { color: rgb(80, 80, 80); }
  .tooltip .swatch { display: inline-block; width: 10px; height: 10px; margin-right: 4px; border: 1px solid #999; vertical-align: -1px; }
  .arrow { position: absolute; width: 0; height: 0; border: 8px solid transparent; }
  .viewport-size {
    position: absolute; top: 0; right: 0; padding: 2px 4px; background: rgba(255, 255, 255, 0.8);
    color: #222; font: 12px system-ui, sans-serif;
  }
  .paused {
    position: absolute; top: 10px; left: 50%; transform: translateX(-50%); padding: 4px 10px;
    background: rgb(255, 255, 194); border: 1px solid rgb(202, 202, 140); border-radius: 3px;
    color: #222; font: 13px system-ui, sans-serif; box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2);
  }
`;

function rgba(color, fallback = "transparent") {
  if (!color) {
    return fallback;
  }
  const { r = 0, g = 0, b = 0, a = 1 } = color;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function quadPath(quad) {
  return `M${quad[0]},${quad[1]} L${quad[2]},${quad[3]} L${quad[4]},${quad[5]} L${quad[6]},${quad[7]} Z`;
}

// Blink's tooltip prints sizes with at most two decimals.
function size(value) {
  return String(Math.round(value * 100) / 100);
}

export class Overlay {
  constructor(session) {
    this.session = session;
    this.target = session.target;
    this.enabled = false;
    this.onEnabled = [];
    this.inspectMode = "none";
    this.content = null;
    this.highlight = null;
  }

  get _dom() {
    return this.session.domain("DOM");
  }

  get _window() {
    return this.target.contentWindow;
  }

  // The anonymous content of the current top-level document, created on
  // first use and again after a navigation replaced the document.
  _root() {
    const document = this._window?.document;
    if (!document) {
      return null;
    }
    if (this.content?.document !== document) {
      this._removeContent();
      let content;
      try {
        content = document.insertAnonymousContent();
      } catch {
        // The document has no canvas frame yet (still parsing).
        return null;
      }
      const style = document.createElementNS(XHTML_NS, "style");
      style.textContent = STYLE;
      const root = document.createElementNS(XHTML_NS, "div");
      root.className = "root";
      content.root.append(style, root);
      this.content = { document, content, root };
      this._watchViewport(document.defaultView);
    }
    return this.content.root;
  }

  _removeContent() {
    if (!this.content) {
      return;
    }
    try {
      this.content.document.removeAnonymousContent(this.content.content);
    } catch {
      // The document is gone.
    }
    this.content = null;
  }

  _watchViewport(win) {
    // The highlight follows the node when the page scrolls or resizes, as
    // Blink repaints its overlay.
    const redraw = () => this.highlight && this._draw();
    win.addEventListener("scroll", redraw, { capture: true, passive: true, mozSystemGroup: true });
    win.addEventListener(
      "resize",
      () => {
        redraw();
        this._showViewportSize();
      },
      { mozSystemGroup: true }
    );
  }

  _layer(name) {
    const root = this._root();
    if (!root) {
      return null;
    }
    let layer = root.querySelector(`:scope > .${name}`);
    if (!layer) {
      layer = root.ownerDocument.createElementNS(XHTML_NS, "div");
      layer.className = name;
      root.append(layer);
    }
    return layer;
  }

  _clearLayer(name) {
    this.content?.root.querySelector(`:scope > .${name}`)?.remove();
  }

  _draw() {
    const highlight = this.highlight;
    this._clearLayer("highlight");
    if (!highlight) {
      return;
    }
    const layer = this._layer("highlight");
    if (!layer) {
      return;
    }
    const document = layer.ownerDocument;
    const svg = document.createElementNS(SVG_NS, "svg");
    layer.append(svg);
    const addPath = (d, fill, stroke) => {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", fill);
      path.setAttribute("fill-rule", "evenodd");
      if (stroke) {
        path.setAttribute("stroke", stroke);
        path.setAttribute("stroke-width", "1");
      }
      svg.append(path);
    };
    if (highlight.quads) {
      for (const quad of highlight.quads) {
        addPath(quadPath(quad), rgba(highlight.color), highlight.outlineColor && rgba(highlight.outlineColor));
      }
      return;
    }
    const config = highlight.config ?? {};
    for (const node of highlight.nodes) {
      if (Cu.isDeadWrapper(node) || !node.isConnected) {
        continue;
      }
      const model = boxModelOf(node);
      if (!model) {
        continue;
      }
      // Each region is the ring between its box and the next inner one, as
      // Blink paints them.
      addPath(quadPath(model.margin) + quadPath(model.border), rgba(config.marginColor));
      addPath(quadPath(model.border) + quadPath(model.padding), rgba(config.borderColor));
      addPath(quadPath(model.padding) + quadPath(model.content), rgba(config.paddingColor));
      addPath(quadPath(model.content), rgba(config.contentColor), config.contentOutlineColor && rgba(config.contentOutlineColor));
      if (config.showInfo && highlight.nodes.length === 1) {
        this._drawTooltip(layer, node, model, config);
      }
    }
  }

  _drawTooltip(layer, node, model, config) {
    const document = layer.ownerDocument;
    const element = (tag, className, text) => {
      const result = document.createElementNS(XHTML_NS, tag);
      if (className) {
        result.className = className;
      }
      if (text !== undefined) {
        result.textContent = text;
      }
      return result;
    };
    const tooltip = element("div", "tooltip");
    const title = element("div", "title");
    const name = element("span", "name");
    const pseudo = node.implementedPseudoElement;
    if (node.nodeType === 1 && !pseudo) {
      name.append(node.localName);
      let selector = node.id ? `#${node.id}` : "";
      for (const className of node.classList ?? []) {
        selector += `.${className}`;
      }
      if (selector) {
        name.append(element("span", "selector", selector));
      }
    } else {
      name.append(pseudo ?? node.nodeName);
    }
    const border = model.border;
    const width = Math.hypot(border[2] - border[0], border[3] - border[1]);
    const height = Math.hypot(border[6] - border[0], border[7] - border[1]);
    title.append(name, element("span", "size", `${size(width)} × ${size(height)}`));
    tooltip.append(title);
    if (config.showStyles && node.nodeType === 1) {
      const target = pseudo ? node.parentNode : node;
      const style = winOf(target).getComputedStyle(target, pseudo ?? null);
      const row = (label, value, swatch) => {
        const line = element("div", "row");
        const right = element("span");
        if (swatch) {
          const chip = element("span", "swatch");
          chip.style.background = swatch;
          right.append(chip);
        }
        right.append(value);
        line.append(element("span", "label", label), right);
        tooltip.append(line);
      };
      row("Color", style.color, style.color);
      row("Font", `${style.fontSize} ${style.fontFamily}`);
      if (style.backgroundColor !== "rgba(0, 0, 0, 0)") {
        row("Background", style.backgroundColor, style.backgroundColor);
      }
      if (style.margin !== "0px") {
        row("Margin", style.margin);
      }
      if (style.padding !== "0px") {
        row("Padding", style.padding);
      }
    }
    layer.append(tooltip);
    // Below the node when there is room, otherwise above it, like Blink.
    const win = winOf(layer);
    const bounds = {
      left: Math.min(border[0], border[6]),
      top: Math.min(border[1], border[3]),
      bottom: Math.max(border[5], border[7]),
    };
    const box = tooltip.getBoundingClientRect();
    const arrow = element("div", "arrow");
    let top;
    if (bounds.bottom + box.height + 10 <= win.innerHeight) {
      top = bounds.bottom + 8;
      arrow.style.borderBottomColor = "#fff";
      arrow.style.top = `${top - 16}px`;
    } else {
      top = Math.max(0, bounds.top - box.height - 8);
      arrow.style.borderTopColor = "#fff";
      arrow.style.top = `${top + box.height}px`;
    }
    const left = Math.max(0, Math.min(bounds.left, win.innerWidth - box.width));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    arrow.style.left = `${Math.max(left + 8, Math.min(bounds.left + 8, left + box.width - 24))}px`;
    layer.append(arrow);
  }

  _setHighlight(highlight) {
    this.highlight = highlight;
    this._draw();
  }

  _showViewportSize() {
    if (!this.showViewportSize) {
      return;
    }
    const layer = this._layer("viewport-size");
    if (!layer) {
      return;
    }
    const win = this._window;
    layer.textContent = `${win.innerWidth}px × ${win.innerHeight}px`;
    win.clearTimeout(this.viewportSizeTimer);
    // Blink hides the size a second after the last resize.
    this.viewportSizeTimer = win.setTimeout(() => this._clearLayer("viewport-size"), 1000);
  }

  // Inspect mode: hovering a node highlights it and asks the client to
  // reveal it; a click picks it and the page never sees the click.
  _startInspecting() {
    if (this.inspecting) {
      return;
    }
    this.inspecting = true;
    this.onInspectEvent = event => this._inspectEvent(event);
    for (const type of ["mousemove", "mousedown", "mouseup", "click", "pointerdown", "pointerup", "dblclick", "contextmenu", "keydown"]) {
      this.target.browser.addEventListener(type, this.onInspectEvent, true);
    }
  }

  _stopInspecting() {
    if (!this.inspecting) {
      return;
    }
    this.inspecting = false;
    for (const type of ["mousemove", "mousedown", "mouseup", "click", "pointerdown", "pointerup", "dblclick", "contextmenu", "keydown"]) {
      this.target.browser?.removeEventListener(type, this.onInspectEvent, true);
    }
  }

  _inspectedNodeOf(event) {
    let node = event.originalTarget;
    while (node && node.nodeType !== 1) {
      node = node.parentNode;
    }
    if (!node) {
      return null;
    }
    // Native anonymous content (scrollbars, form control internals) belongs
    // to its element; so does a UA widget's shadow tree unless the client
    // searches user-agent shadow DOM.
    while (node.isNativeAnonymous && !node.implementedPseudoElement) {
      node = node.parentNode ?? node.getRootNode().host;
    }
    if (this.inspectMode !== "searchForUAShadowDOM") {
      for (let root = node.getRootNode(); root?.isUAWidget?.(); root = node.getRootNode()) {
        node = root.host;
      }
    }
    return node;
  }

  _inspectEvent(event) {
    const document = event.originalTarget?.ownerDocument ?? event.originalTarget;
    if (!document?.defaultView || document.defaultView.browsingContext?.top !== this.target.browsingContext) {
      return;
    }
    if (event.type === "keydown") {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.inspectMode = "none";
        this._stopInspecting();
        this._setHighlight(null);
        this.session.emit("Overlay.inspectModeCanceled");
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const node = this._inspectedNodeOf(event);
    if (!node) {
      return;
    }
    // A touch never hovers, so a pointer going down shows its node too.
    if (event.type === "mousemove" || event.type === "pointerdown") {
      if (this.highlight?.nodes?.[0] !== node) {
        this._setHighlight({ nodes: [node], config: this.inspectConfig });
        const nodeId = this._dom._pushPath(node);
        if (nodeId) {
          this.session.emit("Overlay.nodeHighlightRequested", { nodeId });
        }
      }
    } else if (event.type === "click") {
      this.session.emit("Overlay.inspectNodeRequested", { backendNodeId: backendNodeIdOf(node) });
    }
  }

  // METHODS

  enable() {
    if (!this.session.domain("DOM").enabled) {
      throw new ProtocolError("DOM should be enabled first");
    }
    this.enabled = true;
    for (const action of this.onEnabled.splice(0)) {
      action();
    }
  }

  // Runs `action` once the front-end has enabled this domain. Elements
  // enables it after it has asked for the document, and an
  // Overlay.inspectNodeRequested that arrives earlier is dropped (the panel
  // then selects <body>).
  whenEnabled(action) {
    if (this.enabled) {
      action();
    } else {
      this.onEnabled.push(action);
    }
  }

  disable() {
    this.enabled = false;
    this._stopInspecting();
    this.highlight = null;
    this._removeContent();
  }

  highlightNode({ highlightConfig, nodeId, backendNodeId, objectId, selector }) {
    let node;
    if (nodeId !== undefined || backendNodeId !== undefined || objectId !== undefined) {
      node = this._dom._anyNode({ nodeId, backendNodeId, objectId });
    } else {
      throw new ProtocolError("Either nodeId, backendNodeId or objectId must be specified");
    }
    let nodes = [node];
    if (selector) {
      // Blink highlights every element the selector matches in the node's
      // document instead.
      const root = node.nodeType === 9 || node.nodeType === 11 ? node : node.ownerDocument;
      try {
        nodes = [...root.querySelectorAll(selector)];
      } catch {
        throw new ProtocolError("DOM Error while querying");
      }
    }
    this._setHighlight({ nodes, config: highlightConfig });
  }

  highlightQuad({ quad, color, outlineColor }) {
    this._setHighlight({ quads: [quad], color, outlineColor });
  }

  highlightRect({ x, y, width, height, color, outlineColor }) {
    this._setHighlight({
      quads: [[x, y, x + width, y, x + width, y + height, x, y + height]],
      color,
      outlineColor,
    });
  }

  hideHighlight() {
    this._setHighlight(null);
  }

  setInspectMode({ mode, highlightConfig }) {
    if (mode === "captureAreaScreenshot") {
      throw new ProtocolError("Capturing an area screenshot is not supported");
    }
    this.inspectMode = mode;
    this.inspectConfig = highlightConfig;
    if (mode === "none") {
      this._stopInspecting();
      this._setHighlight(null);
    } else {
      this._startInspecting();
    }
  }

  setShowViewportSizeOnResize({ show }) {
    this.showViewportSize = show;
  }

  setPausedInDebuggerMessage({ message } = {}) {
    if (!message) {
      this._clearLayer("paused");
      return;
    }
    const layer = this._layer("paused");
    if (layer) {
      layer.textContent = message;
    }
  }

  // Gecko's paint flashing is Blink's paint rects.
  setShowPaintRects({ result }) {
    this._window.windowUtils.paintFlashing = result;
  }

  // Persistent grid/flex/scroll-snap/container/isolation overlays: none is
  // what the client asks for until the user turns one on, and drawing them
  // is not implemented.
  _persistentOverlays(configs, what) {
    if (configs?.length) {
      throw new ProtocolError(`Showing ${what} overlays is not supported`);
    }
  }

  setShowGridOverlays({ gridNodeHighlightConfigs }) {
    this._persistentOverlays(gridNodeHighlightConfigs, "grid");
  }

  setShowFlexOverlays({ flexNodeHighlightConfigs }) {
    this._persistentOverlays(flexNodeHighlightConfigs, "flex");
  }

  setShowScrollSnapOverlays({ scrollSnapHighlightConfigs }) {
    this._persistentOverlays(scrollSnapHighlightConfigs, "scroll snap");
  }

  setShowContainerQueryOverlays({ containerQueryHighlightConfigs }) {
    this._persistentOverlays(containerQueryHighlightConfigs, "container query");
  }

  setShowIsolatedElements({ isolatedElementHighlightConfigs }) {
    this._persistentOverlays(isolatedElementHighlightConfigs, "isolated element");
  }

  _destroy() {
    this._stopInspecting();
    this._removeContent();
  }
}
