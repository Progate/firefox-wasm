/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// FireDog's toolbars follow Chromium's layout (chromium.css draws them):
// the tab strip holds the tab search button, the tabs and the new tab button;
// the toolbar holds back, forward, reload, the address bar, the profile
// button and the app menu. currentVersion is CustomizableUI's kVersion so the
// migrations for older layouts do not run over this one.
pref("browser.uiCustomization.state", "{\"placements\":{\"widget-overflow-fixed-list\":[],\"unified-extensions-area\":[],\"nav-bar\":[\"back-button\",\"forward-button\",\"stop-reload-button\",\"urlbar-container\"],\"toolbar-menubar\":[\"menubar-items\"],\"TabsToolbar\":[\"alltabs-button\",\"tabbrowser-tabs\",\"new-tab-button\"],\"vertical-tabs\":[],\"PersonalToolbar\":[\"personal-bookmarks\"]},\"seen\":[\"save-to-pocket-button\",\"developer-button\",\"sidebar-button\",\"firefox-view-button\"],\"dirtyAreaCache\":[\"nav-bar\",\"TabsToolbar\",\"toolbar-menubar\",\"PersonalToolbar\",\"vertical-tabs\"],\"currentVersion\":24,\"newElementCount\":0}");
pref("browser.proton.toolbar.version", 3);
pref("browser.toolbars.bookmarks.visibility", "never");
pref("sidebar.revamp", false);
pref("sidebar.verticalTabs", false);
pref("browser.tabs.firefox-view", false);
pref("browser.tabs.tabmanager.enabled", true);
// Chromium hides http:// as well as https:// in the address bar. The
// "Scotch Bonnet" override forces Firefox's newer behavior of showing http://,
// so it is off; the one part of it Chromium has an equivalent for (no one-off
// search buttons in the dropdown) is kept on its own.
pref("browser.urlbar.scotchBonnet.enableOverride", false);
pref("browser.urlbar.scotchBonnet.disableOneOffs", true);
pref("browser.urlbar.trimHttps", false);
pref("browser.urlbar.trimURLs", true);
// Chromium keeps the tab strip in the window's title bar, with the window's
// traffic lights at its start (chromium.js draws them).
pref("browser.tabs.inTitlebar", 1);
// Chromium does not dim the address bar's page action icons until hovered.
pref("browser.urlbar.showSearchTerms.enabled", false);

// New tabs, new windows and Home show FireDog's blank page (firedog/newtab.html,
// which repack.mjs puts in place of blanktab.html): the new tab page is off,
// as Settings > Home > "Blank Page" or the NewTabPage policy turns it off, and
// the homepage is a blank page, which HomePage.sys.mjs maps to blanktab.html.
// Firefox Home (the newtab add-on) draws an empty page in FireDog: its
// content comes from Mozilla's services, which FireDog turns off. A
// distribution that sets browser.startup.homepage keeps its own homepage, and
// FireDog still opens a URL it is started with.
pref("browser.newtabpage.enabled", false);
pref("browser.startup.homepage", "about:blank");

// No AI chatbot. FireDog follows Chrome, whose menus have no "Ask an AI
// chatbot" item, and the chatbot opens third-party sites in a sidebar that
// FireDog's Chrome-like window does not show. These are the prefs Firefox's
// own AI controls (the AIControls / GenerativeAI policies, Settings) turn off:
// the chatbot itself and its page feature, which drives the page and tab
// context menu item even without a provider; the context menu item; and the
// shortcuts shown over selected text.
pref("browser.ml.chat.enabled", false);
pref("browser.ml.chat.page", false);
pref("browser.ml.chat.menu", false);
pref("browser.ml.chat.shortcuts", false);

// Japanese by default: the window, menus, error pages and the languages pages
// are asked for (Accept-Language, navigator.languages) are those of a
// Japanese Chromium. repack.mjs packages the Japanese strings.
pref("intl.locale.requested", "ja");
pref("intl.accept_languages", "ja, en-US, en");

// Firefox's DevTools front-end is not packaged (repack.mjs); FireDog's
// developer tools are Chrome DevTools. Without this F12 and the menus would try
// to open the missing toolbox.
pref("devtools.policy.disabled", true);
// Chromium shows JSON responses as text. Firefox's JSON viewer is part of the
// DevTools front-end.
pref("devtools.jsonview.enabled", false);

// The Chrome DevTools Protocol endpoint (devtools/RemoteDebugging.sys.mjs),
// Chromium's --remote-debugging-port and --remote-allow-origins. Closed unless
// a port is set.
pref("firedog.devtools.remote-debugging-port", 0);
pref("firedog.devtools.remote-allow-origins", "");
