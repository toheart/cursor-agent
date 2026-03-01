# Cursor Agent — OpenClaw 插件

**在 OpenClaw 聊天中直接调用本机 Cursor Agent CLI**

[English](README.md) | 中文

---

> AI 编程的真正力量不在于单一 IDE——而在于将 AI Agent 连接到你的整个工作流中。

## 什么是 Cursor Agent 插件？

**Cursor Agent** 是一个 OpenClaw Gateway 插件，将你的聊天对话与 Cursor Agent CLI 打通。通过简单的 `/cursor` 命令即可对项目进行代码分析、排查和修改——结果原样返回，不经过 LLM 二次总结。

**技术栈：**

* **运行时**: Node.js + TypeScript + ESM
* **构建**: esbuild（单文件打包）
* **平台**: OpenClaw Gateway 插件系统
* **后端**: Cursor Agent CLI（使用你的 Cursor 订阅额度）

## 功能特性

### ⚡ 直接 CLI 调用

通过 `/cursor` 命令零开销地调用 Cursor Agent CLI。

| 特性 | 说明 |
|------|------|
| **结果原样返回** | CLI 输出直接返回——不经 LLM 二次总结 |
| **三种模式** | `agent`（修改文件）、`ask`（只读分析）、`plan`（出方案） |
| **项目映射** | 通过名称映射表快速切换分析目标 |
| **会话管理** | 支持继续或恢复历史分析会话 |
| **上下文加载** | 自动加载 `.cursor/rules`、`AGENTS.md` 等 |

### 🔌 MCP 服务器集成

启用项目配置的 MCP 服务器，拓展分析能力。

| 特性 | 说明 |
|------|------|
| **默认启用** | MCP 服务器默认开启（`--approve-mcps`） |
| **灵活接入** | 支持 GitLab、数据库、监控等多种数据源 |
| **按项目配置** | 每个项目可拥有独立的 MCP 配置 |

### 🤖 Agent Tool（兜底调用）

当用户未使用 `/cursor` 命令时，PI Agent 可自动调用 Cursor CLI。

| 特性 | 说明 |
|------|------|
| **自动检测** | PI Agent 自动判断何时需要代码分析 |
| **安全默认** | 默认使用 `ask` 模式（只读），确保安全 |
| **可配置** | 通过 `enableAgentTool` 开关控制 |

### 🛡️ 完善的进程管理

企业级子进程管理，保障运行稳定性。

| 特性 | 说明 |
|------|------|
| **独立进程组** | Unix 上 `detached: true`，避免信号误杀 Gateway |
| **两阶段终止** | SIGTERM → 5 秒 → SIGKILL，优雅退出 |
| **并发控制** | 可配置最大并发 CLI 进程数 |
| **退出清理** | Gateway 退出时自动清理所有子进程 |
| **无输出超时** | 检测长时间无输出的挂死进程 |

## 前置要求

| 依赖 | 说明 |
|------|------|
| Cursor Agent CLI | 需在本机安装 `agent` 命令 |
| Cursor 订阅 | CLI 使用 Cursor 订阅中的模型额度 |
| OpenClaw Gateway | v2026.2.24+ |

## 快速开始

### 1. 安装 Cursor Agent CLI

**Linux / macOS：**

```bash
curl https://cursor.com/install -fsSL | bash
```

可能需要将 `$HOME/.local/bin` 加入 PATH：

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

**Windows（PowerShell）：**

```powershell
irm https://cursor.com/install | iex
```

**验证安装：**

```bash
agent --version
```

### 2. 认证登录

```bash
agent login
```

或通过环境变量设置 API Key：

```bash
export CURSOR_API_KEY="your-api-key"
```

### 3. 安装插件

**方式 A：源码路径加载（开发模式）**

