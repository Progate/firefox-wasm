/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One CDP connection to a target. Messages are dispatched to domain objects
// (domains/<Domain>.sys.mjs), created on first use; each method of a domain
// object is the CDP method of the same name. Errors follow Chromium's codes
// and messages, which clients match on (Puppeteer checks for
// "wasn't found").

const DOMAINS = new Set([
  "Accessibility",
  "Animation",
  "Audits",
  "Browser",
  "CSS",
  "DOM",
  "DOMDebugger",
  "DOMStorage",
  "Debugger",
  "Emulation",
  "EventBreakpoints",
  "IO",
  "Input",
  "Inspector",
  "Log",
  "Network",
  "Overlay",
  "Page",
  "Profiler",
  "Runtime",
  "ServiceWorker",
  "Storage",
  "Target",
]);

export class ProtocolError extends Error {
  constructor(message, code = -32000, data = undefined) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export class InvalidParams extends ProtocolError {
  constructor(message) {
    super(message, -32602);
  }
}

export class Session {
  static attach(socket, target) {
    return new Session(socket, target);
  }

  constructor(socket, target) {
    this.socket = socket;
    this.target = target;
    this.domains = new Map();
    // Per-connection state shared by domains (objects handed out by Runtime,
    // nodes handed out by DOM, ...). Each domain keeps its own part.
    this.state = {};
    this.closed = false;
    socket.addEventListener("message", event => this.receive(event.data));
    socket.addEventListener("close", () => this.close());
  }

  domain(name) {
    let domain = this.domains.get(name);
    if (!domain) {
      if (!DOMAINS.has(name)) {
        return null;
      }
      const module = ChromeUtils.importESModule(
        `resource:///modules/firedog/devtools/domains/${name}.sys.mjs`
      );
      domain = new module[name](this);
      this.domains.set(name, domain);
    }
    return domain;
  }

  async receive(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      this.send({ error: { code: -32700, message: "JSON: invalid syntax" } });
      return;
    }
    const { id, method, params = {}, sessionId } = message;
    const reply = body =>
      this.send({ id, ...body, ...(sessionId ? { sessionId } : {}) });
    const [domainName, methodName] = method?.split(".") ?? [];
    let domain = null;
    try {
      domain = domainName && this.domain(domainName);
    } catch (error) {
      console.error(`FireDog DevTools: domain ${domainName}`, error);
    }
    const handler = domain?.[methodName];
    if (typeof handler !== "function" || methodName.startsWith("_")) {
      reply({ error: { code: -32601, message: `'${method}' wasn't found` } });
      return;
    }
    try {
      const result = await handler.call(domain, params);
      reply({ result: result ?? {} });
    } catch (error) {
      if (error instanceof ProtocolError) {
        reply({
          error: {
            code: error.code,
            message: error.message,
            ...(error.data ? { data: error.data } : {}),
          },
        });
      } else {
        console.error(`FireDog DevTools: ${method}`, error);
        reply({ error: { code: -32603, message: String(error?.message ?? error) } });
      }
    }
  }

  // Sends an event to the client.
  emit(method, params = {}) {
    this.send({ method, params });
  }

  send(message) {
    if (this.closed) {
      return;
    }
    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      console.error("FireDog DevTools: send", error);
    }
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const domain of this.domains.values()) {
      try {
        domain._destroy?.();
      } catch (error) {
        console.error("FireDog DevTools: close", error);
      }
    }
    this.domains.clear();
  }
}
