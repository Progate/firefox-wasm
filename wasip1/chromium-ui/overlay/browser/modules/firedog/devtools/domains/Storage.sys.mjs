/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Storage domain: storage keys, cookies, quota usage and clearing a
// site's data, from Gecko's cookie service, QuotaManager and
// ClearDataService.
//
// Chromium names a partition of storage with a serialized StorageKey: the
// origin and a slash, followed by "^0" and the top-level site when the frame
// is third-party. Gecko partitions third-party storage by top-level site as
// well (dFPI), so the same key describes where a frame's storage lives.

import { frameIdOf } from "resource:///modules/firedog/devtools/domains/Runtime.sys.mjs";
import {
  cookieToCDP,
  setCookie,
} from "resource:///modules/firedog/devtools/domains/Network.sys.mjs";
import {
  InvalidParams,
  ProtocolError,
} from "resource:///modules/firedog/devtools/Session.sys.mjs";

function siteOf(principal) {
  let host;
  try {
    host = principal.baseDomain || principal.host;
  } catch {
    host = principal.host;
  }
  return `${principal.scheme}://${host}`;
}

// The serialized storage key of a window's document, or null for an opaque
// origin.
export function storageKeyOf(win) {
  const principal = win.document.nodePrincipal;
  if (!principal.isContentPrincipal) {
    return null;
  }
  let key = principal.originNoSuffix + "/";
  const top = win.browsingContext?.top?.window;
  if (top && top !== win) {
    const topPrincipal = top.document.nodePrincipal;
    if (topPrincipal.isContentPrincipal && siteOf(topPrincipal) !== siteOf(principal)) {
      key += "^0" + siteOf(topPrincipal);
    }
  }
  return key;
}

// The windows of a page target, the top one first.
export function windowsOf(target) {
  const windows = [];
  const visit = context => {
    if (context.window) {
      windows.push(context.window);
    }
    context.children.forEach(visit);
  };
  visit(target.browsingContext);
  return windows;
}

// A content principal for an origin ("https://example.com") or a storage key
// ("https://example.com/").
function principalOf(originOrKey) {
  let uri;
  try {
    uri = Services.io.newURI(originOrKey.split("^")[0]);
  } catch {
    throw new InvalidParams("Unable to deserialize storage key");
  }
  return Services.scriptSecurityManager.createContentPrincipal(uri, {});
}

// QuotaManager's per-client storage for Chromium's storage types; local
// storage lives outside QuotaManager when LSNG is off, so it is cleared
// through ClearDataService.
const QUOTA_CLIENTS = {
  indexeddb: "idb",
  cache_storage: "cache",
  file_systems: "fs",
};

function request(makeRequest) {
  return new Promise((resolve, reject) => {
    const req = makeRequest();
    req.callback = () => {
      if (req.resultCode === Cr.NS_OK) {
        resolve(req.result);
      } else {
        reject(new ProtocolError("Quota information is not available"));
      }
    };
  });
}

function clearData(principal, flags) {
  return new Promise(resolve => {
    Services.clearData.deleteDataFromPrincipal(principal, true, flags, resolve);
  });
}

export class Storage {
  constructor(session) {
    this.session = session;
    this.target = session.target;
  }

  _window(frameId) {
    if (!frameId) {
      return this.target.contentWindow;
    }
    const win = windowsOf(this.target).find(
      w => frameIdOf(this.target, w.browsingContext) === frameId
    );
    if (!win) {
      throw new InvalidParams("Frame tree node for given frame not found");
    }
    return win;
  }

  getStorageKey({ frameId } = {}) {
    const key = storageKeyOf(this._window(frameId));
    if (!key) {
      throw new ProtocolError(
        "Frame corresponds to an opaque origin and its storage key cannot be serialized"
      );
    }
    return { storageKey: key };
  }

  getStorageKeyForFrame({ frameId }) {
    return this.getStorageKey({ frameId });
  }

  async _clear(principal, storageTypes) {
    const types = new Set(storageTypes.split(",").map(type => type.trim()));
    const all = types.has("all");
    const known = ["cookies", "local_storage", "service_workers", ...Object.keys(QUOTA_CLIENTS)];
    if (!all && !known.some(type => types.has(type))) {
      // Types Gecko has no storage for (websql, shader_cache, interest
      // groups, shared storage, storage buckets) leave nothing to clear.
      if (![...types].some(type => type)) {
        throw new InvalidParams("No valid storage type specified");
      }
      return;
    }
    if (all) {
      await clearData(
        principal,
        Ci.nsIClearDataService.CLEAR_COOKIES |
          Ci.nsIClearDataService.CLEAR_DOM_STORAGES |
          Ci.nsIClearDataService.CLEAR_DOM_QUOTA
      );
      return;
    }
    if (types.has("cookies")) {
      await clearData(principal, Ci.nsIClearDataService.CLEAR_COOKIES);
    }
    if (types.has("local_storage")) {
      await clearData(principal, Ci.nsIClearDataService.CLEAR_DOM_STORAGES);
    }
    if (types.has("service_workers")) {
      await new Promise(resolve => {
        const swm = Cc["@mozilla.org/serviceworkers/manager;1"].getService(
          Ci.nsIServiceWorkerManager
        );
        const registrations = swm.getAllRegistrations();
        let pending = 0;
        for (let i = 0; i < registrations.length; i++) {
          const info = registrations.queryElementAt(i, Ci.nsIServiceWorkerRegistrationInfo);
          if (info.principal.origin === principal.origin) {
            pending++;
            swm.unregister(info.principal, { unregisterSucceeded: done, unregisterFailed: done }, info.scope);
          }
        }
        function done() {
          if (--pending === 0) {
            resolve();
          }
        }
        if (!pending) {
          resolve();
        }
      });
    }
    for (const [type, client] of Object.entries(QUOTA_CLIENTS)) {
      if (types.has(type)) {
        await request(() => Services.qms.clearStoragesForClient(principal, client)).catch(() => {});
      }
    }
  }

  clearDataForOrigin({ origin, storageTypes }) {
    return this._clear(principalOf(origin), storageTypes);
  }

  clearDataForStorageKey({ storageKey, storageTypes }) {
    return this._clear(principalOf(storageKey), storageTypes);
  }

  // Gecko's QuotaManager knows an origin's total usage and its limit, not
  // the share of each storage type.
  async getUsageAndQuota({ origin }) {
    const principal = principalOf(origin);
    const estimate = await request(() => Services.qms.estimate(principal));
    return {
      usage: estimate.usage,
      quota: estimate.limit,
      overrideActive: false,
      usageBreakdown: [],
    };
  }

  getCookies() {
    return { cookies: Services.cookies.cookies.map(cookieToCDP) };
  }

  setCookies({ cookies }) {
    for (const cookie of cookies) {
      setCookie(cookie);
    }
  }

  clearCookies() {
    Services.cookies.removeAll();
  }
}
