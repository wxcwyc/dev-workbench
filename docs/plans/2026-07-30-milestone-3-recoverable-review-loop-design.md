# Milestone 3 Recoverable Review Loop Design

## Goal

Complete Milestone 3 with an isolated, recoverable Migration workflow: every real command runs in a workbench-owned Git worktree, every attempt retains reviewable evidence, users can inspect file-level diffs, cancel or safely retry work, restore an explicit checkpoint, and navigate durable annotations and bookmarks.

The implementation remains a trusted-local, dependency-free Node.js application. Git worktrees isolate the user's branch and working directory; they are not a process sandbox.

## Scope

This milestone adds:

- clean-source Git validation and a persistent managed execution worktree;
- append-only attempt and checkpoint evidence;
- per-file change manifests and lazy unified/side-by-side diffs;
- user cancellation with partial-result evidence;
- baseline-restoring retry;
- explicit filesystem restore with exact-target confirmation;
- Markdown annotations, tags, bookmarks, and durable evidence jumps;
- a real Git/HTTP/process migration example and browser smoke verification.

It does not add:

- automatic stash, temporary commits on the user's branch, or copying dirty source state;
- applying migration results back to the user's source branch;
- force-push, reset of a user branch, or forced removal of an unconfirmed worktree;
- a code editor, general Git client, PTY, terminal input, container sandbox, or remote worker;
- durable preview logs, SQLite persistence, cross-process locking, or full crash reconciliation.

The last group remains Milestone 4 or later.

## Safety Invariants

1. `session.projectRoot` remains the canonical user project identity and is never replaced with a worktree path.
2. Commands and preview processes use only the persisted managed `executionRoot` after workspace preparation.
3. Workspace preparation fails on staged, unstaged, untracked, unmerged, submodule, or in-progress Git state and reports exact diagnostics.
4. The workbench never stashes, commits, resets, cleans, checks out, or otherwise mutates the user's source worktree or branch.
5. Every checkpoint ref, full OID, execution path, session ID, and attempt ID is validated before a mutation.
6. Timeline seeking is read-only. Restore is a separate mutation with separate UI, endpoint, confirmation, event, and result state.
7. Attempts, command results, checkpoint identities, file manifests, annotations, and events are append-only evidence.
8. Retry and restore may replace content only in a clean, workbench-owned execution worktree.
9. No cleanup command uses `--force`. Missing, dirty, moved, or ownership-mismatched managed worktrees are reported for manual resolution.

## Workspace Lifecycle

Migration sessions keep two roots:

- `projectRoot`: the imported source repository shown in project identity and safety confirmations;
- `workspace.repositoryRoot`: the top level of the source Git worktree;
- `workspace.projectRelativePath`: the path from that repository root to `projectRoot`;
- `workspace.executionRoot`: the same project-relative path inside a server-managed linked Git worktree, used by commands, snapshots, and previews.

Workspace preparation is explicit:

```text
POST /api/sessions/:id/workspace/prepare
```

The server:

1. acquires the session mutation claim;
2. resolves the source repository and its full `HEAD` OID;
3. rejects non-Git, unborn, dirty, unmerged, submodule-dirty, or Git-operation-in-progress repositories with structured diagnostics;
4. verifies the configured managed-worktree root is outside the source repository and creates a detached linked worktree there;
5. records the project root, repository root, project-relative path, repository common directory, execution root, full base OID, and ownership token in Session state;
6. persists the Session before returning the authoritative public projection.

Preparation does not create or move a user branch. Trace-only logical steps remain backward compatible and do not require a workspace. A Migration action command or preview lifecycle request without a prepared workspace returns `409 workspace_required`.

The workspace is retained across ordinary server restarts because its evidence is user-reviewable state. Milestone 3 validates the recorded worktree and refs on use, but does not automatically reconcile or delete orphaned resources. Automatic lifecycle cleanup is deferred until reliable startup reconciliation exists.

