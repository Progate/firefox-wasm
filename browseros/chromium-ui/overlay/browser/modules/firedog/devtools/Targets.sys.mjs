/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// CDP targets: the browser itself and one "page" per tab. A page target
// follows its tab's <browser> across navigations, as a Chromium tab's target
// does; its id is 32 uppercase hex digits like Chromium's.

const ids = new WeakMap();
const byIdMap = new Map();

function newId() {
  return Services.uuid
    .generateUUID()
    .toString()
    .replace(/[{}-]/g, "")
    .toUpperCase();
}

const browserTargetId = newId().toLowerCase().replace(
  /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
  "$1-$2-$3-$4-$5"
);

function browserWindows() {
  return [...Services.wm.getEnumerator("navigator:browser")].filter(
    win => win.gBrowser
  );
}

class PageTarget {
  constructor(browser) {
    this.browser = browser;
    this.id = newId();
    this.type = "page";
  }

  get window() {
    return this.browser.ownerDocument?.defaultView ?? null;
  }

  get tab() {
    return this.window?.gBrowser?.getTabForBrowser(this.browser) ?? null;
  }

  get alive() {
    return !!this.browser.isConnected && !!this.tab;
  }

  get url() {
    return this.browser.currentURI?.spec ?? "about:blank";
  }

  get title() {
    return this.browser.contentTitle || this.url;
  }

  get contentWindow() {
    return this.browser.contentWindow;
  }

  get browsingContext() {
    return this.browser.browsingContext;
  }

  info() {
    return {
      targetId: this.id,
      type: this.type,
      title: this.title,
      url: this.url,
      attached: false,
      canAccessOpener: false,
      browserContextId: Targets.defaultBrowserContextId,
    };
  }
}

export const Targets = {
  browserTargetId,
  defaultBrowserContextId: newId(),

  pages() {
    const pages = [];
    for (const win of browserWindows()) {
      for (const tab of win.gBrowser.tabs) {
        pages.push(this.forBrowser(tab.linkedBrowser));
      }
    }
    return pages;
  },

  forBrowser(browser) {
    let target = ids.get(browser);
    if (!target) {
      target = new PageTarget(browser);
      ids.set(browser, target);
      byIdMap.set(target.id, target);
    }
    return target;
  },

  byId(id) {
    const target = byIdMap.get(id);
    return target?.alive ? target : null;
  },

  browser() {
    return {
      id: browserTargetId,
      type: "browser",
      info() {
        return {
          targetId: browserTargetId,
          type: "browser",
          title: "",
          url: "",
          attached: true,
          canAccessOpener: false,
        };
      },
    };
  },
};
