# Milestone 3 Recoverable Review Loop Implementation Plan

> **For Codex:** Execute this plan with `superpowers:subagent-driven-development`. Each task requires a fresh implementer, then an independent specification reviewer, then an independent quality reviewer. Return review fixes to the task implementer. Use `superpowers:test-driven-development` for every behavior change and `superpowers:verification-before-completion` before integration.

**Goal:** Deliver an isolated Git-worktree migration workflow with append-only attempts, safe cancellation/retry/restore, lazy per-file review, durable evidence navigation, and a real recoverable migration example.

**Architecture:** Preserve `session.projectRoot` as source identity and create a separate persisted managed workspace outside the source repository. Commands and previews use `workspace.executionRoot`. Each attempt owns immutable baseline/result refs and lightweight evidence. Git mutations occur only in the owned detached worktree. Session JSON remains the authoritative projection; Git refs are the recoverable filesystem evidence.

**Tech Stack:** Node.js 22 standard library, Git CLI through `execFile`, dependency-free HTTP/SSE server, vanilla HTML/CSS/JavaScript, `node:test`.

**Design:** `docs/plans/2026-07-30-milestone-3-recoverable-review-loop-design.md`

**Baseline:** `217f3ba`; authorized `npm test` passes 256/256.

## Global Delivery Rules

- Do not change or stage user-owned planning files outside this feature worktree.
- Do not use shell command strings for Git or migration execution.
- Never run `git reset --hard`, `git clean`, force-push, or forced worktree removal.
- Treat source repository identity and managed execution identity as separate values.
- Validate full OIDs, refs, paths, session ownership, and attempt ownership before Git mutations.
- Keep full file patches out of Session JSON and full-session SSE.
- Preserve old sessions with absent workspace, attempts, or expanded annotation fields.
- Every task ends with `git diff --check`, its targeted tests, a Lore-format commit, specification review, and quality review.
- Tests using loopback sockets or real child processes may require the authorized local test environment.

---

## Task 1: Canonical Protocol Contracts

**Files:**

- Modify: `packages/protocol/src/index.js`
- Modify: `packages/protocol/schemas/v1/snapshot.schema.json`
- Modify: `packages/protocol/schemas/v1/session.schema.json`
- Modify: `test/protocol.test.js`

**Success criteria:**

- Protocol constants expose `cancelled`, workspace/checkpoint/restore/cancel events, and the existing statuses/events.
- Snapshot schema canonically documents runtime `tree` and `treeChanges` while accepting legacy `files` and `changes`.
- Runtime workspace, attempt summaries, checkpoint identities, file manifests, and expanded annotations have strict reusable validators.
- Existing imported Session input does not accept callers injecting runtime-owned workspace or attempt state.

**TDD steps:**

1. Add failing protocol tests for the new status/event constants and canonical snapshot fields.
2. Add failing validator tests for:
   - full object IDs and namespaced refs;
   - workspace paths and source/execution separation;
   - attempt identity/status/baseline/result/file manifest;
   - annotation kinds, tags, and file/diff/command targets;
   - rejection of unknown keys, unsafe target shapes, invalid line numbers, and oversized collections.
3. Run `node --test test/protocol.test.js` and record the expected RED failures.
4. Implement only the constants, schemas, and validation helpers required by those tests.
5. Preserve existing v1 session-input behavior and precise JSON-pointer errors.
6. Re-run `node --test test/protocol.test.js`.
7. Run `git diff --check`.

**Commit:**

```text
feat(protocol): define recoverable migration evidence
```

---

## Task 2: Managed Git Workspace and Checkpoint Primitives

**Files:**

- Modify: `packages/project-adapters/src/git-adapter.js`
- Add: `test/git-adapter.test.js`

**Success criteria:**

- Repository inspection returns repository root, project-relative path, common Git directory, full HEAD OID, stable dirty classification, and exact paths.
- Preparation rejects non-Git, unborn, staged, unstaged, untracked, unmerged, submodule-dirty, and in-progress repositories without mutation.
- Managed worktrees are detached, outside the source repository, and carry verifiable session ownership metadata.
- Baseline/result refs use an exact `refs/dev-workbench/checkpoints/<session>/<attempt>/...` namespace.
- Result checkpoints use a temporary index plus `write-tree`/`commit-tree`, capture non-ignored untracked files, and normalize only the owned worktree to the exact result commit.
- Restore validates ownership/path/ref/OID and materializes only an accepted checkpoint in a clean managed worktree.

