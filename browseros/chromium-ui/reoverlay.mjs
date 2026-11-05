// SPDX-License-Identifier: MPL-2.0
// Puts overlay/browser/ into a gre/ that repack.mjs already wrote, for a change
// that touches only the overlay (FireDog's modules, styles, prefs):
//
//   node browseros/chromium-ui/reoverlay.mjs <gre> <out>
//
// repack.mjs cannot run twice on its own output: it prunes and empties files
// of the Gecko package and then finds them missing. This copies the overlay
// over the browser/omni.ja of <gre> and stamps the archives the way repack.mjs
// does (firedog-cache-key, the BuildID in application.ini), so the startup
// cache and the profile's caches of the old archives are not reused. Files the
// overlay removed are not removed here; run repack.mjs on the Gecko package
// for that. The startup cache seeded into gre/startupCache goes stale with
// the BuildID: seed it again before publishing (packages/browser-gecko's
// seed:startup-cache).
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [input, output] = process.argv.slice(2).map((path) => path && resolve(path))
if (!input || !output) {
  console.error('usage: node reoverlay.mjs <gre> <out>')
  process.exit(1)
}
if (!existsSync(join(input, 'browser/omni.ja'))) throw new Error(`${input} has no browser/omni.ja`)
if (input !== output) cpSync(input, output, {recursive: true})

const staging = mkdtempSync(join(tmpdir(), 'firedog-reoverlay-'))
try {
  // unzip warns about the read-ahead index at the start of omni.ja and exits 1.
  try {
    execFileSync('unzip', ['-q', '-o', join(output, 'browser/omni.ja'), '-d', staging], {stdio: ['ignore', 'ignore', 'pipe']})
  } catch (error) {
    if (error.status !== 1) throw error
  }
  cpSync(join(here, 'overlay/browser'), staging, {recursive: true})
  rmSync(join(output, 'browser/omni.ja'))
  execFileSync('zip', ['-q', '-0', '-X', '-r', join(output, 'browser/omni.ja'), '.'], {cwd: staging})
} finally {
  rmSync(staging, {recursive: true, force: true})
}

const archives = createHash('sha256')
for (const file of ['omni.ja', 'browser/omni.ja']) archives.update(readFileSync(join(output, file)))
writeFileSync(join(output, 'firedog-cache-key'), `${archives.digest('hex')}\n`)

const ini = join(output, 'application.ini')
const buildId = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
writeFileSync(ini, readFileSync(ini, 'utf8').replace(/^BuildID=.*$/m, `BuildID=${buildId}`))
for (const file of ['browser/omni.ja', 'firedog-cache-key', 'application.ini']) console.log(`wrote ${join(output, file)}`)
