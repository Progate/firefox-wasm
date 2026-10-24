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
//   - FireDog's blank page (firedog/newtab.html) in place of Firefox's
//     blanktab.html, which about:newtab and a blank homepage show,
//   - Settings trimmed to what a learner needs and opening on the search pane
//     (see patchSettings), with its categories named in Japanese (see
//     nameSettingsCategories), and the extensions page made Chrome's (see
//     patchAboutAddons),
//   - Japanese packaged next to en-US, as a multi-locale build does: the
//     Firefox Nightly language pack of the same mozilla-central day as the
//     Gecko source (LANGPACK), with FireDog's branding in place of Nightly's,
//   - the images listed in mozilla-marks.txt made empty,
//   - Firefox's DevTools front-end left out (see pruneDevtoolsClient),
//   - Firefox Home, the on-device machine learning libraries, their Remote
//     Settings dumps and the non-English hyphenation patterns left out (see
//     pruneUnusedFeatures),
//   - the startup tasks of the features FireDog leaves out taken out of the
//     component manifest (see UNUSED_STARTUP_TASKS),
//   - Chromium's DevTools front-end as devtools-frontend.zip (see
//     writeDevtoolsFrontend),
//   - firedog-cache-key, a hash of both archives. The embedding empties a
//     profile's startup caches when it differs from the key they were written
//     with (embed-init.cpp PrepareStartupCache), as XRE does on a new build:
//     a repack changes the scripts without relinking Gecko.
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

/**
 * Shows FireDog's blank page (the overlay's firedog/newtab.html) in place of
 * Firefox's empty one. Firefox loads chrome://browser/content/blanktab.html
 * for about:newtab when the new tab page is off (browser.newtabpage.enabled,
 * which firedog-chromium.js turns off) and for a blank homepage, so a
 * chrome.manifest override of that URL covers both.
 *
 * @param {string} browser the extracted browser/omni.ja
 */
const overrideBlankPage = (browser) => {
  if (!existsSync(join(browser, 'chrome/browser/content/browser/blanktab.html'))) {
    throw new Error('blanktab.html is not in this Gecko; update overrideBlankPage')
  }
  appendLines(join(browser, 'chrome/chrome.manifest'), [
    'override chrome://browser/content/blanktab.html chrome://browser/content/firedog/newtab.html',
  ])
}

/**
 * Gives Settings (about:preferences) FireDog's stylesheet (the overlay's
 * firedog/settings.css), which keeps the panes a learner checking their site
 * needs and hides those of the features FireDog leaves out. Settings stays
 * whole: leaving it out would save little (about 1.2 MB before compression)
 * and take away the search engine, fonts, cookies and permissions.
 *
 * Settings opens on the search pane. The redesigned Settings opens on
 * "Account and sync", which settings.css hides, so a learner would land on a
 * pane that is not in the sidebar.
 *
 * @param {string} browser the extracted browser/omni.ja
 */
const patchSettings = (browser) => {
  const path = join(browser, 'chrome/browser/content/browser/preferences/preferences.xhtml')
  const anchor = '<link rel="stylesheet" href="chrome://browser/content/preferences/widgets/setting-control.css" />'
  const link = '<link rel="stylesheet" href="chrome://browser/content/firedog/settings.css" />'
  const text = readFileSync(path, 'utf8')
  if (text.includes(link)) return
  if (!text.includes(anchor)) throw new Error('preferences.xhtml does not have the expected stylesheets; update patchSettings')
  writeFileSync(path, text.replace(anchor, `${anchor}\n  ${link}`))

  const script = join(browser, 'chrome/browser/content/browser/preferences/preferences.js')
  const defaults = [
    ['? "paneSync"\n    : "paneGeneral";', '? "paneSearch"\n    : "paneGeneral";'],
    ['const kDefaultCategory = redesignEnabled ? "sync" : "general";', 'const kDefaultCategory = redesignEnabled ? "search" : "general";'],
  ]
  let code = readFileSync(script, 'utf8')
  for (const [from, to] of defaults) {
    if (!code.includes(from)) throw new Error('preferences.js does not pick its first pane as expected; update patchSettings')
    code = code.replace(from, to)
  }
  writeFileSync(script, code)
}

