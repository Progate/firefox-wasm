/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The DOM domain: the page's documents as the Elements panel sees them.
//
// Like Blink's InspectorDOMAgent, a node gets a nodeId when it is first sent
// to the client, and the client only hears about changes under parents whose
// children it has been sent (otherwise just the new child count). Changes are
// observed with a MutationObserver per document and shadow root; it also
// reports native anonymous children, which is how ::before/::after/::marker
// come and go in Gecko.
//
// Edits go through a history (Blink's InspectorHistory) so that undo/redo
// work, CSS edits included.

import { frameIdOf } from "resource:///modules/firedog/devtools/domains/Runtime.sys.mjs";
import {
  InvalidParams,
  ProtocolError,
} from "resource:///modules/firedog/devtools/Session.sys.mjs";

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

// Blink's kMaxTextSize for text and comment values sent with a node.
const MAX_TEXT_SIZE = 10000;

// The pseudo-elements Gecko implements as anonymous children, as
// DOM.PseudoType names.
const PSEUDO_TYPES = new Map([
  ["::marker", "marker"],
  ["::before", "before"],
  ["::after", "after"],
  ["::backdrop", "backdrop"],
]);
// Blink lists an element's pseudo-elements in this order.
const PSEUDO_ORDER = ["marker", "before", "after", "backdrop"];

// Backend node ids are global like Blink's DOMNodeIds, so that any session
// (and Accessibility, Network initiators, ...) can name a node. The reverse
// map keeps a node only as long as its document lives.
const backendIds = new WeakMap();
const nodesByBackendId = new Map();
let nextBackendId = 1;

export function backendNodeIdOf(node) {
  let id = backendIds.get(node);
  if (!id) {
    id = nextBackendId++;
    backendIds.set(node, id);
    nodesByBackendId.set(id, Cu.getWeakReference(node));
  }
  return id;
}

export function nodeForBackendId(id) {
  const node = nodesByBackendId.get(id)?.get() ?? null;
  if (!node) {
    nodesByBackendId.delete(id);
  }
  return node;
}

// The window of a node's document (Xrays of content nodes have no
// ownerGlobal).
export function winOf(node) {
  return node.nodeType === 9 ? node.defaultView : node.ownerDocument?.defaultView ?? null;
}

function isWhitespaceText(node) {
  return node.nodeType === 3 && !/[^\t\n\f\r ]/.test(node.data);
}

function pseudoTypeOf(node) {
  return node.nodeType === 1 ? PSEUDO_TYPES.get(node.implementedPseudoElement) : undefined;
}

// The ::before/::after/::marker/::backdrop nodes of an element, in Blink's
// order.
export function pseudoElementsOf(element) {
  if (element.nodeType !== 1 || pseudoTypeOf(element)) {
    return [];
  }
  const found = [];
  for (const child of InspectorUtils.getChildrenForNode(element, true, false)) {
    const type = pseudoTypeOf(child);
    if (type) {
      found.push([type, child]);
    }
  }
  found.sort((a, b) => PSEUDO_ORDER.indexOf(a[0]) - PSEUDO_ORDER.indexOf(b[0]));
  return found.map(([, node]) => node);
}

// The shadow root Blink would show for a host: author roots and Gecko's UA
// widget roots (Blink's user-agent shadow roots).
function shadowRootOf(element) {
  try {
    return element.openOrClosedShadowRoot ?? null;
  } catch {
    return null;
  }
}

function shadowRootType(root) {
  if (root.isUAWidget?.()) {
    return "user-agent";
  }
  return root.mode === "closed" ? "closed" : "open";
}

// Blink's InnerParentNode: a document's parent is its frame's owner element,
// a shadow root's is its host, a pseudo-element's is its originating element.
export function parentOf(node) {
  if (node.nodeType === 9) {
    return node.defaultView?.browsingContext?.embedderElement ?? null;
  }
  if (node.nodeType === 11 && node.host) {
    return node.host;
  }
  return node.parentNode;
}

// The element whose style a node shows: the node itself, or the element a
// pseudo-element belongs to with the pseudo name.
export function styledElementOf(node) {
  const pseudo = node.nodeType === 1 ? node.implementedPseudoElement : null;
  if (pseudo && PSEUDO_TYPES.has(pseudo)) {
    return { element: node.parentNode, pseudo };
  }
  return { element: node.nodeType === 1 ? node : null, pseudo: null };
}

// Gecko reports limited-quirks (almost standards) documents as CSS1Compat
// like standards ones, so only quirks mode can be told apart.
function compatibilityMode(document) {
  return document.compatMode === "BackCompat" ? "QuirksMode" : "NoQuirksMode";
}

function innerChildren(node) {
  const children = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (!isWhitespaceText(child)) {
      children.push(child);
    }
  }
  return children;
}

function isContainer(node) {
  return node.nodeType === 1 || node.nodeType === 9 || node.nodeType === 11;
}

// Quads of a node in its top-level viewport's CSS pixels, one per box like
// Blink's BuildNodeQuads gives for an inline element: the union of its
// fragments.
function boxQuad(node, box) {
  const top = node.ownerDocument?.defaultView?.top?.document ?? node.ownerDocument;
  let quads;
  try {
    quads = node.getBoxQuads({ box, relativeTo: top, createFramesForSuppressedWhitespace: false });
  } catch {
    return null;
  }
  if (!quads.length) {
    return null;
  }
  if (quads.length === 1) {
    const { p1, p2, p3, p4 } = quads[0];
    return [p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, p4.x, p4.y];
  }
  let left = Infinity;
  let topEdge = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const quad of quads) {
    const bounds = quad.getBounds();
    left = Math.min(left, bounds.left);
    topEdge = Math.min(topEdge, bounds.top);
    right = Math.max(right, bounds.right);
    bottom = Math.max(bottom, bounds.bottom);
  }
  return [left, topEdge, right, topEdge, right, bottom, left, bottom];
}

export function boxModelOf(node) {
  const content = boxQuad(node, "content");
  if (!content) {
    return null;
  }
  const padding = boxQuad(node, "padding");
  const border = boxQuad(node, "border");
  const margin = boxQuad(node, "margin");
  // Blink reports the offset size of boxes and the bounding box of others
  // (SVG).
  const hasOffsetSize = typeof node.offsetWidth === "number";
  return {
    content,
    padding,
    border,
    margin,
    width: hasOffsetSize ? node.offsetWidth : Math.round(border[2] - border[0]),
    height: hasOffsetSize ? node.offsetHeight : Math.round(border[5] - border[1]),
  };
}

// A DOM change the client can undo: Blink's InspectorHistory::Action.
class History {
  constructor() {
    this.actions = [];
    this.position = 0;
  }

