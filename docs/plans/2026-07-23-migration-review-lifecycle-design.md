# Migration Review Lifecycle Design

## Goal

Complete the next Milestone 2 Migration slice with a review gate, stable step identity, dependency readiness, risk semantics, and retry counting. Every successfully executed Migration step must be explicitly accepted or rejected before the plan can advance.

Execution workbench behavior remains unchanged.

## Scope

This slice adds:

- stable step IDs;
- `low`, `medium`, and `high` risk levels;
- dependencies on earlier plan steps;
- a numeric attempt counter;
- the `awaiting_review` step and session status;
- accepted and rejected review transitions;
- server-enforced high-risk confirmation;
- plan-editor and Migration Center controls for these fields and transitions.

Plan replacement remains limited to pristine Migration sessions. Execution-time plan editing, downstream invalidation, concurrent plan revisions, cancellation, checkpoint restoration, and independent attempt persistence remain deferred.

## Step Model

Plan input may contain:

- `id`: a non-empty stable identifier;
- `risk`: `low`, `medium`, or `high`;
- `dependsOn`: an array of step IDs.

Normalization supplies a UUID when `id` is absent, `low` when `risk` is absent, and an empty dependency list when `dependsOn` is absent. Runtime steps also contain `attempt`, initialized to `0`.

Plan and session input validation enforces:

- unique step IDs;
- unique dependency entries;
- dependency targets that exist in the same plan;
- no self-dependencies;
- dependencies only on earlier steps.

Restricting dependencies to earlier steps makes cycles impossible and preserves the current deterministic plan order. An imported plan that references a dependency must provide the referenced step's explicit ID; server-generated IDs are intended for steps without incoming references.

The plan editor retains existing IDs and assigns an ID to every newly added draft step. Reordering may make a dependency invalid; the editor reports that error instead of silently rewriting user intent.

## Lifecycle

Migration steps follow:

```text
pending or failed
  -> running
  -> failed                 when execution fails
  -> awaiting_review        when execution succeeds
       -> completed         when accepted
       -> failed            when rejected
```

`startStep()` increments `attempt` and clears the previous review outcome. A successful Migration run records its snapshot and moves the cursor to that step, but it does not mark the step completed. The session becomes `awaiting_review`.

Accepting the review marks the step completed. The session becomes `completed` when every step is completed or skipped; otherwise it becomes `ready`.

Rejecting the review marks the step failed and the session failed. The same step becomes the next retry candidate. Review decisions and attempt numbers are recorded in events; retry may replace the current step snapshot while the event history remains intact.

Execution sessions retain their existing direct `running -> completed` transition.

## Dependency Readiness

A Migration step is runnable only when:

- its status is `pending` or `failed`;
- every ID in `dependsOn` identifies a completed step;
- no step is currently `running` or `awaiting_review`.

The engine remains authoritative for readiness. The server accepts a run only for the index returned by `nextRunnable()`, and the UI mirrors that result for presentation.

Because plans remain immutable after execution begins, this slice cannot create completed descendants of an edited or invalidated ancestor. Downstream invalidation is therefore deferred safely.

## Risk Semantics

Risk is visible on plan steps and in the execution confirmation.

- `low` and `medium` are descriptive in this slice;
- `high` requires `confirmedRisk: true` at the run endpoint;
- the high-risk requirement applies even to observation-only steps;
- command execution continues to require the existing `confirmed: true`.

The server owns both confirmation checks. UI confirmation text includes the step's risk, command or observation description, project root, and dependency context.

## Review API

The server adds:

```text
POST /api/sessions/:id/steps/:index/review
Content-Type: application/json

{ "decision": "accept" }
```

or:

```json
{ "decision": "reject" }
```

Only those exact request shapes are accepted. The step must belong to a Migration session and be in `awaiting_review`.

Run and review use the existing per-session mutation lock. Validation or transition failures happen before persistence and SSE publication. A successful decision is saved once, published over the existing session event stream, and returned as the full public session.

## Events

The engine records:

- `step.awaiting_review` after successful Migration execution;
- `step.review.accepted` after acceptance;
- `step.review.rejected` after rejection.

Each event includes the step index, stable step ID, and attempt number. Existing `step.started` and `step.failed` events also include the current attempt where applicable.

## Web UI

The plan editor adds:

- a visible stable ID;
- a risk selector;
- dependency checkboxes limited to earlier draft steps.

Draft cloning and serialization preserve all three fields. New draft IDs use `crypto.randomUUID()`. Validation matches server rules and reports the first affected JSON Pointer path.

Migration Center displays each step's status, risk, dependencies, and attempt count. When a step is awaiting review, the normal run action is replaced by Accept and Reject controls. Rejected steps present a retry label.

All mutation controls are locked while their request is in flight. SSE remains authoritative, and stale responses must not overwrite a different active session. Review status and controls are keyboard accessible and use the existing live status/error presentation.

## Error Handling

- Invalid IDs, risks, and dependencies are rejected before plan mutation.
- A blocked or out-of-order run does not increment the attempt or mutate the session.
- Missing command confirmation and missing high-risk confirmation do not mutate the session.
- Review of a non-Migration or non-`awaiting_review` step is rejected without mutation.
- Duplicate run/review operations receive the existing conflict response.
- Persistence occurs before SSE publication.

## Testing

Tests cover:

- protocol field validation and cross-step dependency errors;
- normalization defaults, stable IDs, attempts, dependency readiness, and both review decisions;
- unchanged Execution lifecycle behavior;
- run and review HTTP persistence, confirmation gates, locking, SSE publication, and no-mutation failures;
- plan-editor ID/risk/dependency cloning, edits, reordering validation, and serialization;
- Migration rendering, review actions, request locking, stale-response protection, and accessible controls;
- full repository regression and a runtime HTTP smoke test.

## Delivery

Implementation is split into sequential tasks. Each task is implemented by a fresh subagent, then reviewed by an independent specification reviewer and an independent quality reviewer. Review findings return to the original implementer before the task is accepted.
