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

## Migration plan editing v1

Migration Center 的首版计划编辑器只作用于 pristine Migration session：

- `workbench` 是 `migration`；
- `cursor` 是 `-1`；
- 每一步都是 `pending`；
- snapshots 和 annotations 为空；
- 会话当前没有任何运行中的操作。

可编辑字段来自 v1 协议：title、description、expected-result text、command argv、command cwd、risk 和 earlier-step dependsOn；stable ID 只读。

客户端先编辑深拷贝后的 draft，再通过 `PUT /api/sessions/:id/plan { steps }` 一次性提交整个 plan。服务端先校验 step 合同，再由 `SessionEngine.replacePlan()` 重新检查是否仍然满足 pristine 条件，随后替换全部步骤、更新时间戳、记录一个 `plan.updated` 事件，并通过现有 SSE 通道重新发布会话。保存 plan 不会执行项目命令。

Migration 的成功执行会先进入 `awaiting_review`，再由 accept/reject 推进；reject 会把步骤标记为可重试的 `failed`，下一次 retry/start 才会递增 `attempt`。execution-time editing、downstream invalidation、revision conflict 和并发修订控制都留给后续工作。

## Preview runtime

Migration session 现在可以在 `metadata.previewServices.source|target` 中声明 preview 进程。每个 slot 只接受 `command`、`cwd`、`port`、`healthPath` 和 `previewPath`，并由 `PreviewProcessSupervisor` 解析成 loopback-only 的 `actualUrl` / `healthUrl`：

- URL 固定归属 `http://127.0.0.1:<port>`，`healthPath` 和 `previewPath` 必须是 origin-relative path；
- supervisor 在启动前先探测 `127.0.0.1:<port>`，若端口已被外部进程占用，则把 slot 标记为 `conflict` 并保留诊断，不会尝试接管或停止该端口；
- 只有 supervisor 自己 spawn 的子进程会进入 stop/restart/stopAll；`server.close()`、SIGINT 和 SIGTERM 共用幂等的 managed shutdown：拒绝新的 runtime mutation、abort active step 并关闭 SSE，再以 `SIGTERM` / 超时后 `SIGKILL` 停止 owned preview，等待 step 请求收尾后关闭 HTTP；
- 启动阶段轮询健康检查；健康成功后状态变为 `running`，否则保留 `starting`/`exited` 证据与异常诊断。

preview 配置和已完成 step 的 command result 属于持久化 Session；`PreviewProcessSupervisor` 持有的 child reference、生命周期状态和诊断，以及 `TerminalBuffer` 的输出 tail 都只存在于当前服务进程内。它们不会写入 Session JSON，工作台重启后 preview 状态恢复为 `stopped`，runtime tail 清空。

实时输出由 `TerminalBuffer` 和 runtime SSE 提供：

- preview `stdout`/`stderr` 与 migration step `stdout`/`stderr` 都归一为 `terminal.output` 事件；
- `TerminalBuffer` 只保留每个 session 最近 256 KiB UTF-8 输出，用于 `/api/sessions/:id/runtime` 快照与 `/api/sessions/:id/runtime/events` SSE 回放；
- runtime SSE 先发送 `runtime.snapshot`，再补发快照截点之后的新 `preview.state` / `terminal.output` 事件，避免重复回放快照已覆盖的内容；
- runtime SSE 独立于既有 Session SSE；前者只描述当前进程的 ephemeral runtime，后者仍是持久化 Session transition 的权威通道；
- step 命令的完整结果仍保存在 step snapshot 的 `command` 字段，`runConfirmedCommand()` 最多捕获 8 MiB 合并 stdout/stderr 证据。

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
- HTTP 服务只绑定 `127.0.0.1`，并要求 `Host` / `Origin` 精确匹配当前 loopback 地址和监听端口；
- 项目 cwd 同时经过词法路径和 `realpath` 检查，拒绝执行前已存在的 `..` 或符号链接边界逃逸；
- 项目检查拒绝符号链接或非目录根路径，并在扫描开始和结束时比较根目录的 device/inode；`package.json` 通过 no-follow 文件句柄打开、以句柄重新检查类型和身份，并采用有上限的读取。这些措施可阻止静态符号链接、可观察到的常规替换和超大 manifest 造成的资源滥用；
- command 必须是字符串数组，由 `spawn(..., shell=false)` 直接执行；executable 和参数中的 shell 元字符只作为字面字符传递，不会被 shell 解析；
- preview supervisor 同样使用 `spawn(..., shell=false)`，并把 preview URL/health URL 限制为本机 loopback；
- 有 action 的步骤必须提交 `confirmed=true`；
- 一个 session 同时最多运行一个步骤；
- HTTP JSON body 限制为 1 MB；
- 文件树跳过 `.git`、`node_modules` 和 `.dev-workbench`。

本地命令和项目检查仍然具有当前用户权限，所以只应在可信本地环境中导入可信计划。`realpath` 检查与 `execFile` 启动并非原子操作，项目检查的首尾身份比较与扫描过程也不是原子操作。另一个具有相同权限的本地进程可以在命令启动前替换目录；也可以在扫描期间以 ABA 方式替换项目根、让检查器读取替换内容，再恢复原目录，使首尾 device/inode 相同而无法被检测。这类主动对抗不属于 Phase 1 的可信本地威胁模型，因此当前实现不提供原子或强对抗保证。需要抵抗此类攻击时，应使用固定目录文件描述符的原生 walker/launcher，或迁移到隔离 worker、容器或远程沙箱，并增加身份认证、授权、审计与密钥隔离。

## Next adapters

1. Prolog runtime adapter：从解释器事件直接生成 rule/unification/backtracking trace；
2. Git checkpoint adapter：每步生成可恢复 commit 或 worktree；
3. Test adapter：把失败用例、覆盖率和日志映射到时间轴；
4. Container worker：在一次性隔离环境中执行迁移步骤；
5. Preview runtime 扩展：PTY/input、持久 preview logs、创建后 preview config 编辑器和远程 worker。
