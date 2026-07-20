# Architecture

## Shared execution model

两个工作台共享同一种会话：

```text
Session
├── Plan / Trace Steps
├── Immutable Events
├── Per-step Snapshots
├── Timeline Cursor
└── Step Annotations
```

`SessionEngine` 只管理状态变化，不运行外部命令。项目观察和命令执行通过 adapters 注入，因此后续可以增加 Prolog、数据库迁移、测试运行器、浏览器自动化或远程沙箱适配器。

## Package boundaries

```text
apps/server
  HTTP + SSE + execution coordination

packages/execution-core
  session state machine + persistence

packages/project-adapters
  project boundary + argv runner + files + Git snapshots

packages/protocol
  versioned JSON Schemas, validation and shared event contract

packages/adapter-sdk
  manifest definition, trace event builders and NDJSON encoding

apps/web
  Execution Explorer + Migration Center projections
```

## Adapter protocol v1

Adapter manifests declare a stable adapter id, adapter version, protocol version and capabilities. The v1 JSON Schemas live in `packages/protocol/schemas/v1`; runtime validation returns JSON Pointer paths so an importer can show the exact invalid field.

Adapters emit ordered trace events with a semantic kind (`evaluation`, `branch`, `failure`, `backtrack` or `solution`). `packages/adapter-sdk` validates every event before it crosses the adapter boundary and encodes or decodes the event stream as NDJSON without coupling adapters to the server implementation.

The ingestion endpoint accepts JSON events or a streaming NDJSON request. It enforces session id and monotonic sequence numbers, persists each accepted event before publishing it over SSE, and records stream start/completion/failure events. A malformed later line therefore cannot corrupt or erase the valid prefix already stored in the session.

The first runtime adapter is a zero-dependency interpreter for the pure Horn-clause subset of Prolog. It parses project source, performs unification and depth-first clause search, and exposes clause choice, bindings, failed unification, backtracking and solutions as protocol events. This deliberately excludes cuts, negation, arithmetic and implementation-specific built-ins; a future SWI-Prolog bridge can reuse the same manifest and event contract.

## Safety boundary

- `DEV_WORKBENCH_ALLOWED_ROOT` 限制可操作项目范围；
- 项目 cwd 不能通过 `..` 逃逸；
- command 必须是字符串数组，由 `execFile` 直接执行；
- executable 禁止包含 shell 元字符；
- 有 action 的步骤必须提交 `confirmed=true`；
- 一个 session 同时最多运行一个步骤；
- HTTP JSON body 限制为 1 MB；
- 文件树跳过 `.git`、`node_modules` 和 `.dev-workbench`。

本地命令本身仍然具有当前用户权限，所以只应导入可信计划。正式多人版本需要把命令执行迁移到容器或远程隔离 worker，并增加身份认证、授权、审计与密钥隔离。

## Next adapters

1. Prolog runtime adapter：从解释器事件直接生成 rule/unification/backtracking trace；
2. Browser preview adapter：启动并监督 source/target dev server；
3. Git checkpoint adapter：每步生成可恢复 commit 或 worktree；
4. Test adapter：把失败用例、覆盖率和日志映射到时间轴；
5. Container worker：在一次性隔离环境中执行迁移步骤。
