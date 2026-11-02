/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Runtime.RemoteObject and its preview, made from SpiderMonkey's Debugger
// objects the way V8's inspector describes values (v8-inspector's
// value-mirror.cc): the same types, subtypes, class names, descriptions and
// preview limits, since the DevTools front-end formats values from them.
//
// Reading a page object never runs the page's code: properties are read
// through Debugger.Object's own-property descriptors, and getters are left
// unevaluated, as V8 does for previews.

// v8-inspector's limits for previews (kMaxPreviewProperties and the array
// variant) and for strings inside them.
const MAX_PREVIEW_PROPERTIES = 5;
const MAX_PREVIEW_INDICES = 100;
const MAX_PREVIEW_ENTRIES = 5;
const MAX_STRING_IN_PREVIEW = 100;

const TYPED_ARRAYS = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

const ERROR_CLASSES = new Set([
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
  "InternalError",
  "DOMException",
]);

// The page's value behind a Debugger.Object, for reading what the Debugger
// API does not expose (dates, regexps, DOM nodes). Built-in getters only.
function raw(object) {
  return object.unsafeDereference();
}

function nodeOf(object) {
  try {
    const value = raw(object);
    return value && typeof value.nodeType === "number" && Cu.isDOMObject?.(value) !== false
      ? value
      : null;
  } catch {
    return null;
  }
}

export function subtypeOf(object) {
  if (object.isProxy) {
    return "proxy";
  }
  const cls = object.class;
  if (cls === "Array") {
    return "array";
  }
  if (cls === "RegExp") {
    return "regexp";
  }
  if (cls === "Date") {
    return "date";
  }
  if (cls === "Map") {
    return "map";
  }
  if (cls === "Set") {
    return "set";
  }
  if (cls === "WeakMap") {
    return "weakmap";
  }
  if (cls === "WeakSet") {
    return "weakset";
  }
  if (cls === "WeakRef") {
    return "weakref";
  }
  if (cls === "Promise") {
    return "promise";
  }
  if (cls === "Generator" || cls === "AsyncGenerator") {
    return "generator";
  }
  if (cls === "ArrayBuffer" || cls === "SharedArrayBuffer") {
    return "arraybuffer";
  }
  if (cls === "DataView") {
    return "dataview";
  }
  if (TYPED_ARRAYS.has(cls)) {
    return "typedarray";
  }
  if (object.isError || ERROR_CLASSES.has(cls)) {
    return "error";
  }
  if (nodeOf(object)) {
    return "node";
  }
  return undefined;
}

function ownLength(object) {
  const descriptor = object.getOwnPropertyDescriptor("length");
  return typeof descriptor?.value === "number" ? descriptor.value : 0;
}

// How V8 names a DOM node in descriptions: tag#id.class.class, or the node's
// name for other node types.
export function describeNode(node) {
  if (node.nodeType === 1) {
    let text = node.localName;
    if (node.id) {
      text += `#${node.id}`;
    }
    const classes = node.getAttribute?.("class");
    if (classes) {
      text += classes
        .trim()
        .split(/\s+/)
        .map(name => `.${name}`)
        .join("");
    }
    return text;
  }
  if (node.nodeType === 9) {
    return "#document";
  }
  if (node.nodeType === 10) {
    return `<!DOCTYPE ${node.name}>`;
  }
  return node.nodeName;
}

function constructorName(object) {
  // className is the constructor's name, read from the prototype chain
  // without calling the page's code.
  let proto = object;
  for (let depth = 0; proto && depth < 32; depth++) {
    const descriptor = proto.getOwnPropertyDescriptor("constructor");
    const ctor = descriptor?.value;
    if (ctor && typeof ctor === "object" && ctor.callable) {
      return ctor.name || ctor.displayName || "Object";
    }
    proto = proto.proto;
  }
  return object.class;
}