在 `~/.openclaw/openclaw.json` 的 `plugins.load.paths` 中添加插件源码路径：

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/cursor-agent"]
    }
  }
}
```

**方式 B：tgz 包安装**

```bash
npm ci && npm run build && npm pack
openclaw plugin install cursor-agent-0.1.0.tgz
```

### 4. 配置

```json
{
  "plugins": {
    "entries": {
      "cursor-agent": {
        "enabled": true,
        "config": {
          "projects": {
            "my-project": "/home/user/projects/my-project",
            "another-project": "/home/user/projects/another"
          },
          "defaultTimeoutSec": 600,
          "noOutputTimeoutSec": 120,
          "enableMcp": true,
          "maxConcurrent": 3,
          "enableAgentTool": true
        }
      }
    }
  }
}
```

### 5. 开始使用

```
/cursor my-project 分析认证模块的实现，找出潜在的安全问题
```

## 使用

### 命令格式

```
/cursor <project> [options] <prompt>
```

| 参数 | 说明 |
|------|------|
| `<project>` | 项目名称（映射表中的 key）或绝对路径 |
| `<prompt>` | 分析任务的详细描述 |
| `--mode <mode>` | 运行模式：`agent`（默认）/ `ask` / `plan` |
| `--continue` | 继续上一次会话 |
| `--resume <chatId>` | 恢复指定会话 |

### 示例

```bash
# 只读分析
/cursor my-project --mode ask 解释一下 src/auth 目录的架构设计

# 出方案
/cursor my-project --mode plan 设计一个新的缓存层方案

# 继续上一次会话
/cursor my-project --continue 还有其他安全问题吗？

# 恢复指定会话（会话 ID 在每次执行结果的 footer 中显示）
/cursor my-project --resume abc123 在这个基础上添加单元测试
```

### 查看历史对话

每次执行结果的 footer 会显示会话 ID（如 `💬 97fe5ea8-...`），可通过 `--resume` 继续该对话。

在终端中浏览会话：

```bash
cd /path/to/project
agent ls            # 查看历史会话
agent resume        # 交互式恢复
agent --resume <id> # 恢复指定会话
```

更多用法请参考 [Cursor Agent CLI 文档](https://cursor.com/cn/docs/cli/using)。

## 配置参考

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `projects` | `object` | `{}` | 项目名称到本地绝对路径的映射表 |
| `agentPath` | `string` | 自动检测 | Cursor Agent CLI 的完整路径 |
| `defaultTimeoutSec` | `number` | `600` | 单次调用最大执行时间（秒） |
| `noOutputTimeoutSec` | `number` | `120` | 无输出超时，连续无输出超过此时间判定挂死 |
| `model` | `string` | CLI 默认 | 指定 Cursor Agent 使用的模型 |
| `enableMcp` | `boolean` | `true` | 是否启用 MCP 服务器（`--approve-mcps`） |
| `maxConcurrent` | `number` | `3` | 最大并发 Cursor CLI 进程数 |
| `enableAgentTool` | `boolean` | `true` | 注册 Agent Tool 供 PI Agent 自动调用 |

## Agent Tool 与 /cursor 命令的区别

| 特性 | `/cursor` 命令 | Agent Tool |
|------|---------------|------------|
| 触发方式 | 用户显式输入 | PI Agent 自动判断 |
| 结果处理 | 直接返回，不经 LLM | 作为 tool result 返回 |
| 默认模式 | `agent`（可修改文件） | `ask`（只读分析） |
| 会话管理 | 支持 --continue/--resume | 不支持 |

启用 Agent Tool：

1. 确保 `enableAgentTool` 为 `true`（默认）
2. 在 OpenClaw 配置的 `tools.allow` 中添加 `cursor_agent` 或 `group:plugins`

## 架构

```
src/
├── index.ts              # 插件入口，注册 /cursor 命令 + cursor_agent 工具
├── types.ts              # 类型定义（配置、事件、命令解析结果）
├── parser.ts             # Cursor Agent stream-json 输出解析
├── runner.ts             # CLI 进程管理、超时控制、事件流收集
├── formatter.ts          # 事件流格式化为 Markdown 输出
├── process-registry.ts   # 全局进程注册表、并发控制、退出清理
└── tool.ts               # Agent Tool 工厂函数
```

### 调用路径

```
用户消息
  ├─ /cursor 命令 ──→ registerCommand handler ──→ runCursorAgent ──→ 结果直接返回用户
  └─ 普通对话 ──→ PI Agent ──→ cursor_agent tool ──→ runCursorAgent ──→ tool result
```

## 开发

```bash
# 安装依赖
npm install

# 开发模式（watch）
npm run dev

# 构建
npm run build

# 运行测试
npm test

# 打包发布
npm pack
```

## 许可证

[Apache-2.0](LICENSE)
