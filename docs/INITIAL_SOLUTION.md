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

服务端通过 SSE 把会话状态推送给 UI。SSE 足以表达单向执行事件，并且比 WebSocket 更容易调试和降级。

### 无 Shell 命令执行

迁移命令必须写成 argv 数组：

```json
{ "command": ["node", "scripts/migrate.mjs", "content"] }
```

服务使用 `execFile` 执行，不接受 `sh -c` 字符串。cwd 必须处于声明的 projectRoot 中，并且有 action 的步骤要求 UI 显式确认。

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

当前内置 Prolog 风格示例使用静态 JSON trace，目的是验证交互协议。真实解释器 adapter 属于下一阶段。

### Migration Center

```text
导入迁移计划
→ 展示下一步命令和预期结果
→ 用户确认
→ 捕获执行前快照
→ 运行 argv command
→ 捕获执行后文件树和 Git 状态
→ 保存 snapshot
→ 用户检查后进入下一步
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
- 单 session 运行互斥；
- HTTP API 与 SSE；
- Execution Explorer UI；
- Migration Center UI；
- 逻辑 trace 与迁移演示；
- 核心单元测试和两条 API 烟测。

## 初始方案的已知限制

- 逻辑 trace 需要外部生成，尚未连接真实解释器；
- 新旧预览只接受 URL，尚不能负责启动和监督 dev server；
- 文件树能显示文件变化，但没有内置代码编辑器和逐文件 diff；
- Git snapshot 不是可恢复 checkpoint；
- JSON 存储不适合大型 trace；
- 运行中的进程不能流式输出，也不能暂停或终止；
- 本地命令仍拥有当前用户权限；
- 当前没有多人身份认证和项目级授权。

这些限制共同决定了下一阶段的重点：从“可以演示”推进到“可以用于真实项目”。
