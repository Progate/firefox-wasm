// SPDX-License-Identifier: MPL-2.0
// Fixes to Chromium's DevTools front-end for Gecko's layout, applied to the
// files repack.mjs (and reoverlay.mjs) put into devtools-frontend.zip.
//
// The front-end is Chromium's own build, pinned by devtools-frontend.json, and
// it lays itself out for Blink. Where Gecko lays the same CSS out differently
// and the difference shows in a panel, the fix goes here as CSS added next to
// an anchor in the bundled file, so that a front-end update whose file no
// longer has the anchor fails the repack instead of silently dropping the fix.
import {readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

/**
 * One fix: `add` is written right after `anchor` in `file`.
 *
 * DataGrid (the tables of Application > Storage, Network's request list and
 * others) puts its header in a sticky <thead> and, above the rows, a filler
 * row whose height is the scrolled-out rows' (0px when nothing is scrolled
 * out). With fewer rows than fit, Blink gives the table's spare height to the
 * bottom filler alone; Gecko does not count the sticky <thead> in the table's
 * height and shares the spare height between both fillers, so the top filler
 * grows, shows its hidden header labels as a second header in the middle, and
 * pushes the rows to the bottom of the panel (learners saw an empty local
 * storage table). Giving the top filler the header's height (21px, the
 * <thead>'s) while it is 0px keeps it under the header and leaves the spare
 * height to the bottom filler, as in Blink; once rows are scrolled out the
 * filler's own height applies again.
 */
export const DEVTOOLS_FRONTEND_PATCHES = [
  {
    file: 'ui/legacy/components/data_grid/data_grid.js',
    anchor: '.data-grid .top-filler-td,\n.data-grid .bottom-filler-td{height:auto!important;padding:0!important}',
    add: '.data-grid tr.data-grid-filler-row[style*="height: 0px"] > .top-filler-td{height:21px!important}',
  },
]

/**
 * Applies DEVTOOLS_FRONTEND_PATCHES to a directory holding the front-end's
 * files. A file that already has a fix is left as it is, so this can run on an
 * archive it patched before (reoverlay.mjs).
 *
 * @param {string} directory the front-end's root (where devtools_app.html is)
 * @returns {string[]} the files it changed
 */
export const patchDevtoolsFrontend = (directory) => {
  const changed = []
  for (const {file, anchor, add} of DEVTOOLS_FRONTEND_PATCHES) {
    const path = join(directory, file)
    const text = readFileSync(path, 'utf8')
    if (text.includes(anchor + add)) continue
    if (!text.includes(anchor)) {
      throw new Error(`${file} does not have the CSS devtools-frontend-patches.mjs adds to; check the fix against the new front-end`)
    }
    writeFileSync(path, text.replace(anchor, anchor + add))
    changed.push(file)
  }
  return changed
}
