# Dev Workbench

一个用于多数软件项目的本地开发辅助工具。它不替用户隐藏执行过程，而是把执行、状态变化、文件差异和个人理解组织到一条可操控的时间线上。

项目共享一个事件溯源执行内核，并提供两个工作台：

- **Execution Explorer**：回放解释器、规则引擎、算法或 Agent 的结构化 trace，查看程序位置、目标、堆栈、绑定和每步注释。
- **Migration Center**：逐步编辑并运行迁移计划，同时查看命令输出、文件树变化、Git diff 以及新旧系统预览；计划编辑首版只允许 pristine Migration session 整体替换步骤，保存时不会执行命令。

## 项目文档

- [项目创建目的与产品原则](docs/PROJECT_PURPOSE.md)
- [初始技术方案与当前边界](docs/INITIAL_SOLUTION.md)
- [总体开发计划与下一阶段功能方案](docs/DEVELOPMENT_PLAN.md)
- [架构与安全边界](docs/ARCHITECTURE.md)

## 启动

要求 Node.js 22+，没有运行时 npm 依赖。

```bash
npm start
```

打开 `http://127.0.0.1:4177`，然后选择内置的逻辑调试或框架迁移示例。

默认允许打开当前用户目录中的项目。可以收窄边界：

```bash
DEV_WORKBENCH_ALLOWED_ROOT=/absolute/path/to/projects npm start
```

## 打开本地项目

点击 **Open local project**，输入 `DEV_WORKBENCH_ALLOWED_ROOT` 内的绝对路径或相对路径。工作台会在不运行项目命令的前提下，只读识别 Git、package manager、语言和常见框架，并显示探测证据与警告。随后可以：

1. 选择 Execution 或 Migration 工作台并填写会话标题；
2. 可选粘贴或上传 trace/plan JSON；
3. 在创建前检查规范化后的步骤、argv 参数、工作目录、影响分类和允许目录边界；Migration 计划编辑器首版只允许在 pristine Migration session 中编辑 title、description、expected text、argv 和 cwd，保存时只提交整个 plan，不会执行命令；
4. 确认安全预览后创建会话。

最近成功创建的项目会出现在 **Recent projects** 中；重新打开时仍会再次探测路径和项目事实，不会复用旧计划。接入和创建会话本身不会运行任何命令。Migration 步骤中的实际命令仍需逐步在 UI 中明确确认后才会执行。

## 高级入口：直接导入会话 JSON

原始 JSON 导入仍作为高级快捷方式保留。执行回放示例：

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

迁移计划示例：

```json
{
  "title": "Migrate site",
  "workbench": "migration",
  "projectRoot": "/absolute/path/to/project",
  "metadata": {
    "sourceUrl": "http://127.0.0.1:3000",
    "targetUrl": "http://127.0.0.1:4321"
  },
  "steps": [
    {
      "title": "Create target shell",
      "description": "Initialize the new framework.",
      "action": { "command": ["node", "scripts/migrate.mjs", "shell"] }
    }
  ]
}
```

命令必须是 argv 数组，不接受 shell 字符串。工作目录必须位于项目根目录内，每一步都需要在 UI 中确认后才执行。

## 流式提交 Trace

先创建一个空的 Execution 会话，然后向 `/api/sessions/{sessionId}/trace` 提交 `application/json` 或 `application/x-ndjson`。事件的 `sequence` 必须从当前步骤数开始连续递增：

```json
{"protocolVersion":"1.0","sessionId":"SESSION_ID","sequence":0,"kind":"branch","title":"Choose rule","state":{"goals":["parent(X, Y)"]}}
```

服务会逐条校验、持久化并通过会话 SSE 更新 UI。若 NDJSON 中途出现坏行，响应会返回已接受的事件数量，之前的事件不会回滚或丢失。

内置逻辑示例由 `packages/prolog-adapter` 中的 Prolog runtime 实时执行，不再读取手写 trace。也可以为已有 Execution 会话生成 NDJSON：

```bash
node packages/prolog-adapter/src/cli.js \
  --source examples/logic-trace/program.pl \
  --query "grandfather(X, Y)?" \
  --session SESSION_ID
```

当前 runtime 支持纯 Horn 子集：事实、规则、原子与复合项、变量、合一、深度优先搜索和回溯；暂不支持 cut、否定、算术、动态谓词或 SWI-Prolog 内建谓词。可通过 `GET /api/adapters` 查询 manifest 和 capability。

## 当前能力

- 不可变步骤事件和 JSON 会话持久化；
- 时间轴 seek、前进、回放和逐步注释；
- 项目文件树快照及新增/修改/删除比较；
- Git HEAD、status 和工作树 diff 捕获；
- 无 shell 的显式命令执行；
- 同一会话互斥运行；
- SSE 实时更新；
- 两个独立工作台和可导入协议；
- 真实项目只读探测、安全预览和最近项目入口；
- Migration 计划编辑器首版，仅 pristine Migration session 可编辑，支持 title、description、expected text、argv 和 cwd，保存只做整 plan 替换；
- 内置 Prolog runtime trace 与框架迁移示例。

## 测试

```bash
npm test
```

下一步开发范围和验收条件见 [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)。
