#!/usr/bin/env python3
"""Refresh .cargo-checksum.json of vendored crates that gecko.patch edits.

The patch leaves the checksum files out; cargo refuses edited vendored
sources until their checksums match again."""
import hashlib, json, os, sys
for crate in sys.argv[1:]:
    p = os.path.join(crate, '.cargo-checksum.json')
    d = json.load(open(p))
    files = {}
    for root, _, names in os.walk(crate):
        for n in names:
            full = os.path.join(root, n)
            rel = os.path.relpath(full, crate)
            if rel == '.cargo-checksum.json':
                continue
            files[rel] = hashlib.sha256(open(full, 'rb').read()).hexdigest()
    d['files'] = dict(sorted(files.items()))
    json.dump(d, open(p, 'w'), separators=(',', ':'))
    print('rehashed', crate)
