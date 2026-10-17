// SPDX-License-Identifier: MPL-2.0
// Puts FireDog's Chromium-style front-end and its Japanese locale into the
// resources `./mach package` wrote, without rebuilding Gecko.
//
//   node wasip1/chromium-ui/repack.mjs <dist/firefox> <out>
//
// <dist/firefox> is the directory with application.ini, omni.ja and
// browser/omni.ja (obj-full-wasip1/dist/firefox, or the gre/ directory of a
// published build). <out> gets the same files with:
//   - overlay/browser/ added to browser/omni.ja (stylesheet, script, icons,
//     default prefs, FireDog's own strings),
//   - browser.xhtml loading chromium.css and chromium.js,
//   - Japanese packaged next to en-US, as a multi-locale build does: the
//     Firefox Nightly language pack of the same mozilla-central day as the
//     Gecko source (LANGPACK), with FireDog's branding in place of Nightly's,
//   - the images listed in mozilla-marks.txt made empty,
//   - Firefox's DevTools front-end left out (see pruneDevtoolsClient).
// Both archives are written stored (no compression), as `./mach package`
// writes them; the published files are compressed on the wire.
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {homedir, tmpdir} from 'node:os'
import {dirname, extname, join, relative, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [input, output] = process.argv.slice(2).map((path) => path && resolve(path))
if (!input || !output) {
  console.error('usage: repack.mjs <dist/firefox> <out>')
  process.exit(1)
}

// The Gecko source (HeyPuter/firefox 2e1e835) branched from mozilla-central
// on 2026-06-12; this is that evening's Nightly language pack.
const LANGPACK = {
  locale: 'ja',
  url: 'https://ftp.mozilla.org/pub/firefox/nightly/2026/06/2026-06-12-21-16-20-mozilla-central-l10n/linux-x86_64/xpi/firefox-153.0a1.ja.langpack.xpi',
  sha256: 'ffd4143a9c9a917712f442ed941968945d0aaf0822ce1726a3b66bcbc02df7ed',
}

/** browser.xhtml gets these after its last stylesheet and after browser-main.js */
const STYLESHEET = '<link rel="stylesheet" href="chrome://browser/content/firedog/chromium.css" />'
const SCRIPT = '<script src="chrome://browser/content/firedog/chromium.js"></script>'

const patchBrowserXhtml = (path) => {
  let text = readFileSync(path, 'utf8')
  if (text.includes(STYLESHEET)) return
  const localization = text.indexOf('<link rel="localization"')
  const mainScript = '<script src="chrome://browser/content/browser-main.js"></script>'
  if (localization < 0 || !text.includes(mainScript)) {
    throw new Error('browser.xhtml does not have the expected <head>; update repack.mjs for this Gecko')
  }
  text = text.slice(0, localization) + `${STYLESHEET}\n  <link rel="localization" href="browser/firedogChromium.ftl"/>\n  ` + text.slice(localization)
  text = text.replace(mainScript, `${mainScript}\n  ${SCRIPT}`)
  writeFileSync(path, text)
}

/**
 * Shows Chromium's error pages (the overlay's firedog/neterror/) in place of
 * Firefox's: about:neterror and about:certerror both load aboutNetError.html,
 * and a chrome.manifest override redirects that URL.
 *
 * @param {string} browser the extracted browser/omni.ja
 * @param {string} gre the extracted omni.ja
 */
const overrideErrorPage = (browser, gre) => {
  if (!existsSync(join(gre, 'chrome/toolkit/content/global/aboutNetError.html'))) {
    throw new Error('aboutNetError.html is not in this Gecko; update overrideErrorPage')
  }
  appendLines(join(browser, 'chrome/chrome.manifest'), [
    'override chrome://global/content/aboutNetError.html chrome://browser/content/firedog/neterror/neterror.html',
  ])
}

/** Downloads the language pack once into ~/.cache and checks it against LANGPACK.sha256. */
const langpackFile = () => {
  const cache = join(homedir(), '.cache/firedog')
  const file = join(cache, LANGPACK.url.split('/').pop())
  if (!existsSync(file)) {
    mkdirSync(cache, {recursive: true})
    execFileSync('curl', ['-sSfL', '-o', file, LANGPACK.url])
  }
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (digest !== LANGPACK.sha256) {
    rmSync(file)
    throw new Error(`${LANGPACK.url} has sha256 ${digest}, expected ${LANGPACK.sha256}`)
  }
  return file
}

const unzip = (archive, directory) => {
  // unzip warns about the read-ahead index at the start of omni.ja ("extra
  // bytes") and exits with 1 although every file was extracted.
  try {
    execFileSync('unzip', ['-q', '-o', archive, '-d', directory], {stdio: ['ignore', 'ignore', 'pipe']})
  } catch (error) {
    if (!existsSync(join(directory, 'chrome.manifest')) && !existsSync(join(directory, 'manifest.json'))) throw error
  }
}

const zip = (directory, archive) => {
  rmSync(archive, {force: true})
  execFileSync('zip', ['-q', '-0', '-X', '-r', archive, '.'], {cwd: directory})
}

const appendLines = (path, lines) => {
  const text = readFileSync(path, 'utf8')
  const missing = lines.filter((line) => !text.split('\n').includes(line))
  if (missing.length) writeFileSync(path, `${text.replace(/\n?$/, '\n')}${missing.join('\n')}\n`)
}

/**
 * Registers the language pack's chrome locale packages the way en-US is
 * registered: `locale <package> ja <path relative to chrome/>`, with the
 * per-OS variants of global-platform.
 */
const chromeLocaleLines = (resources, prefix) => {
  const os = {macosx: 'os=Darwin', linux: 'os=LikeUnix os=Android', win: 'os=WINNT'}
  const lines = []
  for (const [name, path] of Object.entries(resources)) {
    const entries = typeof path === 'string' ? [[path, '']] : Object.entries(path).filter(([key]) => key in os).map(([key, value]) => [value, ` ${os[key]}`])
    for (const [location, flags] of entries) {
      if (!location.startsWith(prefix)) continue
      lines.push(`locale ${name} ${LANGPACK.locale} ${location.slice(prefix.length)}${flags}`)
    }
  }
  return lines
}

/** Smallest valid transparent image per format, so a replaced image still decodes. */
const EMPTY_IMAGES = {
  '.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n'),
  '.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
  '.gif': Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
  '.webp': Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64'),
}

