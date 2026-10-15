#!/usr/bin/env bash
# Link the BrowserOS Firefox program: the windowserver entry point (main.cpp),
# the gecko.js embedder (embed-*.cpp except the emscripten mailbox loop in
# embed-xul.cpp) and Gecko's relocatable libxul into one wasm32-wasip1-threads
# module. Run after `mach build` inside the toolchain image.
set -euo pipefail
: "${WASI_SDK_PATH:?set WASI_SDK_PATH}"
: "${BROWSEROS_SYSROOT:?set BROWSEROS_SYSROOT}"
HERE=$(cd "$(dirname "$0")/.." && pwd)
OBJ=${GECKO_OBJDIR:-/work/obj-full-wasip1}
OUT=${1:-/work/out/firefox.wasm}
BUILD=$(dirname "$OUT")/link
mkdir -p "$BUILD"

CXX=("$WASI_SDK_PATH/bin/clang++" --target=wasm32-wasip1-threads "--sysroot=$BROWSEROS_SYSROOT")
WASI_FLAGS=(
  -pthread -msimd128
  -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS
  -D_WASI_EMULATED_GETPID
  -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh
)
CXXFLAGS=(
  -std=gnu++20 -fno-exceptions -fno-rtti -fno-sized-deallocation -fno-aligned-new
  -O2 -DMOZILLA_INTERNAL_API -DMOZ_HAS_MOZGLUE -DNDEBUG=1
  -include "$OBJ/mozilla-config.h"
  -isystem "$OBJ/dist/include" -isystem "$OBJ/dist/include/nspr"
  "${WASI_FLAGS[@]}" -Wno-unused-template
)

OBJS=()
for src in embed-init embed-browser embed-paint embed-input embed-mirror; do
  "${CXX[@]}" "${CXXFLAGS[@]}" -c "$HERE/gecko.js/src/$src.cpp" -o "$BUILD/$src.o"
  OBJS+=("$BUILD/$src.o")
done
for src in main windowserver; do
  "${CXX[@]}" "${CXXFLAGS[@]}" -c "$HERE/wasip1/$src.cpp" -o "$BUILD/$src.o"
  OBJS+=("$BUILD/$src.o")
done

# mozglue, mfbt, the allocator and fmt are linked into the program, not libxul
# (MOZ_GLUE_IN_PROGRAM).
GLUE=()
for d in mfbt mozglue/misc mozglue/baseprofiler mozglue/build memory/build memory/mozalloc third_party/fmt; do
  for f in "$OBJ/$d"/*.o; do [ -e "$f" ] && GLUE+=("$f"); done
done

# wasi-threads needs the memory to be shared and supplied by the host (every
# thread instance imports the same memory). Gecko's main thread recurses deeply
# (layout, the JS interpreter), so it gets a 16 MiB stack.
"${CXX[@]}" "${WASI_FLAGS[@]}" -O2 \
  "${OBJS[@]}" "$OBJ/dist/bin/libxul.so" "${GLUE[@]}" \
  -Wl,--import-memory,--export-memory,--shared-memory \
  -Wl,--max-memory=4294967296 -Wl,--initial-memory=268435456 \
  -Wl,-z,stack-size=16777216 \
  -lsetjmp -lwasi-emulated-mman -lwasi-emulated-signal \
  -lwasi-emulated-process-clocks -lwasi-emulated-getpid \
  -Wl,--strip-debug \
  -o "$OUT"
ls -la "$OUT"
