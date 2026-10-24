/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Chrome DevTools Protocol endpoint, as Chromium serves it with
// --remote-debugging-port: HTTP discovery (/json/version, /json/list, ...)
// and one WebSocket per target (/devtools/page/<id>, /devtools/browser/<id>).
// Chrome DevTools, Puppeteer and other CDP clients find FireDog's pages here.
//
// The port comes from the pref firedog.devtools.remote-debugging-port (0, the
// default, keeps it closed, as Chromium does without the switch). Like
// Chromium it listens on 127.0.0.1 only, accepts a Host header only for an IP
// address or localhost (so a web page cannot reach it by DNS rebinding) and
// refuses WebSocket handshakes from web origins unless
// firedog.devtools.remote-allow-origins lists them (Chromium's
// --remote-allow-origins).

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "CryptoHash", () =>
  Components.Constructor("@mozilla.org/security/hash;1", "nsICryptoHash", "initWithString")
);
ChromeUtils.defineESModuleGetters(lazy, {
  HttpServer: "chrome://remote/content/server/httpd.sys.mjs",
  Session: "resource:///modules/firedog/devtools/Session.sys.mjs",
  Targets: "resource:///modules/firedog/devtools/Targets.sys.mjs",
});

const PORT_PREF = "firedog.devtools.remote-debugging-port";
const ALLOW_ORIGINS_PREF = "firedog.devtools.remote-allow-origins";

// What Chromium 158 reports in /json/version. The DevTools front-end reads
// Protocol-Version and the client's user agent; Puppeteer reads Browser.
const PROTOCOL_VERSION = "1.3";

let server = null;
let port = 0;

function json(response, value) {
  response.setStatusLine("1.1", 200, "OK");
  response.setHeader("Content-Type", "application/json; charset=UTF-8", false);
  const body = JSON.stringify(value, null, 2);
  // httpd writes strings as Latin-1; titles and URLs can be any text.
  response.bodyOutputStream.write(...utf8(body));
}

function utf8(text) {
  const bytes = new TextEncoder().encode(text);
  return [String.fromCharCode(...bytes), bytes.length];
}

function hostIsAllowed(host) {
  if (!host) {
    return false;
  }
  const name = host.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  return name === "localhost" || /^[\d.]+$/.test(name) || name.includes(":");
}

function originIsAllowed(origin) {
  // Clients outside a browser (Puppeteer, the DevTools front-end in FireDog's
  // own window through a pipe) send no Origin.
  if (origin === undefined) {
    return true;
  }
  const allowed = Services.prefs
    .getStringPref(ALLOW_ORIGINS_PREF, "")
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean);
  return allowed.includes("*") || allowed.includes(origin);
}

function headerOf(request, name) {
  return request.hasHeader(name) ? request.getHeader(name) : undefined;
}

function writeAll(output, text) {
  return new Promise((resolve, reject) => {
    const data = text;
    let written = 0;
    const write = () => {
      try {
        written += output.write(data.slice(written), data.length - written);
      } catch (error) {
        reject(error);
        return;
      }
      if (written < data.length) {
        output.asyncWait(write, 0, 0, Services.tm.currentThread);
      } else {
        resolve();
      }
    };
    write();
  });
}

// The server half of the WebSocket opening handshake (RFC 6455 4.2), after
// the checks of the module comment. Adapted from the Remote Agent's
// WebSocketHandshake.sys.mjs, which takes its allowed hosts and origins from
// the Remote Agent's command line instead.
async function upgrade(request, response) {
  response._powerSeized = true;
  const { transport, input, output } = response._connection;
  const refuse = async message => {
    await writeAll(
      output,
      `HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\n\r\n${message}`
    );
    output.close();
    throw new Error(message);
  };
  if (!hostIsAllowed(headerOf(request, "Host"))) {
    await refuse("Host header is specified and is not an IP address or localhost.");
  }
  const origin = headerOf(request, "Origin");
  if (!originIsAllowed(origin)) {
    await refuse(
      `Rejected an incoming WebSocket connection from the ${origin} origin. ` +
        `Use the ${ALLOW_ORIGINS_PREF} pref to allow connections from this origin or '*' to allow all origins.`
    );
  }
  const key = headerOf(request, "Sec-WebSocket-Key");
  if (
    request.method !== "GET" ||
    headerOf(request, "Upgrade")?.toLowerCase() !== "websocket" ||
    !key
  ) {
    await refuse("Not a WebSocket handshake.");
  }
  const hash = new lazy.CryptoHash("sha1");
  const data = Array.from(
    `${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
    char => char.charCodeAt(0)
  );
  hash.update(data, data.length);
  await writeAll(
    output,
    "HTTP/1.1 101 WebSocket Protocol Handshake\r\n" +
      "Upgrade: WebSocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${hash.finish(true)}\r\n\r\n`
  );
  return new Promise((resolve, reject) => {
    const socket = WebSocket.createServerWebSocket(
      null,
      [],
      {
        setListener(listener) {
          Services.tm.dispatchToMainThread(() =>
            listener.onTransportAvailable(transport, input, output)
          );
        },
      },
      ""
    );
    socket.addEventListener("close", () => {
      input.close();
      output.close();
    });
    socket.onopen = () => resolve(socket);
    socket.onerror = reject;
  });
}

