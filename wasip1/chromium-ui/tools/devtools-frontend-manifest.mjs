// SPDX-License-Identifier: MPL-2.0
// Lists the files of Chromium's DevTools front-end for one Chromium revision,
// with their SHA-256, into devtools-frontend.json. repack.mjs downloads the
// listed files and checks them against it.
//
//   node wasip1/chromium-ui/tools/devtools-frontend-manifest.mjs <chromium commit>
//
// Chromium publishes the built front-end of every revision at
// chrome-devtools-frontend.appspot.com/serve_rev/@<commit>/ (what Chrome
// opens for remote debugging); it is the same bundle Chromium serves at
// /devtools/ with --remote-debugging-port. The bundle has no file list, so
// this follows references from the entry points: static and dynamic imports,
// `new URL(..., import.meta.url)`, stylesheet urls and the relative paths in
// strings, the way the bundle's own module loader resolves them.
//
// The built bundle carries no license texts, so the manifest also lists the
// LICENSE files of the devtools-frontend source the bundle was built from
// (the revision Chromium's DEPS pins): DevTools' own and one per directory
// of third_party/ in the bundle, where its README.chromium names it.
// repack.mjs puts them in the archive at LICENSE and
// third_party/<name>/LICENSE.
import {createHash} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {dirname, join, posix} from 'node:path'
import {fileURLToPath} from 'node:url'

const commit = process.argv[2]
if (!/^[0-9a-f]{40}$/.test(commit ?? '')) {
  console.error('usage: devtools-frontend-manifest.mjs <chromium commit>')
  process.exit(1)
}
const base = `https://chrome-devtools-frontend.appspot.com/serve_rev/@${commit}/`
// The pages Chromium opens (devtools_app for pages, js_app/node_app for
// other targets), the script Chromium's embedder injects into them
// (devtools_compatibility.js, the InspectorFrontendHost over the embedder's
// DevToolsHost) and the locales FireDog ships.
const ENTRIES = ['devtools_compatibility.js', 'devtools_app.html', 'inspector.html', 'js_app.html', 'worker_app.html', 'core/i18n/locales/en-US.json', 'core/i18n/locales/ja.json']
const TEXT = /\.(html|js|mjs|css|json|svg)$/
const REFERENCE = /(["'`])((?:\.{1,2}\/|(?:Images|core|ui|panels|models|entrypoints|third_party|services)\/)[\w@.\/-]+\.(?:js|mjs|css|json|svg|png|avif|webp|woff2?|wasm|html))\1/g
const CSS_URL = /url\(\s*["']?([^"')]+)["']?\s*\)/g

// The server drops or stalls some of many parallel requests (a reset
// connection, a 5xx, a response that never comes). Only a 404 means the path
// names nothing; anything else is retried, or a file the bundle needs would
// be left out of the manifest.
const fetchWithRetry = async (url, attempts = 5) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {signal: AbortSignal.timeout(30000)})
      if (response.ok || response.status === 404 || attempt === attempts) {
        // The body is read here so that a stalled body is retried too.
        const body = await response.arrayBuffer()
        return new Response(response.status === 204 ? null : body, {status: response.status})
      }
    } catch (error) {
      if (attempt === attempts) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
  }
}

const files = new Map()
const queue = [...ENTRIES]
const seen = new Set(queue)
const enqueue = (from, ref) => {
  if (/^(https?:|data:|blob:|#|\/)/.test(ref)) return
  const resolved = ref.startsWith('.') ? posix.normalize(posix.join(posix.dirname(from), ref)) : posix.normalize(ref)
  if (resolved.startsWith('..') || seen.has(resolved)) return
  seen.add(resolved)
  queue.push(resolved)
}
let missing = 0
while (queue.length) {
  const batch = queue.splice(0, 48)
  if (files.size % 500 < 48) console.error(`${files.size} files, ${queue.length} queued`)
  await Promise.all(batch.map(async (path) => {
    const response = await fetchWithRetry(base + path)
    if (response.status === 404) {
      // A string that looks like a path but names nothing (an example, a
      // pattern) is skipped; real references resolve.
      missing += 1
      return
    }
    if (!response.ok) throw new Error(`${base}${path}: ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    files.set(path, {sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length})
    if (TEXT.test(path)) {
      const text = bytes.toString('utf8')
      for (const match of text.matchAll(REFERENCE)) enqueue(path, match[2])
      if (path.endsWith('.css') || path.endsWith('.js')) for (const match of text.matchAll(CSS_URL)) enqueue(path, match[1])
    }
  }))
}
const gitiles = (path, revision) => `https://chromium.googlesource.com/${path}?format=TEXT&r=${revision}`
const readGitiles = async (url) => {
  const response = await fetchWithRetry(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return Buffer.from(await response.text(), 'base64').toString('utf8')
}
const deps = await readGitiles(gitiles(`chromium/src/+/${commit}/DEPS`, commit))
const revision = deps.match(/'devtools_frontend_revision':\s*'([0-9a-f]{40})'/)?.[1]
if (!revision) throw new Error('DEPS has no devtools_frontend_revision')
const licenseBase = `https://raw.githubusercontent.com/ChromeDevTools/devtools-frontend/${revision}/`
const licenseSources = {LICENSE: 'LICENSE'}
const thirdParty = new Set([...files.keys()].filter((path) => path.startsWith('third_party/')).map((path) => path.split('/')[1]))
for (const name of [...thirdParty].sort()) {
  const readme = await readGitiles(gitiles(`devtools/devtools-frontend/+/${revision}/front_end/third_party/${name}/README.chromium`, revision))
  const file = readme.match(/^License File:\s*(\S+)/m)?.[1] ?? 'LICENSE'
  licenseSources[`third_party/${name}/LICENSE`] = `front_end/third_party/${name}/${file}`
}
const licenses = {}
for (const [path, source] of Object.entries(licenseSources)) {
  const response = await fetchWithRetry(licenseBase + source)
  if (!response.ok) throw new Error(`${licenseBase}${source}: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  licenses[path] = {source, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length}
}
const out = join(dirname(fileURLToPath(import.meta.url)), '../devtools-frontend.json')
const sorted = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)))
writeFileSync(out, `${JSON.stringify({commit, base, files: sorted, licenseBase, licenses}, null, 1)}\n`)
const total = [...files.values()].reduce((sum, file) => sum + file.size, 0)
console.log(`${files.size} files, ${(total / 1e6).toFixed(1)} MB, ${missing} unresolved strings skipped -> ${out}`)
