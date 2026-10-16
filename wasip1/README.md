# FireDog: Gecko on WASIp1 for BrowserOS

FireDog is a browser built from the Firefox source (Gecko) for
`wasm32-wasip1-threads`. It runs as a program on
[BrowserOS](https://github.com/Progate/packages/tree/main/packages/browser-os):
it uses BrowserOS's POSIX libc, opens a window on its windowserver, draws
Gecko's software-rendered frames into it and fetches pages through the OS's
sockets. It is not a Mozilla product and does not use Mozilla's trademarks; the
name and icons are its own (`branding/firedog`).

The package that installs it in BrowserOS is
[`@progate/browser-gecko`](https://github.com/Progate/packages/tree/main/packages/browser-gecko),
which pins the commit of this repository it was built from.

## Source and toolchain

- Gecko: https://github.com/HeyPuter/firefox at
  `2e1e835a5da5907e5ceef19aade58a7493f1e34d`, with `gecko.patch` applied.
- wasi-sdk 34.0, Rust 1.95.0, Ubuntu 24.04; see `Dockerfile`.
- BrowserOS libc: Progate/libc `cd20c0e67af80e7e09e817ab0610160f14c6d3d3`
  (branch `browseros-rlimit`, which adds `getrlimit`/`setrlimit`, `syslog`,
  `shm_open` and thread names), built with
  `packages/browser-libc/build.mjs` using `targets: ['wasm32-wasip1-threads']`
  and `BROWSER_LIBC_SOURCE` pointing at a checkout of that commit.

## Building

Build the toolchain image from this repository's root:

```sh
docker build -t browser-firefox-wasip1:dev -f wasip1/Dockerfile .
```

Run it with this repository mounted at `/port` and a writable build directory
at `/work`. A full build takes hours; give the container at least 6 GB of
memory plus swap and keep `-j` low (2–3), or the linker and rustc run out of
memory. Inside the container, build the BrowserOS sysroot with `buildSysroot`,
extract the pinned Gecko source to `/work/firefox`, then:

```sh
export WASI_SDK_PATH=/opt/wasi-sdk
export GECKO_SOURCE=/work/firefox
export BROWSEROS_SYSROOT=/work/libc/sysroot
export MOZCONFIG=/port/mozconfig.full.wasip1 RUSTC_BOOTSTRAP=1

bash /port/wasip1/configure.sh      # applies gecko.patch and the branding, runs mach configure
cd /work/firefox
./mach build --keep-going -j2
./mach package                      # writes the resources to dist/firefox (omni.ja, …)
bash /port/wasip1/link.sh           # writes /work/out/firedog.wasm
```

`configure.sh` applies `gecko.patch` once and accepts an already-applied patch.
It re-checksums the vendored Rust crates the patch edits; cargo treats them as
registry crates and does not rebuild them otherwise.

The program is `/work/out/firedog.wasm`. The resources it reads at run time are
`application.ini`, `platform.ini`, `omni.ja`, `browser/omni.ja` and
`defaults/pref/channel-prefs.js` from `obj-full-wasip1/dist/firefox`, installed
next to the program in `/usr/lib/firedog`.

## What is here

- `gecko.patch`: the changes to Gecko. Rust targets `wasm32-wasip1-threads`;
  NSPR, NSS, chromium base and mfbt take the wasm paths on WASI; mutexes,
  condition variables, thread locals and JS threads use pthreads under
  `_REENTRANT`; xptcall is generated per XPIDL signature (`xptcodegen.py`);
  libraries are written as wasm-ld response files and linked into one module;
  fonts come from GRE and `/usr/share/fonts`.
- `main.cpp`, `windowserver.cpp`: the program's entry point and the
  windowserver client. They open the window, present frames at the desktop's
  scale and translate pointer, keyboard, IME and clipboard events into Gecko's.
- `link.sh`: links the entry point, the gecko.js embedder and Gecko's libraries
  into `firedog.wasm`, with shared imported memory for wasi-threads.
- `branding/firedog`: names, icons and default prefs. The prefs turn off the
  services Mozilla runs for Firefox (updates, telemetry, studies, accounts,
  remote settings, Safe Browsing); `gecko.patch` replaces the bundled search
  configuration with one that has no partner codes.
- `Dockerfile`, `configure.sh`, `rehash-vendored.py`: the toolchain and the
  configure step.
