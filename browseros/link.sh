#!/usr/bin/env bash
# Link the BrowserOS FireDog program after `mach build`: the windowserver entry
# point (main.cpp), the gecko.js embedder (embed-*.cpp except the emscripten
# mailbox loop in embed-xul.cpp) and Gecko into one position-independent
# executable for wasm32-browseros-linux-musl.
#
# The embedder calls Gecko's internal C++ API, which libxul.so does not export,
# so the program takes libxul's inputs (toolkit/library/build/libxul_so.list and
# its static libraries) and the glue a Firefox program carries (mozglue, mfbt,
# fmt). The libraries libxul loads stay shared libraries next to the program:
# NSPR, NSS, SQLite and the codecs.
#
# FireDog leaves out the LGPL libraries Gecko keeps in shared libraries:
# liblgpllibs.so (SoundTouch) and ffvpx (libmozavutil.so, libmozavcodec.so).
# libxul reaches ffvpx only through dlopen and plays without it when the open
# fails. Its calls into SoundTouch go through RLBoxSoundTouch, which
# gecko.patch replaces on wasm with a version that never calls SoundTouch; that
# wrapper is Mozilla's own code but is built into liblgpllibs, so its object is
# taken alone.
set -euo pipefail
: "${WASI_SDK_PATH:?set WASI_SDK_PATH}"
: "${BROWSEROS_SYSROOT:?set BROWSEROS_SYSROOT}"
: "${BROWSER_LD:?set BROWSER_LD}"
HERE=$(cd "$(dirname "$0")/.." && pwd)
OBJ=${GECKO_OBJDIR:-/work/obj-full-browseros}
OUT=${1:-/work/out/firedog}
BUILD=$(dirname "$OUT")/link
mkdir -p "$BUILD"

CXX=("$HERE/browseros/bin/c++")
ARCH_FLAGS=(-pthread -msimd128 -mllvm -wasm-enable-sjlj)
CXXFLAGS=(
  -std=gnu++20 -fno-exceptions -fno-rtti -fno-sized-deallocation -fno-aligned-new
  -fPIC -O2 -fvisibility=hidden -fvisibility-inlines-hidden
  -DMOZILLA_INTERNAL_API -DIMPL_LIBXUL -DMOZ_HAS_MOZGLUE -DNDEBUG=1 -DMOZILLA_CLIENT
  -include "$OBJ/mozilla-config.h"
  -isystem "$OBJ/dist/stl_wrappers"
  -isystem "$OBJ/dist/include" -isystem "$OBJ/dist/include/nspr"
  -isystem "$OBJ/dist/include/nss"
  -isystem "$OBJ/build"  # application.ini.h (embed-init.cpp)
  "${ARCH_FLAGS[@]}" -Wno-unused-template
)

OBJS=()
for src in embed-init embed-browser embed-paint embed-input embed-mirror; do
  "${CXX[@]}" "${CXXFLAGS[@]}" -c "$HERE/gecko.js/src/$src.cpp" -o "$BUILD/$src.o"
  OBJS+=("$BUILD/$src.o")
done
for src in main windowserver devtools-pipe; do
  "${CXX[@]}" "${CXXFLAGS[@]}" -c "$HERE/browseros/$src.cpp" -o "$BUILD/$src.o"
  OBJS+=("$BUILD/$src.o")
done

# Make's view of a library: its object list file, and the variable lines of
# its backend.mk.
list() {  # <dir> <list file>: the objects, as absolute paths
  (cd "$1" && xargs realpath -m < "$2")
}
libs() {  # <dir> <variable>: the libraries a backend.mk names
  sed -n "s/^$2 += //p" "$1/backend.mk" | sed "s|\$(DEPTH)|$OBJ|"
}

LIBXUL="$OBJ/toolkit/library/build"
APP="$OBJ/browser/app"
# The Firefox program's own objects, without its entry point and the glue that
# loads libxul.so (xpcom/glue/standalone).
list "$APP" firefox.list \
  | grep -v -e '/browser/app/' -e '/xpcom/glue/standalone/' > "$BUILD/glue.list"
list "$LIBXUL" libxul_so.list > "$BUILD/libxul.list"
mapfile -t STATIC < <(libs "$LIBXUL" STATIC_LIBS; libs "$APP" STATIC_LIBS)
mapfile -t SHARED < <(libs "$LIBXUL" SHARED_LIBS | grep -v '/liblgpllibs\.so$')
SHARED+=("$OBJ/media/libsoundtouch/src/RLBoxSoundTouch.o")
mapfile -t OS_LIBS < <(libs "$LIBXUL" OS_LIBS; libs "$APP" OS_LIBS)

# Gecko's main thread recurses deeply (layout, the JS interpreter), so it gets
# a 16 MiB stack. browser-ld exports from the program what the shared libraries
# call back into (mozglue's functions), as -rdynamic does for Firefox. The
# shared libraries are installed next to the program ($ORIGIN), as in a Firefox
# installation directory.
"${CXX[@]}" "${ARCH_FLAGS[@]}" -O2 -pie \
  "${OBJS[@]}" -Wl,@"$BUILD/libxul.list" -Wl,@"$BUILD/glue.list" \
  "${STATIC[@]}" "${SHARED[@]}" $(printf '%s\n' "${OS_LIBS[@]}" | sort -u) \
  -Wl,-rpath,'$ORIGIN' \
  -Wl,-z,stack-size=16777216 -Wl,--strip-debug -Wl,--error-limit=0 \
  -o "$OUT"
ls -la "$OUT"