/**
 * Settings strings the language pack leaves in English or gets wrong, in the
 * panes FireDog keeps, with the words FireDog uses: message id, attribute and
 * text, per packaged locale. tabs-group-header2 is "Tabs" in English and
 * "Tab groups" in the language pack, a feature FireDog turns off.
 */
const SETTINGS_STRINGS = {
  ja: [
    ['tabs-group-header2', 'label', 'タブ'],
    ['preferences-web-appearance-choice-light2', 'label', 'ライト'],
    ['preferences-web-appearance-choice-dark2', 'label', 'ダーク'],
    ['browser-theme-group', 'description', '{ -brand-short-name } を好みの見た目に。テーマの色は、ツールバー、メニュー、メッセージに使われます。'],
  ],
}

/**
 * Names Settings' categories in the language pack's locale, and puts
 * SETTINGS_STRINGS in place. The language pack translates the tooltip
 * (.title) of the redesigned categories but still has the English label for
 * some (pane-tabs-browsing-title2 = Tabs and browsing, .title = タブとブラウジング);
 * the label then takes the tooltip's words.
 *
 * @param {string} browser the extracted browser/omni.ja, with the language pack's strings
 * @param {string} locale the language pack's locale
 */
const nameSettingsCategories = (browser, locale) => {
  const file = 'browser/preferences/preferences.ftl'
  const english = readFileSync(join(browser, 'localization/en-US', file), 'utf8')
  const path = join(browser, 'localization', locale, file)
  let text = readFileSync(path, 'utf8').replace(
    /^(pane-[\w-]+-title2) = (.+)\n( +\.title = (.+))$/gm,
    (message, id, label, title, tooltip) =>
      english.includes(`\n${id} = ${label}\n`) ? `${id} = ${tooltip}\n${title}` : message,
  )
  for (const [id, attribute, words] of SETTINGS_STRINGS[locale] ?? []) {
    const line = new RegExp(`^(${id} =\\n(?: +\\..+\\n)*? +\\.${attribute} = ).+$`, 'm')
    if (!line.test(text)) throw new Error(`${locale} ${file} has no ${id}.${attribute}; update SETTINGS_STRINGS`)
    text = text.replace(line, `$1${words}`)
  }
  writeFileSync(path, text)
}

/**
 * Makes the extensions page (about:addons) Chrome's: titled "Extensions" in the
 * tab and the sidebar, and without what is Firefox's own there: the links to
 * Settings and to Mozilla's add-on support page, the plugins and recommendations categories,
 * addons.mozilla.org's search and its "get extensions" message, and the
 * add-on compatibility warnings. FireDog keeps extensions: they install from a
 * file or a site, as in Chrome.
 *
 * @param {string} gre the extracted omni.ja
 */
const patchAboutAddons = (gre) => {
  const stylesheet = join(gre, 'chrome/toolkit/content/mozapps/extensions/aboutaddons.css')
  if (!existsSync(stylesheet)) throw new Error('aboutaddons.css is not in this Gecko; update patchAboutAddons')
  const rule = [
    'categories-box moz-page-nav-button[slot="secondary-nav"],',
    '#category-plugin,',
    '#category-discover,',
    'addon-page-header .search-label,',
    'addon-page-header search-addons,',
    'global-warnings,',
    '#empty-addons-message {',
    '  display: none !important;',
    '}',
    '',
  ].join('\n')
  const text = readFileSync(stylesheet, 'utf8')
  if (!text.includes(rule)) writeFileSync(stylesheet, `${text.replace(/\n?$/, '\n')}\n/* FireDog (repack.mjs patchAboutAddons) */\n${rule}`)
  const titles = {'en-US': 'Extensions', ja: '拡張機能'}
  for (const [locale, title] of Object.entries(titles)) {
    const strings = join(gre, 'localization', locale, 'toolkit/about/aboutAddons.ftl')
    const before = readFileSync(strings, 'utf8')
    const sidebar = /^(aboutaddons-sidebar =\n {4}\.heading = ).*$/m
    if (!/^addons-page-title = /m.test(before) || !sidebar.test(before)) {
      throw new Error(`addons-page-title or aboutaddons-sidebar is not in ${locale}'s aboutAddons.ftl; update patchAboutAddons`)
    }
    writeFileSync(
      strings,
      before.replace(/^addons-page-title = .*$/m, `addons-page-title = ${title}`).replace(sidebar, `$1${title}`),
    )
  }
}

