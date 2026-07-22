# Migration Plan Editor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Let users safely add, edit, delete, reorder, and persist steps for a pristine Migration session without executing commands.

**Architecture:** A dedicated plan validator and `SessionEngine.replacePlan()` enforce whole-plan replacement for pristine Migration sessions. `PUT /api/sessions/:id/plan` persists and publishes the replacement, while a dependency-free browser draft module and modal controller keep edits local until one explicit save.

**Tech Stack:** Node.js ESM, `node:test`, JSON Schema draft 2020-12, native HTTP, vanilla HTML/CSS/JavaScript.

---

### Task 1: Add the versioned plan input contract

**Files:**
- Create: `packages/protocol/schemas/v1/plan.schema.json`
- Modify: `packages/protocol/src/index.js`
- Modify: `test/protocol.test.js`

**Step 1: Write failing protocol tests**

Add `plan.schema.json` to the exact schema inventory and import `assertPlanInput`. Cover:

```js
assert.deepEqual(assertPlanInput({ steps: [{ title: "Install", expected: "Dependencies installed" }] }).steps.length, 1);
assert.throws(
  () => assertPlanInput({ steps: [{ title: " ", action: { command: ["npm", 42] } }] }),
  (error) => error instanceof ProtocolValidationError
    && error.issues.some((item) => item.path === "/steps/0/title")
    && error.issues.some((item) => item.path === "/steps/0/action/command/1")
);
assert.throws(
  () => assertPlanInput({ steps: [], extra: true }),
  (error) => error.issues.some((item) => item.path === "/extra")
);
```

Also assert `EVENT_TYPES` contains `plan.updated`.

**Step 2: Run RED**

Run: `node --test test/protocol.test.js`

Expected: FAIL because the schema and validator do not exist.

**Step 3: Implement the minimum contract**

Create a plan schema requiring only `steps`, referencing `step.schema.json`, with `additionalProperties: false`.

Export:

```js
export function assertPlanInput(input) {
  const issues = [];
  if (!requireObject(input, "/", issues)) throwIssues("plan", issues);
  allowedKeys(input, ["steps"], "/", issues);
  if (!Array.isArray(input.steps)) issue(issues, "/steps", "must be an array");
  input.steps?.forEach((step, index) => validateStep(step, `/steps/${index}`, issues));
  throwIssues("plan", issues);
  return input;
}
```

Add `plan.updated` to `EVENT_TYPES`. Do not add risk, dependencies, or lifecycle statuses.

**Step 4: Run GREEN and regressions**

Run: `node --test test/protocol.test.js`

Expected: all protocol tests pass.

**Step 5: Commit**

```bash
git add packages/protocol/schemas/v1/plan.schema.json packages/protocol/src/index.js test/protocol.test.js
git commit -m "feat(protocol): define migration plan input"
```

### Task 2: Replace pristine plans in SessionEngine

**Files:**
- Modify: `packages/execution-core/src/session-engine.js`
- Modify: `test/session-engine.test.js`

**Step 1: Write failing engine tests**

Cover all of these as separate tests:

- a pristine Migration session replaces its steps, trims text, resets every execution field, deep-clones action/expected values, emits one `plan.updated`, and advances `updatedAt`;
- an empty replacement plan is allowed;
- an Execution session is rejected;
- a session with `cursor !== -1`, any non-pending step, snapshots, or annotations is rejected;
- a rejected replacement leaves the complete session deeply equal to its prior value;
- malformed steps return protocol issues rooted under `/steps`.

Use a fresh engine/session per rejection case so failures are attributable.

**Step 2: Run RED**

Run: `node --test test/session-engine.test.js`

Expected: FAIL because `replacePlan` does not exist.

**Step 3: Implement minimal engine behavior**

Import `assertPlanInput`. Make normalization clone user-controlled nested values instead of retaining references. Add:

```js
replacePlan(session, steps) {
  assertPlanInput({ steps });
  if (session.workbench !== "migration") throw new Error("Only migration plans can be edited");
  const pristine = session.cursor === -1
    && session.steps.every((step) => step.status === "pending")
    && session.snapshots.length === 0
    && session.annotations.length === 0;
  if (!pristine) throw new Error("Only an unstarted migration plan can be edited");
  session.steps = steps.map(normalizeStep);
  session.status = "ready";
  session.events.push(event("plan.updated", { stepCount: session.steps.length }));
  this.touch(session);
  return publicSession(session);
}
```

Perform all validation and eligibility checks before mutating the session.

**Step 4: Run GREEN and related tests**

Run: `node --test test/session-engine.test.js test/protocol.test.js`

