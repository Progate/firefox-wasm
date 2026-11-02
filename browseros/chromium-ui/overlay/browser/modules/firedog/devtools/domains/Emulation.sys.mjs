/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Emulation domain, through the overrides Gecko keeps on the tab's
// BrowsingContext (what Firefox's responsive design mode and WebDriver use)
// and the docShell's color matrix (Firefox's vision simulation). Overrides
// Gecko has no equivalent for are refused unless they ask for the default.
//
// Device metrics follow Blink's DeviceEmulation: the page is laid out at the
// emulated width and height and drawn `scale` times that size. The docked
// front-end places the page's <browser> at the scaled size itself
// (setInspectedPageBounds) and sends dontSetVisibleSize; other clients
// (Puppeteer's setViewport) leave the sizing to the browser, as Chrome resizes
// the view for them. Gecko lays the page out at the <browser>'s size divided
// by the full zoom, so the zoom carries the scale. `mobile` turns on the
// handling of <meta name="viewport"> Gecko otherwise keeps for responsive
// design mode (inRDMPane).

import {
  InvalidParams,
  ProtocolError,
} from "resource:///modules/firedog/devtools/Session.sys.mjs";

// Blink's vision deficiency color matrices (vision_deficiency.cc), in the
// column-major 4x5 order nsIDocShell.setColorMatrix takes.
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0];
const VISION_MATRICES = {
  none: IDENTITY,
  achromatopsia: [
    0.213, 0.213, 0.213, 0, 0.715, 0.715, 0.715, 0, 0.072, 0.072, 0.072, 0, 0, 0, 0, 1, 0, 0, 0, 0,
  ],
  deuteranopia: [
    0.367, 0.28, -0.012, 0, 0.861, 0.673, 0.043, 0, -0.228, 0.047, 0.969, 0, 0, 0, 0, 1, 0, 0, 0, 0,
  ],
  protanopia: [
    0.152, 0.115, -0.004, 0, 1.053, 0.786, -0.048, 0, -0.205, 0.099, 1.052, 0, 0, 0, 0, 1, 0, 0, 0, 0,
  ],
  tritanopia: [
    1.256, -0.078, 0.005, 0, -0.077, 0.931, 0.691, 0, -0.179, 0.148, 0.304, 0, 0, 0, 0, 1, 0, 0, 0, 0,
  ],
  // contrast(50%): halve every channel around mid-grey.
  reducedContrast: [
    0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0.25, 0.25, 0.25, 0,
  ],
};

// Media features of setEmulatedMedia and the BrowsingContext override for
// each, with the values Gecko takes.
const MEDIA_FEATURES = {
  "prefers-color-scheme": ["prefersColorSchemeOverride", { light: "light", dark: "dark", "": "none" }],
  "prefers-reduced-motion": ["prefersReducedMotionOverride", { reduce: "reduce", "no-preference": "no-preference", "": "none" }],
  "forced-colors": ["forcedColorsOverride", { active: "active", none: "none", "": "no-override" }],
};

// Chromium's limits for setDeviceMetricsOverride (EmulationHandler).
const MAX_DIMENSION = 10000000;
const MAX_SCALE = 10;

// CDP's ScreenOrientationType ("portraitPrimary") as the Web API spells it.
function orientationType(type) {
  return type.replace(/[A-Z]/, letter => `-${letter.toLowerCase()}`);
}

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "TouchSimulator", () => {
  const { require } = ChromeUtils.importESModule(
    "resource://devtools/shared/loader/Loader.sys.mjs"
  );
  return require("resource://devtools/server/actors/emulation/touch-simulator.js")
    .TouchSimulator;
});

export class Emulation {
  constructor(session) {
    this.session = session;
    this.target = session.target;
  }

  get _context() {
    return this.target.browsingContext;
  }

  _set(name, value) {
    const context = this._context;
    if (!(name in context)) {
      return false;
    }
    context[name] = value;
    return true;
  }

  canEmulate() {
    return { result: true };
  }