/**
 * Leaves out parts of Firefox that FireDog turns off, each with the pref
 * Firefox itself has for it (firedog-chromium.js), so nothing loads them:
 *
 * - Firefox Home, the newtab built-in add-on (about 4.7 MB): new tabs and the
 *   homepage show FireDog's blank page. It is also dropped from
 *   built_in_addons.json, so the add-on manager does not look for it, and
 *   gecko.patch makes about:home and Activity Stream do without it.
 * - The libraries of on-device machine learning (transformers.js, ONNX
 *   Runtime, wllama, the OpenAI client; about 4 MB), which the inference
 *   process imports when a feature runs a model. `browser.ml.enable` is off.
 * - Remote Settings dumps for those features (Translations, the AI window) and
 *   Firefox Home's wallpapers, and their entries in last_modified.json, which
 *   tells Remote Settings which dumps are packaged.
 * - Hyphenation patterns other than English (about 4.2 MB). Gecko lists the
 *   patterns it finds in the archive, so text in other languages is not
 *   hyphenated, as in a build that does not ship their dictionaries; Japanese
 *   has none.
 *
 * @param {string} browser the extracted browser/omni.ja
 * @param {string} gre the extracted omni.ja
 */
const pruneUnusedFeatures = (browser, gre) => {
  const remove = (path) => {
    if (!existsSync(path)) throw new Error(`${relative(work, path)} is not in this Gecko; update pruneUnusedFeatures`)
    rmSync(path, {recursive: true})
  }

  remove(join(browser, 'chrome/browser/builtin-addons/newtab'))
  const builtIns = join(browser, 'chrome/browser/content/browser/built_in_addons.json')
  const list = JSON.parse(readFileSync(builtIns, 'utf8'))
  list.builtins = list.builtins.filter((addon) => addon.addon_id !== 'newtab@mozilla.org')
  writeFileSync(builtIns, JSON.stringify(list))

  const ml = join(gre, 'chrome/toolkit/content/global/ml')
  for (const library of [
    'transformers.js',
    'transformers-dev.js',
    'ort.webgpu.mjs',
    'ort.webgpu-dev.mjs',
    'ort-wasm-simd-threaded.jsep.mjs',
    'wllama-module.mjs',
    'wllama-module-dev.mjs',
    'openai.mjs',
    'openai-dev.mjs',
  ]) {
    remove(join(ml, library))
  }

  const settings = join(browser, 'defaults/settings')
  const dumps = ['main/ai-window-prompts', 'main/newtab-wallpapers-v2', 'main/translations-models', 'main/translations-wasm']
  for (const dump of dumps) remove(join(settings, `${dump}.json`))
  const lastModified = JSON.parse(readFileSync(join(settings, 'last_modified.json'), 'utf8'))
  for (const dump of dumps) delete lastModified[dump]
  writeFileSync(join(settings, 'last_modified.json'), JSON.stringify(lastModified))

  const hyphenation = join(gre, 'hyphenation')
  if (!existsSync(join(hyphenation, 'hyph_en_US.hyf'))) throw new Error('hyph_en_US.hyf is not in this Gecko; update pruneUnusedFeatures')
  for (const file of readdirSync(hyphenation)) {
    if (file !== 'hyph_en_US.hyf') rmSync(join(hyphenation, file))
  }
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

/**
 * Writes Chromium's DevTools front-end (the files devtools-frontend.json
 * lists, from the revision it pins, with the license texts of its source at
 * LICENSE and third_party/<name>/LICENSE) to devtools-frontend.zip next to omni.ja,
 * where devtools/DevToolsWindow.sys.mjs reads it. It is an archive of its own,
 * not part of browser/omni.ja, so that it is fetched only when DevTools first
 * opens. Files are cached in ~/.cache/firedog and checked against the
 * manifest's SHA-256.
 *
 * @param {string} output the GRE directory being written
 */
const writeDevtoolsFrontend = async (output) => {
  if (!existsSync(join(here, 'devtools-frontend.json'))) {
    throw new Error('devtools-frontend.json is missing; run tools/devtools-frontend-manifest.mjs')
  }
  const manifest = JSON.parse(readFileSync(join(here, 'devtools-frontend.json'), 'utf8'))
  const cache = join(homedir(), '.cache/firedog/devtools-frontend', manifest.commit)
  // The bundle's files, and the license texts of the source it was built from
  // (the bundle carries none), each from its own base URL.
  const entries = [
    ...Object.entries(manifest.files).map(([path, {sha256}]) => [path, {sha256, url: manifest.base + path}]),
    ...Object.entries(manifest.licenses).map(([path, {source, sha256}]) => [path, {sha256, url: manifest.licenseBase + source}]),
  ]
  // The server drops or stalls a few of many parallel requests; each is
  // retried rather than failing or hanging the whole repack.
  const download = async (url, attempts = 5) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(url, {signal: AbortSignal.timeout(30000)})
        if (!response.ok) throw new Error(`${url}: ${response.status}`)
        return Buffer.from(await response.arrayBuffer())
      } catch (error) {
        if (attempt === attempts) throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }
  const fetchOne = async ([path, {sha256, url}]) => {
    const file = join(cache, path)
    if (!existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== sha256) {
      const bytes = await download(url)
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest !== sha256) throw new Error(`${path} has sha256 ${digest}, expected ${sha256}`)
      mkdirSync(dirname(file), {recursive: true})
      writeFileSync(file, bytes)
    }
  }
  for (let i = 0; i < entries.length; i += 32) await Promise.all(entries.slice(i, i + 32).map(fetchOne))
  const staging = join(work, 'devtools-frontend')
  for (const [path] of entries) cpSync(join(cache, path), join(staging, path))
  zip(staging, join(output, 'devtools-frontend.zip'))
}

