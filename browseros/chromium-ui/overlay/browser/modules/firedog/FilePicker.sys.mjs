/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The file picker of a page's <input type=file>.
//
// The WASI build has only the headless toolkit, which registers no file
// picker: @mozilla.org/filepicker;1 (nsFilePickerSelector in
// widget/nsContentProcessWidgetFactory.h) asks the parent process for
// @mozilla.org/parent/filepicker;1, which each toolkit's nsFilePicker
// provides and nothing does here. Without it, HTMLInputElement fails to create
// a picker and clicking a file input does nothing. This module is that
// parent-process picker. On Linux, Firefox hands the choice to the desktop
// (GTK's dialog or xdg-desktop-portal's FileChooser), outside the browser.
// FireDog does the same through its window: it asks the window (the firedog
// command, @progate/browser-gecko's shell/) with the event "pick-files", the
// window asks the windowserver, and the windowserver has the person choose
// (in BrowserOS's host page, from the files of their own computer). The
// windowserver writes what was chosen under /dev/shm/picker/ and the window
// answers with the command "picked-files" and their [{name, mime, path}].
//
// This needs FireDog's window (firedog.shell.embedded): the events and
// commands are the lines browseros/main.cpp carries for shell.js, which is what
// registers this picker.
//
// The windowserver answers one choice at a time, in order: when a second
// request comes before the first is answered, it answers the first with
// nothing. Pickers waiting for an answer therefore form a queue.
//
// A chosen file is read into memory when it arrives, and the page gets a File
// of those bytes. The windowserver deletes the files of one choice when the
// next is made, so a File that read from its path later (a form with two file
// inputs, sent after both were filled) would find the first one gone.

const CONTRACT_ID = "@mozilla.org/parent/filepicker;1";
const CLASS_ID = Components.ID("{79f0b01f-6f4d-4e78-b65f-21ce4fae6b36}");

// What the filter masks of nsIFilePicker.appendFilters mean, as an <input
// accept> list. HTMLInputElement turns "image/*", "audio/*" and "video/*"
// back into these masks; filterAll, filterApps and filterAllowURLs restrict
// nothing a host file input can say.
const MASK_ACCEPT = [
  [Ci.nsIFilePicker.filterHTML, [".html", ".htm"]],
  [Ci.nsIFilePicker.filterText, [".txt"]],
  [Ci.nsIFilePicker.filterImages, ["image/*"]],
  [Ci.nsIFilePicker.filterXML, [".xml"]],
  [Ci.nsIFilePicker.filterXUL, [".xul"]],
  [Ci.nsIFilePicker.filterAudio, ["audio/*"]],
  [Ci.nsIFilePicker.filterVideo, ["video/*"]],
  [Ci.nsIFilePicker.filterPDF, [".pdf"]],
];

const LocalFile = Components.Constructor(
  "@mozilla.org/file/local;1",
  "nsIFile",
  "initWithPath"
);

// Pickers that asked the window and wait for its answer, oldest first.
const waiting = [];

// Sends an event to FireDog's window, as shell.js does.
function sendToWindow(event, ...args) {
  Services.obs.notifyObservers(
    null,
    "firedog-shell-event",
    [event, ...args.map(arg => encodeURIComponent(arg))].join(" ")
  );
}

// The window's answer to the oldest request.
const answerObserver = {
  observe(subject, topic, data) {
    const [command, files] = data
      .split(" ")
      .map(word => decodeURIComponent(word));
    if (command != "picked-files") {
      return;
    }
    // An answer nobody waits for (the picker was dropped) is left alone.
    waiting.shift()?.settle(files);
  },
};

// The extensions of a filter as nsIFilePicker.appendFilter takes it
// ("*.png; *.jpg"), as <input accept> entries (".png", ".jpg"). "*" and
// "*.*" allow everything and add nothing.
function acceptOfPattern(pattern) {
  return pattern
    .split(";")
    .map(entry => entry.trim())
    .filter(entry => entry.startsWith("*.") && entry != "*.*")
    .map(entry => entry.slice(1));
}

function FilePicker() {
  this._accept = new Set();
  this._files = [];
  this._window = null;
  this._callback = null;
}

