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
  `packages/browser-system-libs/build.mjs` pins as `LIBC_COMMIT` (branch
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
at `/work`. With `--enable-release`, gkrust (Gecko's Rust code) is compiled
with link-time optimization, and rustc then needs several gigabytes on its own.
With 16 cores and 50 GB for the container, `-j10` built everything in about an
hour and peaked at 12 GB; with less memory, lower `-j` so that the C++ jobs
running next to that rustc still fit. Inside the container, build the BrowserOS sysroot with `buildSysroot`,
extract the pinned Gecko source to `/work/firefox`, then:

```sh
export WASI_SDK_PATH=/opt/wasi-sdk
export GECKO_SOURCE=/work/firefox
export BROWSEROS_SYSROOT=/work/libc/sysroot
export MOZCONFIG=/port/mozconfig.full.wasip1 RUSTC_BOOTSTRAP=1

bash /port/wasip1/configure.sh      # applies gecko.patch and the branding, runs mach configure
cd /work/firefox
./mach build -j10
./mach package                      # writes the resources to dist/firefox (omni.ja, …)
bash /port/wasip1/link.sh           # writes /work/out/firedog.wasm
```

`configure.sh` applies `gecko.patch` once and accepts an already-applied patch.

Leave out `--keep-going`: the first error then stops the build. With it, a
failure in gkrust can go unnoticed while the C++ keeps compiling for hours.

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

Sound goes out through cubeb's `alsa` backend, as Firefox's does on Linux.
BrowserOS's kernel has Linux's ALSA devices (`/dev/snd/controlC0` and
`/dev/snd/pcmC0D0p`, with the ioctls of the Linux UAPI `<sound/asound.h>`)
when the host plugs in an audio output (`@progate/browser-os`'s
`BrowserOSAudioOutput`; in a page, `@progate/browser-driver`'s
`attachAudioOutput` plays it with Web Audio). The backend is linked to the
sysroot's libasound with cubeb's own `DISABLE_LIBASOUND_DLOPEN`, since WASI has
no `dlopen`; `link.sh` adds `-lasound`. That libasound is not alsa-lib, which
is LGPL and which FireDog does not link: it is a library written for BrowserOS
(`@progate/browser-system-libs`) with alsa-lib's PCM API, talking to the same
kernel interface. `configure` finds it through the sysroot's `alsa.pc`
(`mozconfig.full.wasip1` points pkg-config at the sysroot), so the sysroot must
come from a `browser-system-libs` that builds libasound and from a libc that
has `sound/asound.h` (Progate/libc's `browseros` branch).

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
learner) cannot widen them. Firefox looks there only when
`AppConstants.platform` is `"linux"`, which is `"other"` on WASI, so
gecko.patch also takes that path when `Services.appinfo.OS` is `"WASI"`
(`toolkit/components/enterprisepolicies/EnterprisePoliciesParent.sys.mjs`).
As on Linux, when that file exists Firefox reads it instead of
`distribution/policies.json`.

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
  its own window and draws Firefox's front-end whole, as before.
- `link.sh`: links the entry point, the gecko.js embedder and Gecko's libraries
  into `firedog.wasm`, with shared imported memory for wasi-threads.
- `branding/firedog`: names, icons and default prefs. The icons are Progate's
  mark (the white P on Progate's purple); the PNGs are drawn from
  `content/about-logo.svg`. The prefs turn off the services Mozilla runs for
  Firefox (updates, telemetry, studies, accounts, remote settings, Safe
  Browsing); `gecko.patch` replaces the bundled search configuration with one
  that has no partner codes.
- `std-libc.patch`: the same `wasi` values as `gecko.patch` gives Gecko's
  `libc` crate, for the `libc` crate std depends on (0.2.178 for Rust 1.95).
- `std.patch`: std (rust-src `library/`) reports the errno that its preview1
  calls (`wasi::*`) return with the Linux numbers, so that `io::Error::kind()`
  classifies every error the same way; `MetadataExt::nlink` widens the Linux
  `nlink_t`.
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

`mozconfig.full.wasip1` builds with `--enable-release` (link-time optimization
of gkrust, among Mozilla's release options) and without JPEG XL and the Web
Speech API. `gecko.patch` leaves out the Remote Settings dumps that
application-services embeds for features FireDog turns off (Translations and
its engine, the summarizer's models, the region boundaries; about 7 MB of the
program), and `chromium-ui/repack.mjs` leaves the matching resources out of
the omni.ja archives.