  // Like Chromium, each call replaces the whole emulation: the media type and
  // every feature it does not name go back to the page's own, so
  // setEmulatedMedia({}) or { features: [] } undoes an earlier call.
  setEmulatedMedia({ media = "", features = [] }) {
    const wanted = new Map();
    for (const { name, value } of features) {
      const known = MEDIA_FEATURES[name];
      if (!known) {
        if (value) {
          throw new InvalidParams(`Emulating the ${name} media feature is not supported`);
        }
        continue;
      }
      if (!(value in known[1])) {
        throw new InvalidParams(`Invalid value for ${name}: ${value}`);
      }
      if (value && !(known[0] in this._context)) {
        throw new InvalidParams(`Emulating the ${name} media feature is not supported`);
      }
      wanted.set(name, value);
    }
    this._context.mediumOverride = media;
    for (const [name, [property, values]] of Object.entries(MEDIA_FEATURES)) {
      this._set(property, values[wanted.get(name) ?? ""]);
    }
  }

  setEmulatedVisionDeficiency({ type }) {
    const matrix = VISION_MATRICES[type];
    if (!matrix) {
      // blurredVision is a blur, which a color matrix cannot do.
      throw new InvalidParams(`Emulating ${type} is not supported`);
    }
    const docShell = this._context.docShell;
    if (!docShell) {
      throw new ProtocolError("The page has no document to filter");
    }
    docShell.setColorMatrix(type === "none" ? [] : matrix);
    this.visionDeficiency = type;
  }

  setFocusEmulationEnabled({ enabled }) {
    if (enabled) {
      throw new ProtocolError("Emulating a focused page is not supported");
    }
  }

  setDeviceMetricsOverride({
    width,
    height,
    deviceScaleFactor,
    mobile,
    scale = 1,
    screenWidth = 0,
    screenHeight = 0,
    positionX = 0,
    positionY = 0,
    dontSetVisibleSize = false,
    screenOrientation,
    viewport,
    displayFeature,
    devicePosture,
  }) {
    if (
      !(width >= 0 && width <= MAX_DIMENSION) ||
      !(height >= 0 && height <= MAX_DIMENSION)
    ) {
      throw new InvalidParams(
        `Width and height values must be positive, not greater than ${MAX_DIMENSION}`
      );
    }
    if (!(screenWidth >= 0 && screenWidth <= MAX_DIMENSION) || !(screenHeight >= 0 && screenHeight <= MAX_DIMENSION)) {
      throw new InvalidParams(
        `Screen width and height values must be positive, not greater than ${MAX_DIMENSION}`
      );
    }
    if (!(deviceScaleFactor >= 0)) {
      throw new InvalidParams("deviceScaleFactor must be non-negative");
    }
    if (!(scale > 0 && scale <= MAX_SCALE)) {
      throw new InvalidParams(`scale must be positive, not greater than ${MAX_SCALE}`);
    }
    if (viewport) {
      throw new ProtocolError("Clipping the page to a viewport is not supported");
    }
    if (displayFeature || (devicePosture && devicePosture.type !== "continuous")) {
      throw new ProtocolError("Emulating a foldable device is not supported");
    }
    // The page's own offset inside its view; the docked front-end sends 0
    // and moves the <browser> instead.
    if (positionX || positionY) {
      throw new ProtocolError("Positioning the page inside its view is not supported");
    }
    const context = this._context;
    if (!this.savedMetrics) {
      const style = this.target.browser.style;
      this.savedMetrics = {
        fullZoom: context.fullZoom,
        width: style.width,
        height: style.height,
        flex: style.flex,
      };
    }
    // Without a deviceScaleFactor the page keeps the screen's, which the
    // full zoom would otherwise multiply into devicePixelRatio.
    const hostRatio = this.target.window.devicePixelRatio / (this.savedMetrics.fullZoom || 1);
    context.overrideDPPX = deviceScaleFactor || (scale === 1 ? 0 : hostRatio);
    context.fullZoom = scale;
    context.inRDMPane = !!mobile;
    if (screenWidth && screenHeight) {
      context.setScreenAreaOverride(screenWidth, screenHeight);
    } else if (scale !== 1) {
      // The full zoom would otherwise scale the real screen's size as well.
      const { screen } = this.target.window;
      context.setScreenAreaOverride(screen.width, screen.height);
    } else {
      context.resetScreenAreaOverride();
    }
    if (screenOrientation) {
      context.setOrientationOverride(
        orientationType(screenOrientation.type),
        screenOrientation.angle
      );
    } else {
      context.resetOrientationOverride();
    }
    if (!dontSetVisibleSize && width && height) {
      const style = this.target.browser.style;
      style.width = `${width * scale}px`;
      style.height = `${height * scale}px`;
      style.flex = "none";
    }
  }

