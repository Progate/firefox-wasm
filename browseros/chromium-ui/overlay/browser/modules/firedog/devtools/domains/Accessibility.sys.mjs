/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Accessibility domain (the Elements panel's Accessibility pane): Gecko's
// accessibility tree, described with Blink's roles and properties.
//
// Gecko builds accessibles only once the accessibility service runs, which
// makes every later DOM change more expensive. The client enables this
// domain at startup whether or not the pane is ever opened, so the service
// is started by the first query instead.

import { backendNodeIdOf } from "resource:///modules/firedog/devtools/domains/DOM.sys.mjs";
import { frameIdOf } from "resource:///modules/firedog/devtools/domains/Runtime.sys.mjs";
import { ProtocolError } from "resource:///modules/firedog/devtools/Session.sys.mjs";

// Gecko role names (nsIAccessibilityService.getStringRole) to Blink's
// ax::mojom::Role names as the protocol reports them.
const ROLES = {
  document: "RootWebArea",
  "text leaf": "StaticText",
  statictext: "StaticText",
  section: "generic",
  paragraph: "paragraph",
  heading: "heading",
  link: "link",
  list: "list",
  listitem: "listitem",
  "list item marker": "ListMarker",
  pushbutton: "button",
  "toggle button": "button",
  entry: "textbox",
  "password text": "textbox",
  checkbutton: "checkbox",
  radiobutton: "radio",
  graphic: "image",
  table: "table",
  row: "row",
  cell: "cell",
  gridcell: "gridcell",
  columnheader: "columnheader",
  rowheader: "rowheader",
  combobox: "combobox",
  "combobox option": "option",
  option: "option",
  listbox: "listbox",
  "internal frame": "Iframe",
  label: "LabelText",
  form: "form",
  dialog: "dialog",
  alert: "alert",
  separator: "separator",
  strong: "strong",
  emphasis: "emphasis",
  blockquote: "blockquote",
  "code": "code",
  figure: "figure",
  caption: "caption",
  navigation: "navigation",
  main: "main",
  article: "article",
  region: "region",
  landmark: "region",
  "whitespace": "StaticText",
  slider: "slider",
  progressbar: "progressbar",
  spinbutton: "spinbutton",
  menu: "menu",
  menuitem: "menuitem",
  "menupopup": "menu",
  tree: "tree",
  "outlineitem": "treeitem",
  outline: "tree",
  "page tab": "tab",
  "page tab list": "tablist",
  "property page": "tabpanel",
  grouping: "group",
  "mark": "mark",
  "details": "DescriptionListDetail",
  term: "DescriptionListTerm",
  definition: "definition",
  math: "math",
  "text container": "generic",
  "text": "generic",
  "subscript": "subscript",
  "superscript": "superscript",
  "time": "time",
  "summary": "DisclosureTriangle",
  "image map": "image",
  "editcombobox": "combobox",
  "meter": "meter",
};

export class Accessibility {
  constructor(session) {
    this.session = session;
    this.target = session.target;
    this.enabled = false;
    this.ids = new WeakMap();
    this.accessibles = new Map();
    this.nextId = 1;
  }

  get _service() {
    if (!this.service) {
      const contract = Cc["@mozilla.org/accessibilityService;1"];
      if (!contract) {
        throw new ProtocolError("Accessibility is not available in this build");
      }
      this.service = contract.getService(Ci.nsIAccessibilityService);
    }
    return this.service;
  }

  _id(accessible) {
    let id = this.ids.get(accessible);
    if (!id) {
      id = String(this.nextId++);
      this.ids.set(accessible, id);
      this.accessibles.set(id, accessible);
    }
    return id;
  }

  // Gecko builds a document's accessibles asynchronously once the service
  // starts (and after the document changes); a rendered node without one yet
  // gets it shortly.
  async _accessibleFor(node) {
    const service = this._service;
    for (let attempt = 0; ; attempt++) {
      const accessible = service.getAccessibleFor(node);
      const element = node.nodeType === 9 ? node.documentElement : node.nodeType === 1 ? node : node.parentElement;
      const rendered = !!element?.getClientRects().length;
      if (accessible || !rendered || attempt >= 40) {
        return accessible;
      }
      await new Promise(resolve => this.target.window.setTimeout(resolve, 50));
    }
  }

  _isTopDocument(accessible) {
    return accessible.DOMNode === this.target.contentWindow.document;
  }

  _children(accessible) {
    const children = [];
    for (let child = accessible.firstChild; child; child = child.nextSibling) {
      children.push(child);
    }
    return children;
  }

  _attribute(accessible, name) {
    try {
      return accessible.attributes.getStringProperty(name);
    } catch {
      return "";
    }
  }

  _role(accessible) {
    const geckoRole = this._service.getStringRole(accessible.role);
    const ariaRole = this._attribute(accessible, "xml-roles").split(" ")[0];
    return ariaRole || ROLES[geckoRole] || geckoRole;
  }

  // Accessibility.AXNode.
  _describe(accessible) {
    const states = {};
    const extraStates = {};
    accessible.getState(states, extraStates);
    const state = states.value;
    const extra = extraStates.value;
    const S = Ci.nsIAccessibleStates;
    const properties = [];
    const add = (name, type, value) => properties.push({ name, value: { type, value } });
    if (state & S.STATE_FOCUSABLE) {
      add("focusable", "booleanOrUndefined", true);
    }
    if (state & S.STATE_FOCUSED) {
      add("focused", "booleanOrUndefined", true);
    }
    if (extra & S.EXT_STATE_EDITABLE) {
      add("editable", "token", extra & S.EXT_STATE_MULTI_LINE ? "richtext" : "plaintext");
    }
    if (state & S.STATE_READONLY) {
      add("readonly", "booleanOrUndefined", true);
    }
    if (state & S.STATE_UNAVAILABLE) {
      add("disabled", "boolean", true);
    }
    if (extra & S.EXT_STATE_EXPANDABLE) {
      add("expanded", "booleanOrUndefined", !!(state & S.STATE_EXPANDED));
    }
    if (extra & S.EXT_STATE_MULTI_LINE) {
      add("multiline", "boolean", true);
    }
    if (state & S.STATE_REQUIRED) {
      add("required", "boolean", true);
    }
    if (state & S.STATE_CHECKABLE) {
      add("checked", "tristate", state & S.STATE_MIXED ? "mixed" : state & S.STATE_CHECKED ? "true" : "false");
    }
    if (state & S.STATE_SELECTABLE) {
      add("selected", "booleanOrUndefined", !!(state & S.STATE_SELECTED));
    }
    const level = this._attribute(accessible, "level");
    if (level) {
      add("level", "integer", Number(level));
    }
    const node = accessible.DOMNode;
    const result = {
      nodeId: this._id(accessible),
      ignored: false,
      role: { type: "role", value: this._role(accessible) },
      name: { type: "computedString", value: accessible.name ?? "" },
      properties,
      childIds: this._children(accessible).map(child => this._id(child)),
    };
    if (accessible.description) {
      result.description = { type: "computedString", value: accessible.description };
    }
    if (accessible.value) {
      result.value = { type: "string", value: accessible.value };
    }
    if (accessible.parent && !this._isTopDocument(accessible)) {
      result.parentId = this._id(accessible.parent);
    }
    if (node) {
      result.backendDOMNodeId = backendNodeIdOf(node);
      const win = (node.nodeType === 9 ? node : node.ownerDocument)?.defaultView;
      if (win?.browsingContext) {
        result.frameId = frameIdOf(this.target, win.browsingContext);
      }
    }
    return result;
  }

  // A DOM node Gecko has no accessible for (hidden, or pruned as
  // presentational): Blink lists such nodes as ignored.
  _ignored(node) {
    return {
      nodeId: `dom-${backendNodeIdOf(node)}`,
      ignored: true,
      ignoredReasons: [{ name: "notRendered", value: { type: "boolean", value: true } }],
      role: { type: "role", value: "none" },
      backendDOMNodeId: backendNodeIdOf(node),
    };
  }

  _nodeFrom(params) {
    const dom = this.session.domain("DOM");
    if (params.nodeId === undefined && params.backendNodeId === undefined && params.objectId === undefined) {
      return this.target.contentWindow.document;
    }
    return dom._anyNode(params);
  }

  _ancestors(accessible) {
    const ancestors = [];
    if (this._isTopDocument(accessible)) {
      return ancestors;
    }
    for (let parent = accessible.parent; parent; parent = parent.parent) {
      ancestors.push(parent);
      if (this._isTopDocument(parent)) {
        break;
      }
    }
    return ancestors;
  }

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }

  async getPartialAXTree({ nodeId, backendNodeId, objectId, fetchRelatives = true }) {
    const node = this._nodeFrom({ nodeId, backendNodeId, objectId });
    const accessible = await this._accessibleFor(node);
    if (!accessible) {
      return { nodes: [this._ignored(node)] };
    }
    const nodes = [this._describe(accessible)];
    if (fetchRelatives) {
      for (const ancestor of this._ancestors(accessible)) {
        nodes.push(this._describe(ancestor));
      }
      for (const child of this._children(accessible)) {
        nodes.push(this._describe(child));
      }
    }
    return { nodes };
  }

  async getAXNodeAndAncestors({ nodeId, backendNodeId, objectId }) {
    const node = this._nodeFrom({ nodeId, backendNodeId, objectId });
    const accessible = await this._accessibleFor(node);
    if (!accessible) {
      return { nodes: [this._ignored(node)] };
    }
    return { nodes: [accessible, ...this._ancestors(accessible)].map(each => this._describe(each)) };
  }

  getChildAXNodes({ id }) {
    const accessible = this.accessibles.get(id);
    if (!accessible) {
      throw new ProtocolError("Invalid ID");
    }
    return { nodes: this._children(accessible).map(child => this._describe(child)) };
  }

  async getRootAXNode() {
    const accessible = await this._accessibleFor(this.target.contentWindow.document);
    if (!accessible) {
      throw new ProtocolError("Document has no accessible");
    }
    return { node: this._describe(accessible) };
  }

  async getFullAXTree({ depth, frameId } = {}) {
    let document = this.target.contentWindow.document;
    if (frameId) {
      const win = this.session.domain("Runtime")._windows().find(each => frameIdOf(this.target, each.browsingContext) === frameId);
      if (!win) {
        throw new ProtocolError("Frame with the given frameId is not found.");
      }
      document = win.document;
    }
    const root = await this._accessibleFor(document);
    if (!root) {
      throw new ProtocolError("Document has no accessible");
    }
    const nodes = [];
    const visit = (accessible, level) => {
      nodes.push(this._describe(accessible));
      if (depth === undefined || level < depth) {
        for (const child of this._children(accessible)) {
          visit(child, level + 1);
        }
      }
    };
    visit(root, 1);
    return { nodes };
  }

  async queryAXTree({ nodeId, backendNodeId, objectId, accessibleName, role }) {
    const node = this._nodeFrom({ nodeId, backendNodeId, objectId });
    const root = await this._accessibleFor(node);
    const nodes = [];
    const visit = accessible => {
      if (
        (accessibleName === undefined || accessible.name === accessibleName) &&
        (role === undefined || this._role(accessible) === role)
      ) {
        nodes.push(this._describe(accessible));
      }
      for (const child of this._children(accessible)) {
        visit(child);
      }
    };
    if (root) {
      visit(root);
    }
    return { nodes };
  }
}
