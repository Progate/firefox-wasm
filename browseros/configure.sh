#!/usr/bin/env bash
# Configure a pinned Gecko tree for BrowserOS (wasm32-browseros-linux-musl).
#
#   WASI_SDK_PATH      wasi-sdk 34 (upstream clang 23, wasm-ld, llvm-ar, libclang)
#   BROWSEROS_SYSROOT  the world's sysroot (browseros/sysroot.mjs)
#   BROWSER_LD         packages/browser-ld of Progate/packages (browser-cc)
#   BROWSEROS_RUSTC    rustc of Progate/rust with wasm32-browseros-linux-musl and
#                      its std (browseros/rust.sh)
#   GECKO_SOURCE       the pinned Gecko source directory
set -euo pipefail
: "${WASI_SDK_PATH:?set WASI_SDK_PATH}"
: "${BROWSEROS_SYSROOT:?set BROWSEROS_SYSROOT to the output of browseros/sysroot.mjs}"
: "${BROWSER_LD:?set BROWSER_LD to packages/browser-ld of Progate/packages}"
: "${BROWSEROS_RUSTC:?set BROWSEROS_RUSTC to the rustc that browseros/rust.sh built}"
: "${GECKO_SOURCE:?set GECKO_SOURCE to the pinned Gecko source directory}"
HERE=$(cd "$(dirname "$0")/.." && pwd)
export MOZCONFIG="$HERE/mozconfig.full.browseros"
export BROWSEROS_TOOLS="$HERE/browseros/bin"
export MOZBUILD_STATE_PATH="${MOZBUILD_STATE_PATH:-$GECKO_SOURCE/../mozbuild}"
export MACH_NO_TERMINAL_FOOTER=1
cd "$GECKO_SOURCE"
if patch -p1 --dry-run --forward < "$HERE/browseros/gecko.patch" >/dev/null 2>&1; then
  patch -p1 --forward < "$HERE/browseros/gecko.patch"
elif ! patch -p1 --dry-run --reverse < "$HERE/browseros/gecko.patch" >/dev/null 2>&1; then
  echo 'Gecko source does not match browseros/gecko.patch' >&2
  exit 1
fi
# Re-checksum the vendored Rust crates the patch edits.
crates=$(grep -o '^+++ b/third_party/rust/[^/]*' "$HERE/browseros/gecko.patch" | cut -d/ -f2-4 | sort -u)
if [ -n "$crates" ]; then
  python3 "$HERE/browseros/rehash-vendored.py" $crates
fi
# libc, linux-raw-sys and rustix from Progate's forks, which know BrowserOS
# (target_vendor = "browseros").
if ! grep -q 'version = "0.2.191"' third_party/rust/libc/Cargo.toml; then
  python3 "$HERE/browseros/vendor-forks.py" "$GECKO_SOURCE"
fi
# The ICU data embedded in the program is rebuilt for the locale filter that
# gecko.patch sets in intl/icu/data_filter.json (update-icu-data.py).
./mach python "$HERE/browseros/update-icu-data.py"
# FireDog's branding (name, icons, default prefs). A modified build cannot use
# Mozilla's trademarks, so it replaces the unofficial branding (Nightly).
rm -rf browser/branding/firedog
cp -R "$HERE/browseros/branding/firedog" browser/branding/firedog
./mach configure
