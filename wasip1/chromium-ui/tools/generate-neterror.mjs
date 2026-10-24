// SPDX-License-Identifier: MPL-2.0
// Writes the Chromium parts of FireDog's error pages (neterror/chromium/):
// the stylesheets of Chromium's network error page and SSL interstitial, the
// images they use, and the en and ja strings neterror.mjs asks for.
//
//   node wasip1/chromium-ui/tools/generate-neterror.mjs <Chromium checkout>
//
// The checkout needs components/neterror/resources/,
// components/security_interstitials/core/{common,browser}/resources/,
// components/resources/default_{100,200}_percent/neterror/,
// components/{components_strings.grd,components_chromium_strings.grd},
// components/{error_page,security_interstitials,ssl_errors}_strings.grdp and
// components/strings/components{,_chromium}_strings_ja.xtb.
//
// The stylesheets keep Chromium's text; only grit's <if> blocks are resolved
// for macOS and url()s point at the copied images. Strings are looked up the
// way grit does: a translation's id is a fingerprint of the English message
// with each placeholder written as its name.
import {createHash} from 'node:crypto'
import {copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {basename, dirname, join, relative, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const checkout = process.argv[2] && resolve(process.argv[2])
if (!checkout) {
  console.error('usage: generate-neterror.mjs <chromium checkout>')
  process.exit(1)
}
const page = join(dirname(fileURLToPath(import.meta.url)), '../overlay/browser/chrome/browser/content/browser/firedog/neterror')
const out = join(page, 'chromium')

/** The variables grit's <if expr> sees in a Chromium (not Google Chrome) build for macOS. */
const GRIT_DEFINES = {
  is_macosx: true,
  is_mac: true,
  is_posix: true,
  is_apple: true,
  use_titlecase: true,
  use_blink: true,
  is_android: false,
  is_ios: false,
  is_win: false,
  is_linux: false,
  is_chromeos: false,
  is_fuchsia: false,
  _google_chrome: false,
  _is_chrome_for_testing_branded: false,
}

const evaluate = (expr) =>
  Function(
    `return ${expr.replace(/\b[A-Za-z_]\w*\b/g, (word) => {
      if (word === 'not') return '!'
      if (word === 'and') return '&&'
      if (word === 'or') return '||'
      if (!(word in GRIT_DEFINES)) throw new Error(`grit <if expr="${expr}">: unknown ${word}`)
      return String(GRIT_DEFINES[word])
    })}`,
  )()

/** Keeps the parts of `text` whose <if expr="..."> blocks hold on macOS. */
const resolveIfs = (text) => {
  let result = ''
  const active = [true]
  let at = 0
  for (const match of text.matchAll(/[ \t]*(?:<if expr="([^"]*)">|<\/if>)[ \t]*\n?/g)) {
    if (active.every(Boolean)) result += text.slice(at, match.index)
    if (match[1] !== undefined) active.push(evaluate(match[1]))
    else active.pop()
    at = match.index + match[0].length
  }
  return result + text.slice(at)
}

const unescapeXml = (text) =>
  text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, entity) => {
    const named = {lt: '<', gt: '>', amp: '&', quot: '"', apos: "'"}[entity.toLowerCase()]
    if (named) return named
    return String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
  })

/** grit's FP.FingerPrint: the first 8 bytes of the MD5, as a signed 64-bit number. */
const fingerPrint = (text) => BigInt.asIntN(64, BigInt(`0x${createHash('md5').update(text, 'utf8').digest('hex').slice(0, 16)}`))

/** grit's tclib.GenerateMessageId. */
const messageId = (text, meaning) => {
  let fp = fingerPrint(text)
  if (meaning) fp = BigInt.asIntN(64, fingerPrint(meaning) + (fp << 1n) + (fp < 0n ? 1n : 0n))
  return String(fp & 0x7fffffffffffffffn)
}

/** grit strips a message's surrounding whitespace, and ''' quotes that keep it. */
const trimMessage = (text) => text.trim().replace(/^'''/, '').replace(/'''$/, '')

/**
 * The messages of a .grd/.grdp file that macOS builds have.
 *
 * @returns {Map<string, {en: string, id: string, placeholders: Map<string, string>}>}
 */
const readMessages = (file) => {
  const messages = new Map()
  const text = resolveIfs(readFileSync(join(checkout, file), 'utf8'))
  for (const [, attributes, body] of text.matchAll(/<message\b([^>]*)>([\s\S]*?)<\/message>/g)) {
    const name = attributes.match(/name="([^"]+)"/)[1]
    const meaning = attributes.match(/meaning="([^"]*)"/)?.[1]
    const placeholders = new Map()
    const ph = /<ph name="([^"]+)">([\s\S]*?)<\/ph>/g
    for (const [, phName, content] of body.matchAll(ph)) {
      placeholders.set(phName, unescapeXml(content.replace(/<ex>[\s\S]*?<\/ex>/g, '')))
    }
    const presentable = unescapeXml(trimMessage(body.replace(ph, (_, phName) => phName)))
    const en = trimMessage(body.split(ph).map((part, i) => (i % 3 === 0 ? unescapeXml(part) : i % 3 === 1 ? placeholders.get(part) : '')).join(''))
    messages.set(name, {en, id: messageId(presentable, meaning && unescapeXml(meaning)), placeholders})
  }
  return messages
}

