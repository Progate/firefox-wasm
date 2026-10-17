# FireDog's Chromium-style window and Japanese locale

FireDog keeps Gecko and Firefox's front-end (tabs, address bar, menus,
shortcuts), and draws its window like Chromium's on macOS. It starts in
Japanese. None of this needs a Gecko rebuild: `repack.mjs` adds it to the
`omni.ja` archives that `./mach package` wrote.

```sh
node wasip1/chromium-ui/repack.mjs <dist/firefox or a gre/ directory> <out>
```

The published build's `gre/` (browser-gecko's `prebuilt/gre`) is made this way
from `./mach package`'s output.

## What is here

- `overlay/browser/` is copied into `browser/omni.ja`:
  - `chrome/browser/content/browser/firedog/chromium.css` lays out and paints
    the window. Sizes come from Chromium 158's
    `chrome/browser/ui/layout_constants.cc` and `chrome/browser/ui/tabs/tab_style.cc`;
    colors and the window's own edges (traffic lights, the light inner border)
    are measured from Chromium.app.
  - `chromium.js` adds what Firefox's markup does not have (the traffic lights,
    the profile button) and replays the first page's location change, which
    FireDog's embedder starts before the window listens for it.
  - `icons/` are Chromium's vector icons as SVG, written by
    `tools/generate-icons.mjs` from a Chromium checkout
    (`git clone --depth 1 --filter=blob:none --sparse --branch 158.0.8109.0 https://github.com/chromium/chromium.git`,
    then `git sparse-checkout set --no-cone /LICENSE components/vector_icons/ chrome/app/vector_icons/`).
    Each SVG keeps its `.icon` file's copyright line, and Chromium's `LICENSE`
    (BSD-3-Clause) is copied next to them.
  - `neterror/` is Chromium's network error page and SSL interstitial, which
    `repack.mjs` puts in place of Firefox's `aboutNetError.html` (both
    about:neterror and about:certerror load it) with a chrome.manifest
    `override`. `neterror.mjs` ports `localized_error.cc` (macOS) and the
    interstitial's scripts and maps Gecko's failures to Chromium's net errors;
    `chromium/` (stylesheets, images, en and ja strings) is written by
    `tools/generate-neterror.mjs` from the same checkout, with
    `git sparse-checkout add` of the paths listed at the top of that script.
  - `defaults/preferences/firedog-chromium.js` sets the toolbar layout, the
    address bar's trimming and the Japanese locale.
  - `localization/{en-US,ja}/browser/firedogChromium.ftl` are FireDog's own strings.
- `repack.mjs` also packages Japanese next to en-US as a multi-locale build
  does: the Firefox Nightly language pack of the mozilla-central day the Gecko
  source branched from (pinned by URL and SHA-256), with FireDog's branding in
  place of Nightly's.

- `mozilla-marks.txt` lists the images in the archives that show Mozilla's
  and Firefox's trademarks (the Firefox logo, the fox and Kit illustrations,
  other Mozilla products' logos). `repack.mjs` replaces each with an empty
  image of the same format, so no page or panel that still refers to one shows
  it; it fails if a listed file is missing, so a Gecko update that moves one is
  noticed.
- Firefox's DevTools front-end (`devtools/client`, about 15 MB) is left out:
  `repack.mjs` keeps only the client modules that the rest of the browser
  imports, and the pref `devtools.policy.disabled` keeps F12 and the menus from
  opening the missing toolbox.

## Checking it against Chromium

browser-gecko's `scripts/ui-parity.ts` runs FireDog at a reference's size and
scale and compares it with a capture of Chromium.app
(`test-fixtures/chromium-ui/`). Text is left out of the pixel count, since
Chromium.app draws it with macOS fonts that cannot ship with BrowserOS;
the position and size of each text's ink are reported instead. With the pref
`firedog.chromium.debug` set, `chromium.js` prints the rects of the window's
parts, to tell which part a difference belongs to.
