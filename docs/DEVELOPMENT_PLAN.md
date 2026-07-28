# Development Plan

## 总体路线

开发按能力成熟度分为五个阶段：

| 阶段 | 目标 | 状态 |
| --- | --- | --- |
| Phase 0 | 验证共享时间线与两个工作台的产品形态 | 已完成 |
| Phase 1 | 接入真实项目，形成可用开发闭环 | 进行中（Milestone 1 与 Milestone 2 已完成；Milestone 3+ 待完成） |
| Phase 2 | 增强恢复、隔离和长任务可靠性 | 计划中 |
| Phase 3 | 建立 Adapter/Plugin 生态 | 计划中 |
| Phase 4 | 支持团队协作和远程 Worker | 远期 |

## 当前开发进度（2026-07-28）

Phase 1 的 Milestone 1 与 Milestone 2 已完成。Milestone 2 当前包含 UI 项目接入、迁移计划编辑器首版、review lifecycle、Preview Process Supervisor，以及实时终端输出：

- 固化 v1 Session、Step、Snapshot、Artifact、Adapter Manifest 和 Trace Event JSON Schema；
- 提供 Adapter SDK、manifest/capability discovery、Trace Event 构造与 NDJSON 编解码；
- 提供 JSON/NDJSON 流式 ingestion，逐事件校验、持久化和 SSE 发布，并保留失败前已接收的历史；
- 实现零依赖纯 Horn 子集 Prolog runtime adapter，覆盖解析、规则选择、合一、choice point、失败、回溯、源码位置和多解搜索；
- Execution Explorer 已区分 evaluation、branch、failure、backtrack 和 solution，并展示合一与回溯证据；
- 内置逻辑示例已从静态手写 trace 切换为 runtime 实际执行。
- UI 可以输入允许目录内的真实路径，完成边界与符号链接校验，并只读探测 Git、package manager、语言和常见框架；
- UI 可以从最近项目重新探测路径，选择 Execution 或 Migration，导入可选 trace/plan JSON，并在创建空会话或计划会话前检查规范化步骤与安全边界；Migration 计划现在保留稳定 ID 只读、risk、dependsOn 和 review gate，成功执行的步骤会先进入 `awaiting_review`，高风险步骤在每次 run 和 retry 时都需要显式确认，再由用户接受或拒绝后继续。
- Migration session 可以声明 source/target preview service；supervisor 只生成 `127.0.0.1:<port>` 的 health/preview URL，启动前先探测端口占用，冲突时只报告 `conflict`，不会终止工作台外部进程；
- Preview 与 step 的 `stdout`/`stderr` 都会进入 runtime SSE；`TerminalBuffer` 为每个 session 保留最近 256 KiB UTF-8 输出，step 完成后的 command snapshot 最多保留 8 MiB 结果证据；
- `/api/sessions/:id/runtime` 和 `/api/sessions/:id/runtime/events` 已提供独立于 Session SSE 的 runtime snapshot/SSE；preview lifecycle 与 terminal tail 是 ephemeral runtime，不写入持久化 Session；
- managed shutdown 会 abort active step、关闭 session/runtime SSE、stop owned previews，再等待 step 请求收尾并关闭 HTTP，避免遗留受管子进程。

当前自动化回归覆盖协议、SDK、NDJSON、SessionEngine、项目探测与边界、最近项目、浏览器接入辅助逻辑、Prolog runtime、Preview Process Supervisor、TerminalBuffer，以及 runtime SSE。

## Phase 0：交互与架构验证

已完成：

- 共享事件、步骤、快照、时间线和注释模型；
- Execution Explorer 和 Migration Center 两个投影；
- 文件树、Git diff、命令结果采集；
- 显式命令确认和项目目录边界；
- 内置示例、文档、测试和独立 Git 项目。

Phase 0 的验收结论是：两个产品场景可以复用同一执行内核，不需要维护两套工作流系统。

## Phase 1：真实项目可用闭环

Phase 1 的目标是：开发者能够把真实解释器或真实迁移项目接入工作台，逐步执行、理解、验证并恢复，而不是只运行内置演示。

### 1. 项目接入与会话创建

状态：首个版本已完成。

功能：

- 在 UI 中输入本地项目路径，或从最近项目重新打开并探测；
- 只读识别 Git、package manager、语言和常见框架；
- 创建 Execution 或 Migration 会话；
- 导入、校验和预览 trace/plan JSON；
- 保存项目最近使用记录；
- 在执行前展示安全边界和待运行命令总览。

