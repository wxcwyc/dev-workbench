# Dev Workbench

[English](README.md) | [简体中文](README.zh-CN.md)

**Understand software by stepping through its execution and changes.**

Dev Workbench is a local-first developer tool for replaying execution traces and reviewing project migrations one step at a time. It brings program state, command output, file diffs, live previews, and your own notes into a shared timeline.

The project is in active development. It runs locally with Node.js and has no runtime npm dependencies.

## Two workbenches

| Workbench | What you can do |
| --- | --- |
| **Execution Explorer** | Replay structured traces from interpreters, algorithms, rule engines, or agents. Inspect source positions, goals, stacks, bindings, branches, and backtracking. |
| **Migration Center** | Run a migration plan in a managed Git worktree. Review each result, inspect diffs, compare previews, accept or reject changes, retry from a baseline, and restore accepted checkpoints. |

Both share an event-based execution core, session persistence, timeline, and annotation model. The included examples cover a Prolog query and a framework migration workflow.

## Quick start

Requirements: **Node.js 22+** and **Git** for migration workspaces and checkpoints.

```bash
git clone https://github.com/wxcwyc/dev-workbench.git
cd dev-workbench
npm start
```

Open **http://127.0.0.1:4177** and choose the logic debugger or migration example. No dependency installation or build step is required.

The UI follows your browser's first preferred language: `zh` / `zh-*` selects Simplified Chinese; other languages select English. Change the browser preference and reload to switch. Project content, code, paths, and command output retain their original text.