/**
 * Empties the images in mozilla-marks.txt that live in one archive.
 *
 * @param {string} directory the extracted archive
 * @param {string} prefix the list's prefix for this archive (`gre/` or `browser/`)
 */
const emptyMozillaMarks = (directory, prefix) => {
  const listed = readFileSync(join(here, 'mozilla-marks.txt'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(prefix))
  for (const line of listed) {
    const path = join(directory, line.slice(prefix.length))
    const empty = EMPTY_IMAGES[extname(path)]
    if (!existsSync(path) || !empty) throw new Error(`mozilla-marks.txt: ${line} is not an image in this Gecko; review the list`)
    writeFileSync(path, empty)
  }
}

const filesUnder = (directory) =>
  readdirSync(directory, {withFileTypes: true, recursive: true})
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))

/**
 * Removes the parts of Firefox's DevTools front-end (devtools/client) that
 * nothing else loads. FireDog's developer tools are Chrome DevTools speaking
 * the Chrome DevTools Protocol, so the Firefox toolbox (about 15 MB) is dead
 * weight; `devtools.policy.disabled` keeps F12 and the menus from opening it.
 * The DevTools server and shared modules stay: the remote agent and the
 * protocol implementation build on them, and they load a few client modules
 * (fronts, netmonitor's request utilities, vendored libraries).
 *
 * What stays is found by following every `devtools/client/...` path mentioned
 * by a file outside the client (or by a client file already kept). A path to a
 * directory keeps the whole directory, since modules there may be loaded by
 * names built at run time.
 *
 * @param {string} browser the extracted browser/omni.ja
 * @param {string} gre the extracted omni.ja
 */