  perform(action) {
    action.perform();
    this.actions.length = this.position;
    this.actions.push(action);
    this.position = this.actions.length;
  }

  // An undoable state groups the actions since the previous one, as one
  // Ctrl+Z in the panel.
  markUndoableState() {
    if (this.actions.at(this.position - 1)?.mark) {
      return;
    }
    this.actions.length = this.position;
    this.actions.push({ mark: true });
    this.position = this.actions.length;
  }

  undo() {
    while (this.position > 0 && this.actions[this.position - 1].mark) {
      this.position--;
    }
    while (this.position > 0 && !this.actions[this.position - 1].mark) {
      this.actions[--this.position].undo();
    }
  }

  redo() {
    while (this.position < this.actions.length && this.actions[this.position].mark) {
      this.position++;
    }
    while (this.position < this.actions.length && !this.actions[this.position].mark) {
      this.actions[this.position++].redo();
    }
  }

  reset() {
    this.actions = [];
    this.position = 0;
  }
}

function setAttributeAction(element, name, value) {
  const had = element.hasAttribute(name);
  const old = element.getAttribute(name);
  const set = () => element.setAttribute(name, value);
  const restore = () => (had ? element.setAttribute(name, old) : element.removeAttribute(name));
  return { perform: set, undo: restore, redo: set };
}

function removeAttributeAction(element, name) {
  const had = element.hasAttribute(name);
  const old = element.getAttribute(name);
  const remove = () => element.removeAttribute(name);
  const restore = () => had && element.setAttribute(name, old);
  return { perform: remove, undo: restore, redo: remove };
}

function insertBeforeAction(parent, node, anchor) {
  const oldParent = node.parentNode;
  const oldNext = node.nextSibling;
  const insert = () => parent.insertBefore(node, anchor);
  const restore = () => {
    if (oldParent) {
      oldParent.insertBefore(node, oldNext);
    } else {
      node.remove();
    }
  };
  return { perform: insert, undo: restore, redo: insert };
}

function removeChildAction(parent, node) {
  const next = node.nextSibling;
  const remove = () => parent.removeChild(node);
  const restore = () => parent.insertBefore(node, next);
  return { perform: remove, undo: restore, redo: remove };
}

function setNodeValueAction(node, value) {
  const old = node.nodeValue;
  const set = () => (node.nodeValue = value);
  const restore = () => (node.nodeValue = old);
  return { perform: set, undo: restore, redo: set };
}

export class DOM {
  constructor(session) {
    this.session = session;
    this.target = session.target;
    this.enabled = false;
    this.history = new History();
    // Nodes most recently selected in the Elements panel, for $0..$4.
    this._inspectedNodes = [];
    this.searches = new Map();
    this.nextSearchId = 1;
    this._reset();
  }

  get _runtime() {
    return this.session.domain("Runtime");
  }

  _reset() {
    this.ids = new Map();
    this.idOf = new WeakMap();
    this.nextId = 1;
    // Parents whose children were sent, with the children as sent.
    this.sentChildren = new Map();
    this.childCount = new Map();
    this.sentPseudos = new Map();
    this.sentShadowRoot = new Map();
    this.searches?.clear();
    this.history?.reset();
    this._disconnectObservers();
    this.observers = new Map();
  }

  _disconnectObservers() {
    for (const observer of this.observers?.values() ?? []) {
      try {
        observer.disconnect();
      } catch {
        // The document is gone.
      }
    }
  }

  get _document() {
    return this.target.contentWindow?.document ?? null;
  }

  // Node ids.

  // For callers outside the protocol (the docked DevTools' "Inspect"
  // context menu item), which then ask the client to inspect the node.
  _backendNodeIdFor(node) {
    return backendNodeIdOf(node);
  }

  _bind(node) {
    let id = this.idOf.get(node);
    if (!id) {
      id = this.nextId++;
      this.idOf.set(node, id);
      this.ids.set(id, node);
    }
    return id;
  }

  _boundId(node) {
    return (node && this.idOf.get(node)) || 0;
  }

  _unbind(node) {
    const id = this._boundId(node);
    if (!id) {
      return;
    }
    this.ids.delete(id);
    this.idOf.delete(node);
    const children = this.sentChildren.get(id);
    this.sentChildren.delete(id);
    this.childCount.delete(id);
    for (const child of children ?? []) {
      this._unbind(child);
    }
    for (const pseudo of this.sentPseudos.get(id) ?? []) {
      this._unbind(pseudo);
    }
    this.sentPseudos.delete(id);
    const root = this.sentShadowRoot.get(id);
    if (root) {
      this._unbind(root);
      this.sentShadowRoot.delete(id);
    }
    if (node.nodeType === 1) {
      const content = node.contentDocument;
      if (content) {
        this._unbind(content);
      }
    }
  }

  // The node a client id names, or the error Blink gives.
  _node(nodeId) {
    const node = this.ids.get(nodeId);
    if (!node || Cu.isDeadWrapper(node)) {
      throw new ProtocolError("Could not find node with given id");
    }
    return node;
  }

  _element(nodeId) {
    const node = this._node(nodeId);
    if (node.nodeType !== 1) {
      throw new ProtocolError("Node is not an Element");
    }
    return node;
  }

  // Blink's AssertNode(nodeId, backendNodeId, objectId).
  _anyNode({ nodeId, backendNodeId, objectId }) {
    if (nodeId !== undefined) {
      return this._node(nodeId);
    }
    if (backendNodeId !== undefined) {
      const node = nodeForBackendId(backendNodeId);
      if (!node) {
        throw new ProtocolError("No node found for given backend id");
      }
      return node;
    }
    if (objectId !== undefined) {
      return this._nodeForObjectId(objectId);
    }
    throw new ProtocolError("Either nodeId, backendNodeId or objectId must be specified");
  }

  _nodeForObjectId(objectId) {
    const object = this._runtime._object(objectId);
    let value = null;
    try {
      value = typeof object === "object" ? object.unsafeDereference() : null;
    } catch {
      value = null;
    }
    value = value && Cu.unwaiveXrays(value);
    if (!value || typeof value.nodeType !== "number" || !Cu.isDOMObject?.(value)) {
      throw new ProtocolError("Object id doesn't reference a Node");
    }
    return value;
  }

  _assertEditable(node) {
    const root = node.getRootNode?.();
    if (node.nodeType === 11 && node.host) {
      throw new ProtocolError("Cannot edit shadow roots");
    }
    if (root?.isUAWidget?.()) {
      throw new ProtocolError("Cannot edit nodes from user-agent shadow trees");
    }
    if (pseudoTypeOf(node)) {
      throw new ProtocolError("Cannot edit pseudo elements");
    }
    return node;
  }

