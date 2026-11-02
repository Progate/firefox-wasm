#!/usr/bin/env node
// Lay out the world's sysroot that FireDog is compiled and linked against: the
// headers and libraries of BrowserOS as its C and C++ toolchains ship them.
//
//   node browseros/sysroot.mjs <out> <packages>
//
// <packages> is a directory holding the unpacked npm packages (npm pack, then
// tar -xzf into <packages>/<name>):
//   browser-system-libs  wasm/usr (libc.so, libc++.so and the other shared
//                        libraries) and wasm/libc-dev.bundle (the C headers,
//                        crt objects and static libraries)
//   browser-c            dist/c-sysroot.bundle
//   browser-cplusplus    dist/cpp-sysroot.bundle (libc++'s headers)
// The bundles are PWAB1 archives: "PWAB1\n", a little-endian u32 length, a
// JSON list of {path, size}, then the files' bytes in that order.
import {cpSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'

const [out, packages] = process.argv.slice(2)
if (!out || !packages) {
  console.error('usage: node sysroot.mjs <out> <packages>')
  process.exit(1)
}

function unbundle(file) {
  const bytes = readFileSync(file)
  const magic = 'PWAB1\n'
  if (bytes.subarray(0, magic.length).toString('latin1') !== magic) {
    throw new Error(`${file}: not a PWAB1 bundle`)
  }
  const length = bytes.readUInt32LE(magic.length)
  const start = magic.length + 4
  const entries = JSON.parse(bytes.subarray(start, start + length).toString('utf8'))
  let offset = start + length
  for (const {path, size} of entries) {
    const dest = join(out, path)
    mkdirSync(dirname(dest), {recursive: true})
    writeFileSync(dest, bytes.subarray(offset, offset + size))
    offset += size
  }
  console.log(`${file}: ${entries.length} files`)
}

mkdirSync(out, {recursive: true})
const pkg = (name) => join(packages, name, 'package')
unbundle(join(pkg('browser-system-libs'), 'wasm/libc-dev.bundle'))
cpSync(join(pkg('browser-system-libs'), 'wasm/usr'), join(out, 'usr'), {recursive: true})
unbundle(join(pkg('browser-c'), 'dist/c-sysroot.bundle'))
unbundle(join(pkg('browser-cplusplus'), 'dist/cpp-sysroot.bundle'))
