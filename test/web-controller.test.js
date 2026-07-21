import assert from "node:assert/strict";
import test from "node:test";

import { deferred, FakeResponse, installFakeBrowser } from "./helpers/fake-browser.js";

let importSequence = 0;

function session(id, title = id) {
  return {
    id,
    title,
    projectRoot: `/projects/${id}`,
    workbench: "execution",
    status: "idle",
    cursor: -1,
    steps: [],
    snapshots: [],
    annotations: [],
  };
}

async function loadController(t, route) {
  const browser = installFakeBrowser((path, options) => {
    if (path === "/api/health") return new FakeResponse({ allowedRoot: "/projects" });
    if (path === "/api/sessions" && !options.method) return new FakeResponse([]);
    if (path === "/api/projects/recent") return new FakeResponse([]);
    return route(path, options);
  });
  t.after(() => browser.restore());
  const module = await import(`../apps/web/app.js?controller-test=${++importSequence}`);
  return { browser, controller: module.__testing };
}

test("openSession gives the latest request and EventSource exclusive ownership", async (t) => {
  const first = deferred();
  const second = deferred();
  let repeated = null;
  const { browser, controller } = await loadController(t, (path) => {
    if (path === "/api/sessions/first") return first.promise;
    if (path === "/api/sessions/second" && !repeated) return second.promise;
    if (path === "/api/sessions/second") return repeated.promise;
    throw new Error(`Unexpected fetch ${path}`);
  });

  const firstOpen = controller.openSession("first");
  const secondOpen = controller.openSession("second");
  second.resolve(new FakeResponse(session("second", "fresh second")));
  await secondOpen;

  const freshSource = browser.eventSources[0];
  assert.equal(controller.state.active.title, "fresh second");
  assert.equal(freshSource.url, "/api/sessions/second/events");

  first.resolve(new FakeResponse(session("first", "stale first")));
  await firstOpen;
  assert.equal(controller.state.active.title, "fresh second");
  assert.equal(browser.eventSources.length, 1);
  assert.equal(freshSource.closed, false);

  const oldHandler = freshSource.onmessage;
  repeated = deferred();
  const repeatedOpen = controller.openSession("second");
  repeated.resolve(new FakeResponse(session("second", "new owner")));
  await repeatedOpen;

  assert.equal(freshSource.closed, true);
  assert.equal(freshSource.onmessage, null);
  assert.equal(controller.state.active.title, "new owner");
  oldHandler({ data: JSON.stringify(session("second", "old payload")) });
  assert.equal(controller.state.active.title, "new owner");
  assert.equal(browser.eventSources[1].closed, false);
});

test("session creation lock survives dialog close and reopen until POST settles", async (t) => {
  const creation = deferred();
  let postCount = 0;
  const { browser, controller } = await loadController(t, (path, options) => {
    if (path === "/api/sessions" && options.method === "POST") {
      postCount += 1;
      return creation.promise;
    }
    throw new Error(`Unexpected fetch ${path}`);
  });

  const draft = {
    title: "Demo",
    workbench: "execution",
    projectRoot: "/projects/demo",
    steps: [],
  };
  controller.openOnboarding();
  controller.state.onboarding.inspection = { projectRoot: "/projects/demo" };
  controller.state.onboarding.draft = draft;
  const firstCreate = controller.createOnboardingSession();
  const creationControlIds = [
    "project-path",
    "onboarding-inspect",
    "onboarding-config",
    "onboarding-preview-action",
    "onboarding-create",
  ];
  assert.equal(postCount, 1);
  assert.equal(controller.state.onboarding.creating, true);
  creationControlIds.forEach((id) => assert.equal(browser.element(id).disabled, true, id));

  browser.element("project-onboarding").close();
  controller.openOnboarding();
  controller.state.onboarding.inspection = { projectRoot: "/projects/demo" };
  controller.state.onboarding.draft = draft;
  await controller.createOnboardingSession();
  assert.equal(postCount, 1);
  assert.equal(controller.state.onboarding.creating, true);
  creationControlIds.forEach((id) => assert.equal(browser.element(id).disabled, true, id));

  creation.resolve(new FakeResponse({ id: "created" }));
  await firstCreate;
  assert.equal(controller.state.onboarding.creating, false);
  creationControlIds.forEach((id) => assert.equal(browser.element(id).disabled, false, id));
});

test("bound draft field handler invalidates preview and disables creation", async (t) => {
  const { browser, controller } = await loadController(t, (path) => {
    throw new Error(`Unexpected fetch ${path}`);
  });
  controller.state.onboarding.inspection = { projectRoot: "/projects/demo" };
  controller.state.onboarding.draft = { title: "Ready" };
  browser.element("onboarding-create").disabled = false;

  browser.element("onboarding-session-title").oninput();

  assert.equal(controller.state.onboarding.draft, null);
  assert.equal(browser.element("onboarding-create").disabled, true);
  assert.match(browser.element("onboarding-status").textContent, /Preview the safety gate again/);
});

test("inspection and preview render untrusted values only as escaped HTML", async (t) => {
  const { browser, controller } = await loadController(t, (path) => {
    throw new Error(`Unexpected fetch ${path}`);
  });
  const attack = '<img src=x onerror="globalThis.pwned=true">';

  controller.renderInspection({
    git: true,
    packageManager: attack,
    languages: [attack],
    frameworks: [attack],
    evidence: [attack],
    warnings: [attack],
  });
  controller.state.onboarding.allowedRoot = attack;
  controller.renderOnboardingPreview({
    title: attack,
    workbench: attack,
    projectRoot: attack,
    steps: [{ title: attack, action: { command: [attack], cwd: attack } }],
  });

  const html = [
    browser.element("detection-facts").innerHTML,
    browser.element("detection-evidence").innerHTML,
    browser.element("detection-warnings").innerHTML,
    browser.element("onboarding-preview").innerHTML,
  ].join("\n");
  assert.doesNotMatch(html, /<img\b/i);
  assert.match(html, /&lt;img src=x onerror=&quot;globalThis\.pwned=true&quot;&gt;/);
});
