import assert from "node:assert/strict";

const elementIds = [
  "allowed-root", "detection-evidence", "detection-facts", "detection-warnings",
  "empty", "execution-view", "health", "latest", "logic-demo", "migration-demo",
  "migration-view", "next", "note-form", "note-text", "notes", "notes-title",
  "onboarding-close", "onboarding-config", "onboarding-create", "onboarding-detection",
  "onboarding-file", "onboarding-import", "onboarding-inspect", "onboarding-preview",
  "onboarding-preview-action", "onboarding-recent", "onboarding-session-title",
  "onboarding-status", "open-project", "open-project-mobile", "previous",
  "plan-editor", "plan-editor-add", "plan-editor-cancel", "plan-editor-save",
  "plan-editor-status", "plan-editor-steps", "edit-plan",
  "project-inspect-form", "project-onboarding", "project-path", "run-next",
  "session-file", "session-path", "session-status", "session-title", "sessions",
  "step-counter", "timeline", "workbench", "workbench-badge",
];

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export class FakeResponse {
  constructor(body, { ok = true } = {}) {
    this.body = body;
    this.ok = ok;
  }

  async json() {
    return this.body;
  }
}

class FakeClassList {
  constructor() {
    this.names = new Set();
  }

  add(...names) {
    names.forEach((name) => this.names.add(name));
  }

  remove(...names) {
    names.forEach((name) => this.names.delete(name));
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.names.has(name) : force;
    if (enabled) this.names.add(name);
    else this.names.delete(name);
    return enabled;
  }

  contains(name) {
    return this.names.has(name);
  }
}

export class FakeElement {
  constructor(document, id = "") {
    this.ownerDocument = document;
    this.id = id;
    this.classList = new FakeClassList();
    this.dataset = {};
    this.disabled = false;
    this.checked = false;
    this.files = [];
    this._innerHTML = "";
    this.renderedErrors = [];
    this.queryResults = new Map();
    this.attributes = new Map();
    this.hidden = false;
    this.open = false;
    this.textContent = "";
    this.value = "";
    this.parentElement = null;
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = value;
    this.renderedErrors = [...String(value).matchAll(/data-error-path="([^"]+)"/g)].map((match) => {
      const element = new FakeElement(this.ownerDocument);
      element.dataset.errorPath = match[1];
      return element;
    });
  }

  closest(selector) {
    if (selector.startsWith(".") && this.classList.contains(selector.slice(1))) return this;
    const key = selector.match(/^\[data-([a-z-]+)\]$/)?.[1]
      ?.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (key && Object.hasOwn(this.dataset, key)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setQuerySelectorAll(selector, elements) {
    this.queryResults.set(selector, elements);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  reset() {}

  replaceChildren(...children) {
    this.children = children;
    this.innerHTML = "";
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    if (selector === "[data-error-path]") return this.renderedErrors;
    return this.queryResults.get(selector) ?? [];
  }

  showModal() {
    this.open = true;
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.onclose?.();
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map(elementIds.map((id) => [id, new FakeElement(this, id)]));
    this.workbenches = ["execution", "migration"].map((value) => {
      const input = new FakeElement(this);
      input.value = value;
      input.checked = value === "execution";
      return input;
    });
  }

  querySelector(selector) {
    if (selector.startsWith("#")) return this.elements.get(selector.slice(1)) ?? null;
    if (selector === 'input[name="onboarding-workbench"]:checked') {
      return this.workbenches.find((input) => input.checked) ?? null;
    }
    const value = selector.match(/^input\[name="onboarding-workbench"\]\[value="([^"]+)"\]$/)?.[1];
    if (value) return this.workbenches.find((input) => input.value === value) ?? null;
    return null;
  }

  querySelectorAll(selector) {
    if (selector === 'input[name="onboarding-workbench"]') return this.workbenches;
    return [];
  }
}

export function installFakeBrowser(route = () => {
  throw new Error("Unexpected fetch");
}) {
  const globalNames = ["document", "alert", "confirm", "fetch", "EventSource"];
  const originalGlobals = new Map(globalNames.map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]));
  const document = new FakeDocument();
  const requests = [];
  const eventSources = [];

  globalThis.document = document;
  globalThis.alert = () => {};
  globalThis.confirm = () => true;
  globalThis.fetch = async (path, options = {}) => {
    requests.push({ path, options });
    return route(path, options);
  };
  globalThis.EventSource = class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.onmessage = null;
      eventSources.push(this);
    }

    close() {
      this.closed = true;
    }
  };

  return {
    document,
    eventSources,
    requests,
    restore() {
      eventSources.forEach((source) => {
        source.onmessage = null;
        source.close();
      });
      originalGlobals.forEach((descriptor, name) => {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      });
    },
    element(id) {
      const element = document.elements.get(id);
      assert.ok(element, `Unknown fake element #${id}`);
      return element;
    },
  };
}