## Checkpoint and Attempt Model

Each real step execution appends an attempt record keyed by an opaque UUID and `{stepIndex, attempt}`:

```json
{
  "id": "attempt-id",
  "stepIndex": 1,
  "attempt": 2,
  "status": "failed",
  "startedAt": "2026-07-30T08:00:00.000Z",
  "completedAt": "2026-07-30T08:00:03.000Z",
  "baseline": {
    "oid": "full-40-or-64-character-object-id",
    "ref": "refs/dev-workbench/checkpoints/session-id/attempt-id/baseline"
  },
  "result": {
    "oid": "full-object-id",
    "ref": "refs/dev-workbench/checkpoints/session-id/attempt-id/result",
    "restorable": false
  },
  "snapshot": {
    "files": [],
    "command": {}
  }
}
```

Before the command starts, the adapter verifies the managed worktree is clean and creates an owned baseline ref at its current full OID. After success, failure, or cancellation, it builds a tree through a temporary Git index rooted at the baseline, creates a workbench-authored checkpoint commit with `commit-tree`, and creates the owned result ref. This captures tracked and non-ignored untracked filesystem results without depending on or committing through an index or merge state left by the command.

The adapter then materializes that exact result commit into the detached managed worktree and verifies the managed worktree is clean. These index/worktree mutations are allowed only after validating the workbench ownership token, execution path, and full OID; they never target the source worktree or a user branch. The fixed author identity is process-local metadata and does not alter repository configuration.

`session.attempts` is append-only. Attempt summaries and file manifests stay lightweight; historical command evidence retains a bounded stdout/stderr tail and explicit truncation metadata. Existing `session.snapshots[index]` remains the latest step projection for backward compatibility, but is no longer the sole evidence store. UI labels any snapshot or attempt that does not match the active workspace checkpoint as historical.

A result checkpoint becomes a general restore target only after its review is accepted. The initial workspace base and each accepted result are restorable boundaries. Failed, cancelled, and rejected result checkpoints remain inspectable evidence but cannot become the projected completed state.

## Execution, Review, Retry, and Cancellation

The normal run route remains the single execution pipeline:

```text
POST /api/sessions/:id/steps/:index/run
```

For a pending step, it creates a new attempt from the current accepted workspace boundary.

For a failed or cancelled step, retry first restores the matching attempt baseline, then creates the next attempt. The request must include the expected attempt ID, baseline OID, execution root, and explicit restore confirmation. A stale or mismatched value returns `409` without changing Git or Session state. The UI presents this as “Restore baseline and retry” with the exact target and a second confirmation.

Retry never stacks a command on top of partial failed or cancelled changes. The partial result remains reachable through its immutable checkpoint ref and attempt evidence.

User cancellation uses:

```text
POST /api/sessions/:id/steps/:index/cancel
{ "attempt": 2 }
```

The cancel route validates the exact active `{sessionId, stepIndex, attempt}` record and signals its `AbortController` outside the Session mutation claim, because the run request already owns that claim. It returns:

```text
202 { "status": "cancelling", "stepIndex": 1, "attempt": 2 }
```

The original run request remains solely responsible for command termination, partial-result checkpointing, Session transition, persistence, and SSE publication. A cancelled command ends in the distinct `cancelled` step and attempt status and may be retried. Cancellation requested after the command phase has ended returns `409 finishing`; cancellation never races a second state transition.

Shutdown-triggered abort uses the same finalization path but records its shutdown reason. Retry continues to require the same baseline-restore confirmation.

## Restore Semantics

Restore targets an accepted checkpoint boundary in the managed execution worktree:

```text
POST /api/sessions/:id/checkpoints/:checkpointId/restore
{
  "confirmed": true,
  "expectedOid": "full-object-id",
  "expectedExecutionRoot": "/exact/managed/path"
}
```

