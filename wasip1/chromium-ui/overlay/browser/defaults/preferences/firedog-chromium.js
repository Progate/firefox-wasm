/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// FireDog's toolbars follow Chromium's layout (chromium.css draws them):
// the tab strip holds the tab search button, the tabs and the new tab button;
// the toolbar holds back, forward, reload, the address bar and the app menu. currentVersion is CustomizableUI's kVersion so the
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
// Chromium keeps the tab strip in the window's title bar.
pref("browser.tabs.inTitlebar", 1);
// Chromium does not dim the address bar's page action icons until hovered.
pref("browser.urlbar.showSearchTerms.enabled", false);

// New tabs, new windows and Home show FireDog's blank page (firedog/newtab.html,
// which repack.mjs puts in place of blanktab.html): the new tab page is off,
// as Settings > Home > "Blank Page" or the NewTabPage policy turns it off, and
// the homepage is a blank page, which HomePage.sys.mjs maps to blanktab.html.
// Firefox Home (the newtab add-on) is not packaged (repack.mjs): its content
// comes from Mozilla's services, which FireDog turns off. A distribution that
// sets browser.startup.homepage keeps its own homepage, and FireDog still
// opens a URL it is started with.
pref("browser.newtabpage.enabled", false);
pref("browser.startup.homepage", "about:blank");
// The about:home startup cache is a prerendered Firefox Home.
pref("browser.startup.homepage.abouthome_cache.enabled", false);

// No on-device machine learning: repack.mjs leaves out the inference engine's
// libraries. browser.ml.enable is the switch for the engine (Settings > AI
// controls); the features that run models are turned off with it so that
// they are not offered: Translations (whose engine runs the same way and whose
// models come from Mozilla's services), link previews and suggested tab
// group names.
pref("browser.ml.enable", false);
pref("browser.translations.enable", false);
pref("browser.translations.select.enable", false);
pref("browser.ml.linkPreview.enabled", false);
pref("browser.tabs.groups.smart.enabled", false);

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
// Chromium's --remote-debugging-port, --remote-debugging-pipe and
// --remote-allow-origins. Closed unless a port is set or the pipe is asked for.
pref("firedog.devtools.remote-debugging-port", 0);
pref("firedog.devtools.remote-debugging-pipe", false);
pref("firedog.devtools.remote-allow-origins", "");