**TDD steps:**

1. Create real temporary Git repositories in `test/git-adapter.test.js`, with a local test-only author configuration.
2. Add RED tests for clean repo discovery, nested project roots, detached source HEAD, and SHA-1/full-OID handling.
3. Add RED tests for each dirty/in-progress class and assert source HEAD, index, status, and files remain byte-for-byte unchanged.
4. Add RED tests for managed root containment rejection, existing-path collision, ref collision, and ownership mismatch.
5. Add RED tests for:
   - detached worktree creation;
   - baseline ref creation;
   - result commit containing tracked additions/modifications/deletions and non-ignored untracked files;
   - ignored and binary files;
   - exact diff manifest including deleted and renamed paths;
   - worktree normalization and clean status.
6. Add RED restore tests for stale OID, dirty managed worktree, foreign ref/path, and successful accepted-checkpoint materialization.
7. Run `node --test test/git-adapter.test.js` and record RED.
8. Implement small exported argv-only Git helpers and typed error diagnostics. Do not add a Git library.
9. Re-run `node --test test/git-adapter.test.js`.
10. Run `node --test test/project-adapters.test.js test/project-inspector.test.js`.
11. Run `git diff --check`.

**Commit:**

```text
feat(git): manage isolated migration checkpoints
```

---

## Task 3: Append-Only Attempt and Restore State Machine

**Files:**

- Modify: `packages/execution-core/src/session-engine.js`
- Modify: `test/session-engine.test.js`

**Success criteria:**

- New Migration sessions include empty runtime-owned `attempts` and no prepared workspace.
- Starting a real attempt appends identity and baseline evidence atomically and increments the existing step attempt.
- Completion, failure, cancellation, review, and restore update the current projection without mutating old attempt records.
- `cancelled` is rerunnable like `failed`.
- Accept marks the result checkpoint restorable; reject retains evidence and allows baseline-restoring retry.
- Restore to an initial or accepted boundary resets only later step projections to `pending`, preserves history, and emits one restore event.
- Candidate-first transitions remain atomic when cloning or validation throws.

**TDD steps:**

1. Add RED creation/hydration tests for legacy sessions and new attempts.
2. Add RED tests for start/finalize success, failure, and cancellation with exact `{stepIndex, attempt}` ownership.
3. Add RED tests proving two retries preserve attempt 1 and attempt 2 snapshots/checkpoints.
4. Add RED review tests proving only accepted results become restorable.
5. Add RED restore tests for initial boundary, accepted middle boundary, invalid/foreign checkpoint, downstream dependency readiness, cursor projection, and immutable old evidence.
6. Add RED atomicity tests for invalid evidence and failing public clones.
7. Run `node --test test/session-engine.test.js` and record RED.
8. Implement focused candidate-first methods; do not move Git or HTTP orchestration into the engine.
9. Re-run `node --test test/session-engine.test.js`.
10. Run `node --test test/protocol.test.js test/session-engine.test.js`.
11. Run `git diff --check`.

**Commit:**

```text
feat(core): retain recoverable migration attempts
```

---

## Task 4: Workspace Preparation and Execution-Root Routing

**Files:**

- Modify: `apps/server/src/config.js`
- Modify: `apps/server/src/server.js`
- Modify: `packages/project-adapters/src/preview-process-supervisor.js`
- Modify: `test/server-projects.test.js`
- Modify: `test/preview-process-supervisor.test.js`

**Success criteria:**

- `POST /api/sessions/:id/workspace/prepare` strictly accepts `{}` and returns the persisted full Session.
- Preparation is Migration-only, mutation-locked, idempotent only for an exactly valid existing workspace, and reports structured dirty diagnostics.
- Managed workspace root is configurable and rejected when it overlaps the source repository.
- Real action commands and preview lifecycle requests return `409 workspace_required` until prepared.
- Command/snapshot cwd and preview relative cwd resolve from `workspace.executionRoot`; UI/source identity still uses `projectRoot`.
- Trace-only steps remain compatible without a workspace.

