# Migration Review Lifecycle Implementation Plan

> **Execution rule:** Implement tasks sequentially. For every task, use a fresh implementation subagent, then a separate specification-review subagent, then a separate code-quality-review subagent. Return all findings to the original implementer and repeat reviews until both reviewers approve.

**Goal:** Add a server-authoritative review gate, stable step IDs, earlier-step dependencies, risk confirmation, and retry counts to Migration sessions without changing Execution behavior.

**Architecture:** Extend the v1 plan input model, keep lifecycle and readiness rules in `SessionEngine`, expose one focused review endpoint under the existing per-session mutation lock, and make the browser UI a projection of the returned/SSE session state. Preserve pristine-only plan replacement so execution-time invalidation and revision control remain out of scope.

**Tech stack:** Node.js 22, native `node:test`, dependency-free ES modules, HTTP/SSE server, browser DOM with the existing fake-browser test harness.

---

## Task 1: Extend Step Protocol and Cross-Step Validation

**Files:**

- Modify: `packages/protocol/schemas/v1/step.schema.json`
- Modify: `packages/protocol/src/index.js`
- Test: `test/protocol.test.js`

### Step 1: Write failing protocol tests

Add tests proving that session and plan input accept:

```js
{
  id: "install-runtime",
  title: "Install runtime",
  risk: "high",
  dependsOn: ["prepare-project"]
}
```

Add table-driven failures for:

- unsupported risk;
- non-array or non-string dependencies;
- duplicate step IDs;
- duplicate dependency IDs;
- missing dependency targets;
- self-dependency;
- dependency on a later step.

Assert exact JSON Pointer paths, including `/steps/1/dependsOn/0`.

Run:

```bash
node --test test/protocol.test.js
```

Expected: FAIL because the new fields are rejected or cross-step rules are absent.

### Step 2: Implement the smallest validator changes

- Add `risk` and `dependsOn` to the step schema.
- Accept only `low`, `medium`, and `high`.
- Extend the manual step validator with matching field rules.
- Add one cross-step validation helper used by both `assertSessionInput()` and `assertPlanInput()`.
- Validate references only after individual step shapes, without throwing incidental JavaScript errors for malformed entries.
- Do not require an ID when a step has no incoming reference.

### Step 3: Verify

Run:

```bash
node --test test/protocol.test.js
```

Expected: PASS.

### Step 4: Commit

```bash
git add packages/protocol/schemas/v1/step.schema.json packages/protocol/src/index.js test/protocol.test.js
git commit -m "feat(protocol): validate migration step metadata"
```

---

## Task 2: Implement Engine Lifecycle, Readiness, and Attempts

**Files:**

- Modify: `packages/execution-core/src/session-engine.js`
- Modify: `packages/protocol/src/index.js` only if event constants require it
- Test: `test/session-engine.test.js`

### Step 1: Write failing engine tests

Cover:

- normalized defaults: UUID-like stable ID, `risk: "low"`, `dependsOn: []`, `attempt: 0`;
- explicit IDs/risk/dependencies survive normalization and plan replacement;
- `startStep()` increments attempt and rejects unmet dependencies;
- successful Migration completion records the snapshot and enters `awaiting_review`;
- review accept produces `completed` and advances session readiness;
- final acceptance completes the session;
- review reject produces retryable `failed`;
- retry increments attempt and clears the prior review outcome;
- no later step is runnable while a step is running or awaiting review;
- Execution sessions still complete immediately;
- transition failures leave the session unchanged.

Run:

```bash
node --test test/session-engine.test.js
```

Expected: FAIL on missing lifecycle behavior.

### Step 2: Implement lifecycle primitives

- Generate absent IDs with `randomUUID()`.
- Normalize `risk`, `dependsOn`, and `attempt`.
- Make `nextRunnable()` enforce Migration dependency completion and the global running/review gate.
- Increment attempts only after all start preconditions pass.
- Preserve `completeStep()` behavior for Execution; for Migration set step/session to `awaiting_review` and emit `step.awaiting_review`.
- Add one review method accepting only `accept` or `reject`.
- Emit `step.review.accepted` and `step.review.rejected` with step index, ID, and attempt.
- Keep command failures in `failStep()` distinct from review rejection.

### Step 3: Verify focused and adjacent tests

Run:

```bash
node --test test/session-engine.test.js test/protocol.test.js
```