/**
 * The startup tasks of features FireDog leaves out, as `<object>.<method>` of
 * their `category browser-*` entries in browser/omni.ja's
 * components/components.manifest (BrowserComponents.manifest in the source).
 * BrowserGlue and the window call every entry of these categories while
 * starting up, whether or not the feature is turned on, so each one imports its
 * modules and some start services: in a wasm Gecko that interprets its
 * JavaScript this was about 230 modules and seconds of the main thread in the
 * first half minute after the window appeared. Their prefs and FireDog's
 * enterprise policies already turn the features themselves off.
 */
const UNUSED_STARTUP_TASKS = [
  // Studies and rollouts (DisableFirefoxStudies), Firefox accounts, private
  // browsing (DisablePrivateBrowsing) and the prerendered Firefox Home, which
  // is not packaged.
  'Normandy.init',
  'AccountsGlue.init',
  'ResetPBMPanel.init',
  'AboutHomeStartupCache.init',
  // Enterprise data loss prevention agents, which need a native agent.
  'ContentAnalysis.initialize',
  // Machine learning features (browser.ml.enable) and the AI window.
  'LinkPreview.init',
  'GenAI.init',
  'AIWindow.init',
  'AIWindow.onFirstWindowReady',
  // Page tools FireDog's prefs turn off: Reader View, whose handler threw on
  // every location change without its button; Translations;
  // Picture-in-Picture; tab notes; and the recommendations (CFR).
  'AboutReaderParent.onLocationChange',
  'TranslationsParent.onLocationChange',
  'PictureInPicture.onLocationChange',
  'TabNotesController.browserFirstWindowReady',
  'TabNotesController.browserWindowDelayedStartup',
  'CFRPageActions.onLocationChange',
  // Feedback (DisableFeedbackCommands) and telemetry (DisableTelemetry).
  'ReportBrokenSite.init',
  'CaptchaDetectionPingUtils.init',
  'StartupTelemetry.browserIdleStartup',
  'StartupTelemetry.bestEffortIdleStartup',
  'RustLogForwarder.init',
  // Windows taskbar tabs.
  'TaskbarTabsPageAction.init',
  // Firefox Home's thumbnails and the profile switcher (browser.profiles.enabled).
  // The profiles database also failed to open: it takes a lock the profile's
  // file system cannot give.
  'PageThumbs.init',
  'ProfilesDatastoreService.init',
  'SelectableProfileService.init',
  // The DNS over HTTPS rollout (BrowserOS resolves names itself) and the VPN.
  'DoHController.init',
  'IPProtectionActivator.init',
  // Lists Firefox downloads from Remote Settings (Mozilla's services), which
  // FireDog does not reach: the add-on blocklist, CRLite and intermediates,
  // Firefox Suggest, search result categorization, content relevancy and
  // the colorway theme notice.
  'Blocklist.loadBlocklistAsync',
  'RemoteSecuritySettings.init',
  'QuickSuggest.init',
  'SERPCategorization.init',
  'ContentRelevancyManager.init',
  'ColorwayThemeMigration.maybeWarn',
  // Unloading tabs on the OS's low-memory notifications, which BrowserOS
  // does not send, and search terms kept in the address bar
  // (browser.urlbar.showSearchTerms.enabled).
  'TabUnloader.init',
  'UrlbarSearchTermsPersistence.init',
]