**TDD steps:**

1. Extend the server test helper to create a real temporary Git repo only for new workspace tests; do not silently change legacy fake-project fixtures.
2. Add RED HTTP tests for method/content-type/body/session/workbench validation, dirty diagnostics, concurrent claims, save failure, and one SSE emission after save.
3. Add RED tests proving source repository HEAD/status/files never change.
4. Add RED command tests proving the spawned cwd is the project-relative path inside the managed worktree.
5. Add RED preview tests proving source/target configs resolve against execution root and never fall back to source after workspace preparation.
6. Add RED backward-compatibility tests for trace-only sessions.
7. Run `node --test test/server-projects.test.js test/preview-process-supervisor.test.js` and record RED.
8. Implement `workspaceRoot` configuration, injected Git workspace adapter seams, route orchestration, and execution-root selection.
9. Re-run the targeted tests in the authorized local environment if loopback is required.
10. Run `git diff --check`.

**Commit:**

```text
feat(server): prepare isolated migration workspaces
```

---

## Task 5: Checkpointed Run, Cancel, Retry, Review, and Restore

**Files:**

- Modify: `apps/server/src/server.js`
- Modify: `packages/project-adapters/src/snapshot.js`
- Modify: `test/server-projects.test.js`
- Modify: `test/project-adapters.test.js`

**Success criteria:**

- Every real run creates baseline evidence before spawn and result evidence after success, failure, or cancellation.
- The persisted running projection exists before command execution; final evidence is persisted before SSE.
- `POST .../cancel` validates the exact active attempt outside the session lock, returns `202 cancelling`, and cannot cancel a newer generation.
- The owning run request finalizes user cancellation as `cancelled`, retains bounded partial output and a result checkpoint, then releases the lock.
- Retry requires exact baseline/OID/root confirmation, restores before spawn, and never stacks on partial changes.
- Accept makes the exact result restorable; reject retains it as non-restorable history.
- Restore requires exact target confirmation, inactive previews, a clean owned worktree, and one mutation claim; it never mutates source.
- Git/session persistence tears return explicit expected/observed reconciliation diagnostics.

**TDD steps:**

1. Add RED real-Git HTTP tests for successful checkpointed run and review acceptance.
2. Add RED failure and cancellation tests with partial file changes and stdout/stderr.
3. Add RED cancellation race tests: wrong attempt, no active command, command already finishing, repeated cancel, shutdown reason, and newer generation.
4. Add RED retry tests for missing/stale confirmation, exact baseline restore, attempt increment, and preserved partial evidence.
5. Add RED restore tests for preview-active rejection, dirty/foreign worktree, stale OID, double request, save failure, downstream projection reset, immutable history, and unchanged source.
6. Run `node --test test/server-projects.test.js test/project-adapters.test.js` and record RED.
7. Replace `activeStepControllers` values with exact active-operation records while keeping cancel out-of-band.
8. Wire checkpoint capture/finalization and restore orchestration without duplicating SessionEngine transitions.
9. Re-run targeted tests in the authorized local environment.
10. Run `node --test test/session-engine.test.js test/protocol.test.js`.
11. Run `git diff --check`.

**Commit:**

```text
feat(server): recover migration attempts safely
```

---

## Task 6: Lazy Per-File Diff API

**Files:**

- Modify: `packages/project-adapters/src/git-adapter.js`
- Modify: `apps/server/src/server.js`
- Modify: `test/git-adapter.test.js`
- Modify: `test/server-projects.test.js`

**Success criteria:**

- `GET /api/sessions/:id/attempts/:attemptId/diff?path=...` reads only a manifest-listed path from validated immutable OIDs.
- The response includes status, old/new paths, binary/truncation metadata, bounded old/new text, and structured hunks.
- Added, modified, deleted, renamed, copied, type-changed, empty, Unicode, binary, and oversized files are handled.
- Path traversal, non-manifest paths, foreign attempts/refs, malformed encoding, stale refs, and unsupported methods fail without filesystem reads.
- Full patches never enter Session JSON or Session SSE.

**TDD steps:**