首个版本不提供原生 folder picker。浏览器中的路径输入与最近项目快捷入口满足当前“选择或输入”需求；服务端会对输入路径执行真实路径解析、允许目录边界和符号链接逃逸检查。项目接入与创建会话不会运行命令，实际迁移步骤仍需逐步确认。

验收条件：

- 不修改配置文件即可打开允许目录中的任意项目；
- 无效协议能指出具体字段和位置；
- UI 能在执行前完整展示计划及每一步影响范围；
- 项目路径不能逃逸 `DEV_WORKBENCH_ALLOWED_ROOT`。

### 2. Adapter SDK 与流式 Trace

功能：

- 定义版本化 Adapter manifest；
- 提供 session、step、snapshot 和 artifact 的 JSON Schema；
- 支持通过 HTTP 或 NDJSON 流式提交 trace event；
- 支持 adapter capability discovery；
- 提供 adapter 测试工具和示例模板；
- 首个真实 adapter：Prolog runtime adapter。

Prolog adapter 至少产生：

- 当前 query 和 goal list；
- 规则选择与源码位置；
- unification 前后绑定；
- choice point；
- backtracking 原因；
- 成功解和失败分支。

验收条件：

- 真实 Prolog 示例不依赖手写 trace JSON；
- 执行过程中 UI 可以逐步收到新事件；
- 时间轴能区分普通求值、分支、失败和回溯；
- adapter 异常不会破坏已有 session 历史。

### 3. 迁移计划编辑与步骤生命周期

功能：

- 迁移计划编辑器首版已完成，可在 pristine Migration session 中创建、编辑、删除和重排步骤；
- 可编辑字段是 title、description、expected-result text、command argv、command cwd，以及 risk 和 earlier-step dependsOn；稳定 ID 只读；
- 保存时整体替换 plan，不执行命令；
- 稳定 ID、risk、dependsOn、`awaiting_review`、attempt，以及成功步骤后的 review gate 已完成；reject 会把步骤标记为可重试的 failed，下一次 retry start 才会递增 attempt；
- execution-time editing、downstream invalidation、revision conflict 和并发修订控制仍待后续补齐；
- Agent 可以提议计划修改，但需要用户接受。

验收条件：

- 未开始的 Migration 计划可以被整体替换并重新保存；
- 已开始或非 pristine session 不能进入编辑保存；
- 保存后的 session 只反映新的 plan，不触发执行。

### 4. Preview Process Supervisor

功能：

- 为 source 和 target 分别配置启动命令、端口、health path 和 preview path；
- 只生成 loopback-only 的 `http://127.0.0.1:<port>` health/preview URL；
- 启动、停止、重启和监控 dev server；
- 实时采集 preview 与 step 的 stdout/stderr；
- `/api/sessions/:id/runtime` 与 runtime SSE 提供 preview state + terminal output 快照和增量事件；
- iframe 并排预览和手动刷新；
- 端口冲突诊断；
- 服务异常退出后保留证据并允许重启；
- 服务关闭时执行 managed shutdown，只清理自己创建的 preview child process。

验收条件：

- 可以同时运行两个示例 Web 项目；
- UI 显示服务状态和实际 URL；
- 工作台退出时能清理自己创建的子进程；
- 不终止用户在工作台外启动的进程。

当前限制：

- 没有 PTY，也不支持向运行中的 step 或 preview 进程写入 input；
- runtime terminal 只保留每个 session 最近 256 KiB 输出，preview 日志不会单独持久化到磁盘；
- preview 配置必须在创建 session 时写入 metadata，创建后还没有专门的 preview config editor；
- 仍然只支持本地受信任进程，不支持 remote worker。

### 5. Git Checkpoint 与恢复

功能：

- 执行前检查工作树是否干净；
- 为每一步建立临时 Git checkpoint；
- 展示逐文件 diff 和提交关系；
- 恢复到某个 checkpoint；
- 支持在临时 branch 或 worktree 中运行迁移；
- 禁止自动 force push、reset 用户分支或删除未确认修改。

验收条件：

- 每个高影响步骤都可以恢复；
- 恢复不会丢失用户原有未提交变更；
- UI 明确区分“时间线回看”和“真实文件恢复”；
- 所有 destructive action 都显示精确目标并二次确认。