function functionDescription(object) {
  try {
    // SpiderMonkey prints a native function over three lines; V8 on one,
    // which the front-end parses (argument hints in the Console).
    return Function.prototype.toString
      .call(raw(object))
      .replace(/^(function [^(]*\([^)]*\)) \{\s*\[native code\]\s*\}$/, "$1 { [native code] }");
  } catch {
    return `function ${object.name ?? ""}() { [native code] }`;
  }
}

function errorDescription(object) {
  try {
    const value = raw(object);
    const header = `${value.name}: ${value.message}`;
    const lines = String(value.stack ?? "").split("\n").filter(Boolean);
    // Gecko continues the stack past async boundaries ("cause*fn@..."); V8's
    // error.stack ends there.
    const boundary = lines.findIndex(line => /^[^@]*\*[^@]*@/.test(line));
    const stack = (boundary === -1 ? lines : lines.slice(0, boundary))
      .map(line => {
        const [name, location] = line.split("@");
        return `    at ${name || "<anonymous>"} (${location})`;
      });
    return [header, ...stack].join("\n");
  } catch {
    return object.class;
  }
}

export function describe(object) {
  if (object.callable) {
    return functionDescription(object);
  }
  const subtype = subtypeOf(object);
  const cls = constructorName(object);
  switch (subtype) {
    case "array":
      return `Array(${ownLength(object)})`;
    case "typedarray":
      return `${cls}(${ownLength(object)})`;
    case "map":
    case "set":
      try {
        return `${cls}(${raw(object).size})`;
      } catch {
        return cls;
      }
    case "regexp":
      try {
        return RegExp.prototype.toString.call(raw(object));
      } catch {
        return cls;
      }
    case "date":
      try {
        return Date.prototype.toString.call(raw(object));
      } catch {
        return "Invalid Date";
      }
    case "error":
      return errorDescription(object);
    case "node":
      return describeNode(raw(object));
    case "proxy":
      return "Proxy(Object)";
    case "arraybuffer":
      try {
        return `${cls}(${raw(object).byteLength})`;
      } catch {
        return cls;
      }
    default:
      return cls;
  }
}

function primitive(value) {
  switch (typeof value) {
    case "undefined":
      return { type: "undefined" };
    case "boolean":
      return { type: "boolean", value };
    case "string":
      return { type: "string", value };
    case "number":
      if (Object.is(value, -0)) {
        return { type: "number", unserializableValue: "-0", description: "-0" };
      }
      if (!Number.isFinite(value)) {
        const text = String(value);
        return { type: "number", unserializableValue: text, description: text };
      }
      return { type: "number", value, description: String(value) };
    case "bigint":
      return {
        type: "bigint",
        unserializableValue: `${value}n`,
        description: `${value}n`,
      };
  }
  return null;
}

// A property value as it appears inside a preview (PropertyPreview).
function previewValue(name, value) {
  if (value === null) {
    return { name, type: "object", subtype: "null", value: "null" };
  }
  if (typeof value !== "object") {
    if (typeof value === "symbol") {
      return { name, type: "symbol", value: value.toString() };
    }
    const remote = primitive(value);
    let text = remote.description ?? String(value);
    if (typeof value === "string" && text.length > MAX_STRING_IN_PREVIEW) {
      text = `${text.slice(0, MAX_STRING_IN_PREVIEW)}…`;
    }
    return { name, type: remote.type, value: typeof value === "string" ? text : remote.unserializableValue ?? String(value) };
  }
  if (value.class === "Symbol" || value.isSymbol) {
    return { name, type: "symbol", value: String(value) };
  }
  const subtype = subtypeOf(value);
  return {
    name,
    type: value.callable ? "function" : "object",
    ...(subtype ? { subtype } : {}),
    value: value.callable ? "" : describe(value),
  };
}

