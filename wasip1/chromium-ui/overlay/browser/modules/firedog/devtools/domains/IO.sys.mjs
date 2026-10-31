/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The IO domain: streams other domains hand out by handle, such as the body
// Network.loadNetworkResource fetched. A stream is the bytes already in
// memory; IO.read returns them in pieces, as text when they are UTF-8 and as
// base64 otherwise, like Chromium's DevToolsIOContext.

import { ProtocolError } from "resource:///modules/firedog/devtools/Session.sys.mjs";

// Chromium's default IO.read size.
const DEFAULT_READ_SIZE = 10 * 1024 * 1024;

export class IO {
  constructor(session) {
    this.session = session;
    this.streams = new Map();
    this.nextHandle = 1;
  }

  // Registers bytes as a stream and returns its handle.
  _open(bytes) {
    const handle = String(this.nextHandle++);
    let isText = true;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      isText = false;
    }
    this.streams.set(handle, { bytes, position: 0, isText });
    return handle;
  }

  read({ handle, offset, size }) {
    const stream = this.streams.get(handle);
    if (!stream) {
      throw new ProtocolError("Invalid stream handle");
    }
    if (offset !== undefined) {
      if (offset < 0) {
        throw new ProtocolError("Invalid offset");
      }
      stream.position = offset;
    }
    let end = Math.min(stream.bytes.length, stream.position + (size > 0 ? size : DEFAULT_READ_SIZE));
    if (stream.isText) {
      // Do not split a UTF-8 sequence between two reads.
      while (end > stream.position + 1 && end < stream.bytes.length && (stream.bytes[end] & 0xc0) === 0x80) {
        end--;
      }
    }
    const piece = stream.bytes.subarray(stream.position, end);
    stream.position = end;
    const eof = stream.position >= stream.bytes.length;
    if (stream.isText) {
      return { data: new TextDecoder().decode(piece), eof };
    }
    let binary = "";
    for (let i = 0; i < piece.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, piece.subarray(i, i + 0x8000));
    }
    return { base64Encoded: true, data: btoa(binary), eof };
  }

  close({ handle }) {
    if (!this.streams.delete(handle)) {
      throw new ProtocolError("Invalid stream handle");
    }
  }

  _destroy() {
    this.streams.clear();
  }
}
