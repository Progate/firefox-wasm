FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential clang lld libclang-dev cmake ninja-build git curl ca-certificates \
    python3 python3-dev python3-venv python3-pip pkg-config m4 autoconf2.13 \
    nodejs npm xz-utils zstd patch unzip zip && rm -rf /var/lib/apt/lists/*
ARG WASI_SDK_VERSION=34.0
RUN arch="$(uname -m)"; case "$arch" in aarch64) arch=arm64;; x86_64) arch=x86_64;; *) exit 1;; esac; \
    curl -fL --retry 3 "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION%%.*}/wasi-sdk-${WASI_SDK_VERSION}-${arch}-linux.tar.gz" -o /tmp/sdk.tar.gz && \
    mkdir /opt/wasi-sdk && tar -xzf /tmp/sdk.tar.gz --strip-components=1 -C /opt/wasi-sdk && rm /tmp/sdk.tar.gz
ENV WASI_SDK_PATH=/opt/wasi-sdk
ENV PATH=/root/.cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup.sh && \
    sh /tmp/rustup.sh -y --profile minimal --default-toolchain 1.95.0 && \
    rustup component add rust-src && rustup target add wasm32-wasip1-threads && rm /tmp/rustup.sh
WORKDIR /src