  clearDeviceMetricsOverride() {
    const saved = this.savedMetrics;
    if (!saved) {
      return;
    }
    this.savedMetrics = null;
    const context = this._context;
    context.overrideDPPX = 0;
    context.fullZoom = saved.fullZoom;
    context.inRDMPane = false;
    context.resetScreenAreaOverride();
    context.resetOrientationOverride();
    const style = this.target.browser.style;
    // The docked front-end may have moved the page since; its bounds win.
    if (!this.target.browser.classList.contains("firedog-devtools-inspected")) {
      style.width = saved.width;
      style.height = saved.height;
      style.flex = saved.flex;
    }
  }

  setVisibleSize({ width, height }) {
    if (!(width > 0 && height > 0)) {
      throw new InvalidParams("Width and height must be positive");
    }
    const style = this.target.browser.style;
    style.width = `${width}px`;
    style.height = `${height}px`;
    style.flex = "none";
  }

  setPageScaleFactor({ pageScaleFactor }) {
    if (!(pageScaleFactor > 0)) {
      throw new InvalidParams("pageScaleFactor must be positive");
    }
    const window = this.target.contentWindow;
    window?.windowUtils.setResolutionAndScaleTo(pageScaleFactor);
  }

  resetPageScaleFactor() {
    this.target.contentWindow?.windowUtils.setResolutionAndScaleTo(1);
  }

  setTouchEmulationEnabled({ enabled, maxTouchPoints = 1 }) {
    if (enabled && !(maxTouchPoints >= 1 && maxTouchPoints <= 16)) {
      throw new InvalidParams("Touch points must be between 1 and 16");
    }
    const context = this._context;
    context.touchEventsOverride = enabled ? "enabled" : "none";
    context.setRDMPaneMaxTouchPoints(enabled ? maxTouchPoints : 0);
  }

  // Mouse input on the page becomes touch input, through the touch simulator
  // of Firefox's responsive design mode.
  setEmitTouchEventsForMouse({ enabled }) {
    if (enabled && !this.touchSimulator) {
      this.touchSimulator = new lazy.TouchSimulator({
        chromeEventHandler: this.target.browser,
        emit() {},
      });
    }
    if (enabled) {
      this.touchSimulator.start();
    } else {
      this.touchSimulator?.stop();
    }
  }

  setScriptExecutionDisabled({ value }) {
    this._context.allowJavascript = !value;
  }

  // userAgentMetadata feeds User-Agent Client Hints, which Gecko does not
  // send or expose (navigator.userAgentData), so it has nothing to change.
  setUserAgentOverride({ userAgent, acceptLanguage, platform }) {
    if (acceptLanguage || platform) {
      throw new InvalidParams("Only the user agent string can be overridden");
    }
    this._context.customUserAgent = userAgent;
  }

  setTimezoneOverride({ timezoneId }) {
    if (!this._set("timezoneOverride", timezoneId)) {
      throw new ProtocolError("Overriding the time zone is not supported");
    }
  }

  setCPUThrottlingRate({ rate }) {
    if (rate !== 1) {
      throw new ProtocolError("CPU throttling is not supported");
    }
  }

  setAutoDarkModeOverride({ enabled }) {
    if (enabled) {
      throw new ProtocolError("Auto dark mode is not supported");
    }
  }

  setDefaultBackgroundColorOverride({ color }) {
    if (color) {
      throw new ProtocolError("Overriding the default background color is not supported");
    }
  }

  _destroy() {
    this.touchSimulator?.stop();
    try {
      this.clearDeviceMetricsOverride();
    } catch {
      // The tab is gone.
    }
    try {
      if (this.visionDeficiency && this.visionDeficiency !== "none") {
        this._context.docShell?.setColorMatrix([]);
      }
    } catch {
      // The tab is gone.
    }
  }
}