### 6. 文件、代码和日志审查体验

功能：

- 可折叠文件树；
- 逐文件 unified/side-by-side diff；
- 代码语法高亮和搜索；
- stdout/stderr 流式终端；
- 日志筛选、复制和错误定位；
- 从步骤跳转到相关文件、diff 或日志位置；
- 注释支持书签、标签和 Markdown。

验收条件：

- 大文件 diff 不阻塞整个 UI；
- 用户能从失败步骤直接定位相关日志和文件；
- 注释在时间轴跳转和重启后仍然存在。

### 7. 持久化与可靠性

功能：

- SessionStore 从 JSON 迁移到 SQLite；
- event、snapshot、attempt 和 artifact 独立存储；
- 服务重启后恢复未完成会话；
- 运行命令支持超时、取消和输出流；
- 大 trace 分页和增量加载；
- 数据库迁移和备份策略。

验收条件：

- 服务重启后历史时间线完整；
- 取消命令不会留下错误的 running 状态；
- 至少十万条 trace event 仍能分页浏览；
- schema 升级具有自动化迁移测试。

## Phase 1 实施顺序

建议按以下里程碑推进：

### Milestone 1：协议与真实 Execution Adapter

状态：已实现首个可运行版本。当前 Prolog adapter 覆盖纯 Horn 子集，SWI-Prolog 内建谓词桥接留待后续 adapter 扩展。

1. 固化 v1 JSON Schema；
2. Adapter manifest 与 SDK；
3. 流式 trace ingestion；
4. Prolog runtime adapter；
5. 分支与回溯时间线 UI。

交付结果：Execution Explorer 可以用于一个真实解释器。

### Milestone 2：真实 Migration Runtime

状态：已完成。当前范围是本地项目接入、迁移计划编辑器、review lifecycle、Preview Process Supervisor、runtime SSE 与实时终端输出；Git checkpoint/worktree 恢复、持久 preview logs、PTY/input、remote worker 和创建后 preview config 编辑器仍留在后续里程碑。

1. UI 项目接入（首版已完成）；
2. 迁移计划编辑器（首版已完成）；
3. review lifecycle、dependency 和 risk 语义（已完成）；
4. Preview Process Supervisor（已完成）；
5. 实时终端输出（已完成）。

交付结果：Migration Center 可以编辑并保存真实迁移计划，在每个成功步骤后要求 review 决策，监督 source/target preview 进程，并通过 runtime SSE 向 UI 推送 preview state 与终端输出；Git checkpoint/worktree 恢复尚未纳入该里程碑。

### Milestone 3：可恢复审查闭环

1. Git checkpoint/worktree；
2. 逐文件代码 diff；
3. 失败重试、取消和恢复；
4. 注释、书签和证据跳转；
5. 端到端迁移示例。

交付结果：用户可以安全审查并恢复一次完整迁移。

### Milestone 4：可靠持久化

1. SQLite event store；
2. 服务重启恢复；
3. 大 trace 分页；
4. adapter contract tests；
5. 性能与故障测试。

交付结果：工具可以承担持续使用，而不是一次性演示。

## Phase 2：隔离与高级执行

- Docker/容器 Worker；
- 资源限制和网络策略；
- 远程执行节点；
- 可暂停的长任务；
- 浏览器自动化与视觉对比；
- 测试覆盖率、性能和 bundle 变化趋势；
- Agent 计划生成和证据绑定解释。

## Phase 3：Adapter 与模板生态

- Prolog、Datalog、SQL、AST walker adapter；
- React/Vue/Astro/Next 等迁移模板；
- 数据库 schema migration adapter；
- 测试失败调试工作台；
- 可安装的 adapter registry；
- manifest 版本兼容与签名校验。

## Phase 4：团队与远程协作

- 用户、项目和角色权限；
- 评论、评审和批准流程；
- 会话分享与只读回放；
- 远程 Worker 和队列；
- 审计日志、密钥管理和组织策略；
- 与 GitHub PR、CI 和 Issue 集成。

## 下一阶段不做什么

Phase 1 暂不加入：

- 公网 SaaS 多租户；
- 任意来源的无确认自动执行；
- 完整 IDE 替代能力；
- 大规模 adapter 市场；
- 与产品目标无关的 Agent 聊天功能。

优先级始终是完成一条可理解、可验证、可恢复的真实项目闭环。