/**
 * Takes the startup tasks in UNUSED_STARTUP_TASKS out of browser/omni.ja's
 * component manifest.
 *
 * @param {string} browser the extracted browser/omni.ja
 */
const pruneStartupTasks = (browser) => {
  const manifest = join(browser, 'components/components.manifest')
  const lines = readFileSync(manifest, 'utf8').split('\n')
  const task = (line) => (line.startsWith('category browser-') ? line.trim().split(/\s+/).at(-1) : null)
  const unused = new Set(UNUSED_STARTUP_TASKS)
  const missing = UNUSED_STARTUP_TASKS.filter((name) => !lines.some((line) => task(line) === name))
  if (missing.length) throw new Error(`${missing.join(', ')} not in components.manifest; update UNUSED_STARTUP_TASKS`)
  writeFileSync(manifest, lines.filter((line) => !unused.has(task(line))).join('\n'))
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
  overrideBlankPage(browser)
  patchSettings(browser)
  nameSettingsCategories(browser, locale)
  patchAboutAddons(gre)
  emptyMozillaMarks(browser, 'browser/')
  pruneDevtoolsClient(browser, gre)
  pruneUnusedFeatures(browser, gre)
  pruneStartupTasks(browser)
  zip(gre, join(output, 'omni.ja'))
  zip(browser, join(output, 'browser/omni.ja'))

  const archives = createHash('sha256')
  for (const file of ['omni.ja', 'browser/omni.ja']) archives.update(readFileSync(join(output, file)))
  writeFileSync(join(output, 'firedog-cache-key'), `${archives.digest('hex')}\n`)

  await writeDevtoolsFrontend(output)
  for (const file of ['omni.ja', 'browser/omni.ja', 'firedog-cache-key', 'devtools-frontend.zip']) console.log(`wrote ${join(output, file)}`)
} finally {
  rmSync(work, {recursive: true, force: true})
}