1. Add RED adapter tests for file content and structured hunks across all supported statuses.
2. Add RED limits tests for byte size, line/hunk count, invalid UTF-8/binary, and truncation.
3. Add RED HTTP tests for exact query validation, ownership, path traversal, missing evidence, and response content type.
4. Add an SSE regression assertion that the full patch sentinel never appears.
5. Run `node --test test/git-adapter.test.js test/server-projects.test.js` and record RED.
6. Implement checkpoint-scoped Git blob reads and a small bounded unified-hunk parser/serializer.
7. Re-run targeted tests in the authorized local environment.
8. Run `git diff --check`.

**Commit:**

```text
feat(review): serve bounded file diffs
```

---

## Task 7: Migration Review and Restore UI

**Files:**

- Modify: `apps/web/index.html`
- Modify: `apps/web/styles.css`
- Modify: `apps/web/app.js`
- Modify: `test/helpers/fake-browser.js`
- Modify: `test/web-controller.test.js`
- Add: `test/web-review.test.js`

**Success criteria:**

- Workspace identity and preparation state are visible without replacing source project identity.
- Changed-file list includes deleted/renamed paths from the manifest.
- One selected diff lazy-loads with stale request/session/attempt ownership protection.
- Unified and side-by-side modes, search, bounded rendering, binary/truncated/error states, and safe demo-language highlighting work.
- Running steps expose exact user cancel state.
- Failed/cancelled retry opens an exact “restore baseline and retry” confirmation.
- Timeline seek and filesystem restore have different controls, wording, styling, endpoint, and confirmation.
- Restore dialog shows exact worktree/ref/full OID, double-confirms, locks duplicate requests, and manages focus correctly.

**TDD steps:**

1. Add static RED tests for labelled regions, restore dialog semantics, note label, responsive layout, focus-visible, reduced motion, and overflow containment.
2. Extend fake-browser helpers only for required dialog/focus/scroll behavior.
3. Add RED controller tests for workspace preparation and source/execution identity.
4. Add RED diff tests for deleted/renamed/untrusted paths, selection persistence, lazy response races, search, mode switch, binary, and truncation.
5. Add RED cancel/retry tests for exact bodies, duplicate suppression, stale responses, and SSE convergence.
6. Add RED restore tests proving the first click sends no request, cancel is inert, confirmation sends the exact body, and old session/checkpoint responses are ignored.
7. Run `node --test test/web-controller.test.js test/web-review.test.js` and record RED.
8. Implement small render/state helpers inside the existing controller; do not add a frontend framework or code editor.
9. Re-run targeted tests.
10. Run `node --test test/web-onboarding.test.js test/web-plan-editor.test.js`.
11. Run `git diff --check`.

**Commit:**

```text
feat(web): review and restore migration checkpoints
```

---

## Task 8: Markdown Notes, Tags, Bookmarks, and Evidence Jumps

**Files:**

- Modify: `packages/execution-core/src/session-engine.js`
- Modify: `apps/server/src/server.js`
- Add: `apps/web/annotation-markdown.js`
- Modify: `apps/web/app.js`
- Modify: `apps/web/index.html`
- Modify: `apps/web/styles.css`
- Modify: `test/session-engine.test.js`
- Modify: `test/server-projects.test.js`
- Add: `test/web-annotation-markdown.test.js`
- Modify: `test/web-controller.test.js`

**Success criteria:**

- Existing plain annotations remain readable.
- New annotations validate `kind`, bounded tags, optional attempt ID, and file/diff/command targets against persisted evidence.
- Raw HTML is escaped; the documented Markdown subset renders without scriptable URLs or DOM injection.
- Bookmarks target only persisted diff/file/command evidence, never preview/runtime sequence numbers.
- Jumping seeks the correct step, selects the exact attempt/evidence, lazy-loads if needed, then focuses and scrolls.
- Session/session-switch races cancel stale jumps.

**TDD steps:**

