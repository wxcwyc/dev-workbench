# Project Onboarding Design

## Goal

Complete the Phase 1 Milestone 2 project-onboarding capability as a safe end-to-end flow. A developer can inspect a real local project, review detected tooling and an optional imported session, understand the execution boundary, and create an Execution or Migration session without running project commands.

## Scope

The onboarding flow will:

- accept a project path inside `DEV_WORKBENCH_ALLOWED_ROOT`;
- detect Git, package manager, primary languages, and common Web frameworks;
- create either an empty Execution or Migration session;
- optionally import and validate trace or plan JSON;
- preview the normalized session, steps, commands, working directories, and impact before creation;
- retain a bounded list of recently opened projects;
- show exact validation locations when imported protocol data is invalid.

It will not start preview processes, execute migration commands, edit plan steps, or implement the later Preview Process Supervisor milestone.

## Architecture

### Project inspection

Add a read-only inspection module to `packages/project-adapters`. It will inspect directory metadata, Git markers, manifest and lock files, source extensions, and declared dependencies. It will not execute package managers or project code.

The result will contain:

- the canonical absolute project path;
- whether the directory belongs to a Git repository;
- the detected package manager;
- primary languages;
- detected frameworks;
- evidence files used for each conclusion;
- non-fatal warnings from malformed or unreadable optional metadata.

### Server API

Add two project routes to `apps/server`:

- `POST /api/projects/inspect` canonicalizes and validates a supplied path, then returns inspection results.
- `GET /api/projects/recent` returns the bounded recent-project list.

Successful session creation records the canonical project path, last-used time, and last-used workbench type in a small JSON file under the existing state directory. The existing `POST /api/sessions` remains the only session creation path, so validation and persistence are not duplicated.

### Web onboarding flow

Add an "Open local project" entry point and a staged onboarding panel:

1. Enter a path and inspect it.
2. Review detected project attributes and choose a workbench.
3. Optionally paste or upload trace/plan JSON.
4. Review the normalized session and safety summary.
5. Explicitly create the session.

The existing visual system will be preserved. The new panel should remain usable with a keyboard and at the current desktop and narrow layouts.

## Data Flow

1. The user enters an absolute path or a path relative to `DEV_WORKBENCH_ALLOWED_ROOT`.
2. The server resolves the candidate through `realpath` and rejects `..` or symlink escapes.
3. The inspector returns normalized project facts and supporting evidence.
4. The user selects Execution or Migration and optionally imports JSON.
5. When importing, the currently inspected path overrides any `projectRoot` embedded in the file. The imported workbench must match the selected workbench.
6. The browser builds a final preview containing the title, workbench, project root, and every step's title, argv command, cwd, and impact classification. Steps without commands are marked as observations.
7. The preview states the allowed root and that creating a session executes no commands.
8. Only the final create action submits to `POST /api/sessions`.
9. The server repeats protocol and boundary validation, persists the session, and updates recent projects.

Recent-project entries do not retain imported plan contents. This avoids silently reusing stale commands and limits persisted project information.

## Error Handling

- A missing path, non-directory, or path outside the allowed root fails inspection and does not update recent projects.
- Failure to read the project root is fatal. Failure to read optional metadata becomes a warning when inspection can otherwise continue.
- Malformed `package.json` does not discard other detected facts; the response includes a precise warning.
- Browser-side JSON syntax errors include line and column where available.
- Protocol failures show the JSON Pointer and reason returned by the server.
- A failed create request preserves the onboarding draft for correction and creates no partial session.
- Missing recent paths remain visible until displaced, but reopening them always performs a fresh inspection.
- A corrupted recent-project file degrades to an empty list and does not prevent session creation; the server logs a warning.

## Testing and Acceptance

Automated tests will cover:

- Git, npm, pnpm, yarn, language, and common framework detection;
- malformed optional manifests;
- `..`, outside-root, and symlink boundary escapes;
- inspection and recent-project HTTP routes;
- empty and imported session creation through onboarding;
- JSON Pointer details for invalid protocol input;
- pure browser helpers for import merging, safety summaries, and error formatting.

Completion requires a green full `npm test` run plus a server-start and core-API smoke check. Native system directory picking is not required because browsers cannot reliably provide arbitrary absolute local paths; path entry and recent-project shortcuts satisfy the development plan's "select or enter" requirement.
