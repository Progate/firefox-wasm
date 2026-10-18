# FireDog's Chrome DevTools Protocol

FireDog's developer tools are Chrome DevTools, talking to FireDog over the
Chrome DevTools Protocol (CDP). This directory is the protocol's server side,
written against Gecko's own APIs.

- `RemoteDebugging.sys.mjs`: the endpoint Chromium opens with
  `--remote-debugging-port` (prefs `firedog.devtools.remote-debugging-port`
  and `firedog.devtools.remote-allow-origins`): HTTP discovery and a WebSocket
  per target.
- `Targets.sys.mjs`: the browser target and one page target per tab.
- `Session.sys.mjs`: a connection; dispatches `Domain.method` to
  `domains/<Domain>.sys.mjs`, whose methods are the CDP methods of the same
  name. Methods a domain does not define answer Chromium's
  `'Domain.method' wasn't found`.
- `RemoteObjects.sys.mjs`: `Runtime.RemoteObject` and previews from
  SpiderMonkey's Debugger API, described the way V8's inspector describes
  values.
- `DOMBreakpoints.sys.mjs`: DOMDebugger's DOM breakpoints, from Gecko's
  synchronous devtools mutation events.
- `domains/`: one file per CDP domain.

FireDog runs single-process, so a page's documents and globals are in the
same process as this code and are used directly. The page's JavaScript is
reached through a SpiderMonkey `Debugger` kept in its own compartment
(`Runtime`).

The behavior to match is Chromium 158's: its DevTools front-end is the
client, and where the protocol leaves details open, the front-end expects
what Chromium sends. browser-gecko's CDP comparison runs the same front-end
against Chromium and FireDog and compares the traffic and the panels.
