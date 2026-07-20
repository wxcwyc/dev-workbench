# Project Onboarding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users inspect an allowed local project, review detected tooling and an optional imported plan, then safely create an Execution or Migration session from the browser.

**Architecture:** Add a filesystem-only project inspector and a small recent-project store, expose both through the existing HTTP server, and keep `POST /api/sessions` as the sole creation path. Add testable browser-side draft/preview helpers, then connect them to a staged modal that preserves the existing visual system and never runs commands during onboarding.

**Tech Stack:** Node.js 22 built-ins, `node:test`, ES modules, filesystem JSON persistence, vanilla HTML/CSS/JavaScript.

---

### Task 1: Read-only project inspection

**Files:**
- Create: `packages/project-adapters/src/project-inspector.js`
- Create: `test/project-inspector.test.js`

**Step 1: Write failing detection tests**

Create temporary projects and assert the public result rather than implementation details:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectProject } from "../packages/project-adapters/src/project-inspector.js";

test("inspector detects Git, pnpm, languages, frameworks, and evidence", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-inspect-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".git"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }));
  await fs.writeFile(path.join(root, "src", "page.tsx"), "export default function Page() {}\n");

  const result = await inspectProject(root);

  assert.equal(result.git, true);
  assert.equal(result.packageManager, "pnpm");
  assert.deepEqual(result.languages, ["TypeScript"]);
  assert.deepEqual(result.frameworks, ["Next.js", "React"]);
  assert.ok(result.evidence.includes("pnpm-lock.yaml"));
  assert.deepEqual(result.warnings, []);
});

test("inspector keeps useful facts when package.json is malformed", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-inspect-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "package-lock.json"), "{}");
  await fs.writeFile(path.join(root, "package.json"), "{broken");
  await fs.writeFile(path.join(root, "main.py"), "print('ok')\n");

  const result = await inspectProject(root);

  assert.equal(result.packageManager, "npm");
  assert.deepEqual(result.languages, ["Python"]);
  assert.match(result.warnings[0], /package\.json/);
});
```

**Step 2: Run the tests and verify RED**

Run: `node --test test/project-inspector.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `project-inspector.js`.

**Step 3: Implement the smallest filesystem-only inspector**

Implement `inspectProject(projectRoot)` with these fixed tables and rules:

```js
const packageManagers = [
  ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"], ["bun.lock", "bun"], ["package-lock.json", "npm"]
];
const languageByExtension = new Map([
  [".ts", "TypeScript"], [".tsx", "TypeScript"], [".js", "JavaScript"],
  [".jsx", "JavaScript"], [".vue", "Vue"], [".svelte", "Svelte"],
  [".py", "Python"], [".go", "Go"], [".rs", "Rust"], [".java", "Java"],
  [".rb", "Ruby"], [".php", "PHP"], [".pl", "Prolog"]
]);
const frameworkDependencies = new Map([
  ["next", "Next.js"], ["react", "React"], ["vue", "Vue"],
  ["nuxt", "Nuxt"], ["astro", "Astro"], ["svelte", "Svelte"],
  ["@sveltejs/kit", "SvelteKit"], ["@angular/core", "Angular"],
  ["vite", "Vite"], ["express", "Express"]
]);
```

Use `captureFileTree(projectRoot, 2000)` to avoid a second walker. Count recognized file extensions and return languages sorted by descending count, then alphabetically. Detect `.git` with `fs.stat`, select the first present lockfile, fall back to `npm` when a valid `package.json` exists, combine dependencies and devDependencies for framework detection, sort framework names, deduplicate and sort evidence, and convert only optional-file read/parse failures into warnings.

Return exactly:

```js
{
  projectRoot,
  git,
  packageManager,
  languages,
  frameworks,
  evidence,
  warnings
}
```

**Step 4: Verify GREEN**

Run: `node --test test/project-inspector.test.js test/project-adapters.test.js`

Expected: all tests PASS.

**Step 5: Commit**

```bash
git add packages/project-adapters/src/project-inspector.js test/project-inspector.test.js
git commit -m "feat: inspect local project tooling"
```

### Task 2: Bounded recent-project persistence

**Files:**
- Create: `packages/execution-core/src/recent-project-store.js`
- Create: `test/recent-project-store.test.js`

**Step 1: Write failing persistence tests**