  // DOM.Node, as Blink's BuildObjectForNode.

  _describe(node, depth, pierce, bind = true) {
    const id = bind ? this._bind(node) : this._boundId(node);
    const type = node.nodeType;
    let localName = "";
    let nodeValue = "";
    if (type === 3 || type === 8 || type === 4 || type === 7) {
      nodeValue = node.nodeValue;
      if (nodeValue.length > MAX_TEXT_SIZE) {
        nodeValue = nodeValue.slice(0, MAX_TEXT_SIZE) + "…";
      }
    } else if (type === 1 || type === 2) {
      localName = node.localName;
    }
    const pseudoType = pseudoTypeOf(node);
    const value = {
      nodeId: id,
      backendNodeId: backendNodeIdOf(node),
      nodeType: type,
      nodeName: pseudoType ? node.implementedPseudoElement : node.nodeName,
      localName: pseudoType ? node.implementedPseudoElement : localName,
      nodeValue,
    };
    if (type === 1 && node.namespaceURI === SVG_NS) {
      value.isSVG = true;
    }
    if ((type === 9 || type === 11) && node.adoptedStyleSheets?.length) {
      const css = this.session.domain("CSS");
      value.adoptedStyleSheets = [...node.adoptedStyleSheets].map(sheet => css._styleSheetId(sheet));
    }
    let forceChildren = false;
    if (type === 1) {
      value.attributes = pseudoType ? [] : this._attributes(node);
      if (typeof node.frameLoader !== "undefined") {
        const context = node.browsingContext;
        if (context) {
          value.frameId = frameIdOf(this.target, context);
        }
        const content = node.contentDocument;
        if (content) {
          value.contentDocument = this._describe(content, pierce ? depth : 0, pierce, bind);
        }
      }
      if (node.parentNode?.nodeType === 9) {
        const context = node.ownerDocument.defaultView?.browsingContext;
        if (context) {
          value.frameId = frameIdOf(this.target, context);
        }
      }
      const root = pseudoType ? null : shadowRootOf(node);
      if (root) {
        value.shadowRoots = [this._describe(root, pierce ? depth : 0, pierce, bind)];
        if (bind) {
          this.sentShadowRoot.set(id, root);
          this._observe(root);
        }
        forceChildren = true;
      }
      if (node.localName === "link" && node.namespaceURI === XHTML_NS) {
        forceChildren = true;
      }
      if (node.localName === "template" && node.namespaceURI === XHTML_NS && node.content) {
        value.templateContent = this._describe(node.content, 0, pierce, bind);
        forceChildren = true;
      }
      if (pseudoType) {
        value.pseudoType = pseudoType;
      } else {
        if (node.ownerDocument.xmlVersion) {
          value.xmlVersion = node.ownerDocument.xmlVersion;
        }
        const slot = node.assignedSlot;
        if (slot) {
          value.assignedSlot = {
            nodeType: 1,
            nodeName: slot.nodeName,
            backendNodeId: backendNodeIdOf(slot),
          };
        }
        const pseudos = pseudoElementsOf(node);
        if (pseudos.length) {
          value.pseudoElements = pseudos.map(pseudo => this._describe(pseudo, 0, false, bind));
          if (bind) {
            this.sentPseudos.set(id, pseudos);
          }
          forceChildren = true;
        }
      }
      if (node.localName === "slot" && node.getRootNode() !== node.ownerDocument) {
        value.distributedNodes = node
          .assignedNodes()
          .filter(assigned => !isWhitespaceText(assigned))
          .map(assigned => ({
            nodeType: assigned.nodeType,
            nodeName: assigned.nodeName,
            backendNodeId: backendNodeIdOf(assigned),
          }));
        forceChildren = true;
      }
    } else if (type === 9) {
      value.documentURL = node.URL;
      value.baseURL = node.baseURI;
      value.xmlVersion = node.xmlVersion ?? "";
      value.compatibilityMode = compatibilityMode(node);
      if (bind) {
        this._observe(node);
      }
    } else if (type === 10) {
      value.publicId = node.publicId;
      value.systemId = node.systemId;
    } else if (type === 2) {
      value.name = node.name;
      value.value = node.value;
    } else if (type === 11 && node.host) {
      value.shadowRootType = shadowRootType(node);
    }
    if (isContainer(node) && !pseudoType) {
      const children = innerChildren(node);
      value.childNodeCount = children.length;
      if (bind) {
        this.childCount.set(id, children.length);
      }
      if (bind && forceChildren && !depth) {
        depth = 1;
      }
      const sent = this._describeChildren(node, children, depth, pierce, bind);
      if (sent.length || depth) {
        value.children = sent;
      }
    } else if (pseudoType) {
      value.childNodeCount = 0;
    }
    if (type === 1 && !pseudoType && this._isScrollable(node)) {
      value.isScrollable = true;
    }
    return value;
  }

  _describeChildren(container, children, depth, pierce, bind) {
    const id = bind ? this._bind(container) : this._boundId(container);
    if (!depth) {
      // A lone text child is sent along, as if its parent's children had
      // been requested.
      if (bind && children.length === 1 && children[0].nodeType === 3 && container.childNodes.length === 1) {
        const child = this._describe(children[0], 0, pierce, bind);
        child.parentId = id;
        this.sentChildren.set(id, [children[0]]);
        return [child];
      }
      return [];
    }
    if (bind) {
      this.sentChildren.set(id, children);
    }
    return children.map(child => {
      const described = this._describe(child, depth - 1, pierce, bind);
      described.parentId = id;
      return described;
    });
  }

  _attributes(element) {
    const attributes = [];
    for (const attribute of element.attributes) {
      attributes.push(attribute.name, attribute.value);
    }
    return attributes;
  }

  _isScrollable(element) {
    try {
      if (!(element.scrollTopMax > 0 || element.scrollLeftMax > 0)) {
        return false;
      }
      const style = winOf(element).getComputedStyle(element);
      return style.overflowX !== "visible" || style.overflowY !== "visible";
    } catch {
      return false;
    }
  }

  // Blink's PushChildNodesToFrontend.
  _pushChildren(nodeId, depth = 1, pierce = false) {
    const node = this.ids.get(nodeId);
    if (!node || !isContainer(node)) {
      return;
    }
    if (this.sentChildren.has(nodeId)) {
      if (depth <= 1) {
        return;
      }
      for (const child of this.sentChildren.get(nodeId)) {
        this._pushChildren(this._boundId(child), depth - 1, pierce);
      }
      return;
    }
    const children = this._describeChildren(node, innerChildren(node), depth, pierce, true);
    this.session.emit("DOM.setChildNodes", { parentId: nodeId, nodes: children });
  }

