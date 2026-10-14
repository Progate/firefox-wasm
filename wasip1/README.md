# BrowserOS WASIp1 port (work in progress)

This is an unfinished source port, not a working Firefox distribution. The goal
is to build Gecko for WASI preview1 with wasi-threads, use BrowserOS's POSIX libc,
and present software-rendered frames through its windowserver. The existing
Emscripten release is not the deliverable for this port.

## Source and toolchain

- Gecko: https://github.com/HeyPuter/firefox at
  `2e1e835a5da5907e5ceef19aade58a7493f1e34d` (the Makefile's engine pin).
- Harness base: `bc69aaa5e2c5388bcf93a43b975b490bb940f4c0`.
- wasi-sdk 34.0, Rust 1.95.0, Ubuntu 24.04; see `Dockerfile`.
- BrowserOS libc: Progate/libc
  `a0401d1a4bb6498aa2d39c49e04cd38ec5bf5604`, built with
  `packages/browser-libc/build.mjs` using `targets: ['wasm32-wasip1-threads']`.

Build the toolchain image from this repository's root:

```sh
docker build -t browser-firefox-wasip1:dev -f wasip1/Dockerfile .
```

Inside the image, build the BrowserOS sysroot with `buildSysroot`, extract the
pinned Gecko source, and run:

```sh
export GECKO_SOURCE=/work/firefox
export BROWSEROS_SYSROOT=/work/libc/sysroot
bash /port/wasip1/configure.sh
```

Mount this repository at `/port`, and a writable build directory at `/work`.
`configure.sh` applies `gecko.patch` once and accepts an already-applied patch.
It intentionally does not run the full build or link the application yet.

## What exists

- Linux cross-toolchain image and a WASIp1 configure candidate.
- Initial Gecko configure patch selecting the headless toolkit and in-tree
  FreeType for WASI.
- Guards separating the embedder's WasmFS mounts from non-Emscripten builds.
- A C++ windowserver client: TCP control, surface-file writes, BGRA-to-RGBA
  conversion, and resize/close handling.
- An application entry point intended to call the real Gecko embedder and
  translate windowserver events. This entry point is not compiled or linked yet.

## Validation so far

- Docker toolchain build completed.
- BrowserOS pthread sysroot build completed.
- `windowserver.cpp` compiled with native Clang and with wasi-sdk 34 targeting
  `wasm32-wasip1-threads`, with `-Wall -Wextra -Werror`.
- The first Gecko configure attempt rejected `MOZ_AUTOMATION=1` with a source
  archive rather than a VCS checkout. That setting was removed. The next attempt
  passed the target/host compiler checks and stopped at `Cannot find llvm-objdump`.
  Next: expose the SDK binary through the configure tool override or PATH, then
  rerun configure. The SDK contains `bin/llvm-objdump`.
- No successful Gecko configure/build/link, browser launch, or windowserver
  integration test has been established. There is no Firefox wasm artifact.

## Remaining work

1. Resolve actual configure/build errors, including WASI support in NSPR/NSS,
   Rust target selection, and other platform-specific Gecko build rules.
2. Replace or disable remaining Emscripten-only APIs throughout Gecko; do not
   satisfy missing engine functionality with silent no-op imports.
3. Finish the native entry point (keyboard modifiers, pointer buttons, error
   handling, shutdown, and Firefox chrome resources) and its link recipe.
4. Verify module imports: WASI preview1, wasi-threads, and the supported BrowserOS
   POSIX extensions; no Emscripten runtime dependency.
5. Package the built engine/resources in Progate/packages/browser-firefox,
   expose `firefoxPackage()`, and test inside BrowserOS.
6. Replace browser-browser in the browser-desktop demo and verify actual launch,
   rendering, input, navigation, resizing, and process termination.

Keep this change as a draft until these checks pass. In particular, the
windowserver object's successful compilation does not validate Firefox itself.