Use `npm run dev` for automatic server restart during development.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEV_WORKBENCH_ALLOWED_ROOT` | Current user's home directory | Restricts which local projects can be opened. |
| `DEV_WORKBENCH_PORT` | `4177` | Workbench HTTP port. |

For example, in Bash or another POSIX shell:

```bash
DEV_WORKBENCH_ALLOWED_ROOT=/absolute/path/to/projects npm start
```

Sessions, recent projects, and managed workspaces are stored under `.dev-workbench/`, which is excluded from Git.

## Open your own project

1. Select **Open local project** and enter an absolute path or a path relative to the allowed root.
2. Inspect the detected Git repository, package manager, languages, frameworks, and warnings. Inspection does not run project commands.
3. Choose Execution or Migration, enter a session title, and optionally paste or upload a trace/plan JSON file.
4. Review the normalized steps, command arguments, working directories, and safety boundary before creating the session.

Recent projects are inspected again when reopened; old plans are not reused automatically. Creating a session does not execute commands.

### Review a migration

- Start from a clean Git repository and select **Prepare workspace** to create a managed detached worktree.
- Before execution begins, edit step titles, descriptions, expected results, command arguments, working directories, risks, and dependencies. Step IDs remain stable.
- Confirm each command before running it. High-risk steps require an additional confirmation.
- Successful commands enter a review gate. Inspect file diffs and output, then **Accept step** or **Reject step**.
- Retry failed, cancelled, or rejected attempts after confirming restoration of the exact attempt baseline.
- Restore the initial or an accepted checkpoint after reviewing its full Git OID and execution path. Restore preserves recorded evidence and requires previews and commands to be stopped.

Migration commands run in the managed worktree. The workbench does not run them directly in the source working tree. This is Git workspace separation, not an operating-system sandbox: executed commands still have your user's permissions.

## Import traces and plans

The **Import session JSON** entry also accepts sessions directly. Replace the example project path with your own allowed local path.

### Execution trace

```json
{
  "title": "Parser walkthrough",
  "workbench": "execution",
  "projectRoot": "/absolute/path/to/project",
  "trace": [
    {
      "title": "Read token",
      "explanation": "The parser consumes the first token.",
      "state": {
        "program": ["parse(Expression)"],
        "currentLine": 1,
        "goals": ["parse term"],
        "stack": [{ "rule": "expression", "goals": ["term"], "bindings": {} }]
      }
    }
  ]
}
```

### Migration plan

This example assumes your project contains `scripts/migrate.mjs`:

```json
{
  "title": "Migrate site",
  "workbench": "migration",
  "projectRoot": "/absolute/path/to/project",
  "steps": [
    {
      "id": "create-target-shell",
      "title": "Create target shell",
      "description": "Initialize the new framework.",
      "risk": "medium",
      "dependsOn": [],
      "action": { "command": ["node", "scripts/migrate.mjs", "shell"] }
    }
  ]
}
```

Commands must be argument arrays, not shell strings. Working directories must stay inside the project boundary. Importing a plan does not run it.

### Stream trace events

Create an empty Execution session, then send `application/json` or `application/x-ndjson` to `POST /api/sessions/{sessionId}/trace`. Event sequences must be consecutive, starting at the session's current step count:

```json
{"protocolVersion":"1.0","sessionId":"SESSION_ID","sequence":0,"kind":"branch","title":"Choose rule","state":{"goals":["parent(X, Y)"]}}
```

Events are validated, persisted, and delivered to the UI through Server-Sent Events (SSE). If a later NDJSON line is invalid, the response reports the accepted count and retains previously accepted events.

The built-in logic example uses the runtime in `packages/prolog-adapter`. To generate NDJSON for an existing Execution session:

```bash
node packages/prolog-adapter/src/cli.js --source examples/logic-trace/program.pl --query "grandfather(X, Y)?" --session SESSION_ID
```

The CLI writes NDJSON to standard output; submit it to the trace endpoint to ingest it. The runtime supports pure Horn clauses: facts, rules, atoms, compound terms, variables, unification, depth-first search, and backtracking. It does not yet support cut, negation, arithmetic, dynamic predicates, or SWI-Prolog built-ins. `GET /api/adapters` exposes adapter manifests and capabilities.

## Local execution boundary

The server binds to `127.0.0.1` and checks Host/Origin against its loopback address and port. Project paths are checked against the allowed root, commands run without shell-string interpretation, and mutations require explicit confirmation.

Use trusted local projects and plans. The current version is designed for a trusted local environment and has no authentication for public hosting. See [Architecture and execution boundaries](docs/ARCHITECTURE.md) for the full model and its limitations.

## Development and tests

```bash
npm test
```

The tests cover protocol validation, adapters, execution state, project inspection, browser controllers, live previews, SSE, and migration recovery. The recovery end-to-end test creates real temporary Git repositories and exercises review, retry, cancel, diff, bookmarks, and restore while checking that source repository files and Git state remain unchanged.

```text
apps/server/              Local HTTP server and SSE coordination
apps/web/                 Browser UI and English/Chinese messages
packages/execution-core/  Session state, persistence, and terminal buffer
packages/project-adapters/ Project inspection, commands, Git, and previews
packages/protocol/        Versioned schemas and validation
packages/adapter-sdk/     Adapter manifests and trace helpers
packages/prolog-adapter/  Prolog runtime and NDJSON CLI
examples/                 Logic and migration demos
test/                     Automated regression and integration tests
```

Issues and pull requests are welcome. Include reproduction steps for bugs and run `npm test` before submitting code changes.

## Project documentation

The detailed design and planning documents currently contain Chinese or mixed Chinese/English text.

- [Project purpose and product principles](docs/PROJECT_PURPOSE.md)
- [Initial solution and scope](docs/INITIAL_SOLUTION.md)
- [Development roadmap](docs/DEVELOPMENT_PLAN.md)
- [Architecture and execution boundaries](docs/ARCHITECTURE.md)
- [English and Chinese repository descriptions](docs/REPOSITORY_DESCRIPTION.md)

## License

[MIT](LICENSE) © 2026 wxcwyc. Use, modification, and redistribution, including commercial use, are permitted subject to retaining the copyright and permission notice. The software is provided without warranty.