  // Blink's PushNodePathToFrontend: sends the ancestors' children down to
  // the node and returns its id (0 when it is not in the inspected tree).
  _pushPath(node) {
    const document = this._document;
    if (!document || !this._boundId(document)) {
      return 0;
    }
    const known = this._boundId(node);
    if (known) {
      return known;
    }
    const path = [];
    for (let current = node; ; ) {
      const parent = parentOf(current);
      if (!parent) {
        return 0;
      }
      path.push(parent);
      if (this._boundId(parent)) {
        break;
      }
      current = parent;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const id = this._boundId(path[i]);
      if (id) {
        this._pushChildren(id);
      }
      // A frame's document, a shadow root and pseudo-elements are sent with
      // their owner; the owner being sent binds them.
    }
    return this._boundId(node);
  }

  // Mutations.

  _observe(root) {
    if (this.observers.has(root)) {
      return;
    }
    const win = winOf(root);
    if (!win) {
      return;
    }
    const observer = new win.MutationObserver(records => this._onMutations(records));
    observer.observe(root, {
      childList: true,
      attributes: true,
      characterData: true,
      subtree: true,
      nativeAnonymousChildList: true,
    });
    this.observers.set(root, observer);
  }

  _onMutations(records) {
    if (!this.enabled) {
      return;
    }
    const parents = new Set();
    const pseudoHosts = new Set();
    for (const record of records) {
      const target = record.target;
      switch (record.type) {
        case "attributes": {
          const id = this._boundId(target);
          if (!id) {
            break;
          }
          const name = record.attributeName;
          if (target.hasAttribute(name)) {
            this.session.emit("DOM.attributeModified", {
              nodeId: id,
              name,
              value: target.getAttribute(name),
            });
          } else {
            this.session.emit("DOM.attributeRemoved", { nodeId: id, name });
          }
          this.session.domains.get("CSS")?._nodeChanged(target);
          break;
        }
        case "characterData": {
          const id = this._boundId(target);
          if (id && isWhitespaceText(target)) {
            parents.add(target.parentNode);
          } else if (id) {
            this.session.emit("DOM.characterDataModified", {
              nodeId: id,
              characterData: target.data,
            });
          } else if (target.parentNode) {
            parents.add(target.parentNode);
          }
          break;
        }
        case "childList":
          parents.add(target);
          break;
        case "nativeAnonymousChildList":
          pseudoHosts.add(target);
          break;
      }
    }
    for (const parent of parents) {
      this._syncChildren(parent);
    }
    for (const host of pseudoHosts) {
      this._syncPseudos(host);
    }
    this.session.domains.get("CSS")?._domChanged();
  }

  _syncChildren(parent) {
    const parentId = this._boundId(parent);
    if (!parentId) {
      return;
    }
    const current = innerChildren(parent);
    const sent = this.sentChildren.get(parentId);
    if (!sent) {
      if (this.childCount.get(parentId) !== current.length) {
        this.childCount.set(parentId, current.length);
        this.session.emit("DOM.childNodeCountUpdated", {
          nodeId: parentId,
          childNodeCount: current.length,
        });
      }
      return;
    }
    const currentSet = new Set(current);
    const remaining = [];
    for (const child of sent) {
      if (currentSet.has(child) && this._boundId(child)) {
        remaining.push(child);
      } else {
        this._emitRemoved(parentId, child);
      }
    }
    const remainingSet = new Set(remaining);
    const result = [];
    let next = 0;
    for (const child of current) {
      if (remaining[next] === child) {
        next++;
        result.push(child);
        continue;
      }
      if (remainingSet.has(child)) {
        // Moved within the parent: Blink sees a removal and an insertion.
        remaining.splice(remaining.indexOf(child), 1);
        remainingSet.delete(child);
        this._emitRemoved(parentId, child);
      }
      const previous = result.at(-1);
      result.push(child);
      this.session.emit("DOM.childNodeInserted", {
        parentNodeId: parentId,
        previousNodeId: previous ? this._boundId(previous) : 0,
        node: this._describe(child, 0, false),
      });
    }
    this.sentChildren.set(parentId, result);
    this.childCount.set(parentId, result.length);
  }

  _emitRemoved(parentId, child) {
    const id = this._boundId(child);
    if (!id) {
      return;
    }
    this.session.emit("DOM.childNodeRemoved", { parentNodeId: parentId, nodeId: id });
    this._unbind(child);
  }

  _syncPseudos(host) {
    const hostId = this._boundId(host);
    if (!hostId || host.nodeType !== 1) {
      return;
    }
    const sent = this.sentPseudos.get(hostId) ?? [];
    const current = pseudoElementsOf(host);
    for (const pseudo of sent) {
      if (!current.includes(pseudo)) {
        const id = this._boundId(pseudo);
        if (id) {
          this.session.emit("DOM.pseudoElementRemoved", { parentId: hostId, pseudoElementId: id });
          this._unbind(pseudo);
        }
      }
    }
    for (const pseudo of current) {
      if (!sent.includes(pseudo)) {
        this.session.emit("DOM.pseudoElementAdded", {
          parentId: hostId,
          pseudoElement: this._describe(pseudo, 0, false),
        });
      }
    }
    this.sentPseudos.set(hostId, current);
  }

  // A frame got a new document: Blink re-inserts the owner element so the
  // client drops the old document's nodes.
  _frameDocumentChanged(owner) {
    const ownerId = this._boundId(owner);
    const parent = owner.parentNode;
    const parentId = this._boundId(parent);
    if (!ownerId || !parentId) {
      return;
    }
    this.session.emit("DOM.childNodeRemoved", { parentNodeId: parentId, nodeId: ownerId });
    this._unbind(owner);
    const siblings = this.sentChildren.get(parentId) ?? [];
    const index = siblings.indexOf(owner);
    const previous = index > 0 ? siblings[index - 1] : null;
    this.session.emit("DOM.childNodeInserted", {
      parentNodeId: parentId,
      previousNodeId: previous ? this._boundId(previous) : 0,
      node: this._describe(owner, 0, false),
    });
  }

  observe(subject, topic) {
    if (topic !== "document-element-inserted" || !this.enabled) {
      return;
    }
    const win = subject.defaultView;
    const context = win?.browsingContext;
    if (!context || context.top !== this.target.browsingContext || context === this.target.browsingContext) {
      return;
    }
    const owner = context.embedderElement;
    if (owner && this._boundId(owner)) {
      // The new document is not complete yet; let the parser get going so
      // that the client sees its first children.
      Services.tm.dispatchToMainThread(() => this._frameDocumentChanged(owner));
    }
  }

