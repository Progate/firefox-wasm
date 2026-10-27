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

// Chromium's session ids: 32 uppercase hex digits.
function newSessionId() {
  return Services.uuid
    .generateUUID()
    .toString()
    .replace(/[{}-]/g, "")
    .toUpperCase();
}

export class Session {
  static attach(socket, target) {
    return new Session(socket, target);
  }

  // A connection's own session has a socket; the sessions attached over it
  // with Target.attachToTarget (flatten) have none and talk through it, their
  // messages carrying their sessionId, as Chromium's flat sessions do.
  constructor(socket, target, parent = null, sessionId = null) {
    this.socket = socket;
    this.target = target;
    this.parent = parent;
    this.sessionId = sessionId;
    this.children = new Map();
    this.domains = new Map();
    // Per-connection state shared by domains (objects handed out by Runtime,
    // nodes handed out by DOM, ...). Each domain keeps its own part.
    this.state = {};
    this.closed = false;
    if (socket) {
      socket.addEventListener("message", event => this.receive(event.data));
      socket.addEventListener("close", () => this.close());
    }
  }

  // The session that owns the connection.
  get root() {
    return this.parent ?? this;
  }

  // Attaches a new session to target over this connection.
  attachChild(target) {
    const child = new Session(null, target, this.root, newSessionId());
    this.root.children.set(child.sessionId, child);
    return child;
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
    if (message.sessionId === undefined) {
      await this.dispatch(message);
      return;
    }
    const child = this.children.get(message.sessionId);
    // A tab that closed takes its sessions with it, as Chromium's do.
    if (child && child.target.alive === false) {
      child.detach();
    }
    if (!child || child.closed) {
      this.send({
        id: message.id,
        error: { code: -32001, message: "Session with given id not found." },
        sessionId: message.sessionId,
      });
      return;
    }
    await child.dispatch(message);
  }

  async dispatch({ id, method, params = {} }) {
    const reply = body => this.send({ id, ...body });
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
    if (this.parent) {
      this.parent.send({ ...message, sessionId: this.sessionId });
      return;
    }
    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      console.error("FireDog DevTools: send", error);
    }
  }

  // Ends an attached session and tells the connection, as
  // Target.detachFromTarget and a closing tab do in Chromium.
  detach() {
    if (this.closed || !this.parent) {
      return;
    }
    this.close();
    this.parent.emit("Target.detachedFromTarget", {
      sessionId: this.sessionId,
      targetId: this.target.id,
    });
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.parent?.children.delete(this.sessionId);
    for (const child of [...this.children.values()]) {
      child.close();
    }
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
