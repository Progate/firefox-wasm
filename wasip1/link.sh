#!/usr/bin/env bash
# Link the BrowserOS FireDog program: the windowserver entry point (main.cpp),
# the gecko.js embedder (embed-*.cpp except the emscripten mailbox loop in
# embed-xul.cpp) and Gecko's libraries into one wasm32-wasip1-threads module.
# Run after `mach build` inside the toolchain image.
set -euo pipefail
: "${WASI_SDK_PATH:?set WASI_SDK_PATH}"
: "${BROWSEROS_SYSROOT:?set BROWSEROS_SYSROOT}"
HERE=$(cd "$(dirname "$0")/.." && pwd)
OBJ=${GECKO_OBJDIR:-/work/obj-full-wasip1}
OUT=${1:-/work/out/firedog.wasm}
BUILD=$(dirname "$OUT")/link
mkdir -p "$BUILD"

CXX=("$WASI_SDK_PATH/bin/clang++" --target=wasm32-wasip1-threads "--sysroot=$BROWSEROS_SYSROOT")
WASI_FLAGS=(
  -pthread -msimd128
  -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS
  -D_WASI_EMULATED_GETPID
  -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false
)
CXXFLAGS=(
  -std=gnu++20 -fno-exceptions -fno-rtti -fno-sized-deallocation -fno-aligned-new
  -O2 -DMOZILLA_INTERNAL_API -DMOZ_HAS_MOZGLUE -DNDEBUG=1
  -include "$OBJ/mozilla-config.h"
  -isystem "$OBJ/dist/include" -isystem "$OBJ/dist/include/nspr"
  -isystem "$OBJ/build"  # application.ini.h (embed-init.cpp)
  "${WASI_FLAGS[@]}" -Wno-unused-template
)

OBJS=()
for src in embed-init embed-browser embed-paint embed-input embed-mirror; do
  "${CXX[@]}" "${CXXFLAGS[@]}" -c "$HERE/gecko.js/src/$src.cpp" -o "$BUILD/$src.o"
  OBJS+=("$BUILD/$src.o")
done
for src in main windowserver devtools-pipe; do
  "${CXX[@]}" "${CXXFLAGS[@]}" -c "$HERE/wasip1/$src.cpp" -o "$BUILD/$src.o"
  OBJS+=("$BUILD/$src.o")
done

# mozglue, mfbt, the allocator and fmt are linked into the program, not libxul
# (MOZ_GLUE_IN_PROGRAM).
GLUE=()
for d in mfbt mozglue/misc mozglue/baseprofiler mozglue/build memory/build memory/mozalloc third_party/fmt; do
  for f in "$OBJ/$d"/*.o; do [ -e "$f" ] && GLUE+=("$f"); done
done

# Gecko's libraries are wasm-ld response files listing their objects and
# archives (see build/wasi-relocatable-link.py in gecko.patch). libxul goes in
# whole: its objects register components and run static constructors. The
# libraries it loads (NSS folded into libnss3, the codecs) carry private copies
# of code libxul also has (rlbox's thread locals), hidden inside their shared
# objects natively. In one module they become archives, so only what libxul
# still needs is taken from them.
#
# The LGPL libraries are left out: liblgpllibs (SoundTouch) and ffvpx
# (libmozavutil, libmozavcodec). Gecko keeps them in shared libraries so that
# they stay replaceable; linked into this one module they would not be.
# libxul reaches ffvpx only through dlopen, which fails on WASI. Its calls into
# SoundTouch go through RLBoxSoundTouch, which gecko.patch replaces on WASI
# with a version that never calls SoundTouch; that wrapper is Mozilla's own
# code but is built into liblgpllibs, so its object is taken alone.
LIBS=("@$OBJ/dist/bin/libxul.so" "$OBJ/media/libsoundtouch/src/RLBoxSoundTouch.o")
for lib in libnss3 libgkcodecs; do
  objects=()
  while read -r path; do
    case "$path" in
      *.a) LIBS+=("$path") ;;
      *) objects+=("$path") ;;
    esac
  done < "$OBJ/dist/bin/$lib.so"
  rm -f "$BUILD/$lib.a"
  "$WASI_SDK_PATH/bin/llvm-ar" rcs "$BUILD/$lib.a" "${objects[@]}"
  LIBS+=("$BUILD/$lib.a")
done

# wasi-threads needs the memory to be shared and supplied by the host (every
# thread instance imports the same memory). Gecko's main thread recurses deeply
# (layout, the JS interpreter), so it gets a 16 MiB stack.
"${CXX[@]}" "${WASI_FLAGS[@]}" -O2 \
  "${OBJS[@]}" "${LIBS[@]}" "${GLUE[@]}" \
  -Wl,--import-memory,--export-memory,--shared-memory \
  -Wl,--max-memory=4294967296 -Wl,--initial-memory=268435456 \
  -Wl,-z,stack-size=16777216 \
  -lsetjmp -lwasi-emulated-mman -lwasi-emulated-signal \
  -lwasi-emulated-process-clocks -lwasi-emulated-getpid \
  -Wl,--strip-debug -Wl,--error-limit=0 \
  -o "$OUT"
ls -la "$OUT"