Expected: all tests pass.

**Step 5: Commit**

```bash
git add packages/execution-core/src/session-engine.js test/session-engine.test.js
git commit -m "feat(execution-core): replace pristine migration plans"
```

### Task 3: Persist plan replacement through HTTP and SSE

**Files:**
- Modify: `apps/server/src/server.js`
- Modify: `test/server-projects.test.js`

**Step 1: Write failing API tests**

Add an SSE helper that waits for the next complete session payload. Cover:

- `PUT /api/sessions/:id/plan` returns and persists the normalized replacement;
- the replacement is published through the existing EventSource endpoint;
- an empty plan is accepted;
- Execution, executed/failed, annotated, and actively running sessions are rejected without changing stored state;
- invalid steps return precise JSON Pointer details;
- missing/wrong Content-Type returns `415` before any mutation;
- no command runner or snapshot side effect occurs during save (inject or assert unchanged project files/state using the smallest existing seam).

**Step 2: Run RED**

Run with local-listen permission: `node --test test/server-projects.test.js`

Expected: FAIL with 404 for the new route.

**Step 3: Implement the endpoint**

Before the generic session GET match, add a plan route matching `/api/sessions/:id/plan`. For `PUT`:

1. reject `runningSessions.has(id)` with status `409`;
2. require and parse JSON;
3. load the current session;
4. call `engine.replacePlan(session, body.steps)`;
5. save, emit, and return `publicSession(session)`.

Use existing request-origin, Content-Type, error, store, and SSE helpers. Do not scan the project or execute commands.

**Step 4: Run GREEN and server regressions**

Run: `node --test test/server-projects.test.js`

Expected: all server project tests pass.

**Step 5: Commit**

```bash
git add apps/server/src/server.js test/server-projects.test.js
git commit -m "feat(server): update pristine migration plans"
```

### Task 4: Build dependency-free plan draft helpers

**Files:**
- Create: `apps/web/plan-editor.js`
- Create: `test/web-plan-editor.test.js`

**Step 1: Write failing pure-function tests**

Define and test this public surface:

```js
createPlanDraft(session)
addPlanStep(draft)
updatePlanStep(draft, index, patch)
movePlanStep(draft, index, direction)
removePlanStep(draft, index)
addCommandArgument(draft, stepIndex)
updateCommandArgument(draft, stepIndex, argumentIndex, value)
removeCommandArgument(draft, stepIndex, argumentIndex)
validatePlanDraft(draft)
toPlanInput(draft)
```

Cover deep cloning, no source mutation, first/last move no-ops, empty plan, observation steps with no action, argv item preservation including spaces/quotes/empty input, text formatting for existing object `expected`, trimming on submit, and step-indexed validation errors.

**Step 2: Run RED**

Run: `node --test test/web-plan-editor.test.js`

Expected: FAIL because the module does not exist.

**Step 3: Implement immutable helpers**

Use `structuredClone` and return new draft arrays. Represent an editable action with an explicit enabled flag or `null`; do not infer shell syntax. `validatePlanDraft` returns a stable list such as `{ path, message }`. `toPlanInput` throws a single user-facing error with the first invalid path and otherwise returns `{ steps }` using only protocol fields.

**Step 4: Run GREEN**

Run: `node --test test/web-plan-editor.test.js test/web-onboarding.test.js`

Expected: all tests pass.

**Step 5: Commit**

```bash
git add apps/web/plan-editor.js test/web-plan-editor.test.js
git commit -m "feat(web): model migration plan drafts"
```

### Task 5: Add the accessible plan editor shell

**Files:**
- Modify: `apps/web/index.html`
- Modify: `apps/web/styles.css`
- Modify: `test/web-plan-editor.test.js`

**Step 1: Add failing structure tests**

Assert the page contains:

- a hidden/disabled `Edit plan` action in the Migration view controls;
- a labelled native dialog;
- an `aria-live` status region;
- plan step container and Add/Cancel/Save controls;
- CSS rules for disabled state, focus visibility, step cards, argv rows, and a single-column breakpoint at narrow widths.

Do not assert exact formatting or implementation whitespace.

**Step 2: Run RED**

Run: `node --test test/web-plan-editor.test.js`

Expected: FAIL because the DOM shell is absent.

**Step 3: Implement HTML/CSS only**

Add the editor dialog and scoped plan-editor styles. Reuse the established design tokens and dialog visual language. The static shell contains no duplicated placeholder step; controller rendering owns step cards. Ensure buttons have explicit types and accessible labels.

**Step 4: Run GREEN and syntax/static regressions**

Run: `node --test test/web-plan-editor.test.js test/web-onboarding.test.js`