Expected: PASS.

### Step 4: Commit

```bash
git add packages/execution-core/src/session-engine.js packages/protocol/src/index.js test/session-engine.test.js
git commit -m "feat(engine): add migration review lifecycle"
```

---

## Task 3: Add Review HTTP API and Risk Gate

**Files:**

- Modify: `apps/server/src/server.js`
- Test: `test/server-projects.test.js`

### Step 1: Write failing HTTP tests

Add helpers/tests for:

- successful Migration run returns `awaiting_review` and persists the snapshot;
- accept and reject review decisions persist and publish the full session over SSE;
- accepted final step completes the session;
- rejected step can be retried with an incremented attempt;
- dependency-blocked and out-of-order runs do not mutate stored state;
- high risk requires `confirmedRisk: true`, including an observation step;
- command steps still require `confirmed: true`;
- invalid decision, unknown step, wrong workbench, wrong state, and wrong Content-Type do not mutate or publish;
- simultaneous run/review and duplicate review requests receive `409`;
- the mutation lock is released after every failure.

Run:

```bash
node --test test/server-projects.test.js
```

Expected: FAIL on missing API and changed successful-run status.

### Step 2: Implement the endpoint and confirmation rules

- Add an exact review route:

```text
POST /api/sessions/:id/steps/:index/review
```

- Parse and validate only `{ decision }`.
- Claim the session before loading/mutating it.
- Invoke the engine transition, save once, emit once, and return `publicSession()`.
- Require `confirmedRisk === true` before starting high-risk steps.
- Keep all validation before `startStep()` so rejected requests cannot increment attempts.
- Reuse existing JSON Content-Type, error serialization, and `409` lock behavior.

### Step 3: Verify server and engine tests

Run:

```bash
node --test test/server-projects.test.js test/session-engine.test.js
```

Expected: PASS and process exits cleanly.

### Step 4: Commit

```bash
git add apps/server/src/server.js test/server-projects.test.js
git commit -m "feat(server): expose migration review decisions"
```

---

## Task 4: Extend the Pure Plan-Editor Model

**Files:**

- Modify: `apps/web/plan-editor.js`
- Test: `test/web-plan-editor.test.js`

### Step 1: Write failing editor-model tests

Cover:

- existing IDs, risk, and dependencies survive draft creation and serialization;
- new steps receive a stable ID through an injectable/default ID factory;
- risk defaults to `low`;
- dependencies default to an empty list;
- updating risk and dependencies is immutable;
- moving a step can surface a later-dependency validation error;
- duplicate/missing/self/later dependencies report exact paths;
- removing a referenced step leaves an explicit validation error rather than silently deleting dependencies;
- `attempt` and runtime status never enter plan input.

Run:

```bash
node --test test/web-plan-editor.test.js
```

Expected: FAIL.

### Step 2: Implement draft behavior

- Retain `id`, `risk`, and `dependsOn` in draft steps.
- Give `addPlanStep()` an optional ID factory and default it to `crypto.randomUUID`.
- Add immutable patches for risk and dependency changes.
- Match the protocol's cross-step validation rules.
- Serialize only plan-input fields.
- Avoid adding a generic graph abstraction.

### Step 3: Verify

Run:

```bash
node --test test/web-plan-editor.test.js test/protocol.test.js
```

Expected: PASS.

### Step 4: Commit

```bash
git add apps/web/plan-editor.js test/web-plan-editor.test.js
git commit -m "feat(web): model migration risk and dependencies"
```

---

## Task 5: Add Plan Metadata and Review Controls to the Web UI

**Files:**

- Modify: `apps/web/app.js`
- Modify: `apps/web/index.html`
- Modify: `apps/web/styles.css`
- Modify: `test/helpers/fake-browser.js` only if the existing DOM seam lacks a required standard behavior
- Modify: `test/web-controller.test.js`
- Modify: `test/web-onboarding.test.js` only for source-level UI assertions

### Step 1: Write failing controller/UI tests

Cover:

- plan cards render stable ID, risk selector, and earlier-step dependency checkboxes;
- checkbox/risk changes update the immutable draft and validation state;
- runtime Migration steps show status, risk, dependencies, and attempt;
- `awaiting_review` replaces Run with Accept and Reject;
- review controls are disabled while a request is pending;
- review requests send the exact decision body;
- a stale response cannot overwrite another active session;
- rejected steps present a retry label;
- high-risk confirmation sends `confirmedRisk: true`;
- cancellation sends no request;
- controls have accessible names, focus visibility, and mobile-safe layout.

