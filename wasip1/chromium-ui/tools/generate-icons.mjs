// SPDX-License-Identifier: MPL-2.0
// Writes the vector icons of Chromium's toolbar and tab strip as SVG files for
// chromium.css.
//
//   node wasip1/chromium-ui/tools/generate-icons.mjs <Chromium checkout>
//
// The icons are Chromium's (BSD-3-Clause); each SVG keeps its .icon's
// copyright line and the license is copied next to them. The choice of icon follows
// Chromium 158 with features::IsRoundedIconsEnabled() true: Chromium builds
// ship fieldtrial_testing_config with RoundedIcons on, and Chromium.app draws
// those icons.
import {copyFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {iconToSvg, parseIcon} from './icon-to-svg.mjs'

// Output name -> the .icon Chromium paints there. Chromium has two icon
// directories with some names in both: `vector_icons::kFooIcon` in C++ is
// components/vector_icons/foo.icon, a bare `kFooIcon` is
// chrome/app/vector_icons/foo.icon, and the two differ (account_circle's
// canvases are 24 and 20).
const COMPONENTS = 'components/vector_icons'
const APP = 'chrome/app/vector_icons'
const ICONS = {
  'back.svg': [COMPONENTS, 'arrow_back'], // BackForwardButton (back)
  'forward.svg': [COMPONENTS, 'arrow_forward'], // BackForwardButton (forward)
  'reload.svg': [COMPONENTS, 'refresh'], // ReloadButton
  'stop.svg': [APP, 'close'], // ReloadButton while loading
  'menu.svg': [APP, 'more_vert'], // BrowserAppMenuButton
  'star.svg': [APP, 'star'], // StarView, not bookmarked
  'star-filled.svg': [COMPONENTS, 'star_filled'], // StarView, bookmarked
  'info.svg': [APP, 'info'], // LocationIconView on http pages
  'tab-search.svg': [COMPONENTS, 'keyboard_arrow_down'], // TabStripComboButton
  'tab-close.svg': [APP, 'close_weight500_custom'], // TabCloseButton
  'new-tab.svg': [COMPONENTS, 'add_weight500_custom'], // HorizontalTabStripRegionView
  'globe.svg': [APP, 'globe'], // the favicon of pages without one
}

const checkout = process.argv[2]
if (!checkout) {
  console.error('usage: generate-icons.mjs <chromium checkout>')
  process.exit(1)
}
const out = join(dirname(fileURLToPath(import.meta.url)), '../overlay/browser/chrome/browser/content/browser/firedog/icons')
for (const [file, [dir, name]] of Object.entries(ICONS)) {
  const source = join(checkout, dir, `${name}.icon`)
  if (!existsSync(source)) throw new Error(`${dir}/${name}.icon not found`)
  const text = readFileSync(source, 'utf8')
  const copyright = text.match(/^\/\/ (Copyright .*)$/m)?.[1] ?? 'Copyright The Chromium Authors'
  const svg = iconToSvg(parseIcon(text))
  writeFileSync(
    join(out, file),
    `<!-- ${copyright}. Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.\n     Generated from Chromium's ${dir}/${name}.icon by generate-icons.mjs -->\n${svg}`,
  )
  console.log(file, '<-', name)
}
// The BSD license asks binary redistributions to carry the notice; it goes
// into omni.ja next to the icons.
copyFileSync(join(checkout, 'LICENSE'), join(out, 'LICENSE'))
