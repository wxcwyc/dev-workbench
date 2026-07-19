# Development Plan

## 总体路线

开发按能力成熟度分为五个阶段：

| 阶段 | 目标 | 状态 |
| --- | --- | --- |
| Phase 0 | 验证共享时间线与两个工作台的产品形态 | 已完成 |
| Phase 1 | 接入真实项目，形成可用开发闭环 | 下一阶段 |
| Phase 2 | 增强恢复、隔离和长任务可靠性 | 计划中 |
| Phase 3 | 建立 Adapter/Plugin 生态 | 计划中 |
| Phase 4 | 支持团队协作和远程 Worker | 远期 |

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

功能：

- 在 UI 中选择或输入本地项目路径；
- 自动识别 Git、package manager、语言和常见框架；
- 创建 Execution 或 Migration 会话；
- 导入、校验和预览 trace/plan JSON；
- 保存项目最近使用记录；
- 在执行前展示安全边界和待运行命令总览。

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

- UI 内创建、编辑和重排步骤；
- 步骤依赖、预期结果和风险等级；
- `pending → running → awaiting_review → accepted/failed` 生命周期；
- 执行前确认、执行后人工验收；
- 失败重试、跳过和带理由终止；
- 每一步关联命令、文件、测试、预览和注释；
- Agent 可以提议计划修改，但需要用户接受。

验收条件：

- 未验收步骤不能自动进入下一步；
- 修改已执行步骤会提示下游失效；
- 每次重试保留独立 attempt 记录；
- 用户能看出计划与实际执行是否发生偏离。

### 4. Preview Process Supervisor

功能：

- 为 source 和 target 分别配置启动命令、端口和健康检查；
- 启动、停止、重启和监控 dev server；
- 实时采集 stdout/stderr；
- iframe 并排预览和手动刷新；
- 端口冲突诊断；
- 服务异常退出后保留证据并允许重启。

验收条件：

- 可以同时运行两个示例 Web 项目；
- UI 显示服务状态和实际 URL；
- 工作台退出时能清理自己创建的子进程；
- 不终止用户在工作台外启动的进程。

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

1. 固化 v1 JSON Schema；
2. Adapter manifest 与 SDK；
3. 流式 trace ingestion；
4. Prolog runtime adapter；
5. 分支与回溯时间线 UI。

交付结果：Execution Explorer 可以用于一个真实解释器。

### Milestone 2：真实 Migration Runtime

1. UI 项目接入；
2. 迁移计划编辑器；
3. awaiting_review 生命周期；
4. Preview Process Supervisor；
5. 实时终端输出。

交付结果：Migration Center 可以操控真实的新旧 Web 项目。

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