  _listen() {
    if (this.listening) {
      return;
    }
    this.listening = true;
    this.onLoad = event => {
      const document = event.target;
      if (document?.defaultView?.browsingContext === this.target.browsingContext && this.enabled) {
        // Blink re-pushes the document when the main frame's DOM is ready.
        this._reset();
        this.session.emit("DOM.documentUpdated");
      }
    };
    this.target.browser.addEventListener("DOMContentLoaded", this.onLoad, true);
    Services.obs.addObserver(this, "document-element-inserted");
  }

  _stopListening() {
    if (!this.listening) {
      return;
    }
    this.listening = false;
    this.target.browser?.removeEventListener("DOMContentLoaded", this.onLoad, true);
    Services.obs.removeObserver(this, "document-element-inserted");
  }

  // Documents of the page (main frame and same-process frames).
  _documents() {
    return this._runtime._windows().map(win => win.document);
  }

  // METHODS

  enable({ includeWhitespace } = {}) {
    if (includeWhitespace === "all") {
      // Gecko keeps whitespace text nodes; Blink's "all" mode would list
      // them, which this agent does not do yet.
      throw new InvalidParams("includeWhitespace \"all\" is not supported");
    }
    this.enabled = true;
    this._listen();
  }

  disable() {
    if (!this.enabled) {
      throw new ProtocolError("DOM agent hasn't been enabled");
    }
    this.enabled = false;
    this._reset();
    this._stopListening();
  }

  getDocument({ depth = 2, pierce = false } = {}) {
    if (!this.enabled) {
      this.enable();
    }
    const document = this._document;
    if (!document) {
      throw new ProtocolError("Document is not available");
    }
    this._reset();
    return { root: this._describe(document, depth === -1 ? Infinity : depth, pierce) };
  }

  getFlattenedDocument({ depth = -1, pierce = false } = {}) {
    if (!this.enabled) {
      throw new ProtocolError("DOM agent hasn't been enabled");
    }
    const document = this._document;
    if (!document) {
      throw new ProtocolError("Document is not available");
    }
    this._reset();
    const nodes = [];
    const flatten = described => {
      const { children, contentDocument, shadowRoots, templateContent, pseudoElements, ...rest } = described;
      nodes.push(rest);
      for (const child of [
        ...(contentDocument ? [contentDocument] : []),
        ...(shadowRoots ?? []),
        ...(templateContent ? [templateContent] : []),
        ...(pseudoElements ?? []),
        ...(children ?? []),
      ]) {
        flatten(child);
      }
    };
    flatten(this._describe(document, depth === -1 ? Infinity : depth, pierce));
    return { nodes };
  }

  requestChildNodes({ nodeId, depth = 1, pierce = false }) {
    if (depth === 0 || depth < -1) {
      throw new ProtocolError("Please provide a positive integer as a depth or -1 for entire subtree");
    }
    this._pushChildren(nodeId, depth === -1 ? Infinity : depth, pierce);
  }

  describeNode({ nodeId, backendNodeId, objectId, depth = 0, pierce = false }) {
    const node = this._anyNode({ nodeId, backendNodeId, objectId });
    return { node: this._describe(node, depth === -1 ? Infinity : depth, pierce, false) };
  }

  resolveNode({ nodeId, backendNodeId, objectGroup, executionContextId }) {
    if ((nodeId === undefined) === (backendNodeId === undefined)) {
      throw new ProtocolError("Either nodeId or backendNodeId must be specified.");
    }
    const node = nodeId !== undefined ? this.ids.get(nodeId) : nodeForBackendId(backendNodeId);
    if (!node || Cu.isDeadWrapper(node)) {
      throw new ProtocolError("No node with given id found");
    }
    const runtime = this._runtime;
    let win = winOf(node);
    if (executionContextId !== undefined) {
      win = runtime._contextById(executionContextId).window;
    }
    if (!win) {
      throw new ProtocolError("Node with given id does not belong to the document");
    }
    runtime._contextForWindow(win);
    return { object: runtime._remoteForPageValue(win, node, { group: objectGroup }) };
  }

  requestNode({ objectId }) {
    return { nodeId: this._pushPath(this._nodeForObjectId(objectId)) };
  }

  pushNodesByBackendIdsToFrontend({ backendNodeIds }) {
    const document = this._document;
    if (!document || !this._boundId(document)) {
      throw new ProtocolError("Document needs to be requested first");
    }
    const windows = new Set(this._runtime._windows());
    return {
      nodeIds: backendNodeIds.map(id => {
        const node = nodeForBackendId(id);
        return node && windows.has(winOf(node)) ? this._pushPath(node) : 0;
      }),
    };
  }

  pushNodeByPathToFrontend({ path }) {
    if (!this.enabled) {
      throw new ProtocolError("DOM agent is not enabled");
    }
    const node = this._nodeForPath(path);
    if (!node) {
      throw new ProtocolError("No node with given path found");
    }
    return { nodeId: this._pushPath(node) };
  }

