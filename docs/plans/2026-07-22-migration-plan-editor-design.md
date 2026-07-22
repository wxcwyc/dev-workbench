# Migration Plan Editor Design

## Goal

Add a first persistent plan editor to Migration Center. Users can add, edit, delete, and reorder steps in a Migration session before any step has started. Saving a plan never executes commands.

## Scope

The first version edits only pristine Migration sessions:

- `workbench` is `migration`;
- `cursor` is `-1`;
- every step is `pending`;
- snapshots and annotations are empty;
- no operation for the session is currently running.

Editable fields are the fields already supported by the v1 protocol:

- title;
- description;
- expected-result text;
- command argv;
- command cwd.

The editor may save an empty plan. Dependencies, risk levels, attempts, `awaiting_review`, execution-time plan mutation, downstream invalidation, and concurrent revision control are deliberately deferred.

## Architecture

The client edits a deep-cloned draft and saves the full list once through:

```text
Migration editor draft
  -> PUT /api/sessions/:id/plan { steps }
  -> protocol step validation
  -> SessionEngine.replacePlan(session, steps)
  -> SessionStore.save(session)
  -> existing SSE session publication
```

The endpoint accepts only `{ steps }`; it never accepts a complete client-supplied Session. SessionEngine owns the eligibility checks and step normalization so the same invariants apply outside HTTP. The server rechecks the current stored session immediately before replacement and rejects edits while the session is in the existing running-operation set.

## Protocol and Engine

The protocol exposes a focused plan-input validator that reports JSON Pointer paths rooted at `/steps`. It accepts an object containing only `steps`, and applies the existing step validation rules.

`SessionEngine.replacePlan()` rejects:

- Execution sessions;
- sessions whose cursor moved from `-1`;
- any session containing a non-pending step;
- sessions with snapshots or step-indexed annotations;
- malformed plan input.

On success it replaces steps with freshly normalized pending steps, updates the session timestamp, records one `plan.updated` event, and leaves snapshots, annotations, and cursor empty/unchanged. This event is added to the protocol event-type list. Empty plans are valid.

## HTTP Behavior

`PUT /api/sessions/:id/plan` uses the existing Host, Origin, and JSON Content-Type protections. It:

1. rejects an active operation with `409`;
2. loads the current session;
3. validates `{ steps }` with JSON Pointer errors;
4. invokes `replacePlan`;
5. atomically saves and publishes the updated public session.

Any validation or eligibility failure happens before persistence and SSE publication. Saving a plan performs no project scan, snapshot, or command execution.

## Web UI

Migration Center displays an `Edit plan` action. It is enabled only for pristine plans; otherwise it remains visible but disabled with a concise explanation.

The action opens a wide modal dialog containing a local draft. Each step is a collapsible card with:

- title and description inputs;
- expected-result textarea;
- zero or more argv item inputs, plus add/remove argument actions;
- cwd input;
- move up, move down, and delete actions.

The footer provides `Add step`, `Cancel`, and `Save plan`. Deleting the final step is allowed. Save submits the full draft once. During save, all mutation controls are locked. Failure keeps the dialog and draft open with an inline error; success closes the dialog and renders the server response.

Draft operations live in a dependency-free `apps/web/plan-editor.js` module. They return new values rather than mutating the source session. New expected values are stored as text. Existing non-string expected values are presented as formatted JSON text so they are not silently shown as `[object Object]`.

The controller gives each dialog opening and save request an ownership token. Closing the dialog or switching sessions invalidates stale UI updates. A saving request remains locked across close/reopen until it settles, matching the existing onboarding creation-lock behavior.

## Safety and Accessibility

- Argv stays an array throughout editing; no shell-string parser is introduced.
- All untrusted strings are assigned through form values or escaped before HTML rendering.
- Saving cannot execute a command; execution retains its separate confirmation gate.
- The dialog has a labelled title, initial focus, visible focus styles, keyboard-close behavior, and an `aria-live` status region.
- Desktop uses a wide two-column field layout where useful; narrow viewports use a single column without horizontal page overflow.
- Reordering controls have explicit accessible names and correct disabled states at the first and last positions.

## Error Handling

Front-end validation catches missing titles and blank argv items and identifies the affected step. Server validation remains authoritative and returns JSON Pointer details. Oversized bodies, stale/non-pristine sessions, unsupported workbenches, and running operations surface as inline errors without discarding the draft.

If an SSE update arrives while the editor is open, the visible workbench may update, but the local draft remains stable. Saving against a session that is no longer pristine is rejected by the server. Optimistic revision conflict detection is out of scope for this single-user first version.

## Testing

Tests cover:

- pure draft cloning, add/delete/move, argv operations, and validation;
- protocol JSON Pointer errors and extra-field rejection;
- engine eligibility, normalization, empty plans, and `plan.updated` events;
- HTTP persistence, SSE publication, running/non-pristine rejection, Content-Type, and no-mutation failures;
- controller save locking, close/reopen ownership, stale responses, retained failures, and XSS-safe rendering;
- responsive and accessible structure through DOM/source assertions, followed by manual browser checks when browser tooling is available;
- complete repository regression suite and runtime HTTP smoke tests.

## Deferred Work

The next development item introduces `awaiting_review` and accepted/failed review transitions. That work will define dependency and risk semantics, attempts, edit-after-execution invalidation, skip/terminate behavior, and eventual stable step identifiers.
