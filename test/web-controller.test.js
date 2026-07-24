import assert from "node:assert/strict";
import test from "node:test";

import { deferred, FakeElement, FakeResponse, installFakeBrowser } from "./helpers/fake-browser.js";

let importSequence = 0;

function session(id, title = id) {
  return {
    id,
    title,
    projectRoot: `/projects/${id}`,
    workbench: "execution",
    status: "ready",
    cursor: -1,
    steps: [],
    snapshots: [],
    annotations: [],
  };
}

function migrationSession(id = "migration", overrides = {}) {
  return {
    id,
    title: id,
    projectRoot: `/projects/${id}`,
    workbench: "migration",
    status: "ready",
    cursor: -1,
    steps: [{
      id: "step-1",
      title: "Inspect",
      description: "Read files",
      expected: "Understood",
      risk: "low",
      dependsOn: [],
      attempt: 0,
      status: "pending",
      action: { command: ["node", "inspect.js"], cwd: "." },
    }],
    snapshots: [],
    annotations: [],
    metadata: {},
    ...overrides,
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

test("plan editing is visible only for migration sessions and enabled only while pristine", async (t) => {
  const { browser, controller } = await loadController(t, () => {
    throw new Error("Unexpected fetch");
  });
  const edit = browser.element("edit-plan");

  controller.renderSession(session("execution"));
  assert.equal(edit.hidden, true);

  const pristine = migrationSession();
  controller.renderSession(pristine);
  assert.equal(edit.hidden, false);
  assert.equal(edit.disabled, false);
  assert.equal(controller.canEditPlan(pristine), true);

  for (const changed of [
    { cursor: 0 },
    { steps: [{ ...pristine.steps[0], status: "complete" }] },
    { snapshots: [{}] },
    { annotations: [{ stepIndex: 0, text: "note" }] },
    { status: "running", steps: [{ ...pristine.steps[0], status: "running" }] },
  ]) {
    const ineligible = { ...pristine, ...changed };
    controller.renderSession(ineligible);
    assert.equal(edit.hidden, false);
    assert.equal(edit.disabled, true);
    assert.equal(controller.canEditPlan(ineligible), false);
  }
});

test("disabled plan editing explains why it is unavailable", async (t) => {
  const { browser, controller } = await loadController(t, () => {
    throw new Error("Unexpected fetch");
  });
  const edit = browser.element("edit-plan");

  controller.renderSession(migrationSession("started", { cursor: 0 }));

  assert.equal(edit.hidden, false);
  assert.equal(edit.disabled, true);
  assert.equal(edit.getAttribute("aria-describedby"), "edit-plan-reason");
  assert.match(edit.getAttribute("title"), /only before the migration starts/i);
});

test("opening the plan editor deep-clones and safely renders untrusted plan values", async (t) => {
  const { browser, controller } = await loadController(t, () => {
    throw new Error("Unexpected fetch");
  });
  const attack = '<img src=x onerror="globalThis.pwned=true">';
  const active = migrationSession("safe", {
    steps: [{
      id: "step-x",
      title: attack,
      description: attack,
      expected: attack,
      status: "pending",
      action: { command: [attack], cwd: attack },
    }],
  });
  controller.renderSession(active);

  browser.element("edit-plan").onclick();

  assert.equal(browser.element("plan-editor").open, true);
  assert.notEqual(controller.state.planEditor.draft.steps, active.steps);
  const html = browser.element("plan-editor-steps").innerHTML;
  assert.doesNotMatch(html, /<img\b/i);
  assert.match(html, /&lt;img src=x onerror=&quot;globalThis\.pwned=true&quot;&gt;/);
  assert.match(html, /class="plan-step"/);
  assert.match(html, /class="plan-step-index"/);
  assert.match(html, /class="plan-step-title"/);
  assert.match(html, /class="plan-step-content"/);
  const summary = html.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? "";
  assert.doesNotMatch(summary, /<button\b/);
  assert.equal(browser.document.activeElement, browser.element("plan-editor-add"));
  assert.match(html, /data-action="move-up"[^>]*disabled/);
  assert.match(html, /data-action="move-down"[^>]*disabled/);
});

test("saving a plan sends one exact PUT and duplicate saves never run a command", async (t) => {
  const save = deferred();
  let putCount = 0;
  const { browser, controller } = await loadController(t, (path, options) => {
    if (path === "/api/sessions/migration/plan" && options.method === "PUT") {
      putCount += 1;
      return save.promise;
    }
    throw new Error(`Unexpected fetch ${path}`);
  });
  const active = migrationSession();
  controller.renderSession(active);
  controller.openPlanEditor();

  const first = controller.savePlan();
  const second = controller.savePlan();
  assert.equal(putCount, 1);
  assert.equal(controller.state.planEditor.saving, true);
  assert.equal(browser.element("plan-editor-save").disabled, true);
  const request = browser.requests.find(({ path }) => path.endsWith("/plan"));
  assert.deepEqual(JSON.parse(request.options.body), {
    steps: [{
      id: "step-1",
      title: "Inspect",
      description: "Read files",
      expected: "Understood",
      risk: "low",
      dependsOn: [],
      action: { command: ["node", "inspect.js"], cwd: "." },
    }],
  });
  assert.equal(browser.requests.some(({ path }) => path.includes("/run")), false);

  const saved = migrationSession("migration", {
    title: "Saved by server",
    steps: [{ ...active.steps[0], title: "Normalized by server" }],
  });
  save.resolve(new FakeResponse(saved));
  await Promise.all([first, second]);
  assert.equal(controller.state.active.title, "Saved by server");
  assert.equal(browser.element("session-title").textContent, "Saved by server");
  assert.match(browser.element("migration-view").innerHTML, /Normalized by server/);
  assert.equal(browser.element("plan-editor").open, false);
  assert.equal(controller.state.planEditor.saving, false);
});

test("plan editor renders stable ids, risk controls, and only earlier dependency checkboxes", async (t) => {
  const { browser, controller } = await loadController(t, () => {
    throw new Error("Unexpected fetch");
  });
  controller.renderSession(migrationSession("metadata", {
    steps: [
      {
        id: "prepare-project",
        title: "Prepare project",
        description: "Read files",
        expected: "Ready",
        risk: "medium",
        dependsOn: [],
        attempt: 0,
        status: "pending",
        action: { command: ["node", "prepare.js"], cwd: "." },
      },
      {
        id: "install-runtime",
        title: "Install runtime",
        description: "Apply changes",
        expected: "Installed",
        risk: "high",
        dependsOn: ["prepare-project"],
        attempt: 0,
        status: "pending",
        action: { command: ["node", "install.js"], cwd: "." },
      },
    ],
  }));

  browser.element("edit-plan").onclick();

  const html = browser.element("plan-editor-steps").innerHTML;
  assert.match(html, /Step ID/);
  assert.match(html, /data-field="risk" data-step-index="0"/);
  assert.match(html, /data-field="risk" data-step-index="1"/);
  assert.match(html, /prepare-project/);
  assert.match(html, /install-runtime/);
  assert.match(html, /data-field="dependsOn" data-step-index="1" data-dependency-id="prepare-project"/);
  assert.doesNotMatch(html, /data-field="dependsOn" data-step-index="0"/);
});

test("risk and dependency controls update the draft immutably", async (t) => {
  const { browser, controller } = await loadController(t, () => {
    throw new Error("Unexpected fetch");
  });
  controller.renderSession(migrationSession("metadata", {
    steps: [
      {
        id: "prepare-project",
        title: "Prepare project",
        description: "Read files",
        expected: "Ready",
        risk: "medium",
        dependsOn: [],
        attempt: 0,
        status: "pending",
        action: { command: ["node", "prepare.js"], cwd: "." },
      },
      {
        id: "install-runtime",
        title: "Install runtime",
        description: "Apply changes",
        expected: "Installed",
        risk: "high",
        dependsOn: ["prepare-project"],
        attempt: 0,
        status: "pending",
        action: { command: ["node", "install.js"], cwd: "." },
      },
    ],
  }));
  browser.element("edit-plan").onclick();
  const steps = browser.element("plan-editor-steps");

  const initialDraft = controller.state.planEditor.draft;
  const risk = new FakeElement(browser.document);
  risk.dataset.field = "risk";
  risk.dataset.stepIndex = "1";
  risk.value = "low";
  steps.oninput({ target: risk });

  assert.notEqual(controller.state.planEditor.draft, initialDraft);
  assert.equal(initialDraft.steps[1].risk, "high");
  assert.equal(controller.state.planEditor.draft.steps[1].risk, "low");

  const riskDraft = controller.state.planEditor.draft;
  const dependency = new FakeElement(browser.document);
  dependency.dataset.field = "dependsOn";
  dependency.dataset.stepIndex = "1";
  dependency.dataset.dependencyId = "prepare-project";
  dependency.checked = false;
  steps.oninput({ target: dependency });

  assert.notEqual(controller.state.planEditor.draft, riskDraft);
  assert.deepEqual(riskDraft.steps[1].dependsOn, ["prepare-project"]);
  assert.deepEqual(controller.state.planEditor.draft.steps[1].dependsOn, []);
});

test("plan save lock survives close and reopen until the original PUT settles", async (t) => {
  const save = deferred();
  let putCount = 0;
  const { browser, controller } = await loadController(t, (path, options) => {
    if (path === "/api/sessions/migration/plan" && options.method === "PUT") {
      putCount += 1;
      return save.promise;
    }
    throw new Error(`Unexpected fetch ${path}`);
  });
  const active = migrationSession();
  controller.renderSession(active);
  controller.openPlanEditor();
  const first = controller.savePlan();

  controller.closePlanEditor();
  controller.openPlanEditor();
  assert.equal(browser.document.activeElement, browser.element("plan-editor-cancel"));
  await controller.savePlan();
  assert.equal(putCount, 1);
  assert.equal(browser.element("plan-editor").open, true);

  save.resolve(new FakeResponse(active));
  await first;
  assert.equal(browser.element("plan-editor").open, true);
  assert.equal(controller.state.planEditor.sessionId, "migration");
  assert.equal(browser.element("plan-editor-status").textContent, "Ready to save. No commands will be executed.");
  assert.equal(browser.element("plan-editor-status").className, "");
});

test("a stale plan response cannot close or overwrite an editor owned by another session", async (t) => {
  const save = deferred();
  const { browser, controller } = await loadController(t, (path, options) => {
    if (path === "/api/sessions/first/plan" && options.method === "PUT") return save.promise;
    throw new Error(`Unexpected fetch ${path}`);
  });
  controller.renderSession(migrationSession("first"));
  controller.openPlanEditor();
  const pending = controller.savePlan();

  controller.renderSession(migrationSession("second"));
  assert.equal(browser.element("edit-plan").disabled, false);
  browser.element("edit-plan").onclick();
  assert.equal(controller.state.planEditor.sessionId, "second");
  save.resolve(new FakeResponse(migrationSession("first", { title: "stale" })));
  await pending;

  assert.equal(controller.state.active.id, "second");
  assert.equal(controller.state.planEditor.sessionId, "second");
  assert.equal(browser.element("plan-editor").open, true);
});

test("bound plan controls update fields, steps, order, and argv through delegation", async (t) => {
  const { browser, controller } = await loadController(t, () => {
    throw new Error("Unexpected fetch");
  });
  controller.renderSession(migrationSession());
  browser.element("edit-plan").onclick();
  const steps = browser.element("plan-editor-steps");

  const title = new FakeElement(browser.document);
  const titleSummary = new FakeElement(browser.document);
  const titleCard = new FakeElement(browser.document);
  titleCard.classList.add("plan-step");
  titleCard.setQuerySelectorAll(".plan-step-title", [titleSummary]);
  title.parentElement = titleCard;
  title.dataset.field = "title";
  title.dataset.stepIndex = "0";
  title.value = "Renamed";
  steps.oninput({ target: title });
  assert.equal(controller.state.planEditor.draft.steps[0].title, "Renamed");
  assert.equal(titleSummary.textContent, "Renamed");

  browser.element("plan-editor-add").onclick();
  assert.equal(controller.state.planEditor.draft.steps.length, 2);
  assert.match(steps.innerHTML, /data-action="move-up" data-step-index="0"[^>]*disabled/);
  assert.match(steps.innerHTML, /data-action="move-down" data-step-index="1"[^>]*disabled/);

  const move = new FakeElement(browser.document);
  move.dataset.action = "move-up";
  move.dataset.stepIndex = "1";
  steps.onclick({ target: move });
  assert.equal(controller.state.planEditor.draft.steps[1].title, "Renamed");

  const toggle = new FakeElement(browser.document);
  const toggleCard = new FakeElement(browser.document);
  const actionFields = new FakeElement(browser.document);
  const actionControl = new FakeElement(browser.document);
  toggleCard.classList.add("plan-step");
  toggleCard.setQuerySelectorAll(".plan-action-fields", [actionFields]);
  toggleCard.setQuerySelectorAll('[data-action="add-argument"], [data-action="remove-argument"], [data-field="argument"], [data-field="cwd"]', [actionControl]);
  toggle.parentElement = toggleCard;
  toggle.dataset.field = "actionEnabled";
  toggle.dataset.stepIndex = "0";
  toggle.checked = true;
  steps.oninput({ target: toggle });
  assert.equal(actionFields.getAttribute("aria-disabled"), null);
  assert.equal(actionControl.disabled, false);
  const addArgument = new FakeElement(browser.document);
  addArgument.dataset.action = "add-argument";
  addArgument.dataset.stepIndex = "0";
  steps.onclick({ target: addArgument });
  const argument = new FakeElement(browser.document);
  argument.dataset.field = "argument";
  argument.dataset.stepIndex = "0";
  argument.dataset.argumentIndex = "0";
  argument.value = "npm";
  steps.oninput({ target: argument });
  assert.deepEqual(controller.state.planEditor.draft.steps[0].command, ["npm"]);

  const removeArgument = new FakeElement(browser.document);
  removeArgument.dataset.action = "remove-argument";
  removeArgument.dataset.stepIndex = "0";
  removeArgument.dataset.argumentIndex = "0";
  steps.onclick({ target: removeArgument });
  assert.deepEqual(controller.state.planEditor.draft.steps[0].command, []);

  const removeStep = new FakeElement(browser.document);
  removeStep.dataset.action = "remove-step";
  removeStep.dataset.stepIndex = "0";
  steps.onclick({ target: removeStep });
  steps.onclick({ target: { closest: () => removeStep } });
  assert.deepEqual(controller.state.planEditor.draft.steps, []);
  assert.match(steps.innerHTML, /class="plan-empty"/);
});

test("bound text input preserves rendered DOM while updating draft and validation in place", async (t) => {
  const { browser, controller } = await loadController(t, () => {
    throw new Error("Unexpected fetch");
  });
  controller.renderSession(migrationSession());
  browser.element("edit-plan").onclick();
  const steps = browser.element("plan-editor-steps");
  const originalHtml = steps.innerHTML;
  const originalWrites = steps.innerHTMLWriteCount;
  const card = new FakeElement(browser.document);
  const summaryTitle = new FakeElement(browser.document);
  card.classList.add("plan-step");
  card.setQuerySelectorAll(".plan-step-title", [summaryTitle]);
  const input = new FakeElement(browser.document);
  input.parentElement = card;
  input.dataset.field = "title";
  input.dataset.stepIndex = "0";
  input.value = "Inspect";

  steps.oninput({ target: input });
  assert.equal(steps.innerHTML, originalHtml);
  assert.equal(steps.innerHTMLWriteCount, originalWrites);

  input.value = "   ";

  steps.oninput({ target: input });

  assert.equal(steps.innerHTML, originalHtml);
  assert.equal(steps.innerHTMLWriteCount, originalWrites);
  assert.equal(controller.state.planEditor.draft.steps[0].title, "   ");
  assert.deepEqual(controller.state.planEditor.issues[0], {
    path: "/steps/0/title",
    message: "must be a non-empty string",
  });
  assert.equal(summaryTitle.textContent, "Untitled step 1");
  assert.equal(browser.element("plan-editor-save").disabled, true);
  assert.match(browser.element("plan-editor-status").textContent, /\/steps\/0\/title/);
  assert.equal(steps.querySelectorAll("[data-error-path]").find((node) => node.dataset.errorPath === "/steps/0/title").textContent, "must be a non-empty string");

  input.value = "Restored";
  steps.oninput({ target: input });
  assert.equal(steps.innerHTML, originalHtml);
  assert.equal(steps.innerHTMLWriteCount, originalWrites);
  assert.equal(summaryTitle.textContent, "Restored");
  assert.deepEqual(controller.state.planEditor.issues, []);
  assert.equal(browser.element("plan-editor-save").disabled, false);
});

test("same-session events preserve an open dirty plan draft and make saving stale", async (t) => {
  const active = migrationSession();
  const { browser, controller } = await loadController(t, (path) => {
    if (path === "/api/sessions/migration") return new FakeResponse(active);
    throw new Error(`Unexpected fetch ${path}`);
  });
  await controller.openSession("migration");
  browser.element("edit-plan").onclick();
  const generation = controller.state.planEditor.dialogGeneration;
  const title = new FakeElement(browser.document);
  title.dataset.field = "title";
  title.dataset.stepIndex = "0";
  title.value = "Local unsaved title";
  browser.element("plan-editor-steps").oninput({ target: title });
  const draft = controller.state.planEditor.draft;

  browser.eventSources[0].onmessage({ data: JSON.stringify({
    ...active,
    cursor: 0,
    steps: [{ ...active.steps[0], status: "completed" }],
  }) });

  assert.equal(browser.element("plan-editor").open, true);
  assert.equal(controller.state.planEditor.draft, draft);
  assert.equal(controller.state.planEditor.draft.steps[0].title, "Local unsaved title");
  assert.equal(controller.state.planEditor.sessionId, "migration");
  assert.equal(controller.state.planEditor.dialogGeneration, generation);
  assert.equal(browser.element("plan-editor-save").disabled, true);
  assert.match(browser.element("plan-editor-status").textContent, /server state changed/i);
});

test("a late plan save response cannot replace newer same-session server state", async (t) => {
  const active = migrationSession();
  const save = deferred();
  const { browser, controller } = await loadController(t, (path, options) => {
    if (path === "/api/sessions/migration") return new FakeResponse(active);
    if (path === "/api/sessions/migration/plan" && options.method === "PUT") return save.promise;
    throw new Error(`Unexpected fetch ${path}`);
  });
  await controller.openSession("migration");
  browser.element("edit-plan").onclick();
  const title = new FakeElement(browser.document);
  title.dataset.field = "title";
  title.dataset.stepIndex = "0";
  title.value = "Exact local draft";
  browser.element("plan-editor-steps").oninput({ target: title });
  const draft = controller.state.planEditor.draft;
  const pending = controller.savePlan();
  const newer = {
    ...active,
    cursor: 0,
    steps: [{ ...active.steps[0], status: "completed" }],
  };

  browser.eventSources[0].onmessage({ data: JSON.stringify(newer) });
  save.resolve(new FakeResponse(migrationSession("migration", { title: "Late save" })));
  await pending;

  assert.deepEqual(controller.state.active, newer);
  assert.equal(browser.element("plan-editor").open, true);
  assert.equal(controller.state.planEditor.draft, draft);
  assert.equal(controller.state.planEditor.draft.steps[0].title, "Exact local draft");
  assert.equal(controller.state.planEditor.stale, true);
  assert.equal(browser.element("plan-editor-save").disabled, true);
  assert.match(browser.element("plan-editor-status").textContent, /server state changed/i);
});

test("a current plan save failure retains the dialog and reports the protocol pointer", async (t) => {
  const { browser, controller } = await loadController(t, (path, options) => {
    if (path === "/api/sessions/migration/plan" && options.method === "PUT") {
      return new FakeResponse({
        error: "Invalid plan",
        details: [{ path: "/steps/0/title", message: "is required" }],
      }, { ok: false });
    }
    throw new Error(`Unexpected fetch ${path}`);
  });
  controller.renderSession(migrationSession());
  browser.element("edit-plan").onclick();
  const draft = controller.state.planEditor.draft;

  await browser.element("plan-editor-save").onclick();

  assert.equal(browser.element("plan-editor").open, true);
  assert.equal(controller.state.planEditor.draft, draft);
  assert.match(browser.element("plan-editor-status").textContent, /\/steps\/0\/title: is required/);
  assert.equal(controller.state.planEditor.saving, false);
  assert.equal(browser.element("plan-editor-save").disabled, false);
});

test("migration runtime shows status, risk, dependencies, attempts, and awaiting review controls", async (t) => {
  const { browser, controller } = await loadController(t, () => {
    throw new Error("Unexpected fetch");
  });
  controller.renderSession(migrationSession("review", {
    status: "awaiting_review",
    cursor: 0,
    steps: [
      {
        id: "prepare-project",
        title: "Prepare project",
        description: "Read files",
        expected: "Ready",
        risk: "high",
        dependsOn: [],
        attempt: 2,
        status: "awaiting_review",
        action: { command: ["node", "prepare.js"], cwd: "." },
      },
      {
        id: "install-runtime",
        title: "Install runtime",
        description: "Apply changes",
        expected: "Installed",
        risk: "medium",
        dependsOn: ["prepare-project"],
        attempt: 0,
        status: "pending",
        action: { command: ["node", "install.js"], cwd: "." },
      },
    ],
  }));

  assert.match(browser.element("migration-view").innerHTML, /prepare-project/);
  assert.match(browser.element("migration-view").innerHTML, /Risk/i);
  assert.match(browser.element("migration-view").innerHTML, /Attempt/i);
  assert.match(browser.element("migration-view").innerHTML, /Depends on/i);
  assert.equal(browser.element("run-next").hidden, true);
  assert.equal(browser.element("review-accept").hidden, false);
  assert.equal(browser.element("review-reject").hidden, false);
  assert.match(browser.element("review-accept").textContent, /Accept step 1/i);
  assert.match(browser.element("review-reject").textContent, /Reject step 1/i);
});

test("accept review sends the exact decision body, locks controls, and ignores stale responses", async (t) => {
  const review = deferred();
  const { browser, controller } = await loadController(t, (path, options) => {
    if (path === "/api/sessions/first/steps/0/review" && options.method === "POST") return review.promise;
    throw new Error(`Unexpected fetch ${path}`);
  });
  controller.renderSession(migrationSession("first", {
    status: "awaiting_review",
    cursor: 0,
    steps: [{
      id: "prepare-project",
      title: "Prepare project",
      description: "Read files",
      expected: "Ready",
      risk: "medium",
      dependsOn: [],
      attempt: 1,
      status: "awaiting_review",
      action: { command: ["node", "prepare.js"], cwd: "." },
    }],
  }));

  const pending = browser.element("review-accept").onclick();
  assert.equal(browser.element("review-accept").disabled, true);
  assert.equal(browser.element("review-reject").disabled, true);
  const request = browser.requests.at(-1);
  assert.equal(request.path, "/api/sessions/first/steps/0/review");
  assert.deepEqual(JSON.parse(request.options.body), { decision: "accept" });

  controller.renderSession(migrationSession("second"));
  review.resolve(new FakeResponse(migrationSession("first", {
    status: "completed",
    cursor: 0,
    steps: [{
      id: "prepare-project",
      title: "Prepare project",
      description: "Read files",
      expected: "Ready",
      risk: "medium",
      dependsOn: [],
      attempt: 1,
      status: "completed",
      review: { decision: "accept", reviewedAt: "2026-07-24T00:00:00.000Z" },
      action: { command: ["node", "prepare.js"], cwd: "." },
    }],
  })));
  await pending;

  assert.equal(controller.state.active.id, "second");
  assert.equal(browser.element("review-accept").hidden, true);
});

test("global pending action disables newly opened session controls and suppresses a second request", async (t) => {
  const firstReview = deferred();
  const { browser, controller } = await loadController(t, (path, options) => {
    if (path === "/api/sessions/first/steps/0/review" && options.method === "POST") return firstReview.promise;
    throw new Error(`Unexpected fetch ${path}`);
  });
  controller.renderSession(migrationSession("first", {
    status: "awaiting_review",
    cursor: 0,
    steps: [{
      id: "prepare-project",
      title: "Prepare project",
      description: "Read files",
      expected: "Ready",
      risk: "medium",
      dependsOn: [],
      attempt: 1,
      status: "awaiting_review",
      action: { command: ["node", "prepare.js"], cwd: "." },
    }],
  }));

  const pending = browser.element("review-accept").onclick();
  const requestCount = browser.requests.length;

  controller.renderSession(migrationSession("second", {
    status: "failed",
    cursor: 0,
    steps: [{
      id: "install-runtime",
      title: "Install runtime",
      description: "Apply changes",
      expected: "Installed",
      risk: "medium",
      dependsOn: [],
      attempt: 1,
      status: "failed",
      action: { command: ["node", "install.js"], cwd: "." },
    }],
  }));

  assert.equal(browser.element("run-next").hidden, false);
  assert.equal(browser.element("run-next").disabled, true);
  await browser.element("run-next").onclick();
  assert.equal(browser.requests.length, requestCount);

  firstReview.resolve(new FakeResponse(migrationSession("first", {
    status: "completed",
    cursor: 0,
    steps: [{
      id: "prepare-project",
      title: "Prepare project",
      description: "Read files",
      expected: "Ready",
      risk: "medium",
      dependsOn: [],
      attempt: 1,
      status: "completed",
      review: { decision: "accept", reviewedAt: "2026-07-24T00:00:00.000Z" },
      action: { command: ["node", "prepare.js"], cwd: "." },
    }],
  })));
  await pending;
});

test("stale same-session review success does not overwrite newer SSE state", async (t) => {
  const review = deferred();
  const active = migrationSession("same", {
    status: "awaiting_review",
    cursor: 0,
    steps: [{
      id: "prepare-project",
      title: "Prepare project",
      description: "Read files",
      expected: "Ready",
      risk: "medium",
      dependsOn: [],
      attempt: 1,
      status: "awaiting_review",
      action: { command: ["node", "prepare.js"], cwd: "." },
    }],
  });
  const { browser, controller } = await loadController(t, (path, options) => {
    if (path === "/api/sessions/same") return new FakeResponse(active);
    if (path === "/api/sessions/same/steps/0/review" && options.method === "POST") return review.promise;
    throw new Error(`Unexpected fetch ${path}`);
  });
  await controller.openSession("same");

  const pending = browser.element("review-accept").onclick();
  const newer = {
    ...active,
    cursor: 0,
    annotations: [{ id: "note-1", stepIndex: 0, text: "newer note", createdAt: "2026-07-24T00:00:00.000Z" }],
  };
  browser.eventSources[0].onmessage({ data: JSON.stringify(newer) });

  review.resolve(new FakeResponse(migrationSession("same", {
    status: "completed",
    cursor: -1,
    annotations: [],
    steps: [{
      id: "prepare-project",
      title: "Prepare project",
      description: "Read files",
      expected: "Ready",
      risk: "medium",
      dependsOn: [],
      attempt: 1,
      status: "completed",
      review: { decision: "accept", reviewedAt: "2026-07-24T00:00:00.000Z" },
      action: { command: ["node", "prepare.js"], cwd: "." },
    }],
  })));
  await pending;

  assert.deepEqual(controller.state.active.annotations, newer.annotations);
  assert.equal(controller.state.active.cursor, 0);
  assert.match(browser.element("notes").innerHTML, /newer note/);
  assert.equal(browser.element("review-accept").disabled, false);
});

test("high-risk execution confirmation is precise, cancellation is inert, and retry labels are visible", async (t) => {
  const { browser, controller } = await loadController(t, (path, options) => {
    if (path === "/api/sessions/high/steps/0/run" && options.method === "POST") {
      return new FakeResponse(migrationSession("high", {
        status: "awaiting_review",
        cursor: 0,
        steps: [{
          id: "prepare-project",
          title: "Prepare project",
          description: "Read files",
          expected: "Ready",
          risk: "high",
          dependsOn: [],
          attempt: 1,
          status: "awaiting_review",
          action: { command: ["node", "prepare.js"], cwd: "." },
        }],
      }));
    }
    throw new Error(`Unexpected fetch ${path}`);
  });
  const confirms = [];
  globalThis.confirm = (message) => {
    confirms.push(message);
    return false;
  };
  controller.renderSession(migrationSession("high", {
    status: "failed",
    cursor: 0,
    steps: [{
      id: "prepare-project",
      title: "Prepare project",
      description: "Read files",
      expected: "Ready",
      risk: "high",
      dependsOn: [],
      attempt: 1,
      status: "failed",
      action: { command: ["node", "prepare.js"], cwd: "." },
    }],
  }));

  assert.match(browser.element("run-next").textContent, /Retry step 1/i);
  const requestCount = browser.requests.length;
  await browser.element("run-next").onclick();
  assert.equal(browser.requests.length, requestCount);
  assert.match(confirms[0], /Prepare project/);
  assert.match(confirms[0], /prepare-project/);
  assert.match(confirms[0], /Risk: high/);

  globalThis.confirm = (message) => {
    confirms.push(message);
    return true;
  };
  await browser.element("run-next").onclick();

  const request = browser.requests.findLast(({ path }) => path.endsWith("/steps/0/run"));
  assert.equal(request.path, "/api/sessions/high/steps/0/run");
  assert.deepEqual(JSON.parse(request.options.body), {
    confirmed: true,
    confirmedRisk: true,
  });
});