Cover deduplication, newest-first ordering, the maximum size, and corrupt-file recovery:

```js
test("recent projects are deduplicated and newest first", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-recent-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new RecentProjectStore(path.join(root, "recent-projects.json"), { limit: 2 });

  await store.record({ projectRoot: "/projects/one", workbench: "execution" });
  await store.record({ projectRoot: "/projects/two", workbench: "migration" });
  await store.record({ projectRoot: "/projects/one", workbench: "migration" });

  assert.deepEqual((await store.list()).map(({ projectRoot, workbench }) => ({ projectRoot, workbench })), [
    { projectRoot: "/projects/one", workbench: "migration" },
    { projectRoot: "/projects/two", workbench: "migration" }
  ]);
});

test("corrupt recent project state degrades to an empty list", async (context) => {
  // Create the file with invalid JSON and inject a warning collector.
  // Assert list() returns [] and the warning collector receives one message.
});
```

**Step 2: Run the tests and verify RED**

Run: `node --test test/recent-project-store.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

**Step 3: Implement atomic JSON storage**

Create `RecentProjectStore(filePath, { limit = 8, warn = console.warn } = {})` with:

- `list()` returning validated entries or `[]` for `ENOENT`/corrupt content;
- `record({ projectRoot, workbench })` removing the same canonical path, prepending `{ projectRoot, workbench, lastUsedAt: new Date().toISOString() }`, slicing to `limit`, and atomically writing through a PID-suffixed temporary file;
- schema filtering so malformed entries never reach the browser;
- no project existence check in `list()`.

**Step 4: Verify GREEN**

Run: `node --test test/recent-project-store.test.js`

Expected: all tests PASS with no uncaptured warning output.

**Step 5: Commit**

```bash
git add packages/execution-core/src/recent-project-store.js test/recent-project-store.test.js
git commit -m "feat: persist recently opened projects"
```

### Task 3: Inspection and recent-project HTTP APIs

**Files:**
- Modify: `apps/server/src/server.js`
- Create: `test/server-projects.test.js`

**Step 1: Write failing HTTP integration tests**

Start `createApp({ allowedRoot, stateRoot })` on port `0` inside each test. Add a small `listen(server)` helper and use built-in `fetch`.

Cover:

1. `POST /api/projects/inspect` returns canonical inspection facts for a project inside the allowed root.
2. The same route returns `400` for `../escape`, an outside absolute path, and a symlink resolving outside the root.
3. `POST /api/sessions` can create an empty Migration session, after which `GET /api/projects/recent` returns that canonical root.
4. An invalid imported step returns `details` containing `/steps/0/title` and does not update recents.

Representative assertion:

```js
const response = await fetch(`${baseUrl}/api/projects/inspect`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ projectRoot: "sample" })
});
assert.equal(response.status, 200);
assert.equal((await response.json()).projectRoot, await fs.realpath(projectRoot));
```

**Step 2: Run the tests and verify RED**

Run: `node --test test/server-projects.test.js`

Expected: FAIL because `createApp` ignores injected roots and `/api/projects/inspect` returns 404.

**Step 3: Add dependency-injected runtime paths and routes**

Change the signature to:

```js
export async function createApp(options = {}) {
  const runtime = {
    allowedRoot: options.allowedRoot ?? allowedRoot,
    stateRoot: options.stateRoot ?? stateRoot
  };
```

Use `runtime.allowedRoot` for health, inspection, and session path validation. Use `runtime.stateRoot` for `SessionStore`, and create:

```js
const recentProjects = new RecentProjectStore(
  path.join(runtime.stateRoot, "..", "recent-projects.json")
);
```

Add routes before session-id matching:

```js
if (request.method === "GET" && pathname === "/api/projects/recent") {
  return sendJson(response, 200, await recentProjects.list());
}
if (request.method === "POST" && pathname === "/api/projects/inspect") {
  const body = await readJson(request);
  if (typeof body.projectRoot !== "string" || !body.projectRoot.trim()) {
    throw new Error("projectRoot must be a non-empty string");
  }
  const candidate = path.isAbsolute(body.projectRoot)
    ? body.projectRoot
    : path.join(runtime.allowedRoot, body.projectRoot);
  const resolvedRoot = await resolveProjectRoot(candidate, runtime.allowedRoot);
  return sendJson(response, 200, await inspectProject(resolvedRoot));
}
```

After `store.save(session)` succeeds in `createSession`, call `recentProjects.record({ projectRoot: resolvedRoot, workbench: input.workbench })`. Do not record during inspection or failed creation.

**Step 4: Verify GREEN and regression safety**

Run: `node --test test/server-projects.test.js test/protocol.test.js test/session-engine.test.js`

Expected: all tests PASS.

**Step 5: Commit**

```bash
git add apps/server/src/server.js test/server-projects.test.js
git commit -m "feat: expose project onboarding APIs"
```

### Task 4: Testable onboarding draft and preview helpers

**Files:**
- Create: `apps/web/onboarding.js`
- Create: `test/web-onboarding.test.js`

**Step 1: Write failing pure-function tests**

Test these public behaviors:

```js
import {
  parseSessionImport, buildOnboardingInput, summarizeOnboarding, formatApiError
} from "../apps/web/onboarding.js";

test("import uses the inspected root and selected workbench", () => {
  const imported = parseSessionImport(JSON.stringify({
    title: "Move site", workbench: "migration", projectRoot: "/untrusted", steps: [
      { title: "Install", action: { command: ["npm", "install"], cwd: "target" } }
    ]
  }));
  const input = buildOnboardingInput({
    inspection: { projectRoot: "/allowed/site" }, workbench: "migration", title: "Move site", imported
  });
  assert.equal(input.projectRoot, "/allowed/site");
  assert.deepEqual(input.steps, imported.steps);
});

test("preview exposes commands, cwd, impact, and observation steps", () => {
  const summary = summarizeOnboarding({ steps: [
    { title: "Inspect" },
    { title: "Install", action: { command: ["npm", "install"], cwd: "target" } }
  ] });
  assert.deepEqual(summary.steps.map(({ impact }) => impact), ["observation", "project-changing"]);
  assert.equal(summary.steps[1].command, "npm install");
  assert.equal(summary.steps[1].cwd, "target");
});
```

Also assert:

- `buildOnboardingInput` rejects a workbench mismatch;
- invalid JSON errors include computed `line` and `column` from V8's character position;
- `formatApiError({ error, details })` includes each JSON Pointer and reason.

**Step 2: Run the tests and verify RED**

Run: `node --test test/web-onboarding.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

**Step 3: Implement pure helpers**

Keep this module independent of the DOM. Export:

- `parseSessionImport(text)`: parse non-empty JSON; on `SyntaxError`, derive 1-based line/column from `position N` and throw `Invalid JSON at line X, column Y`.
- `buildOnboardingInput({ inspection, workbench, title, imported })`: validate the selected workbench against imported data, clone the imported object, overwrite `title`, `workbench`, and `projectRoot`, and default to `{ steps: [] }` when no import exists.
- `summarizeOnboarding(input)`: return display-only step records with safe defaults, argv joined by spaces, cwd default `.`, and impact `project-changing` only when an action exists.
- `formatApiError(body)`: join the top-level message and `details` as `path: message` lines.

**Step 4: Verify GREEN**

Run: `node --test test/web-onboarding.test.js`

Expected: all tests PASS.

**Step 5: Commit**

```bash
git add apps/web/onboarding.js test/web-onboarding.test.js
git commit -m "feat: build onboarding session previews"
```

### Task 5: Browser onboarding panel

**Files:**
- Modify: `apps/web/index.html`
- Modify: `apps/web/app.js`
- Modify: `apps/web/styles.css`

**Step 1: Add a failing static contract test**

Extend `test/web-onboarding.test.js` to read `index.html` and assert the accessible structure exists:

```js
test("onboarding dialog exposes labeled stages and actions", async () => {
  const html = await fs.readFile(new URL("../apps/web/index.html", import.meta.url), "utf8");
  assert.match(html, /<dialog[^>]+id="project-onboarding"/);
  assert.match(html, /<form[^>]+id="project-inspect-form"/);
  assert.match(html, /id="onboarding-create"/);
  assert.match(html, /aria-live="polite"/);
});
```

**Step 2: Run the test and verify RED**

Run: `node --test test/web-onboarding.test.js`

Expected: FAIL because the dialog is absent.

**Step 3: Add semantic markup**

In the Start section add `Open local project`. Add a `<dialog id="project-onboarding">` after the main layout containing:

- a heading and close button;
- a labeled path form with Inspect submit button;
- recent-project shortcut buttons;
- a detection summary with warning area;
- workbench radio buttons and editable title;
- optional JSON textarea and file input;
- a Preview button;
- a plan/safety preview region with `aria-live="polite"`;
- a final Create session button disabled until preview succeeds.

Do not add command-running controls to the dialog.

**Step 4: Wire the staged flow in `app.js`**

Import the four helpers from `./onboarding.js`. Expand browser state with an `onboarding` draft. Update `api()` so non-2xx errors retain formatted protocol details:

```js
if (!response.ok) throw new Error(formatApiError(body));
```

Implement small functions to:

- reset and open the dialog;
- fetch/render `/api/projects/recent` on startup and after creation;
- inspect the typed or recent path through `/api/projects/inspect`;
- render Git/package-manager/language/framework evidence and warnings using `escapeHtml`;
- read uploaded JSON into the textarea;
- build and render the normalized draft and per-step safety summary;
- submit the previewed draft to `/api/sessions`, refresh sessions/recents, close the dialog, and open the new session;
- preserve all fields and display an inline error when inspection, parsing, validation, or creation fails.

Imported `projectRoot` must never be used; only `inspection.projectRoot` reaches `buildOnboardingInput`.

**Step 5: Add scoped responsive styles**

Preserve the terminal/industrial design system. Add scoped styles for:

- a centered dialog with dark backdrop and `max-width: 760px`;
- two-column field rows collapsing below `700px`;
- visible labels, focus outlines, detection chips, warning/error text;
- a scrollable plan preview with command/cwd/impact rows;
- a footer that keeps Preview and Create actions obvious;
- `prefers-reduced-motion` compatibility (do not introduce required animation).

Ensure `input`, `select`, and dialog buttons inherit the existing monospace typography, and do not disable the mobile sidebar behavior outside this feature.

**Step 6: Verify automated checks**

Run: `node --test test/web-onboarding.test.js`

Expected: all tests PASS.

Run: `npm test`

Expected: the full suite PASS with no warnings.

**Step 7: Commit**

```bash
git add apps/web/index.html apps/web/app.js apps/web/styles.css test/web-onboarding.test.js
git commit -m "feat: add local project onboarding flow"
```

### Task 6: Documentation and end-to-end verification

**Files:**
- Modify: `README.md`
- Modify: `docs/DEVELOPMENT_PLAN.md`

**Step 1: Update user documentation**

Document the Open local project flow, detected project facts, optional import review, recent projects, and the guarantee that onboarding itself runs no commands. Keep the existing raw JSON import instructions as an advanced shortcut.

Update the development plan's current progress and Milestone 2 status to state that project onboarding is complete while plan lifecycle and preview supervision remain next.

**Step 2: Run the complete verification suite**

Run: `npm test`

Expected: all tests PASS.

Run a smoke server with isolated state and allowed root:

```bash
DEV_WORKBENCH_ALLOWED_ROOT="$PWD" DEV_WORKBENCH_PORT=4188 node apps/server/src/server.js
```

In another shell, verify:

```bash
curl -fsS http://127.0.0.1:4188/api/health
curl -fsS -X POST -H 'content-type: application/json' \
  --data '{"projectRoot":"."}' http://127.0.0.1:4188/api/projects/inspect
```

Expected: health returns `ok: true`; inspection returns the canonical repository path and detected Git/Node facts. Stop the smoke server and confirm no child process remains.

**Step 3: Perform browser acceptance checks**

At desktop and a narrow viewport, verify:

- keyboard focus reaches every onboarding control and remains visible;
- an allowed path can be inspected and its facts are readable;
- an outside path is rejected inline;
- malformed JSON reports line/column;
- invalid plan fields show JSON Pointer details after create;
- an empty session and an imported migration plan can each be created;
- the preview lists every command and cwd before creation;
- no command executes during onboarding;
- newly created sessions appear in Sessions and the path appears in Recent projects.

**Step 4: Commit**

```bash
git add README.md docs/DEVELOPMENT_PLAN.md
git commit -m "docs: describe project onboarding"
```

**Step 5: Final review**

Use `superpowers:verification-before-completion` and `superpowers:requesting-code-review`. Confirm `git status --short` contains only pre-existing user files, especially the untracked root `AGENTS.md`, before reporting completion.