const readTranslations = (file) =>
  new Map([...readFileSync(join(checkout, file), 'utf8').matchAll(/<translation id="(\d+)">([\s\S]*?)<\/translation>/g)].map(([, id, text]) => [id, text]))

const translate = (message, translations) => {
  const text = translations.get(message.id)
  if (text === undefined) return undefined
  return text
    .split(/<ph name="([^"]+)"\s*\/>/)
    .map((part, i) => (i % 2 === 0 ? unescapeXml(part) : message.placeholders.get(part)))
    .join('')
}

/**
 * FireDog is the product the strings name where Chromium names itself, and a
 * line break inside a message, which Chromium draws as a space, becomes one:
 * between two Japanese characters Gecko would drop it (CSS segment break
 * rules).
 */
const finish = (text) => text.replaceAll('Chromium', 'FireDog').replace(/[ \t]*\n\s*/g, ' ')

const sources = [
  {grd: 'components/components_strings.grd', parts: ['error_page_strings.grdp', 'security_interstitials_strings.grdp', 'ssl_errors_strings.grdp'], xtb: 'components/strings/components_strings_ja.xtb'},
  {grd: 'components/components_chromium_strings.grd', parts: [], xtb: 'components/strings/components_chromium_strings_ja.xtb'},
]

// The strings neterror.mjs uses. grit writes "..." in the English strings as
// an ellipsis, as Chromium.app shows them.
const wanted = [...new Set(readFileSync(join(page, 'neterror.mjs'), 'utf8').match(/\bIDS_[A-Z0-9_]+/g))].sort()
const strings = {en: {}, ja: {}}
for (const {grd, parts, xtb} of sources) {
  const files = parts.length ? parts.map((part) => join(dirname(grd), part)) : [grd]
  const translations = readTranslations(xtb)
  for (const file of files) {
    for (const [name, message] of readMessages(file)) {
      if (!wanted.includes(name)) continue
      const ja = translate(message, translations)
      if (ja === undefined) throw new Error(`${name} (${file}) has no ja translation (id ${message.id})`)
      strings.en[name] = finish(message.en.replaceAll('...', '\u2026'))
      strings.ja[name] = finish(ja)
    }
  }
}
const missing = wanted.filter((name) => !(name in strings.en))
if (missing.length) throw new Error(`not found in the checkout: ${missing.join(', ')}`)

rmSync(out, {recursive: true, force: true})
mkdirSync(join(out, 'images'), {recursive: true})
const copyright = (file) => readFileSync(join(checkout, file), 'utf8').match(/Copyright (\d+) The Chromium Authors/)?.[0] ?? 'Copyright The Chromium Authors'
writeFileSync(
  join(out, 'strings.mjs'),
  `// Copyright The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
//
// Generated by tools/generate-neterror.mjs from Chromium's
// ${sources.flatMap(({grd, parts}) => (parts.length ? parts.map((part) => join(dirname(grd), part)) : [grd])).join(', ')}
// and their ja translations; $1... and {0}... are the messages' arguments.

export const STRINGS = ${JSON.stringify(strings, null, 2)};
`,
)

const STYLESHEETS = [
  'components/security_interstitials/core/common/resources/interstitial_core.css',
  'components/security_interstitials/core/common/resources/interstitial_common.css',
  'components/neterror/resources/neterror.css',
  'components/security_interstitials/core/browser/resources/interstitial_ssl.css',
]
const images = new Map()
for (const file of STYLESHEETS) {
  if (!existsSync(join(checkout, file))) throw new Error(`${file} not found`)
  const css = resolveIfs(readFileSync(join(checkout, file), 'utf8')).replace(/url\(([^)]+)\)/g, (whole, url) => {
    const source = relative(checkout, resolve(join(checkout, dirname(file)), url))
    if (!existsSync(join(checkout, source))) {
      console.warn(`${file}: ${url} is not in the checkout; left as is`)
      return whole
    }
    // Images of the same name differ by scale; their scale directory tells them apart.
    const scale = source.split('/').find((part) => /^(default_\d+_percent|\dx)$/.test(part))
    const name = scale ? `${scale}/${basename(source)}` : basename(source)
    images.set(name, source)
    return `url(images/${name})`
  })
  writeFileSync(join(out, basename(file)), css)
  console.log(basename(file), '<-', file, `(${copyright(file)})`)
}
for (const [name, source] of images) {
  mkdirSync(dirname(join(out, 'images', name)), {recursive: true})
  copyFileSync(join(checkout, source), join(out, 'images', name))
  console.log(`images/${name} <-`, source)
}
// The BSD license asks binary redistributions to carry the notice; it goes
// into omni.ja next to the files.
copyFileSync(join(checkout, 'LICENSE'), join(out, 'LICENSE'))
console.log(`strings.mjs: ${wanted.length} messages`)