const pruneDevtoolsClient = (browser, gre) => {
  const modules = join(browser, 'chrome/devtools/modules')
  const client = join(modules, 'devtools/client')
  // Files that name client modules without loading them: the chrome
  // registrations, the license pages, DevToolsStartup (it opens the toolbox,
  // which the policy pref turns off) and the loader of the toolbox's documents.
  const ignored = (file) =>
    file.endsWith('.manifest') ||
    file.endsWith('/license.html') ||
    file === join(browser, 'modules/DevToolsStartup.sys.mjs') ||
    file === join(modules, 'devtools/shared/loader/browser-loader.sys.mjs') ||
    file.startsWith(join(browser, 'chrome/devtools/content/'))
  // The toolbox loads every panel. The server reaches it only to open it
  // (for example an add-on's toolbox), which FireDog never does.
  const toolbox = /^(?:resource:\/\/)?devtools\/client\/framework\//
  // Only quoted paths: comments name client files too (tests, READMEs).
  const reference = /(?<=["'`])(?:resource:\/\/)?devtools\/client\/[\w./-]*[\w-](?=["'`])/g
  const text = /\.(?:m?js|json|html|xhtml|css)$/
  const kept = new Set()
  const pending = []
  const keep = (file) => {
    if (kept.has(file)) return
    kept.add(file)
    if (text.test(file)) pending.push(file)
  }
  const resolveReference = (name) => {
    const base = join(modules, name.replace(/^resource:\/\//, ''))
    if (existsSync(base) && statSync(base).isDirectory()) return filesUnder(base)
    return [base, `${base}.js`, `${base}.mjs`].filter((path) => existsSync(path) && statSync(path).isFile())
  }
  const roots = [...filesUnder(browser), ...filesUnder(gre)].filter((file) => !file.startsWith(`${client}/`) && !ignored(file) && text.test(file))
  pending.push(...roots)
  while (pending.length) {
    for (const name of readFileSync(pending.pop(), 'utf8').match(reference) ?? []) {
      if (toolbox.test(name)) continue
      for (const file of resolveReference(name)) keep(file)
    }
  }
  let removed = 0
  for (const file of filesUnder(client)) {
    if (kept.has(file)) continue
    rmSync(file)
    removed += 1
  }
  // The toolbox's documents and their strings (chrome://devtools/content, the client locale).
  rmSync(join(browser, 'chrome/devtools/content'), {recursive: true, force: true})
  for (const locale of readdirSync(join(browser, 'localization'))) {
    rmSync(join(browser, 'localization', locale, 'devtools/client'), {recursive: true, force: true})
    rmSync(join(browser, 'chrome', locale, 'locale', locale, 'devtools/client'), {recursive: true, force: true})
  }
  console.log(`devtools/client: kept ${kept.size} files, removed ${removed} (${relative(browser, client)})`)
}

const work = mkdtempSync(join(tmpdir(), 'firedog-repack-'))
try {
  if (input !== output) {
    rmSync(output, {recursive: true, force: true})
    cpSync(input, output, {recursive: true})
  }
  const locale = LANGPACK.locale
  const langpack = join(work, 'langpack')
  unzip(langpackFile(), langpack)
  const resources = JSON.parse(readFileSync(join(langpack, 'manifest.json'), 'utf8')).languages[locale].chrome_resources

  // Toolkit (omni.ja): chrome packages, Fluent files and the packaged locale list.
  const gre = join(work, 'gre')
  unzip(join(output, 'omni.ja'), gre)
  cpSync(join(langpack, 'chrome', locale), join(gre, 'chrome', locale), {recursive: true})
  appendLines(join(gre, 'chrome/chrome.manifest'), chromeLocaleLines(resources, 'chrome/'))
  cpSync(join(langpack, 'localization', locale), join(gre, 'localization', locale), {recursive: true})
  const packaged = readFileSync(join(gre, 'res/multilocale.txt'), 'utf8').trim().split(',')
  if (!packaged.includes(locale)) writeFileSync(join(gre, 'res/multilocale.txt'), [...packaged, locale].join(','))
  emptyMozillaMarks(gre, 'gre/')
  zip(gre, join(output, 'omni.ja'))

  // Browser (browser/omni.ja): the same for the browser's strings, then the overlay.
  const browser = join(work, 'browser')
  unzip(join(output, 'browser/omni.ja'), browser)
  cpSync(join(langpack, 'browser/chrome'), join(browser, 'chrome'), {recursive: true})
  appendLines(join(browser, 'chrome/chrome.manifest'), chromeLocaleLines(resources, 'browser/chrome/'))
  cpSync(join(langpack, 'browser/localization', locale), join(browser, 'localization', locale), {recursive: true})
  // The language pack brands itself Firefox Nightly; FireDog's names are not translated.
  cpSync(join(browser, 'chrome/en-US/locale/branding'), join(browser, `chrome/${locale}/locale/branding`), {recursive: true})
  cpSync(join(browser, 'localization/en-US/branding'), join(browser, `localization/${locale}/branding`), {recursive: true})
  cpSync(join(here, 'overlay/browser'), browser, {recursive: true})
  patchBrowserXhtml(join(browser, 'chrome/browser/content/browser/browser.xhtml'))
  overrideErrorPage(browser, gre)
  emptyMozillaMarks(browser, 'browser/')
  pruneDevtoolsClient(browser, gre)
  zip(browser, join(output, 'browser/omni.ja'))

  for (const file of ['omni.ja', 'browser/omni.ja']) console.log(`wrote ${join(output, file)}`)
} finally {
  rmSync(work, {recursive: true, force: true})
}

