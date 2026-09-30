# Initial Solution

## 初始方案概览

第一版采用一个共享事件溯源内核、一个本地 Node.js 服务和两个 UI 投影：

```text
                     ┌──────────────────────┐
Trace / Plan ───────▶│ Shared Session Engine│
                     │ events + snapshots   │
                     └──────────┬───────────┘
                                │
                 ┌──────────────┴──────────────┐
                 │                             │
        Execution Explorer            Migration Center
        program / stack / goals       steps / files / diff
        bindings / timeline           logs / preview / notes
```

两个工作台不分别维护状态逻辑。它们读取同一种 Session，只对 snapshot 中的数据进行不同投影。

## 共享会话模型

```text
Session
├── metadata
├── steps[]
│   ├── description
│   ├── action or traceState
│   └── execution status
├── events[]
├── snapshots[stepIndex]
├── annotations[]
└── cursor
```

### Event

Event 表示发生过的事实，例如：

- `session.created`
- `step.started`
- `step.completed`
- `step.failed`
- `cursor.moved`
- `annotation.added`

执行历史通过 Event 保留；时间轴回看只改变 cursor，不修改过去的 snapshot。

### Snapshot

Snapshot 表示某一步完成后的可观察状态。

Execution Explorer 的 snapshot 主要包含：

- 程序或规则列表；
- 当前源码位置；
- 调用栈或规则栈；
- 当前目标；
- 变量绑定；
- 结果、分支或回溯信息。

Migration Center 的 snapshot 主要包含：

- 文件树；
- 相比前一步的文件变化；
- Git HEAD、status 和 diff；
- 执行命令、stdout、stderr；
- 后续可扩展的测试、构建和预览状态。

## 初始技术选择

### Node.js 22、零运行时依赖

初始版本使用 Node.js 标准库完成 HTTP、SSE、文件读写、子进程和测试，目的是：

- 降低首次运行成本；
- 先验证执行模型和交互，而不是投入构建系统；
- 让工具可以直接放进多数本地项目旁边运行；
- 在协议稳定后再选择 React、Monaco、xterm.js 或数据库。

这不是永久限制。复杂代码查看、终端模拟和大型状态管理成熟后，可以逐步引入专用依赖。

### JSON 会话持久化

MVP 使用原子重命名写入 JSON 会话。它适合单机、小并发和便于检查的数据格式。

下一阶段在需要索引、恢复和大 trace 时迁移到 SQLite，同时保留现有 Session 协议。

### SSE 实时更新

服务端通过 SSE 把会话状态推送给 UI。SSE 足以表达单向执行事件，并且比 WebSocket 更容易调试和降级。当前除了权威发布持久化 Session transition 的 session SSE，还提供独立的 migration runtime SSE：先发送一次 runtime snapshot，再推送 preview state 和 terminal output 增量事件。

### 无 Shell 命令执行

迁移命令必须写成 argv 数组：

```json
{ "command": ["node", "scripts/migrate.mjs", "content"] }
```

服务使用 `spawn(..., shell=false)` 执行，不接受 `sh -c` 字符串。cwd 必须处于声明的 projectRoot 中，并且有 action 的步骤要求 UI 显式确认。

## 初始工作流

### Execution Explorer

```text
Adapter 产生 trace
→ 创建 Session
→ 每个 trace event 转换为 step + snapshot
→ 用户拖动时间轴
→ UI 投影 program / stack / goals / bindings
→ 用户添加注释
```

当前内置逻辑示例已经切换到 runtime 实际执行；真实解释器输出会逐事件写入共享 session。

### Migration Center

```text
导入迁移计划
→ 展示下一步命令和预期结果
→ 可选启动/重启 source 与 target preview
→ 用户确认
→ 准备工作台拥有的隔离 Git worktree
→ 捕获 attempt baseline checkpoint
→ 在 execution root 中运行 argv command
→ 通过 runtime SSE 推送 preview / step stdout、stderr
→ 捕获 result checkpoint、文件 manifest 和 command 结果
→ 用户按需检查逐文件 diff，并 Accept / Reject
→ 失败或取消后从精确 baseline 重试，或恢复到已接受 checkpoint
```

## 已完成的 MVP

- 独立项目及 Git 基线；
- 共享 SessionEngine；
- JSON SessionStore；
- 时间轴 seek 和注释；
- 文件树快照与新增/修改/删除比较；
- Git status 和 diff 捕获；
- projectRoot 边界；
- argv 命令执行与逐步确认；
- Preview Process Supervisor、runtime snapshot 和 runtime SSE；
- TerminalBuffer 实时输出聚合；
- 工作台拥有的 detached Git worktree、attempt baseline/result refs 和 accepted checkpoint restore；
- Reject/Retry、精确 attempt Cancel、partial evidence 和源仓库不变性保护；
- 按需逐文件 unified/side-by-side diff、搜索、历史 attempt 证据；
- 安全 Markdown 注释、标签、file/diff/command 书签和证据跳转；
- 单 session 运行互斥；
- HTTP API 与 SSE；
- Execution Explorer UI；
- Migration Center UI；
- 逻辑 trace 与迁移演示；
- 核心单元测试和两条 API 烟测。

当前 preview/runtime 的具体约束：

- preview service 只接受 session metadata 中的 source/target 配置，并始终解析到 `127.0.0.1:<port>` 的 health/preview URL；
- preview 配置和已完成的 command result 持久化在 Session；supervisor 生命周期状态、child reference 与 terminal tail 只存在于当前进程，重启后不会恢复；
- `TerminalBuffer` 只保留每个 session 最近 256 KiB UTF-8 终端输出；
- step `command` 结果最多保留 8 MiB stdout/stderr 证据，并写入完成或失败 snapshot；
- managed shutdown 会先 abort active step 并关闭 SSE，再停止 workbench 自己创建的 preview child process，等待 step 请求收尾后关闭 HTTP；
- 如果目标端口已被外部进程占用，只会显示 `conflict`，不会把该端口上的现有进程视为本工具资产。

## 初始方案的已知限制

- 预览运行时没有 PTY，也不支持向 step 或 preview 进程写入 input；
- preview 日志只保存在内存中的 runtime buffer，没有独立持久化 preview log；
- 创建 session 后还不能在 UI 中编辑 preview 配置；
- 当前提供审查型逐文件 diff，但没有内置代码编辑器；
- JSON SessionStore 不能在服务崩溃后可靠恢复进行中的操作，preview/terminal runtime 也仍是进程内状态；
- JSON 存储不适合大型 trace；
- 没有 remote worker 或隔离执行环境；
- 本地命令仍拥有当前用户权限；
- 当前没有多人身份认证和项目级授权。

这些限制共同决定了下一阶段的重点：从“可以演示”推进到“可以用于真实项目”。