Run:

```bash
node --test test/web-controller.test.js test/web-onboarding.test.js
```

Expected: FAIL.

### Step 2: Implement plan metadata controls

- Render the stable ID read-only.
- Render a native risk `<select>`.
- Render dependency checkboxes only for earlier draft steps, labelled by title and ID.
- Keep the dialog draft stable across SSE updates.

### Step 3: Implement runtime review controls

- Derive the server-selected runnable index with the same visible rules, while treating the server as authoritative.
- Render Accept/Reject only for the awaiting-review step.
- Add request ownership/locking equivalent to the existing plan-editor safeguards.
- Use a high-risk confirmation message that identifies exact target and risk.
- Refresh the session after failed mutations.

### Step 4: Style and accessibility

- Add distinct awaiting-review and risk treatments without changing the established visual system.
- Preserve keyboard operation and visible focus.
- Stack new metadata and controls at narrow widths without horizontal page overflow.

### Step 5: Verify focused browser modules

Run:

```bash
node --test test/web-plan-editor.test.js test/web-controller.test.js test/web-onboarding.test.js
```

Expected: PASS.

### Step 6: Commit

```bash
git add apps/web/app.js apps/web/index.html apps/web/styles.css test/helpers/fake-browser.js test/web-controller.test.js test/web-onboarding.test.js
git commit -m "feat(web): review migration step results"
```

Only stage files actually changed.

---

## Task 6: Update Product Documentation and Examples

**Files:**

- Modify: `docs/DEVELOPMENT_PLAN.md`
- Modify: `README.md` if its Migration walkthrough describes direct completion
- Modify: example fixture/source identified by `rg -n "migration-demo|risk|dependsOn" apps packages examples test`
- Test: relevant existing example test

### Step 1: Identify documentation and fixture assertions

Run:

```bash
rg -n "migration-demo|awaiting_review|Run next|completed|risk|dependsOn" README.md docs apps packages examples test
```

Record only statements made stale by this feature.

### Step 2: Update surgically

- Mark the review lifecycle, dependency, and risk slice complete in the development plan.
- Document run → review → accept/reject behavior and high-risk confirmation.
- Give the built-in Migration example explicit stable IDs, representative risks, and earlier-step dependencies if it improves the demo.
- Do not document deferred checkpoint restoration, concurrency, or execution-time editing as complete.

### Step 3: Verify documentation/example tests

Run the narrow test discovered in Step 1, then:

```bash
git diff --check
```

Expected: PASS.

### Step 4: Commit

```bash
git add docs/DEVELOPMENT_PLAN.md README.md <changed-example-files> <changed-tests>
git commit -m "docs: describe migration review workflow"
```

Only stage files actually changed.

---

## Task 7: Full Verification and Final Review

**Files:**

- Modify only files required to fix verified regressions.
- Do not add scope during this task.

### Step 1: Run the full automated suite

```bash
npm test
```

Expected: all tests pass and the process exits cleanly.

### Step 2: Run runtime HTTP smoke verification

Start the server on an isolated allowed root and port, then verify:

1. create a two-step Migration plan with a dependency and high-risk first step;
2. high-risk run without `confirmedRisk` is rejected without mutation;
3. confirmed run enters `awaiting_review`;
4. later step cannot run before review;
5. rejection makes the first step retryable;
6. retry increments attempt;
7. acceptance permits the dependent step;
8. final acceptance completes the session.

Stop only the server process created by this verification.

### Step 3: Run browser verification

Using the available browser tooling, verify:

- desktop and narrow layouts;
- plan editing of risk/dependencies;
- high-risk confirmation;
- Accept/Reject controls and keyboard focus;
- no console errors;
- SSE-driven status updates.

If browser tooling is unavailable, record the limitation and rely on controller/source assertions without claiming manual browser verification.

### Step 4: Independent final reviews

Run one independent specification review against the approved design and this plan, then one independent code-quality review over the complete feature diff. Send any findings to the owning task implementer and rerun the affected focused tests plus the full suite.

### Step 5: Final commit if verification fixes were required

```bash
git add <only-fixed-files>
git commit -m "fix: close migration review verification gaps"
```

No commit is required when verification makes no changes.