Expected: all tests pass.

**Step 5: Commit**

```bash
git add apps/web/index.html apps/web/styles.css test/web-plan-editor.test.js
git commit -m "feat(web): add migration plan editor dialog"
```

### Task 6: Wire editor rendering, saving, and async ownership

**Files:**
- Modify: `apps/web/app.js`
- Modify: `test/helpers/fake-browser.js`
- Modify: `test/web-controller.test.js`
- Modify: `test/web-onboarding.test.js`

**Step 1: Write failing controller behavior tests**

Extend the fake browser only with DOM behavior the real controller needs. Test real bound handlers and controller functions for:

- Edit action visible only for Migration and enabled only for pristine sessions;
- opening creates a deep draft and renders escaped/form-value-safe step data;
- add/delete/move and argv actions update draft and boundary button states;
- Save sends exactly `PUT /api/sessions/:id/plan` with `{ steps }` and performs no run request;
- duplicate saves are locked;
- close/reopen while saving stays locked until settlement;
- a stale response after close or session switch cannot close/overwrite the current editor or active session;
- a failed save keeps the draft/dialog and shows protocol details;
- successful current-owner save closes the dialog and renders the server-returned session;
- malicious title/description/expected/argv/cwd never becomes executable HTML.

Mutation-check the lock and stale-owner tests by temporarily removing the relevant guard and observing RED, then restore.

**Step 2: Run RED**

Run: `node --test test/web-controller.test.js test/web-onboarding.test.js`

Expected: FAIL because editor controller behavior is absent.

**Step 3: Implement controller behavior**

Import the pure plan-editor helpers. Add a narrow state object with draft, session id, dialog generation, save request, and saving flag. Render untrusted text with escaped HTML or DOM values. Use event delegation for step/argv controls to avoid handler duplication. Keep the save lock independent from dialog reset, following the proven onboarding creation-lock pattern.

When `renderSession` changes active session, update Edit eligibility and invalidate editor ownership if the ids differ. On success, render only if both request and dialog generation still own the UI. Always release the matching save lock after settlement.

**Step 4: Run GREEN and web regressions**

Run: `node --test test/web-plan-editor.test.js test/web-controller.test.js test/web-onboarding.test.js`

Expected: all web tests pass with no unhandled rejections.

**Step 5: Commit**

```bash
git add apps/web/app.js test/helpers/fake-browser.js test/web-controller.test.js test/web-onboarding.test.js
git commit -m "feat(web): edit pristine migration plans"
```

### Task 7: Document status and verify the complete feature

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DEVELOPMENT_PLAN.md`

**Step 1: Add documentation assertions or review checklist**

Record the exact facts that documentation must state:

- Migration plan editor first version is complete;
- only pristine sessions can be edited;
- supported fields and whole-plan save behavior;
- saving executes no commands;
- dependencies/risk and `awaiting_review` remain next work;
- Milestone 2 as a whole is still in progress.

**Step 2: Update documentation surgically**

Do not claim Preview Supervisor, terminal streaming, review lifecycle, retries, or executed-plan editing are complete.

**Step 3: Run documentation and complete verification**

Run:

```bash
rg -n "plan editor|计划编辑|pristine|awaiting_review|Milestone 2" README.md docs/ARCHITECTURE.md docs/DEVELOPMENT_PLAN.md
node --check apps/web/app.js
node --check apps/web/plan-editor.js
node --check apps/server/src/server.js
npm test
git diff --check 4e5822d..HEAD
git status --short
```

Expected: syntax checks exit 0, the complete suite passes, the committed diff has no whitespace errors, and only the three uncommitted planning-with-files artifacts remain untracked.

**Step 4: Runtime smoke and manual UI QA**

Start the server with an isolated `DEV_WORKBENCH_STATE_ROOT` and allowed root. Verify:

- create a Migration session;
- replace its plan and read it back;
- observe one SSE plan update;
- reject an executed/non-pristine session;
- malicious Host/Origin and wrong Content-Type protections still hold;
- desktop and narrow editor layouts, keyboard focus, close, reordering, validation, and retained error draft when browser tooling is available.

Stop the temporary service and verify the port is closed.

**Step 5: Independent final review and commit**

Request whole-branch correctness/security/UX review. Fix every Critical or Important finding and re-run verification before committing docs:

```bash
git add README.md docs/ARCHITECTURE.md docs/DEVELOPMENT_PLAN.md
git commit -m "docs: describe migration plan editing"
```

After all reviews pass, remove the untracked `task_plan.md`, `findings.md`, and `progress.md` session artifacts before branch handoff.
