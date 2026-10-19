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
- BrowserOS libc: the Progate/libc commit that
  `packages/browser-libc/build.mjs` pins as `LIBC_COMMIT` (branch
  `browseros-linux-syscall`), built with `buildSysroot` using
  `targets: ['wasm32-wasip1-threads']`. Its constants and structs (errno,
  `O_*`, `AT_*`, sockets, `POLL*`, `struct stat`, `struct dirent`, the
  `CLOCK_*` numbers) are the riscv32 Linux ones, and `gecko.patch` gives the
  vendored `libc` crate's `wasi` module the same values.

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

Start a build after `gecko.patch` or `mozconfig.full.wasip1` changed from a
fresh `/work/firefox` and objdir. A tree patched by an earlier version can pass
that check and then fail hours later (`arc4random` undeclared, `PRIxPTR`
format errors). Right after `configure.sh`, these two tell a current tree from
a stale one:

```sh
grep -q getrandom /work/firefox/mfbt/RandomNum.cpp           # gecko.patch is applied
grep -q -- "--sysroot=$BROWSEROS_SYSROOT" /work/obj-full-wasip1/config.status   # configured with this mozconfig
```

When only the embedder changed (`wasip1/*.cpp`, `gecko.js/src/embed-*.cpp`),
`link.sh` alone rebuilds `firedog.wasm` in a few minutes.
It re-checksums the vendored Rust crates the patch edits; cargo treats them as
registry crates and does not rebuild them otherwise. `std.patch` goes into the
image's rust-src, not into `/work`, so a new container on an existing `/work`
needs `configure.sh` again before `mach build`; otherwise cargo rebuilds std
without it and fails on `st_nlink`.

Rust's std is built from source (`-Z build-std=std,panic_abort`, set in
`config/makefiles/rust.mk` by `gecko.patch`). The prebuilt std of
`wasm32-wasip1-threads` is compiled with the WASI values of the `libc` crate and
passes them to BrowserOS's libc (open flags, `struct stat`, errno), which uses the
Linux ones. `configure.sh` therefore vendors std's own dependencies into
`third_party/rust` (`vendor-std-deps.py`, which needs network), applies
`std-libc.patch` to std's `libc` crate and applies `std.patch` to the toolchain's
rust-src. Both are applied once and accepted when already applied.

The program is `/work/out/firedog.wasm`. The resources it reads at run time are
`application.ini`, `platform.ini`, `omni.ja`, `browser/omni.ja` and
`defaults/pref/channel-prefs.js` from `obj-full-wasip1/dist/firefox`, installed
next to the program in `/usr/lib/firedog`, plus the fonts in `fonts/`. Gecko
fails in `gfxFT2FontList::FindFonts` without any font; the published GRE has
the four Liberation Sans faces that Gecko ships for pdf.js
(`toolkit/components/pdfjs/content/web/standard_fonts/LiberationSans-*.ttf`).

The program has no LGPL code. Gecko keeps its LGPL libraries in shared
libraries, liblgpllibs (SoundTouch) and ffvpx (libmozavutil, libmozavcodec), so
that they stay replaceable; FireDog is one module, so `link.sh` leaves them out
and `gecko.patch` gives WASI an `RLBoxSoundTouch` that never calls SoundTouch.
Playback-rate changes then shift the pitch. To check a build, list the
function names and look for none from SoundTouch or FFmpeg (`soundtouch::`,
`av_`, `ff_`).

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
- `std-libc.patch`: the same `wasi` values as `gecko.patch` gives Gecko's
  `libc` crate, for the `libc` crate std depends on (0.2.178 for Rust 1.95).
- `std.patch`: std (rust-src `library/`) reports the errno that its preview1
  calls (`wasi::*`) return with the Linux numbers, so that `io::Error::kind()`
  classifies every error the same way; `MetadataExt::nlink` widens the Linux
  `nlink_t`.
- `Dockerfile`, `configure.sh`, `rehash-vendored.py`: the toolchain and the
  configure step.