function webSocketDebuggerUrl(path) {
  return `ws://127.0.0.1:${port}${path}`;
}

function describeTarget(target) {
  const path = `/devtools/page/${target.id}`;
  return {
    description: "",
    devtoolsFrontendUrl: `/devtools/inspector.html?ws=127.0.0.1:${port}${path}`,
    id: target.id,
    title: target.title,
    type: target.type,
    url: target.url,
    webSocketDebuggerUrl: webSocketDebuggerUrl(path),
  };
}

const handlers = {
  "/json/version"(request, response) {
    json(response, {
      Browser: `FireDog/${Services.appinfo.version}`,
      "Protocol-Version": PROTOCOL_VERSION,
      "User-Agent": Cc["@mozilla.org/network/protocol;1?name=http"].getService(
        Ci.nsIHttpProtocolHandler
      ).userAgent,
      "V8-Version": "",
      "WebKit-Version": "",
      webSocketDebuggerUrl: webSocketDebuggerUrl(
        `/devtools/browser/${lazy.Targets.browserTargetId}`
      ),
    });
  },
  "/json/list"(request, response) {
    json(response, lazy.Targets.pages().map(describeTarget));
  },
};
handlers["/json"] = handlers["/json/list"];

async function handleWebSocket(request, response) {
  const [, kind, id] = request.path.match(/^\/devtools\/(page|browser)\/(.+)$/) ?? [];
  const target =
    kind === "browser" && id === lazy.Targets.browserTargetId
      ? lazy.Targets.browser()
      : kind === "page" && lazy.Targets.byId(id);
  if (!target) {
    response.setStatusLine("1.1", 404, "Not Found");
    response.write(`No such target id: ${id}`);
    return;
  }
  response.processAsync();
  const socket = await upgrade(request, response);
  lazy.Session.attach(socket, target);
}

export const RemoteDebugging = {
  get port() {
    return port;
  },

  // Opens or closes the endpoint to match the pref. Safe to call again.
  startFromPrefs() {
    const wanted = Services.prefs.getIntPref(PORT_PREF, 0);
    if (wanted === port && server) {
      return;
    }
    this.stop();
    if (!wanted) {
      return;
    }
    server = new lazy.HttpServer();
    // httpd answers only for the host:port pairs of its identity, but a
    // client may reach the port forwarded (ssh -L, BrowserOS's host bridge)
    // and name another port, which Chromium accepts. The Host check of the
    // module comment replaces it.
    const identity = server.identity;
    const getScheme = identity.getScheme.bind(identity);
    const has = identity.has.bind(identity);
    identity.getScheme = (host, hostPort) =>
      getScheme(host, hostPort) || (hostIsAllowed(host) ? "http" : "");
    identity.has = (scheme, host, hostPort) =>
      has(scheme, host, hostPort) || (scheme === "http" && hostIsAllowed(host));
    for (const [path, handler] of Object.entries(handlers)) {
      server.registerPathHandler(path, { handle: handler });
    }
    server.registerPrefixHandler("/devtools/", {
      handle: (request, response) => {
        handleWebSocket(request, response).catch(error =>
          console.error("FireDog DevTools: WebSocket", error)
        );
      },
    });
    server._start(wanted, "127.0.0.1");
    port = server.identity.primaryPort;
    dump(`\nDevTools listening on ws://127.0.0.1:${port}/devtools/browser/${lazy.Targets.browserTargetId}\n`);
  },

  stop() {
    if (server) {
      server.stop(() => {});
      server = null;
      port = 0;
    }
  },
};
