#!/usr/bin/env python3
"""Replace vendored Rust crates with Progate's forks for wasm32-browseros-linux-musl.

BrowserOS's libc is musl with the riscv32 ABI, and these crates learn that from
`target_vendor = "browseros"` (they use their riscv32 definitions for wasm32).
The Rust toolchain (Progate/rust) uses the same forks.

Each fork is checked out at a pinned commit and packaged with `cargo package`,
which gives the same files as the crates.io release Gecko vendors. The crate
then replaces third_party/rust/<name>, and Cargo.lock takes its version.

Usage: vendor-forks.py <gecko source directory>
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

FORKS = [
    # (crate, repository, commit)
    ("libc", "https://github.com/Progate/rust-libc.git", "1d8b649b6e1fe571bada9fc778654887658e1fa2"),
    ("linux-raw-sys", "https://github.com/Progate/linux-raw-sys.git", "3ad56fff7388ad6933c7ee7a91c51dd2220c1ef9"),
    ("rustix", "https://github.com/Progate/rustix.git", "eb2ba84e186fd15c048f6899d86cf8570f570588"),
]


def package(repository, commit, work):
    """Check out the fork and return the directory of its packaged crate."""
    checkout = os.path.join(work, "src")
    subprocess.check_call(["git", "init", "-q", checkout])
    subprocess.check_call(["git", "-C", checkout, "fetch", "-q", "--depth", "1", repository, commit])
    subprocess.check_call(["git", "-C", checkout, "checkout", "-q", "FETCH_HEAD"])
    subprocess.check_call(
        ["cargo", "package", "--no-verify", "--allow-dirty", "--quiet", "--target-dir", os.path.join(work, "target")],
        cwd=checkout,
    )
    out = os.path.join(work, "target", "package")
    (crate,) = [f for f in os.listdir(out) if f.endswith(".crate")]
    with tarfile.open(os.path.join(out, crate)) as tar:
        tar.extractall(os.path.join(work, "crate"), filter="data")
    (directory,) = os.listdir(os.path.join(work, "crate"))
    return os.path.join(work, "crate", directory)


def checksum_files(directory):
    files = {}
    for root, _, names in os.walk(directory):
        for name in names:
            full = os.path.join(root, name)
            relative = os.path.relpath(full, directory)
            if relative != ".cargo-checksum.json":
                with open(full, "rb") as f:
                    files[relative] = hashlib.sha256(f.read()).hexdigest()
    return dict(sorted(files.items()))


def version_of(directory):
    with open(os.path.join(directory, "Cargo.toml")) as f:
        return re.search(r'^version = "([^"]+)"', f.read(), re.M).group(1)


def main(gecko):
    lock_path = os.path.join(gecko, "Cargo.lock")
    with open(lock_path) as f:
        lock = f.read()
    for name, repository, commit in FORKS:
        vendored = os.path.join(gecko, "third_party", "rust", name)
        with open(os.path.join(vendored, ".cargo-checksum.json")) as f:
            listed = json.load(f)["package"]
        old = version_of(vendored)
        with tempfile.TemporaryDirectory() as work:
            crate = package(repository, commit, work)
            new = version_of(crate)
            shutil.rmtree(vendored)
            shutil.copytree(crate, vendored)
        # Cargo.lock keeps the checksum it lists; the directory source only
        # needs .cargo-checksum.json to give the same one.
        with open(os.path.join(vendored, ".cargo-checksum.json"), "w") as f:
            json.dump({"files": checksum_files(vendored), "package": listed}, f, separators=(",", ":"))
        entry = f'name = "{name}"\nversion = "{old}"\n'
        if old != new:
            if lock.count(entry) != 1:
                sys.exit(f"Cargo.lock has no single {name} {old}")
            lock = lock.replace(entry, f'name = "{name}"\nversion = "{new}"\n')
        print(f"{name} {old} -> {new} ({repository} {commit[:12]})")
    with open(lock_path, "w") as f:
        f.write(lock)


if __name__ == "__main__":
    main(sys.argv[1])