// Features FireDog leaves out, with the prefs Firefox itself has for them.
// FireDog runs inside a tab of a learning page as the browser a learner checks
// their site in; chromium.css hides the menu items of these features and
// chromium.js their shortcuts. @progate/browser-gecko's enterprise policies turn
// off the rest (accounts, private windows, passwords, printing, feedback).
//
// Container tabs and Firefox accounts (sync, send tab to device).
pref("privacy.userContext.enabled", false);
pref("privacy.userContext.ui.enabled", false);
pref("identity.fxaccounts.enabled", false);
// Tab groups and split view, which Chrome draws differently.
pref("browser.tabs.groups.enabled", false);
pref("browser.tabs.splitView.enabled", false);
// Reader View, Picture-in-Picture (and its toggle over every video), Pocket
// and screenshots: Firefox's own page tools.
pref("reader.parse-on-load.enabled", false);
pref("media.videocontrols.picture-in-picture.enabled", false);
pref("media.videocontrols.picture-in-picture.video-toggle.enabled", false);
pref("extensions.pocket.enabled", false);
pref("extensions.screenshots.disabled", true);
pref("screenshots.browser.component.enabled", false);
// The address bar's dropdown shows the learner's history and the search
// engine's suggestions, as Chrome's does; Firefox Suggest, its group labels,
// trending searches and the dropdown's tips are left out.
pref("browser.urlbar.quicksuggest.enabled", false);
pref("browser.urlbar.suggest.quicksuggest.sponsored", false);
pref("browser.urlbar.suggest.quicksuggest.nonsponsored", false);
pref("browser.urlbar.groupLabels.enabled", false);
pref("browser.urlbar.trending.featureGate", false);
pref("browser.urlbar.suggest.topsites", false);
pref("browser.urlbar.suggest.engines", false);
pref("browser.urlbar.quickactions.enabled", false);
pref("browser.urlbar.suggest.quickactions", false);
pref("browser.urlbar.tipShownCount.searchTip_onboard", 999);
pref("browser.urlbar.tipShownCount.searchTip_redirect", 999);
// Firefox's onboarding, what's-new and default-browser prompts, and the
// recommendations in the extensions page.
pref("browser.aboutwelcome.enabled", false);
pref("browser.shell.checkDefaultBrowser", false);
pref("browser.messaging-system.whatsNewPanel.enabled", false);
pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons", false);
pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features", false);
pref("extensions.htmlaboutaddons.recommendations.enabled", false);
pref("extensions.getAddons.showPane", false);
// Settings' "same settings, new look" notice, which only means something to
// someone who used Firefox's settings before.
pref("browser.settings-redesign.promo.dismissed", true);
// The bookmark panel's import prompt and the bookmarks toolbar's import button.
pref("browser.bookmarks.addedImportButton", false);
// Profile backups and the profile switcher, which work on the profile Firefox
// keeps on the learner's disk; FireDog's profile lives in BrowserOS. Off, they
// also skip the shared profiles database Nimbus would otherwise open at startup.
pref("browser.backup.enabled", false);
pref("browser.profiles.enabled", false);
pref("nimbus.profilesdatastoreservice.enabled", false);
// Firefox Translations: its translation models come from Remote Settings,
// which FireDog does not use, so the page translation offer could not work.
pref("browser.translations.enable", false);
// Background services that start after the window appears and that FireDog
// does not use. Each one runs in the same interpreted JavaScript as the
// window, so it competes with the page a learner opens. repack.mjs takes the
// startup tasks of the features above out of the component manifest
// (UNUSED_STARTUP_TASKS); these are the services BrowserGlue starts itself.
//
// Safe Browsing downloads Google's lists with an API key FireDog does not
// have, so its lists stay empty.
pref("browser.safebrowsing.malware.enabled", false);
pref("browser.safebrowsing.phishing.enabled", false);
pref("browser.safebrowsing.downloads.enabled", false);
pref("browser.safebrowsing.blockedURIs.enabled", false);
// Web Push connects to Mozilla's push service; pages see no PushManager, as
// in a browser without push.
pref("dom.push.enabled", false);
// DNS over HTTPS: names are resolved by BrowserOS (5 is "off by choice", so
// the rollout does not turn it on).
pref("network.trr.mode", 5);
// The hidden about:newtab browser kept ready for the next new tab. FireDog's
// new tab is a blank page.
pref("browser.newtab.preload", false);
// Records of how long each page was looked at, for Firefox's history
// recommendations.
pref("browser.places.interactions.enabled", false);
// Telemetry on pages that show a CAPTCHA.
pref("captchadetection.actor.enabled", false);
// Gecko Media Plugins (OpenH264, the Widevine CDM): native libraries Gecko
// runs in a plugin process, which a single-process wasm FireDog can neither
// load nor start. The provider lists them as add-ons for the add-on manager's
// update check, and BrowserGlue's idle startup tasks check for them on their
// own (GMPInstallManager): both ask Mozilla's update server and download them.
pref("media.gmp-provider.enabled", false);
pref("media.gmp-manager.updateEnabled", false);
// Firefox's in-product messages (ASRouter): onboarding, recommendations and
// Mozilla's campaigns, which FireDog's enterprise policies already keep from
// being shown (UserMessaging). With a provider enabled, ASRouter still loads
// its messages and evaluates their targeting after startup, which starts the
// profile backup service (off here, browser.backup.enabled) and failed on the
// documents directory BrowserOS does not have.
pref("browser.newtabpage.activity-stream.asrouter.providers.message-groups", "{\"id\":\"message-groups\",\"enabled\":false,\"type\":\"remote-settings\",\"collection\":\"message-groups\",\"updateCycleInMs\":3600000}");
pref("browser.newtabpage.activity-stream.asrouter.providers.onboarding", "{\"id\":\"onboarding\",\"type\":\"local\",\"localProvider\":\"OnboardingMessageProvider\",\"enabled\":false,\"exclude\":[]}");
pref("browser.newtabpage.activity-stream.asrouter.providers.cfr", "{\"id\":\"cfr\",\"enabled\":false,\"type\":\"remote-settings\",\"collection\":\"cfr\",\"updateCycleInMs\":3600000}");
pref("browser.newtabpage.activity-stream.asrouter.providers.messaging-experiments", "{\"id\":\"messaging-experiments\",\"enabled\":false,\"type\":\"remote-experiments\",\"updateCycleInMs\":3600000}");
