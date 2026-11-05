/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The ServiceWorker domain: the browser's service worker registrations and
// their versions, from Gecko's ServiceWorkerManager.
//
// Gecko's registrations have no ids of their own, so each gets one for the
// session; a version is a ServiceWorkerInfo, whose id Gecko assigns. A
// version is running when Gecko has a worker for it (its debugger exists).

import {
  InvalidParams,
  ProtocolError,
} from "resource:///modules/firedog/devtools/Session.sys.mjs";

const STATUS = {
  [Ci.nsIServiceWorkerInfo.STATE_PARSED]: "new",
  [Ci.nsIServiceWorkerInfo.STATE_INSTALLING]: "installing",
  [Ci.nsIServiceWorkerInfo.STATE_INSTALLED]: "installed",
  [Ci.nsIServiceWorkerInfo.STATE_ACTIVATING]: "activating",
  [Ci.nsIServiceWorkerInfo.STATE_ACTIVATED]: "activated",
  [Ci.nsIServiceWorkerInfo.STATE_REDUNDANT]: "redundant",
};

function manager() {
  return Cc["@mozilla.org/serviceworkers/manager;1"].getService(Ci.nsIServiceWorkerManager);
}

function allRegistrations() {
  const array = manager().getAllRegistrations();
  const registrations = [];
  for (let i = 0; i < array.length; i++) {
    registrations.push(array.queryElementAt(i, Ci.nsIServiceWorkerRegistrationInfo));
  }
  return registrations;
}

function workersOf(registration) {
  return [
    registration.evaluatingWorker,
    registration.installingWorker,
    registration.waitingWorker,
    registration.activeWorker,
  ].filter(Boolean);
}

export class ServiceWorker {
  constructor(session) {
    this.session = session;
    this.target = session.target;
    this.enabled = false;
    this.registrationIds = new Map();
    this.nextRegistrationId = 0;
    this.watched = new Map();
  }

  _registrationKey(registration) {
    return `${registration.principal.origin}\t${registration.scope}`;
  }

  _registrationId(registration) {
    const key = this._registrationKey(registration);
    let id = this.registrationIds.get(key);
    if (id === undefined) {
      id = String(this.nextRegistrationId++);
      this.registrationIds.set(key, id);
    }
    return id;
  }

  _registration(registration, isDeleted = false) {
    return {
      registrationId: this._registrationId(registration),
      scopeURL: registration.scope,
      isDeleted,
    };
  }

  // The clients a version controls, among the targets this session can
  // name: this page, when its document is controlled by the version.
  _controlledClients(worker) {
    try {
      const controller = this.target.contentWindow?.navigator.serviceWorker?.controller;
      if (controller && controller.scriptURL === worker.scriptSpec) {
        return [this.target.id];
      }
    } catch {
      // No service worker container (an opaque origin).
    }
    return [];
  }

  _version(registration, worker) {
    const running = !!worker.debugger;
    return {
      versionId: worker.id,
      registrationId: this._registrationId(registration),
      scriptURL: worker.scriptSpec,
      runningStatus: running ? "running" : "stopped",
      status: STATUS[worker.state] ?? "new",
      scriptLastModified: 0,
      scriptResponseTime: 0,
      controlledClients: this._controlledClients(worker),
    };
  }

  _report(registration) {
    this.session.emit("ServiceWorker.workerRegistrationUpdated", {
      registrations: [this._registration(registration)],
    });
    this.session.emit("ServiceWorker.workerVersionUpdated", {
      versions: workersOf(registration).map(worker => this._version(registration, worker)),
    });
  }

  _watch(registration) {
    const key = this._registrationKey(registration);
    if (this.watched.has(key)) {
      return;
    }
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIServiceWorkerRegistrationInfoListener"]),
      onChange: () => this._report(registration),
    };
    registration.addListener(listener);
    this.watched.set(key, { registration, listener });
  }

  _unwatch(registration) {
    const key = this._registrationKey(registration);
    const watched = this.watched.get(key);
    if (watched) {
      watched.registration.removeListener(watched.listener);
      this.watched.delete(key);
    }
  }

  enable() {
    if (this.enabled) {
      return;
    }
    this.enabled = true;
    const registrations = allRegistrations();
    this.session.emit("ServiceWorker.workerRegistrationUpdated", {
      registrations: registrations.map(registration => this._registration(registration)),
    });
    this.session.emit("ServiceWorker.workerVersionUpdated", {
      versions: registrations.flatMap(registration =>
        workersOf(registration).map(worker => this._version(registration, worker))
      ),
    });
    registrations.forEach(registration => this._watch(registration));
    this.managerListener = {
      QueryInterface: ChromeUtils.generateQI(["nsIServiceWorkerManagerListener"]),
      onRegister: registration => {
        this._watch(registration);
        this._report(registration);
      },
      onUnregister: registration => {
        this._unwatch(registration);
        this.session.emit("ServiceWorker.workerRegistrationUpdated", {
          registrations: [this._registration(registration, true)],
        });
      },
      onQuotaUsageCheckFinish() {},
    };
    manager().addListener(this.managerListener);
  }

  disable() {
    if (!this.enabled) {
      return;
    }
    this.enabled = false;
    manager().removeListener(this.managerListener);
    for (const { registration } of [...this.watched.values()]) {
      this._unwatch(registration);
    }
  }

  _registrationByScope(scopeURL) {
    const registration = allRegistrations().find(r => r.scope === scopeURL);
    if (!registration) {
      throw new ProtocolError("No service worker registration for the given scope");
    }
    return registration;
  }

  _worker(versionId) {
    for (const registration of allRegistrations()) {
      const worker = workersOf(registration).find(w => w.id === versionId);
      if (worker) {
        return worker;
      }
    }
    throw new InvalidParams("Invalid version ID");
  }

  unregister({ scopeURL }) {
    const registration = this._registrationByScope(scopeURL);
    return new Promise((resolve, reject) => {
      manager().unregister(
        registration.principal,
        {
          QueryInterface: ChromeUtils.generateQI(["nsIServiceWorkerUnregisterCallback"]),
          unregisterSucceeded: () => resolve(),
          unregisterFailed: () => reject(new ProtocolError("Failed to unregister")),
        },
        scopeURL
      );
    });
  }

  updateRegistration({ scopeURL }) {
    const registration = this._registrationByScope(scopeURL);
    manager().propagateSoftUpdate(registration.principal.originAttributes, scopeURL);
  }

  stopWorker({ versionId }) {
    this._worker(versionId).terminateWorker();
  }

  stopAllWorkers() {
    for (const registration of allRegistrations()) {
      for (const worker of workersOf(registration)) {
        if (worker.debugger) {
          worker.terminateWorker();
        }
      }
    }
  }

  // Gecko always lets the HTTP cache rules decide when a service worker
  // script is checked for updates; there is no mode that updates it on every
  // page load.
  setForceUpdateOnPageLoad({ forceUpdateOnPageLoad }) {
    if (forceUpdateOnPageLoad) {
      throw new ProtocolError("Updating service workers on every page load is not supported");
    }
  }

  _destroy() {
    this.disable();
  }
}
