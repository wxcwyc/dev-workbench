import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  buildOnboardingInput,
  formatApiError,
  parseSessionImport,
  summarizeOnboarding,
} from "../apps/web/onboarding.js";

test("onboarding dialog exposes labeled stages and actions", async () => {
  const [html, styles, app] = await Promise.all([
    fs.readFile(new URL("../apps/web/index.html", import.meta.url), "utf8"),
    fs.readFile(new URL("../apps/web/styles.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../apps/web/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="open-project"/);
  assert.match(html, /id="open-project-mobile"/);
  assert.match(html, /<dialog[^>]+id="project-onboarding"/);
  assert.match(html, /<form[^>]+id="project-inspect-form"/);
  assert.match(html, /<label[^>]+for="project-path"/);
  assert.match(html, /<input[^>]+id="project-path"/);
  assert.match(html, /id="onboarding-create"/);
  assert.match(html, /id="onboarding-preview"[^>]+aria-live="polite"/);
  assert.match(html, /id="onboarding-status"[^>]+aria-live="polite"/);
  assert.match(html, /id="onboarding-close"[^>]+aria-label="Close project onboarding"/);
  assert.match(styles, /#project-onboarding \.onboarding-file input\{[^}]*display:block;[^}]*position:absolute/);
  assert.match(styles, /#project-onboarding \.onboarding-file:focus-within\{/);
  assert.match(styles, /#project-onboarding \.onboarding-status\{[^}]*max-height:[^;}]+;[^}]*overflow:auto/);
  assert.match(styles, /#project-onboarding button,#project-onboarding input,#project-onboarding select,#project-onboarding textarea\{font:inherit}/);
  const fileHandler = app.slice(app.indexOf('$("#onboarding-file").onchange'));
  assert.ok(fileHandler.indexOf("invalidateOnboardingPreview()") < fileHandler.indexOf("await file.text()"));
  const createHandler = app.slice(app.indexOf("async function createOnboardingSession"));
  assert.match(createHandler, /async function createOnboardingSession\(\)\{\n  if\(state\.onboarding\.creating\)return;/);
  assert.match(createHandler, /state\.onboarding\.recentRequest\+=1;/);
  assert.ok(createHandler.indexOf("state.onboarding.recentRequest+=1") < createHandler.indexOf('await api("/api/sessions"'));
  assert.match(createHandler, /finally\{\n    if\(request===state\.onboarding\.creationRequest\)state\.onboarding\.creating=false;\n    if\(generation!==state\.onboarding\.dialogGeneration&&request===state\.onboarding\.creationRequest\)setOnboardingCreating\(false\);\n  }/);
  assert.equal(createHandler.match(/refreshRecentProjects\(false\)/g)?.length,3);
  assert.match(createHandler, /if\(generation!==state\.onboarding\.dialogGeneration\)\{\n    if\(\$\("#project-onboarding"\)\.open\)setOnboardingStatus\(creationError\?`Session creation failed: \$\{creationError\.message}`:"Session created\. You can inspect another project\.",creationError\?"error":"success"\);/);
  assert.match(createHandler, /if\(generation!==state\.onboarding\.dialogGeneration\)\{[\s\S]*?refreshRecentProjects\(false\)/);
  const recentHandler = app.slice(app.indexOf("async function refreshRecentProjects"), app.indexOf("function resetOnboarding"));
  assert.match(recentHandler, /const request=\+\+state\.onboarding\.recentRequest;/);
  assert.match(recentHandler, /if\(generation!==state\.onboarding\.dialogGeneration\|\|request!==state\.onboarding\.recentRequest\)return;/);
  assert.ok(recentHandler.indexOf('await api("/api/projects/recent")') < recentHandler.indexOf("if(generation!==state.onboarding.dialogGeneration||request!==state.onboarding.recentRequest)return"));
  assert.ok(recentHandler.indexOf("if(generation!==state.onboarding.dialogGeneration||request!==state.onboarding.recentRequest)return") < recentHandler.indexOf("state.onboarding.recent="));
  assert.match(recentHandler, /if\(reportError&&!state\.onboarding\.creating&&\$\("#project-onboarding"\)\.open\)setOnboardingStatus/);
  const resetHandler = app.slice(app.indexOf("function resetOnboarding"), app.indexOf("function openOnboarding"));
  assert.doesNotMatch(resetHandler, /state\.onboarding\.creating=false/);
  assert.doesNotMatch(app, /onclose=[^\n]*state\.onboarding\.creating=false/);
  assert.match(fileHandler, /finally\{\n    if\(event\.target\.files\?\.\[0\]===file\)event\.target\.value="";\n  }/);
  const sessionsHandler = app.slice(app.indexOf("async function refreshSessions"), app.indexOf("async function openSession"));
  assert.match(sessionsHandler, /const request=\+\+state\.sessionsRequest;/);
  assert.match(sessionsHandler, /if\(request!==state\.sessionsRequest\)return;/);
  const openHandler = app.slice(app.indexOf("async function openSession"), app.indexOf("async function seek"));
  assert.match(openHandler, /const request=\+\+state\.openSessionRequest;/);
  assert.match(openHandler, /catch\(error\)\{\n    if\(request!==state\.openSessionRequest\)return;/);
  assert.match(openHandler, /}\n  if\(request!==state\.openSessionRequest\)return;\n  if\(state\.events\)\{state\.events\.onmessage=null;state\.events\.close\(\);}/);
  const openFreshness = openHandler.lastIndexOf("if(request!==state.openSessionRequest)return");
  assert.ok(openHandler.indexOf("await api(") < openFreshness);
  assert.ok(openFreshness < openHandler.indexOf("state.events.close()"));
  assert.ok(openFreshness < openHandler.indexOf("renderSession(session)"));
  assert.ok(openFreshness < openHandler.indexOf("new EventSource("));
  assert.match(openHandler, /const sessionEvents=new EventSource\(/);
  assert.match(openHandler, /state\.events=sessionEvents;/);
  const eventHandler = openHandler.slice(openHandler.indexOf("sessionEvents.onmessage"));
  assert.match(eventHandler, /if\(state\.events!==sessionEvents\)return;/);
  assert.ok(eventHandler.indexOf("if(state.events!==sessionEvents)return") < eventHandler.indexOf("renderSession("));
});

test("parseSessionImport parses an object and treats whitespace as no import", () => {
  assert.deepEqual(parseSessionImport('{"steps":[]}'), { steps: [] });
  assert.equal(parseSessionImport(" \n\t "), null);
});

test("parseSessionImport reports one-based line and column for invalid JSON", () => {
  assert.throws(
    () => parseSessionImport("{\n  x: 1}"),
    /Invalid JSON at line 2, column 3/,
  );
});

test("parseSessionImport counts CR-only and CRLF line endings correctly", () => {
  for (const text of ["{\r  x: 1}", "{\r\n  x: 1}"]) {
    assert.throws(
      () => parseSessionImport(text),
      /Invalid JSON at line 2, column 3/,
      JSON.stringify(text),
    );
  }
});

test("parseSessionImport falls back when the JSON error has no character position", () => {
  assert.throws(
    () => parseSessionImport("[1,"),
    /^Error: Invalid JSON: Unexpected end of JSON input$/,
  );
});

test("parseSessionImport rejects valid JSON values that are not objects", () => {
  for (const text of ["[]", "null", '"text"', "42", "true"]) {
    assert.throws(
      () => parseSessionImport(text),
      /Imported session must be an object/,
      text,
    );
  }
});

test("buildOnboardingInput trusts the inspection and current form fields", () => {
  const imported = {
    schemaVersion: 1,
    title: "Untrusted title",
    workbench: "migration",
    projectRoot: "/untrusted",
    steps: [{ title: "Install", action: { command: ["npm", "install"] } }],
    metadata: { sourceLabel: "Legacy" },
  };

  const input = buildOnboardingInput({
    inspection: { projectRoot: "/allowed/site" },
    workbench: "migration",
    title: "Move site",
    imported,
  });

  assert.deepEqual(input, {
    schemaVersion: 1,
    title: "Move site",
    workbench: "migration",
    projectRoot: "/allowed/site",
    steps: [{ title: "Install", action: { command: ["npm", "install"] } }],
    metadata: { sourceLabel: "Legacy" },
  });
  assert.notEqual(input, imported);
  assert.notEqual(input.steps, imported.steps);
  input.steps[0].title = "Changed clone";
  assert.equal(imported.steps[0].title, "Install");
  assert.equal(imported.title, "Untrusted title");
  assert.equal(imported.projectRoot, "/untrusted");
});

test("buildOnboardingInput rejects an imported workbench mismatch", () => {
  assert.throws(
    () => buildOnboardingInput({
      inspection: { projectRoot: "/allowed/site" },
      workbench: "migration",
      title: "Move site",
      imported: { workbench: "execution", trace: [] },
    }),
    /Imported workbench execution does not match selected workbench migration/,
  );
});

test("buildOnboardingInput creates an empty plan without an import", () => {
  assert.deepEqual(buildOnboardingInput({
    inspection: { projectRoot: "/allowed/site" },
    workbench: "execution",
    title: "Inspect site",
  }), {
    title: "Inspect site",
    workbench: "execution",
    projectRoot: "/allowed/site",
    steps: [],
  });
});

test("buildOnboardingInput validates basic inspection, workbench, and title input", () => {
  assert.throws(
    () => buildOnboardingInput({ inspection: {}, workbench: "migration", title: "Move" }),
    /inspection\.projectRoot must be a non-empty string/,
  );
  assert.throws(
    () => buildOnboardingInput({ inspection: { projectRoot: "/allowed/site" }, workbench: "other", title: "Move" }),
    /workbench must be execution or migration/,
  );
  assert.throws(
    () => buildOnboardingInput({ inspection: { projectRoot: "/allowed/site" }, workbench: "migration", title: " " }),
    /title must be a non-empty string/,
  );
});

test("summarizeOnboarding previews commands, cwd, impact, and safe defaults", () => {
  const summary = summarizeOnboarding({
    steps: [
      {},
      { title: "Install", action: { command: ["npm", "install"], cwd: "target" } },
    ],
  });

  assert.deepEqual(summary, {
    steps: [
      { title: "Step 1", command: "", cwd: ".", impact: "observation" },
      { title: "Install", command: "npm install", cwd: "target", impact: "project-changing" },
    ],
  });
});

test("summarizeOnboarding preserves argv boundaries in a single display line", () => {
  const summary = summarizeOnboarding({
    steps: [{
      title: "Run tool",
      action: { command: ["tool", "two words", 'a"b', "line\nbreak", ""] },
    }],
  });

  assert.equal(summary.steps[0].command, 'tool "two words" "a\\"b" "line\\nbreak" ""');
  assert.equal(summary.steps[0].command.includes("\n"), false);
});

test("summarizeOnboarding gives malformed argv a stable fallback", () => {
  const summary = summarizeOnboarding({
    steps: [{ title: "Malformed", action: { command: ["tool", 42] } }],
  });

  assert.equal(summary.steps[0].command, "");
});

test("summarizeOnboarding previews execution trace items as observations", () => {
  assert.deepEqual(summarizeOnboarding({
    trace: [{ title: "Resolve goal" }, { title: "Backtrack" }],
  }), {
    steps: [
      { title: "Resolve goal", command: "", cwd: ".", impact: "observation" },
      { title: "Backtrack", command: "", cwd: ".", impact: "observation" },
    ],
  });
});

test("formatApiError includes protocol detail paths and has a fallback", () => {
  assert.equal(formatApiError({
    error: "Invalid session",
    details: [
      { path: "/steps/0/title", message: "is required" },
      { path: "/workbench", message: "is invalid" },
    ],
  }), "Invalid session\n/steps/0/title: is required\n/workbench: is invalid");
  assert.equal(formatApiError({ error: "Not found" }), "Not found");
  assert.equal(formatApiError(null), "Request failed");
});