export function preview(object) {
  const subtype = subtypeOf(object);
  const result = {
    type: object.callable ? "function" : "object",
    ...(subtype ? { subtype } : {}),
    description: describe(object),
    overflow: false,
    properties: [],
  };
  const isArrayLike = subtype === "array" || subtype === "typedarray";
  const limit = isArrayLike ? MAX_PREVIEW_INDICES : MAX_PREVIEW_PROPERTIES;
  let names;
  try {
    names = object.getOwnPropertyNames();
  } catch {
    names = [];
  }
  for (const name of names) {
    if (isArrayLike && name === "length") {
      continue;
    }
    const descriptor = object.getOwnPropertyDescriptor(name);
    if (!descriptor || !descriptor.enumerable) {
      continue;
    }
    if (result.properties.length >= limit) {
      result.overflow = true;
      break;
    }
    if ("get" in descriptor || "set" in descriptor) {
      result.properties.push({ name, type: "accessor" });
    } else {
      result.properties.push(previewValue(name, descriptor.value));
    }
  }
  if (subtype === "map" || subtype === "set") {
    result.entries = [];
    try {
      const value = raw(object);
      let count = 0;
      for (const entry of value.entries()) {
        if (count++ >= MAX_PREVIEW_ENTRIES) {
          result.overflow = true;
          break;
        }
        const [key, item] = entry;
        const global = object.makeDebuggeeValue ? object : null;
        const wrap = v => (global && v && typeof v === "object" ? global.makeDebuggeeValue(v) : v);
        result.entries.push(
          subtype === "map"
            ? { key: previewValue("", wrap(key)), value: previewValue("", wrap(item)) }
            : { value: previewValue("", wrap(item)) }
        );
      }
    } catch {
      // A Map from another realm whose iterator was replaced; no entries.
    }
  }
  return result;
}

// Objects handed to a client, by objectId, grouped as the client asked
// (objectGroup) so it can release them together.
export class ObjectStore {
  constructor() {
    this.byId = new Map();
    this.idOf = new Map();
    this.groups = new Map();
    this.next = 1;
    this.prefix = Math.floor(Math.random() * 2 ** 52).toString();
  }

  add(object, group) {
    let id = this.idOf.get(object);
    if (!id) {
      id = `${this.prefix}.1.${this.next++}`;
      this.byId.set(id, object);
      this.idOf.set(object, id);
    }
    if (group) {
      let ids = this.groups.get(group);
      if (!ids) {
        ids = new Set();
        this.groups.set(group, ids);
      }
      ids.add(id);
    }
    return id;
  }

  get(id) {
    return this.byId.get(id) ?? null;
  }

  release(id) {
    const object = this.byId.get(id);
    if (object !== undefined) {
      this.byId.delete(id);
      this.idOf.delete(object);
    }
  }

  releaseGroup(group) {
    for (const id of this.groups.get(group) ?? []) {
      this.release(id);
    }
    this.groups.delete(group);
  }

  clear() {
    this.byId.clear();
    this.idOf.clear();
    this.groups.clear();
  }
}

// Runtime.RemoteObject for a value from Debugger (a primitive or a
// Debugger.Object).
export function remoteObject(value, store, { group, generatePreview = false, returnByValue = false } = {}) {
  if (value === null) {
    return { type: "object", subtype: "null", value: null };
  }
  if (typeof value !== "object") {
    if (typeof value === "symbol") {
      return { type: "symbol", description: value.toString(), objectId: store.add(value, group) };
    }
    return primitive(value);
  }
  if (returnByValue) {
    try {
      return { type: value.callable ? "function" : "object", value: JSON.parse(JSON.stringify(raw(value))) ?? {} };
    } catch {
      // Not serializable (a cycle, a DOM node): fall through to a reference.
    }
  }
  const subtype = subtypeOf(value);
  const result = {
    type: value.callable ? "function" : "object",
    ...(subtype ? { subtype } : {}),
    className: value.callable ? "Function" : subtype === "node" ? ChromeUtils.getClassName(raw(value)) : constructorName(value),
    description: describe(value),
    objectId: store.add(value, group),
  };
  if (generatePreview && !value.callable) {
    result.preview = preview(value);
  }
  return result;
}
