# Dev Workbench

一个用于多数软件项目的本地开发辅助工具。它不替用户隐藏执行过程，而是把执行、状态变化、文件差异和个人理解组织到一条可操控的时间线上。

项目共享一个事件溯源执行内核，并提供两个工作台：

- **Execution Explorer**：回放解释器、规则引擎、算法或 Agent 的结构化 trace，查看程序位置、目标、堆栈、绑定和每步注释。
- **Migration Center**：逐步确认并运行迁移计划，同时查看命令输出、文件树变化、Git diff 以及新旧系统预览。

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

## 导入自己的会话

界面可以导入 JSON。执行回放示例：

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

## 当前能力

- 不可变步骤事件和 JSON 会话持久化；
- 时间轴 seek、前进、回放和逐步注释；
- 项目文件树快照及新增/修改/删除比较；
- Git HEAD、status 和工作树 diff 捕获；
- 无 shell 的显式命令执行；
- 同一会话互斥运行；
- SSE 实时更新；
- 两个独立工作台和可导入协议；
- 内置 Prolog 风格 trace 与框架迁移示例。

## 测试

```bash
npm test
```

下一步开发范围和验收条件见 [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)。
