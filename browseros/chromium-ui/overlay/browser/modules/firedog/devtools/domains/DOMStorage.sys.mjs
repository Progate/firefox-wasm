/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The DOMStorage domain: the page's localStorage and sessionStorage.
//
// A storage id names a storage key; its Storage object is that of a frame of
// the page with that key, read and written through the frame's window (an
// Xray, so page script cannot interfere). Changes are reported from Gecko's
// "dom-storage2-changed" notifications, which carry the StorageEvent of
// every change.

import {
  storageKeyOf,
  windowsOf,
} from "resource:///modules/firedog/devtools/domains/Storage.sys.mjs";
import { ProtocolError } from "resource:///modules/firedog/devtools/Session.sys.mjs";

const TOPICS = ["dom-storage2-changed", "dom-private-storage2-changed"];

export class DOMStorage {
  constructor(session) {
    this.session = session;
    this.target = session.target;
    this.enabled = false;
  }

  _keyOfStorageId(storageId) {
    if (storageId?.storageKey) {
      return storageId.storageKey;
    }
    if (storageId?.securityOrigin) {
      return storageId.securityOrigin.replace(/\/?$/, "/");
    }
    throw new ProtocolError("Storage key or security origin must be specified");
  }

  // Runs fn with the Storage of a storage id. Gecko's failures (storage
  // disabled, quota exceeded, the backend failing to open) become protocol
  // errors that name them.
  _withStorage(storageId, fn) {
    const key = this._keyOfStorageId(storageId);
    const win = windowsOf(this.target).find(w => storageKeyOf(w) === key);
    if (!win) {
      throw new ProtocolError("Frame not found for the given storage id");
    }
    try {
      return fn(storageId.isLocalStorage ? win.localStorage : win.sessionStorage);
    } catch (error) {
      const reason = error?.name || error?.message || String(error);
      throw new ProtocolError(`Storage operation failed: ${reason}`);
    }
  }

  enable() {
    if (this.enabled) {
      return;
    }
    this.enabled = true;
    for (const topic of TOPICS) {
      Services.obs.addObserver(this, topic);
    }
  }

  disable() {
    if (!this.enabled) {
      return;
    }
    this.enabled = false;
    for (const topic of TOPICS) {
      Services.obs.removeObserver(this, topic);
    }
  }

  observe(event, topic, type) {
    if (!event || !("storageArea" in event)) {
      return;
    }
    const isLocalStorage = type === "localStorage";
    let storageKey = null;
    for (const win of windowsOf(this.target)) {
      let storage;
      try {
        storage = isLocalStorage ? win.localStorage : win.sessionStorage;
      } catch {
        continue;
      }
      // localStorage is shared by every document of an origin, so a change
      // from another tab of the origin is a change of this frame's storage
      // too; sessionStorage belongs to this page alone.
      const sameOrigin = event.url && new URL(event.url).origin === win.origin;
      if (storage === event.storageArea || (isLocalStorage && sameOrigin)) {
        storageKey = storageKeyOf(win);
        break;
      }
    }
    if (!storageKey) {
      return;
    }
    const storageId = { storageKey, isLocalStorage };
    if (event.key === null) {
      this.session.emit("DOMStorage.domStorageItemsCleared", { storageId });
    } else if (event.oldValue === null) {
      this.session.emit("DOMStorage.domStorageItemAdded", {
        storageId,
        key: event.key,
        newValue: event.newValue,
      });
    } else if (event.newValue === null) {
      this.session.emit("DOMStorage.domStorageItemRemoved", { storageId, key: event.key });
    } else {
      this.session.emit("DOMStorage.domStorageItemUpdated", {
        storageId,
        key: event.key,
        oldValue: event.oldValue,
        newValue: event.newValue,
      });
    }
  }

  getDOMStorageItems({ storageId }) {
    return this._withStorage(storageId, storage => {
      const entries = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        entries.push([key, storage.getItem(key)]);
      }
      return { entries };
    });
  }

  setDOMStorageItem({ storageId, key, value }) {
    this._withStorage(storageId, storage => storage.setItem(key, value));
  }

  removeDOMStorageItem({ storageId, key }) {
    this._withStorage(storageId, storage => storage.removeItem(key));
  }

  clear({ storageId }) {
    this._withStorage(storageId, storage => storage.clear());
  }

  _destroy() {
    this.disable();
  }
}