  // Blink's NodeForPath: "1,HTML,2,BODY,1,DIV", with "d" for a frame's
  // document and "a"/"u" for author/user-agent shadow roots.
  _nodeForPath(path) {
    let node = this._document;
    const tokens = path.split(",").filter(Boolean);
    if (!node || !tokens.length) {
      return null;
    }
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const [index, name] = [tokens[i], tokens[i + 1]];
      let child;
      if (index === "d") {
        child = node.contentDocument ?? null;
      } else if (index === "a" || index === "u") {
        const root = node.nodeType === 1 ? shadowRootOf(node) : null;
        child = root && (shadowRootType(root) === "user-agent") === (index === "u") ? root : null;
      } else {
        child = innerChildren(node)[parseInt(index, 10)] ?? null;
      }
      if (!child || child.nodeName !== name) {
        return null;
      }
      node = child;
    }
    return node;
  }

  setInspectedNode({ nodeId }) {
    const node = this._node(nodeId);
    this._inspectedNodes = [node, ...this._inspectedNodes.filter(other => other !== node)].slice(0, 5);
  }

  getAttributes({ nodeId }) {
    return { attributes: this._attributes(this._element(nodeId)) };
  }

  querySelector({ nodeId, selector }) {
    const node = this._node(nodeId);
    if (!node.querySelector) {
      throw new ProtocolError("Not a container node");
    }
    let element;
    try {
      element = node.querySelector(selector);
    } catch {
      throw new ProtocolError("DOM Error while querying");
    }
    return { nodeId: element ? this._pushPath(element) : 0 };
  }

  querySelectorAll({ nodeId, selector }) {
    const node = this._node(nodeId);
    if (!node.querySelectorAll) {
      throw new ProtocolError("Not a container node");
    }
    let elements;
    try {
      elements = [...node.querySelectorAll(selector)];
    } catch {
      throw new ProtocolError("DOM Error while querying");
    }
    return { nodeIds: elements.map(element => this._pushPath(element)) };
  }

  collectClassNamesFromSubtree({ nodeId }) {
    const root = this.ids.get(nodeId);
    if (!root || !isContainer(root)) {
      throw new ProtocolError("No suitable node with given id found");
    }
    const names = new Set();
    const visit = node => {
      if (node.nodeType === 1) {
        for (const name of node.classList ?? []) {
          names.add(name);
        }
        const shadow = shadowRootOf(node);
        if (shadow) {
          visit(shadow);
        }
      }
      for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
        visit(child);
      }
    };
    visit(root);
    return { classNames: [...names] };
  }

  getOuterHTML({ nodeId, backendNodeId, objectId, includeShadowDOM = false }) {
    const node = this._anyNode({ nodeId, backendNodeId, objectId });
    if (node.nodeType === 1) {
      if (!includeShadowDOM) {
        return { outerHTML: node.outerHTML };
      }
      // getHTML serializes the children with shadow roots as declarative
      // <template>s; the element's own tags come from a shallow clone.
      const inner = node.getHTML({ shadowRoots: this._shadowRootsUnder(node) });
      const shell = node.cloneNode(false).outerHTML;
      const close = shell.lastIndexOf("</");
      return {
        outerHTML: close > 0 ? shell.slice(0, close) + inner + shell.slice(close) : shell,
      };
    }
    if (node.nodeType === 9) {
      return { outerHTML: new node.defaultView.XMLSerializer().serializeToString(node).replace(/^<\?xml[^>]*>\n?/, "") };
    }
    if (node.nodeType === 11) {
      const container = node.ownerDocument.createElement("div");
      container.append(node.cloneNode(true));
      return { outerHTML: container.innerHTML };
    }
    return { outerHTML: new (winOf(node).XMLSerializer)().serializeToString(node) };
  }

  _shadowRootsUnder(element) {
    const roots = [];
    const visit = node => {
      const root = node.nodeType === 1 ? shadowRootOf(node) : null;
      if (root && !root.isUAWidget?.()) {
        roots.push(root);
        visit(root);
      }
      for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
        visit(child);
      }
    };
    visit(element);
    return roots;
  }

  setOuterHTML({ nodeId, outerHTML }) {
    const node = this._assertEditable(this._node(nodeId));
    const document = node.nodeType === 9 ? node : node.ownerDocument;
    if (!document || !(document.contentType === "text/html" || /xml/.test(document.contentType))) {
      throw new ProtocolError("Not an HTML/XML document");
    }
    if (node.nodeType === 9) {
      // Blink patches the whole document in place; Gecko has no such patch,
      // so the document's root is replaced.
      const parsed = new document.defaultView.DOMParser().parseFromString(outerHTML, document.contentType);
      const root = document.importNode(parsed.documentElement, true);
      this.history.perform(insertBeforeAction(document, root, document.documentElement));
      this.history.perform(removeChildAction(document, root.nextSibling));
      return;
    }
    const parent = node.parentNode;
    if (!parent) {
      throw new ProtocolError("Cannot set outer HTML of a detached node");
    }
    const context = parent.nodeType === 1 ? parent : document.body ?? document.documentElement;
    const range = document.createRange();
    range.selectNodeContents(context);
    const fragment = range.createContextualFragment(outerHTML);
    const newNodes = [...fragment.childNodes];
    const anchor = node.nextSibling;
    for (const newNode of newNodes) {
      this.history.perform(insertBeforeAction(parent, newNode, anchor));
    }
    this.history.perform(removeChildAction(parent, node));
    const first = newNodes.find(child => !isWhitespaceText(child));
    if (!first) {
      return;
    }
    const wasRequested = this.sentChildren.has(nodeId);
    this._flushMutations(parent);
    const newId = this._pushPath(first);
    if (wasRequested && newId) {
      this._pushChildren(newId);
    }
  }

  // MutationObserver callbacks run later; methods that answer with ids of
  // nodes they just created must first tell the client about them.
  _flushMutations(root) {
    const doc = root.nodeType === 9 ? root : root.getRootNode?.() ?? root.ownerDocument;
    for (const [observed, observer] of this.observers) {
      if (observed === doc || observed === root.ownerDocument) {
        const records = observer.takeRecords();
        if (records.length) {
          this._onMutations(records);
        }
      }
    }
  }

  setAttributeValue({ nodeId, name, value }) {
    const element = this._assertEditable(this._element(nodeId));
    this.history.perform(setAttributeAction(element, name, value));
  }

  setAttributesAsText({ nodeId, text, name }) {
    const element = this._assertEditable(this._element(nodeId));
    const document = element.ownerDocument;
    const isHTML = document.contentType === "text/html";
    const markup = element.namespaceURI === SVG_NS
      ? `<svg ${text}></svg>`
      : element.namespaceURI === MATHML_NS
        ? `<math ${text}></math>`
        : `<span ${text}></span>`;
    let parsed = null;
    if (isHTML) {
      const context = element.namespaceURI === SVG_NS && element.ownerSVGElement
        ? element.ownerSVGElement
        : document.body ?? document.documentElement;
      const range = document.createRange();
      range.selectNodeContents(context);
      // createContextualFragment would run <script>; attributes of one
      // element never do, and event handler attributes are only set, as in
      // Blink.
      parsed = range.createContextualFragment(markup).firstChild;
    } else {
      const xml = new document.defaultView.DOMParser().parseFromString(
        markup.replace(/^<(\w+)/, `<$1 xmlns="${element.namespaceURI ?? ""}"`),
        "application/xml"
      );
      parsed = xml.documentElement?.localName === "parsererror" ? null : xml.documentElement;
    }
    if (!parsed || parsed.nodeType !== 1) {
      throw new ProtocolError("Could not parse value as attributes");
    }
    const ignoreCase = isHTML && element.namespaceURI === XHTML_NS;
    const original = name === undefined ? undefined : ignoreCase ? name.toLowerCase() : name;
    if (!parsed.attributes.length && name !== undefined) {
      this.history.perform(removeAttributeAction(element, original));
      return;
    }
    let foundOriginal = false;
    for (const attribute of parsed.attributes) {
      const attributeName = ignoreCase ? attribute.name.toLowerCase() : attribute.name;
      foundOriginal ||= name !== undefined && attributeName === original;
      try {
        this.history.perform(setAttributeAction(element, attributeName, attribute.value));
      } catch (error) {
        throw new ProtocolError(error.message);
      }
    }
    if (!foundOriginal && name !== undefined && name.trim()) {
      this.history.perform(removeAttributeAction(element, original));
    }
  }

  removeAttribute({ nodeId, name }) {
    const element = this._assertEditable(this._element(nodeId));
    this.history.perform(removeAttributeAction(element, name));
  }

  removeNode({ nodeId }) {
    const node = this._assertEditable(this._node(nodeId));
    const parent = node.parentNode;
    if (!parent) {
      throw new ProtocolError("Cannot remove detached node");
    }
    this.history.perform(removeChildAction(parent, node));
  }

  setNodeName({ nodeId, name }) {
    const old = this._node(nodeId);
    if (old.nodeType !== 1) {
      throw new ProtocolError("Not an element");
    }
    let element;
    try {
      element = old.ownerDocument.createElementNS(old.namespaceURI, name);
    } catch (error) {
      throw new ProtocolError(error.message);
    }
    for (const attribute of old.attributes) {
      element.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
    }
    while (old.firstChild) {
      this.history.perform(insertBeforeAction(element, old.firstChild, null));
    }
    const parent = old.parentNode;
    this.history.perform(insertBeforeAction(parent, element, old.nextSibling));
    this.history.perform(removeChildAction(parent, old));
    const wasRequested = this.sentChildren.has(nodeId);
    this._flushMutations(parent);
    const newId = this._pushPath(element);
    if (wasRequested && newId) {
      this._pushChildren(newId);
    }
    return { nodeId: newId };
  }

  setNodeValue({ nodeId, value }) {
    const node = this._assertEditable(this._node(nodeId));
    if (node.nodeType !== 3 && node.nodeType !== 7) {
      throw new ProtocolError("Can only set value of text nodes or processing instructions");
    }
    this.history.perform(setNodeValueAction(node, value));
  }

  _moveOrCopy(nodeId, targetNodeId, insertBeforeNodeId, copy) {
    const node = this._assertEditable(this._node(nodeId));
    const target = this._assertEditable(this._element(targetNodeId));
    if (!copy) {
      for (let current = target; current; current = current.parentNode) {
        if (current === node) {
          throw new ProtocolError("Unable to move node into self or descendant");
        }
      }
    }
    let anchor = null;
    if (insertBeforeNodeId) {
      anchor = this._assertEditable(this._node(insertBeforeNodeId));
      if (anchor.parentNode !== target) {
        throw new ProtocolError("Anchor node must be child of the target element");
      }
    }
    const moved = copy ? node.cloneNode(true) : node;
    this.history.perform(insertBeforeAction(target, moved, anchor));
    this._flushMutations(target);
    return { nodeId: this._pushPath(moved) };
  }

  moveTo({ nodeId, targetNodeId, insertBeforeNodeId }) {
    return this._moveOrCopy(nodeId, targetNodeId, insertBeforeNodeId, false);
  }

  copyTo({ nodeId, targetNodeId, insertBeforeNodeId }) {
    return this._moveOrCopy(nodeId, targetNodeId, insertBeforeNodeId, true);
  }

  undo() {
    if (!this.enabled) {
      throw new ProtocolError("DOM agent is not enabled");
    }
    try {
      this.history.undo();
    } catch (error) {
      throw new ProtocolError(error.message);
    }
  }

  redo() {
    if (!this.enabled) {
      throw new ProtocolError("DOM agent is not enabled");
    }
    try {
      this.history.redo();
    } catch (error) {
      throw new ProtocolError(error.message);
    }
  }

  markUndoableState() {
    if (!this.enabled) {
      throw new ProtocolError("DOM agent is not enabled");
    }
    this.history.markUndoableState();
  }

  focus({ nodeId, backendNodeId, objectId }) {
    const node = this._anyNode({ nodeId, backendNodeId, objectId });
    if (node.nodeType !== 1) {
      throw new ProtocolError("Node is not an Element");
    }
    node.focus();
    if (node.getRootNode().activeElement !== node) {
      throw new ProtocolError("Element is not focusable");
    }
  }

  getBoxModel({ nodeId, backendNodeId, objectId }) {
    const node = this._anyNode({ nodeId, backendNodeId, objectId });
    const model = boxModelOf(node);
    if (!model) {
      throw new ProtocolError("Could not compute box model.");
    }
    return { model };
  }

  getContentQuads({ nodeId, backendNodeId, objectId }) {
    const node = this._anyNode({ nodeId, backendNodeId, objectId });
    const top = node.ownerDocument?.defaultView?.top?.document;
    let quads = [];
    try {
      quads = node.getBoxQuads({ box: "border", relativeTo: top });
    } catch {
      quads = [];
    }
    if (!quads.length) {
      throw new ProtocolError("Could not compute content quads.");
    }
    return {
      quads: quads.map(({ p1, p2, p3, p4 }) => [p1.x, p1.y, p2.x, p2.y, p3.x, p3.y, p4.x, p4.y]),
    };
  }

  getNodeForLocation({ x, y, includeUserAgentShadowDOM = false }) {
    let win = this.target.contentWindow;
    // The point is in the main document's coordinates; hit testing works in
    // a frame's viewport, descending into frames like Blink's hit test.
    let px = x - win.scrollX;
    let py = y - win.scrollY;
    let node = null;
    for (;;) {
      const hit = win.windowUtils.elementFromPoint(px, py, true, true);
      if (!hit) {
        break;
      }
      node = hit;
      const content = hit.contentWindow;
      if (!content || !hit.contentDocument) {
        break;
      }
      const rect = hit.getBoxQuads({ box: "content", relativeTo: win.document })[0]?.getBounds();
      if (!rect) {
        break;
      }
      px -= rect.left;
      py -= rect.top;
      win = content;
    }
    if (node && !includeUserAgentShadowDOM) {
      for (let root = node.getRootNode(); root?.isUAWidget?.(); root = node.getRootNode()) {
        node = root.host;
      }
    }
    while (node && node.nodeType === 3) {
      node = node.parentNode;
    }
    if (!node) {
      throw new ProtocolError("No node found at given location");
    }
    const result = {
      backendNodeId: backendNodeIdOf(node),
      frameId: frameIdOf(this.target, winOf(node).browsingContext),
    };
    if (this.enabled && this._document && this._boundId(this._document)) {
      result.nodeId = this._pushPath(node);
    }
    return result;
  }

  scrollIntoViewIfNeeded({ nodeId, backendNodeId, objectId, rect }) {
    const node = this._anyNode({ nodeId, backendNodeId, objectId });
    if (!node.isConnected) {
      throw new ProtocolError("Node is detached from document");
    }
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element || !boxModelOf(element)) {
      throw new ProtocolError("Node does not have a layout object");
    }
    if (rect) {
      // Gecko scrolls to elements, not to rects inside them.
      throw new ProtocolError("Scrolling to a rect inside a node is not supported");
    }
    // Blink centres the node only when it is not fully in view.
    const box = element.getBoundingClientRect();
    const win = winOf(element);
    if (box.top >= 0 && box.left >= 0 && box.bottom <= win.innerHeight && box.right <= win.innerWidth) {
      return;
    }
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  }

  getFrameOwner({ frameId }) {
    for (const win of this._runtime._windows()) {
      const context = win.browsingContext;
      if (frameIdOf(this.target, context) !== frameId) {
        continue;
      }
      const owner = context.embedderElement;
      if (!owner || context === this.target.browsingContext) {
        throw new ProtocolError("Frame with the given id does not belong to the target.");
      }
      const result = { backendNodeId: backendNodeIdOf(owner) };
      if (this.enabled && this._document && this._boundId(this._document)) {
        result.nodeId = this._pushPath(owner);
      }
      return result;
    }
    throw new ProtocolError("Frame with the given id was not found.");
  }

  getTopLayerElements() {
    if (!this._document) {
      throw new ProtocolError("DOM agent hasn't been enabled");
    }
    const nodeIds = [];
    for (const document of this._documents()) {
      for (const element of document.querySelectorAll(":modal, :popover-open, :fullscreen")) {
        const id = this._pushPath(element);
        if (id) {
          nodeIds.push(id);
        }
      }
    }
    return { nodeIds };
  }

  getNodesForSubtreeByStyle({ nodeId, computedStyles, pierce = false }) {
    if (!this.enabled) {
      throw new ProtocolError("DOM agent hasn't been enabled");
    }
    const root = this._node(nodeId);
    const nodeIds = [];
    const visit = node => {
      if (node.nodeType === 1) {
        const style = winOf(node).getComputedStyle(node);
        if (computedStyles.some(({ name, value }) => style.getPropertyValue(name) === value)) {
          nodeIds.push(this._pushPath(node));
        }
        if (pierce) {
          const shadow = shadowRootOf(node);
          if (shadow) {
            visit(shadow);
          }
          if (node.contentDocument) {
            visit(node.contentDocument);
          }
        }
      }
      for (const child of innerChildren(node)) {
        visit(child);
      }
    };
    visit(root);
    return { nodeIds };
  }

  performSearch({ query, includeUserAgentShadowDOM = false }) {
    if (!this.enabled) {
      throw new ProtocolError("DOM agent is not enabled");
    }
    const results = new Set();
    let tagQuery = query;
    let start = false;
    let end = false;
    if (tagQuery.startsWith("</")) {
      tagQuery = tagQuery.slice(2);
      start = true;
    } else if (tagQuery.startsWith("<")) {
      tagQuery = tagQuery.slice(1);
      start = true;
    }
    if (tagQuery.endsWith(">")) {
      tagQuery = tagQuery.slice(0, -1);
      end = true;
    }
    tagQuery = tagQuery.toLowerCase();
    const matchesName = name => {
      name = name.toLowerCase();
      if (start && end) {
        return name === tagQuery;
      }
      if (start) {
        return name.startsWith(tagQuery);
      }
      if (end) {
        return name.endsWith(tagQuery);
      }
      return name.includes(tagQuery);
    };
    let attributeQuery = query;
    const exact = attributeQuery.length > 1 && attributeQuery.startsWith('"') && attributeQuery.endsWith('"');
    attributeQuery = attributeQuery.replace(/^"/, "").replace(/"$/, "").toLowerCase();
    const lowerQuery = query.toLowerCase();
    const roots = [];
    for (const document of this._documents()) {
      try {
        for (const element of document.querySelectorAll(query)) {
          results.add(element);
        }
      } catch {
        // Not a selector.
      }
      roots.push(document);
    }
    const walk = (node, visitShadow) => {
      switch (node.nodeType) {
        case 3:
        case 4:
        case 8:
          if (node.nodeValue.toLowerCase().includes(lowerQuery)) {
            results.add(node);
          }
          break;
        case 1: {
          if (matchesName(node.nodeName)) {
            results.add(node);
          } else {
            for (const attribute of node.attributes) {
              const value = attribute.value.toLowerCase();
              if (
                attribute.localName.toLowerCase().includes(lowerQuery) ||
                (exact ? value === attributeQuery : value.includes(attributeQuery))
              ) {
                results.add(node);
                break;
              }
            }
          }
          const shadow = shadowRootOf(node);
          if (shadow && (includeUserAgentShadowDOM || !shadow.isUAWidget?.())) {
            visitShadow(shadow);
            walk(shadow, visitShadow);
          }
          break;
        }
      }
      for (let child = node.firstChild; child; child = child.nextSibling) {
        walk(child, visitShadow);
      }
    };
    for (const document of roots) {
      if (!document.documentElement) {
        continue;
      }
      walk(document.documentElement, shadow => {
        try {
          for (const element of shadow.querySelectorAll(query)) {
            results.add(element);
          }
        } catch {
          // Not a selector.
        }
      });
      try {
        const xpath = document.evaluate(query, document, null, 7, null);
        for (let i = 0; i < xpath.snapshotLength; i++) {
          const node = xpath.snapshotItem(i);
          results.add(node.nodeType === 2 ? node.ownerElement : node);
        }
      } catch {
        // Not an XPath expression.
      }
    }
    const searchId = `${this.nextSearchId++}`;
    this.searches.set(searchId, [...results]);
    return { searchId, resultCount: results.size };
  }

  getSearchResults({ searchId, fromIndex, toIndex }) {
    const results = this.searches.get(searchId);
    if (!results) {
      throw new ProtocolError("No search session with given id found");
    }
    if (fromIndex < 0 || toIndex > results.length || fromIndex >= toIndex) {
      throw new ProtocolError("Invalid search result range");
    }
    return { nodeIds: results.slice(fromIndex, toIndex).map(node => this._pushPath(node)) };
  }

  discardSearchResults({ searchId }) {
    this.searches.delete(searchId);
  }

  // The deprecated DOM.highlight* methods are Overlay's.
  highlightNode(params) {
    return this.session.domain("Overlay").highlightNode(params);
  }

  hideHighlight() {
    return this.session.domain("Overlay").hideHighlight();
  }

  highlightRect(params) {
    return this.session.domain("Overlay").highlightRect(params);
  }

  setFileInputFiles({ files, nodeId, backendNodeId, objectId }) {
    const node = this._anyNode({ nodeId, backendNodeId, objectId });
    if (node.nodeType !== 1 || node.localName !== "input" || node.type !== "file") {
      throw new ProtocolError("Node is not a file input element");
    }
    node.mozSetFileNameArray(files, files.length);
  }

  _destroy() {
    this._stopListening();
    this._disconnectObservers();
  }
}
