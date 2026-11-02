#!/usr/bin/env bash
# Build the rustc that compiles Gecko's Rust code for wasm32-browseros-linux-musl:
# Progate/rust (the target's definition) at a pinned commit, built for the host,
# with the standard library for the host and for the target.
#
#   BROWSEROS_SYSROOT  the world's sysroot (browseros/sysroot.mjs)
#   BROWSER_LD         packages/browser-ld of Progate/packages (browser-cc)
#   WASI_SDK_PATH      wasi-sdk 34 (llvm-ar, llvm-ranlib)
#   RUST_SOURCE        where to check out Progate/rust (default /work/rust-browseros)
#
# The compiler is <RUST_SOURCE>/build/host/stage1/bin/rustc (BROWSEROS_RUSTC).
set -euo pipefail
: "${BROWSEROS_SYSROOT:?set BROWSEROS_SYSROOT to the output of browseros/sysroot.mjs}"
: "${BROWSER_LD:?set BROWSER_LD to packages/browser-ld of Progate/packages}"
: "${WASI_SDK_PATH:?set WASI_SDK_PATH}"
RUST_SOURCE=${RUST_SOURCE:-/work/rust-browseros}
HERE=$(cd "$(dirname "$0")" && pwd)
REPOSITORY=https://github.com/Progate/rust.git
COMMIT=48b76c165de53e083617ad1629bdf00e05274912
HOST=$(rustc -vV | sed -n 's/^host: //p')

if [ ! -d "$RUST_SOURCE/.git" ]; then
  git init -q "$RUST_SOURCE"
fi
# download-ci-llvm finds the LLVM to download from the history (the last merge
# that touched src/llvm-project), so fetch the history without the file contents.
unshallow=()
if [ "$(git -C "$RUST_SOURCE" rev-parse --is-shallow-repository)" = true ]; then unshallow=(--unshallow); fi
git -C "$RUST_SOURCE" fetch -q --filter=blob:none "${unshallow[@]}" "$REPOSITORY" "$COMMIT"
git -C "$RUST_SOURCE" checkout -q FETCH_HEAD

cat > "$RUST_SOURCE/bootstrap.toml" <<EOF
profile = "compiler"
change-id = "ignore"
[rust]
codegen-backends = ["llvm"]
deny-warnings = false
debug = false
debuginfo-level = 0
[llvm]
download-ci-llvm = true
[build]
docs = false
extended = false
tools = []
host = ["$HOST"]
target = ["$HOST", "wasm32-browseros-linux-musl"]
[target.wasm32-browseros-linux-musl]
cc = "$HERE/bin/cc"
cxx = "$HERE/bin/c++"
linker = "$HERE/bin/cc"
ar = "$WASI_SDK_PATH/bin/llvm-ar"
ranlib = "$WASI_SDK_PATH/bin/llvm-ranlib"
llvm-libunwind = "system"
musl-libdir = "$BROWSEROS_SYSROOT/usr/lib/wasm32-linux-musl"
EOF

# The cc crate (bootstrap and the build scripts of std's dependencies) looks for
# the sysroot of wasm32 Linux targets in WASM_MUSL_SYSROOT.
export WASM_MUSL_SYSROOT="$BROWSEROS_SYSROOT"
# Both standard libraries in one run: building one leaves only it in the
# stage1 sysroot.
cd "$RUST_SOURCE"
./x.py build --stage 1 library --target "$HOST,wasm32-browseros-linux-musl"
echo "BROWSEROS_RUSTC=$RUST_SOURCE/build/host/stage1/bin/rustc"