The UI first opens a dedicated restore dialog. The final action displays and submits the exact session, checkpoint, full OID, execution path, and affected step boundary.

The server requires:

- no active step command;
- no running or starting preview process;
- a clean managed worktree;
- matching session ownership, checkpoint ref, full OID, and execution root;
- a currently restorable checkpoint;
- the Session mutation claim.

It switches the detached managed worktree to the validated OID without force, appends a `workspace.restored` event, records the current workspace checkpoint, and resets steps after that accepted boundary to `pending`. Runtime fields on those step projections are cleared, while all prior attempts, snapshots, reviews, annotations, and events remain unchanged.

The cursor moves to the restored boundary for visibility, but the restore result explicitly identifies a filesystem mutation. A plain timeline seek never changes `workspace.currentCheckpointId`.

If persistence fails after a Git mutation, the server returns an explicit reconciliation error containing the intended and observed checkpoint identities. It does not attempt a second implicit restore. Full automatic reconciliation is deferred to Milestone 4.

## File Diff Contract

Attempt snapshots persist a lightweight file manifest rather than every patch:

```json
{
  "path": "src/app.js",
  "oldPath": null,
  "status": "modified",
  "binary": false,
  "additions": 8,
  "deletions": 3
}
```

Statuses cover added, modified, deleted, renamed, copied, type-changed, and unmerged evidence. Deleted and renamed paths come from the Git manifest rather than the post-step file tree.

One file is loaded lazily:

```text
GET /api/sessions/:id/attempts/:attemptId/diff?path=<encoded-path>
```

The server resolves `path` only through the persisted manifest and reads both sides from the validated baseline and result OIDs. It never treats the query as a filesystem path.

The response contains bounded text, structured hunks, truncation metadata, and binary metadata. Text content and hunk count have fixed limits; oversized files return a visible truncated response and can still be opened externally. Binary files show metadata without embedding binary patches. Full Session SSE never carries per-file patch bodies.

The protocol work also reconciles the existing snapshot-schema names (`files`/`changes`) with the runtime names (`tree`/`treeChanges`). Readers remain compatible with stored v1 sessions, while newly produced evidence uses one documented canonical shape. Milestone 3 does not build new APIs on top of the divergent names.

The Migration Center provides:

- a collapsible changed-file list with status, additions, and deletions;
- unified and side-by-side modes for the selected file;
- search within the loaded file diff;
- safe extension-based syntax highlighting for the bundled Web migration formats, with escaped plain-text fallback;
- loading, empty, binary, truncated, and error states;
- keyboard-operable selection and stable focus targets.

The browser uses request-generation and session/attempt ownership checks so stale lazy responses cannot replace the current selection.

## Annotations, Bookmarks, and Evidence Jumps

Annotations extend compatibly:

```json
{
  "id": "annotation-id",
  "stepIndex": 1,
  "attemptId": "attempt-id",
  "kind": "note",
  "text": "**Check** the target heading.",
  "tags": ["content"],
  "target": {
    "type": "diff",
    "path": "target/index.html",
    "line": 12
  },
  "createdAt": "2026-07-30T08:05:00.000Z"
}
```

`kind` is `note` or `bookmark`. `attemptId`, `tags`, and `target` are optional so existing annotations remain valid. Evidence target types are:

- `file` or `diff`: validated attempt ID, manifest path, and optional line;
- `command`: validated attempt ID, persisted `stdout` or `stderr`, and optional line.

Preview runtime sequence numbers are not durable evidence anchors and are rejected as bookmark targets.

Markdown rendering supports a small documented subset and always escapes raw HTML before applying markup. Links accept only safe protocols. Tags, text, path lengths, line numbers, and collection sizes are bounded and validated on the server.

A bookmark jump first seeks the step, selects the attempt and file or command stream, loads lazy evidence if necessary, then focuses and scrolls to a stable target. Generation tokens prevent a jump from completing after the user changes session or selection.

