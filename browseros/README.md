# FireDog: Gecko for BrowserOS

FireDog is a browser built from the Firefox source (Gecko) for
`wasm32-browseros-linux-musl`, the Linux target of
[BrowserOS](https://github.com/Progate/packages/tree/main/packages/browser-os):
a position-independent wasm program that loads the world's `libc.so` (musl) and
`libc++.so`, talks to the kernel through Linux system calls, opens a window on
the windowserver, draws Gecko's software-rendered frames into it and fetches
pages through the OS's sockets. Gecko builds it as a Linux program
(`OS_TARGET=Linux`, `XP_LINUX`); the changes for the wasm CPU are in
`gecko.patch`. It is not a Mozilla product and does not use Mozilla's
trademarks; the name and icons are its own (`branding/firedog`).

The package that installs it in BrowserOS is
[`@progate/browser-gecko`](https://github.com/Progate/packages/tree/main/packages/browser-gecko),
which pins the commit of this repository it was built from.

## Source and toolchain

- Gecko: https://github.com/HeyPuter/firefox at
  `2e1e835a5da5907e5ceef19aade58a7493f1e34d`, with `gecko.patch` applied.
- C and C++: upstream clang and wasm-ld from wasi-sdk 34.0, driven by
  `browser-cc` of [`@progate/browser-ld`](https://github.com/Progate/packages/tree/main/packages/browser-ld)
  (`bin/cc`, `bin/c++`), which compiles for `wasm32-unknown-linux-musl` and
  links programs and shared libraries the way the world's C programs are.
- Rust: the `wasm32-browseros-linux-musl` target of
  [Progate/rust](https://github.com/Progate/rust), built by `rust.sh` with the
  standard library for the target. The `libc`, `linux-raw-sys` and `rustix`
  crates come from Progate's forks, which know the target
  (`target_vendor = "browseros"`); `vendor-forks.py` puts them in
  `third_party/rust`.
- The world's sysroot: the headers and libraries of
  `@progate/browser-system-libs` (musl, libasound), `@progate/browser-c` and
  `@progate/browser-cplusplus` (libc++), laid out by `sysroot.mjs`, and the
  Linux UAPI headers.
- Ubuntu 24.04 with Rust 1.95.0 on the host; see `Dockerfile`.

## Building

Build the toolchain image from this repository's root:

```sh
docker build -t browser-firedog:dev -f browseros/Dockerfile .
```

Run it with this repository mounted at `/port`, Progate/packages at
`/packages` and a writable build directory at `/work`. gkrust (Gecko's Rust
code) is compiled with link-time optimization (`--enable-release`), and rustc
then needs several gigabytes on its own; lower `-j` when the C++ jobs next to it
do not fit.

```sh
# The world's sysroot from the npm packages (npm pack, then tar -xzf into
# /work/packages/<name>), and the Linux UAPI headers on top.
node /port/browseros/sysroot.mjs /work/sysroot /work/packages
export BROWSEROS_SYSROOT=/work/sysroot
export BROWSER_LD=/packages/packages/browser-ld
export WASI_SDK_PATH=/opt/wasi-sdk
# rustc for wasm32-browseros-linux-musl (prints BROWSEROS_RUSTC).
bash /port/browseros/rust.sh
export BROWSEROS_RUSTC=/work/rust-browseros/build/host/stage1/bin/rustc
export GECKO_SOURCE=/work/firefox     # the pinned Gecko source

bash /port/browseros/configure.sh     # applies gecko.patch, the crate forks and the branding; runs mach configure
cd /work/firefox
./mach build -j10
./mach package                        # writes the resources to dist/firefox (omni.ja, …)
bash /port/browseros/link.sh          # writes /work/out/firedog
```

`configure.sh` applies `gecko.patch` once and accepts an already-applied patch.
It re-checksums the vendored Rust crates the patch edits; cargo treats them as
registry crates and does not rebuild them after an edit, so after changing one
in a built tree, remove its entries from the objdir's `.fingerprint`, `deps` and
`build` directories.

When only the embedder changed (`browseros/*.cpp`, `gecko.js/src/embed-*.cpp`),
`link.sh` alone rebuilds the program.

## What is built

The program is `/work/out/firedog`, installed in BrowserOS as
`/usr/lib/firedog/firedog-bin`. Next to it go the shared libraries Gecko keeps
out of libxul (`dist/bin/*.so`: NSPR, NSS, SQLite and the codecs), which the
program finds through its RUNPATH (`$ORIGIN`), and the
resources it reads at run time: `application.ini`, `platform.ini`, `omni.ja`,
`browser/omni.ja` and `defaults/pref/channel-prefs.js` from
`obj-full-browseros/dist/firefox`. Gecko fails in `gfxFT2FontList::FindFonts`
without any font; BrowserOS's system fonts are in `/usr/share/fonts`.

`link.sh` links libxul's inputs (`toolkit/library/build/libxul_so.list` and its
static libraries) into the program instead of loading `libxul.so`: the
embedder calls Gecko's internal C++ API, which `libxul.so` does not export.

FireDog has no LGPL code. Gecko keeps its LGPL libraries in shared libraries,
`liblgpllibs.so` (SoundTouch) and ffvpx (`libmozavutil.so`,
`libmozavcodec.so`); FireDog does not ship them. libxul reaches ffvpx only
through dlopen and plays without it. `gecko.patch` gives wasm an
`RLBoxSoundTouch` that never calls SoundTouch, and `link.sh` takes that
wrapper's object alone and leaves `liblgpllibs.so` out; playback-rate changes
then shift the pitch. To check a build, list the program's function names and
its NEEDED and look for none from SoundTouch or FFmpeg (`soundtouch::`, `av_`,
`ff_`, `liblgpllibs.so`).

Sound goes out through cubeb's `alsa` backend, as Firefox's does on Linux.
BrowserOS's kernel has Linux's ALSA devices (`/dev/snd/controlC0` and
`/dev/snd/pcmC0D0p`) when the host plugs in an audio output
(`@progate/browser-os`'s `BrowserOSAudioOutput`). The backend is linked to the
sysroot's libasound, a library written for BrowserOS
(`@progate/browser-system-libs`) with alsa-lib's PCM API; it has no sequencer,
so Web MIDI is left out (`toolkit/moz.configure`, as for riscv64).

## https://

FireDog does TLS itself, with NSS, like any Firefox. Inside BrowserOS a
connection to port 443 that leaves the BrowserOS world goes to BrowserOS's
egress proxy (`@progate/browser-egress-proxy`), which is a TLS inspection
proxy: it issues a certificate for the name from a CA made for that OS
(`/etc/ssl/certs/browseros-local-ca.pem`) and passes the request on to the
gateway. FireDog trusts that CA the way an enterprise makes Firefox trust its
inspection proxy: `@progate/browser-gecko` ships
`/usr/lib/firedog/distribution/policies.json` with `Certificates.Install`.
The gecko.js embedder starts the enterprise policies and resolves the
distribution directory as XRE does. QUIC, Alt-Svc and HTTPS DNS records are
off (branding prefs), since BrowserOS sockets carry TCP only.

Policies that the host decides at each launch (site permissions such as
`Permissions.Camera` and `Permissions.Location` for the page FireDog opens)
go to `/etc/firefox/policies/policies.json`, the system policies file that
Firefox reads on Linux. BrowserOS keeps the installation read-only, so
`distribution/policies.json` cannot be rewritten after the OS starts, and
`/etc/firefox` is owned by root, so the pages' own code (running as the
learner) cannot widen them. As on Linux, when that file exists Firefox reads it
instead of `distribution/policies.json`.

## What is here

- `gecko.patch`: the changes to Gecko. Builds for `TARGET_CPU=wasm32` on Linux
  (bindgen's target, visibility, the GN-generated directories read as
  riscv64); `RLBoxSoundTouch` without SoundTouch; xptcall through tables of C++ functions that `xptcodegen.py`
  generates per XPIDL signature (wasm's `call_indirect` checks the exact
  function type); child processes through `posix_spawn` (a wasm program cannot
  fork); the headless toolkit without GTK (gamepad, Web Serial, the UI message
  pump and WebGPU's DMA-BUF sharing take their non-GTK paths); fonts from GRE
  and `/usr/share/fonts`; and the vendored crates whose wasm32 or 32-bit musl
  paths needed a branch (`cc`, `mio`, `authenticator`, `alsa`, `zeitstempel`).
- `vendor-forks.py`: replaces the vendored `libc`, `linux-raw-sys` and
  `rustix` with Progate's forks at pinned commits.
- `rust.sh`: builds Progate/rust's rustc and the target's standard library.
- `sysroot.mjs`: lays out the world's sysroot from the npm packages.
- `bin/cc`, `bin/c++`: browser-cc with the world's sysroot.
- `main.cpp`, `windowserver.cpp`: the program's entry point and the
  windowserver client. They open the window, present frames at the desktop's
  scale and translate pointer, keyboard, IME and clipboard events into Gecko's.
  `Element.requestFullscreen()` does not resize the window on its own: the
  headless widget asks the windowserver (`set-fullscreen`, Wayland's
  `xdg_toplevel.set_fullscreen`) and enters or leaves fullscreen when the
  window manager's `configure` says so, including when the window manager
  leaves fullscreen unasked (Esc on the host page). A refused request fails
  with `fullscreenerror`. When the window manager's `wm-capabilities` leave out
  fullscreen (the viewer did not allow it), `full-screen-api.enabled` is off,
  so the page sees `document.fullscreenEnabled` false and `requestFullscreen()`
  fails at once, as under a Permissions Policy that denies fullscreen.
- Inside FireDog's window: the firedog command of `@progate/browser-gecko`
  (its `shell/`, in Rust) opens the window and draws the tabs and the toolbar
  at once, then starts this program as `/usr/lib/firedog/firedog-bin` with
  `FIREDOG_EMBED=READ,WRITE`, two pipe descriptors. The program then speaks
  the windowserver's lines over those pipes instead of `DISPLAY`'s socket: the
  window hands it a surface inside its own (a subsurface) and passes it the
  input that lands there, as a nested Wayland compositor does for its
  clients. Firefox's front-end hides its own tabs and toolbar
  (`firedog.shell.embedded`, set before `browser.xhtml` loads) and takes the
  window's commands as `firedog` lines; `chromium-ui/overlay/.../shell.js` acts
  on them and reports the tabs back. Without `FIREDOG_EMBED` the program opens
  its own window and draws Firefox's front-end whole.
- `link.sh`: links the entry point, the gecko.js embedder and Gecko into the
  program.
- `branding/firedog`: names, icons and default prefs. The icons are Progate's
  mark (the white P on Progate's purple); the PNGs are drawn from
  `content/about-logo.svg`. The prefs turn off the services Mozilla runs for
  Firefox (updates, telemetry, studies, accounts, remote settings, Safe
  Browsing); `gecko.patch` replaces the bundled search configuration with one
  that has no partner codes.
- `Dockerfile`, `configure.sh`, `rehash-vendored.py`: the toolchain and the
  configure step.
- `update-icu-data.py`: `configure.sh` rebuilds Gecko's ICU data file
  (`config/external/icu/data/icudt*.dat`, embedded in the program) the way
  `intl/update-icu.sh` does, for the locale filter `gecko.patch` adds to
  `intl/icu/data_filter.json`: English and Japanese, FireDog's UI locales.
  Mozilla's filter keeps every locale's main data, so dates and numbers are
  formatted in every locale; the other locales' display names (languages,
  regions, currencies, units, time zones; about 10 MB of the program) fall
  back to the root locale's. It builds ICU for the host once (a few minutes);
  a stamp next to the data file skips it while the filter is unchanged.

## Size

`mozconfig.full.browseros` builds with `--enable-release` (link-time
optimization of gkrust, among Mozilla's release options) and without JPEG XL
and the Web Speech API. `gecko.patch` leaves out the Remote Settings dumps that
application-services embeds for features FireDog turns off (Translations and
its engine, the summarizer's models, the region boundaries; about 7 MB of the
program), and `chromium-ui/repack.mjs` leaves the matching resources out of
the omni.ja archives.
