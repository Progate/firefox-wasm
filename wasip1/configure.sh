#!/usr/bin/env bash
# Configure a pinned Gecko tree with the BrowserOS WASIp1 pthread sysroot.
set -euo pipefail
: "${WASI_SDK_PATH:?set WASI_SDK_PATH}"
: "${BROWSEROS_SYSROOT:?set BROWSEROS_SYSROOT to browser-libc buildSysroot output}"
: "${GECKO_SOURCE:?set GECKO_SOURCE to the pinned Gecko source directory}"
HERE=$(cd "$(dirname "$0")/.." && pwd)
export MOZCONFIG="$HERE/mozconfig.full.wasip1"
export MOZBUILD_STATE_PATH="${MOZBUILD_STATE_PATH:-$GECKO_SOURCE/../mozbuild}"
export MACH_NO_TERMINAL_FOOTER=1
export RUSTC_BOOTSTRAP=1
cd "$GECKO_SOURCE"
if patch -p1 --dry-run --forward < "$HERE/wasip1/gecko.patch" >/dev/null 2>&1; then
  patch -p1 --forward < "$HERE/wasip1/gecko.patch"
elif ! patch -p1 --dry-run --reverse < "$HERE/wasip1/gecko.patch" >/dev/null 2>&1; then
  echo 'Gecko source does not match the WASIp1 patch' >&2
  exit 1
fi
# Re-checksum the vendored Rust crates the patch edits.
crates=$(grep -o '^+++ b/third_party/rust/[^/]*' "$HERE/wasip1/gecko.patch" | cut -d/ -f2-4 | sort -u)
if [ -n "$crates" ]; then
  python3 "$HERE/wasip1/rehash-vendored.py" $crates
fi
# The ICU data embedded in the program is rebuilt for the locale filter that
# gecko.patch sets in intl/icu/data_filter.json (update-icu-data.py).
./mach python "$HERE/wasip1/update-icu-data.py"
# Rust std is built from source (-Z build-std, config/makefiles/rust.mk) so that
# it uses BrowserOS's libc values. Vendor std's own dependencies, give std's libc
# crate the same values as Gecko's (std-libc.patch) and make std report the
# preview1 calls' errno with the Linux numbers (std.patch, applied to rust-src).
apply_once() { # <directory> <patch>
  if patch -d "$1" -p1 --dry-run --forward < "$2" >/dev/null 2>&1; then
    patch -d "$1" -p1 --forward < "$2"
  elif ! patch -d "$1" -p1 --dry-run --reverse < "$2" >/dev/null 2>&1; then
    echo "$1 does not match $2" >&2
    exit 1
  fi
}
GECKO_SOURCE="$GECKO_SOURCE" python3 "$HERE/vendor-std-deps.py"
apply_once "$GECKO_SOURCE" "$HERE/wasip1/std-libc.patch"
python3 "$HERE/wasip1/rehash-vendored.py" $(grep -o '^+++ b/third_party/rust/[^/]*' "$HERE/wasip1/std-libc.patch" | cut -d/ -f2-4 | sort -u)
apply_once "$(rustc --print sysroot)/lib/rustlib/src/rust" "$HERE/wasip1/std.patch"
# FireDog's branding (name, icons, default prefs). A modified build cannot use
# Mozilla's trademarks, so it replaces the unofficial branding (Nightly).
rm -rf browser/branding/firedog
cp -R "$HERE/wasip1/branding/firedog" browser/branding/firedog
./mach configure
