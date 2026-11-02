// SPDX-License-Identifier: MPL-2.0
#pragma once

// Chromium's --remote-debugging-pipe: the Chrome DevTools Protocol on file
// descriptors 3 (requests in) and 4 (responses and events out), each message a
// JSON text ended by a NUL byte, as Puppeteer and Playwright launch Chromium.
//
// The protocol is RemoteDebugging.sys.mjs's; this only moves the bytes. Gecko's
// file streams cannot wait on a pipe (NSPR answers available() for a file with
// lseek, which a pipe refuses, so nsInputStreamPump never delivers), so, as
// Playwright's Firefox does (Juggler's nsRemoteDebuggingPipe), one thread reads
// descriptor 3 and another writes 4. They meet the main thread through the
// observer service:
//
//   firedog-devtools-pipe-start    JS -> here   start reading (once its
//                                               observers are in place, so no
//                                               message is notified to nobody)
//   firedog-devtools-pipe-message  here -> JS   one message (the data)
//   firedog-devtools-pipe-send     JS -> here   one message to write (the data)
//   firedog-devtools-pipe-closed   here -> JS   descriptor 3 reached its end
//
// Call on the main thread once XPCOM is up, only when the switch was given.
void registerDevToolsPipe();
