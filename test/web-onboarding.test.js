import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOnboardingInput,
  formatApiError,
  parseSessionImport,
  summarizeOnboarding,
} from "../apps/web/onboarding.js";

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