1. Add RED engine/server tests for compatible plain notes and strict new annotation validation.
2. Add RED tests rejecting foreign attempt IDs, non-manifest paths, invalid streams/lines, runtime sequence anchors, duplicate/oversized tags, and unknown keys.
3. Add RED Markdown tests for emphasis, code, lists, safe links, escaped HTML, dangerous protocols, malformed markup, and Unicode.
4. Add RED controller tests for note/bookmark creation, filtered rendering, seek-then-select order, lazy evidence, focus/scroll, broken targets, and stale jumps.
5. Run `node --test test/session-engine.test.js test/server-projects.test.js test/web-annotation-markdown.test.js test/web-controller.test.js` and record RED.
6. Implement the smallest safe Markdown subset and evidence-navigation state.
7. Re-run targeted tests in the authorized local environment where needed.
8. Run `git diff --check`.

**Commit:**

```text
feat(review): link durable migration evidence
```

---

## Task 9: Real Recoverable Migration Example and Completion Verification

**Files:**

- Modify: `examples/migration-demo/session.json`
- Modify: `examples/migration-demo/step-runner.js`
- Add or modify only required demo fixture files under `examples/migration-demo/`
- Modify: `test/migration-demo.test.js`
- Add: `test/migration-recovery-e2e.test.js`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/INITIAL_SOLUTION.md`
- Modify: `docs/DEVELOPMENT_PLAN.md`
- Modify: `README.md`

**Success criteria:**

- A real temporary Git repository executes the complete Migration workflow through real HTTP, Git, command, preview, persistence, SSE, review, retry, cancel, diff, bookmark, and restore paths.
- The source repository HEAD, status, index, tracked files, and sentinel remain unchanged.
- The managed execution root reaches the accepted final result, then restores to an earlier accepted boundary while old evidence remains accessible.
- The demo uses dynamic ports and cleans up only workbench-owned processes.
- Documentation accurately marks Milestone 3 complete and retains remaining Milestone 4 limits.

**TDD and verification steps:**

1. Add a RED real-Git E2E test that copies the demo to a temp directory, initializes/commits it, starts the actual server, and prepares a workspace.
2. Extend it through high-risk confirmation, reject, baseline-restoring retry, accept, dependent steps, lazy diffs, annotation/bookmark, long-step cancel, and accepted-checkpoint restore.
3. Assert source Git and filesystem identity before and after the entire flow.
4. Run `node --test test/migration-demo.test.js test/migration-recovery-e2e.test.js` and record RED.
5. Make the smallest demo changes required to satisfy the scenario.
6. Re-run the E2E tests in the authorized local environment.
7. Update architecture, solution limits, development-plan status, and README usage from verified behavior only.
8. Run all targeted suites:

```bash
node --test \
  test/protocol.test.js \
  test/git-adapter.test.js \
  test/project-adapters.test.js \
  test/project-inspector.test.js \
  test/session-engine.test.js \
  test/preview-process-supervisor.test.js \
  test/server-projects.test.js \
  test/web-controller.test.js \
  test/web-review.test.js \
  test/web-annotation-markdown.test.js \
  test/migration-demo.test.js \
  test/migration-recovery-e2e.test.js
```

9. Run authorized `npm test`.
10. Start the real app and perform browser smoke at approximately 390, 768, and 1440 CSS pixels:
    - workspace identity and preparation;
    - keyboard changed-file selection;
    - unified/side-by-side mode and search;
    - cancellation;
    - retry confirmation;
    - bookmark focus;
    - restore dialog focus/cancel/confirm;
    - preview behavior;
    - no console errors or unexpected overflow.
11. Run independent security review for Git ownership/ref/path validation, command execution boundaries, restore confirmation, diff path traversal, Markdown/XSS, and stale-request races.
12. Run independent final specification review against the design and `docs/DEVELOPMENT_PLAN.md`.
13. Run `git diff --check` and confirm the feature worktree is clean.

**Commit:**

```text
docs: complete recoverable migration workflow
```

---

## Integration

After all nine task commits pass their per-task reviews:

1. Use `superpowers:verification-before-completion`.
2. Record exact targeted, full-suite, E2E, browser, security, and final-spec evidence.
3. Use `superpowers:finishing-a-development-branch`.
4. Locally merge `feature/milestone-3-recoverable-review-loop` into `main` only after the user-authorized workflow remains satisfied.
5. Re-run authorized `npm test` on merged `main`.
6. Remove only the owned Milestone 3 feature worktree and branch after verifying the merge; retain any older unrelated worktrees.