## Web Interaction and Accessibility

The existing centralized controller and delegated actions remain in place. New state is limited to:

- current attempt and selected file;
- diff mode, search, loading, and request generation;
- restore-dialog target, ownership, and pending state;
- pending evidence jump.

Timeline controls gain visible labels, accessible names, `aria-current`, and scroll containment. Changed files use semantic buttons with an exposed selected state. The diff panel has a labelled region and local loading status.

The restore dialog moves focus inside on open, traps keyboard navigation, returns focus to its trigger on cancel, and focuses the authoritative result after success. Restore and timeline seek use different wording, visual emphasis, controls, and endpoints.

The note editor gains a real label. The live terminal uses bounded log semantics without repeatedly announcing the entire buffer. Responsive layouts keep workspace identity, changed files, diff, and restore controls reachable at narrow widths.

## API, Concurrency, and Persistence

New or extended endpoints are:

```text
POST /api/sessions/:id/workspace/prepare
GET  /api/sessions/:id/attempts/:attemptId/diff?path=...
POST /api/sessions/:id/steps/:index/cancel
POST /api/sessions/:id/checkpoints/:checkpointId/restore
POST /api/sessions/:id/annotations
```

Prepare, run/retry, review, restore, seek, and annotation mutations use the existing per-session mutation claim. Cancel only signals the exact active attempt outside that claim; finalization remains inside the owning run operation. Preview start/stop retains its per-slot serialization, while restore refuses to start until both slots are inactive.

Every mutation persists before publishing the normal Session SSE projection. Git and Session JSON cannot form a cross-resource transaction, so failures return explicit observed/expected checkpoint evidence rather than pretending atomic rollback. No new cross-process guarantee is claimed.

`cancelled` is intentionally added as a distinct step status rather than encoding user intent as a generic failure. Readiness treats it like `failed`, and protocol, engine, controller, and compatibility tests cover the new value explicitly.

Existing sessions load with absent `workspace`, `attempts`, and expanded annotation fields. Existing read-only trace sessions continue to render. Real Migration actions require a prepared valid Git workspace.

## End-to-End Example and Verification

The migration demo becomes a real Git-backed flow in a temporary test repository:

1. initialize and commit the unchanged source project;
2. create a Migration session and prepare its isolated workspace;
3. start source and target previews from the execution root;
4. run a high-risk step and verify confirmation, checkpoint, command output, and file manifest;
5. reject it, inspect the failed attempt, confirm baseline restore, retry, and accept;
6. execute the remaining dependent steps and inspect per-file unified/side-by-side evidence;
7. create a Markdown note, tags, and a bookmark to a persisted diff or command line;
8. cancel a long-running step and verify partial output and a `cancelled` attempt;
9. restore an earlier accepted checkpoint and verify files and step projection roll back while historical evidence remains;
10. verify the original source branch and working tree are byte-for-byte unchanged.

Automated coverage includes Git-adapter unit tests, SessionEngine transition tests, protocol validation, real HTTP/SSE/process integration, controller race tests, static accessibility/responsive checks, and the real Git migration flow.

Real-browser smoke verification covers desktop and narrow layouts, keyboard file selection, unified/side-by-side switching, bookmark focus, restore confirmation and focus return, preview behavior, and absence of console errors. Product-level browser automation remains a later adapter concern.

## Delivery Strategy

Implementation follows the dependency chain:

1. Git status, managed worktree, and owned checkpoint primitives;
2. protocol and append-only attempt model;
3. server workspace preparation and execution-root routing;
4. attempt finalization, cancellation, retry, review, and restore;
5. lazy per-file diff API;
6. Web diff review and restore confirmation;
7. annotations, bookmarks, Markdown, and evidence jumps;
8. real migration example, browser verification, security review, and documentation.

Every task uses RED-GREEN TDD, a fresh implementation agent, independent specification review, and independent quality review before the next task begins.