FilePicker.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIFilePicker"]),
  classID: CLASS_ID,

  defaultString: "",
  defaultExtension: "",
  filterIndex: 0,
  displayDirectory: null,
  displaySpecialDirectory: "",
  addToRecentDocs: false,
  okButtonLabel: "",
  capture: Ci.nsIFilePicker.captureNone,

  init(browsingContext, title, mode, relevantGlobal) {
    this._mode = mode;
    // The page's global: the Files are made in it, as the page reads them.
    this._window = relevantGlobal ?? browsingContext?.window ?? null;
  },

  get mode() {
    return this._mode;
  },

  // The host file input chooses files only, so FireDog cannot pick a folder
  // (<input webkitdirectory>) or a place to save to.
  isModeSupported(mode) {
    return Promise.resolve(
      mode == Ci.nsIFilePicker.modeOpen ||
        mode == Ci.nsIFilePicker.modeOpenMultiple
    );
  },

  appendFilters(mask) {
    for (const [bit, accept] of MASK_ACCEPT) {
      if (mask & bit) {
        accept.forEach(entry => this._accept.add(entry));
      }
    }
  },

  appendFilter(title, filter) {
    acceptOfPattern(filter).forEach(entry => this._accept.add(entry));
  },

  appendRawFilter(filter) {
    acceptOfPattern(filter).forEach(entry => this._accept.add(entry));
  },

  get file() {
    return this._files[0]?.file ?? null;
  },

  get fileURL() {
    const file = this.file;
    return file ? Services.io.newFileURI(file) : null;
  },

  get files() {
    return this._files.map(entry => entry.file)[Symbol.iterator]();
  },

  get domFileOrDirectory() {
    return this._files[0]?.domFile ?? null;
  },

  get domFileOrDirectoryEnumerator() {
    return this._files.map(entry => entry.domFile)[Symbol.iterator]();
  },

  get domFilesInWebKitDirectory() {
    throw Components.Exception("", Cr.NS_ERROR_NOT_IMPLEMENTED);
  },

  open(callback) {
    this._callback = callback;
    if (
      !this._window ||
      (this._mode != Ci.nsIFilePicker.modeOpen &&
        this._mode != Ci.nsIFilePicker.modeOpenMultiple)
    ) {
      this._done(Ci.nsIFilePicker.returnCancel);
      return;
    }
    waiting.push(this);
    sendToWindow(
      "pick-files",
      [...this._accept].join(","),
      this._mode == Ci.nsIFilePicker.modeOpenMultiple ? "1" : "0"
    );
  },

  // Reads what the window answered and tells the page. Nothing chosen (or
  // nothing readable) is a cancel, so the page gets its cancel event.
  async settle(answer) {
    let chosen = [];
    try {
      chosen = JSON.parse(answer);
    } catch (error) {
      console.error("FireDog file picker: unreadable answer", error);
    }
    const files = [];
    for (const { name, mime, path } of Array.isArray(chosen) ? chosen : []) {
      try {
        const bytes = await IOUtils.read(path);
        files.push({
          file: new LocalFile(path),
          domFile: new this._window.File([bytes], name, { type: mime ?? "" }),
        });
      } catch (error) {
        console.error(`FireDog file picker: cannot read ${path}`, error);
      }
    }
    this._files = files;
    this._done(
      files.length ? Ci.nsIFilePicker.returnOK : Ci.nsIFilePicker.returnCancel
    );
  },

  _done(result) {
    const callback = this._callback;
    this._callback = null;
    Services.tm.dispatchToMainThread(() => callback?.done(result));
  },
};

const factory = {
  createInstance(iid) {
    return new FilePicker().QueryInterface(iid);
  },
  QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
};

export const FireDogFilePicker = {
  // Registers the picker once per process. A build whose toolkit has its own
  // picker keeps that one.
  register() {
    const registrar = Components.manager.QueryInterface(
      Ci.nsIComponentRegistrar
    );
    if (registrar.isContractIDRegistered(CONTRACT_ID)) {
      return;
    }
    registrar.registerFactory(
      CLASS_ID,
      "FireDog file picker",
      CONTRACT_ID,
      factory
    );
    Services.obs.addObserver(answerObserver, "firedog-shell-command");
  },
};
