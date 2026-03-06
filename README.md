# Cursor Agent — OpenClaw Plugin

**Invoke the local Cursor Agent CLI directly from OpenClaw chat conversations**

English | [中文](README_CN.md)

---

> The real power of AI coding isn't in a single IDE — it's in connecting AI agents across your workflow.

## What is Cursor Agent Plugin?

**Cursor Agent** is an OpenClaw Gateway plugin that bridges your chat conversations with the Cursor Agent CLI. It allows you to analyze, troubleshoot, and modify project code through simple `/cursor` commands — with results returned verbatim, no LLM re-summarization.

**Tech Stack:**

* **Runtime**: Node.js + TypeScript + ESM
* **Build**: esbuild (single-file bundle)
* **Platform**: OpenClaw Gateway Plugin System
* **Backend**: Cursor Agent CLI (uses your Cursor subscription)

## Features

### ⚡ Direct CLI Invocation

Use the `/cursor` command to invoke Cursor Agent CLI with zero abstraction overhead.

| Feature | Description |
|---------|-------------|
| **Verbatim Results** | CLI output returned directly — no LLM re-summarization |
| **Three Modes** | `agent` (modify files), `ask` (read-only), `plan` (generate plans) |
| **Project Mapping** | Quick project switching by name via mapping table |
| **Session Management** | Continue or resume previous analysis sessions |
| **Context Loading** | Automatically loads `.cursor/rules`, `AGENTS.md`, etc. |

### 🔌 MCP Server Integration

Enable project-configured MCP servers for extended capabilities.

| Feature | Description |
|---------|-------------|
| **Auto-Enable** | MCP servers enabled by default (`--approve-mcps`) |
| **Flexible Sources** | GitLab, databases, monitoring, and more |
| **Per-Project Config** | Each project can have its own MCP configuration |

### 🤖 Agent Tool (Fallback Invocation)

When users don't use the `/cursor` command, PI Agent can automatically invoke Cursor CLI.

| Feature | Description |
|---------|-------------|
| **Auto-Detection** | PI Agent determines when code analysis is needed |
| **Safe Default** | Defaults to `ask` mode (read-only) for safety |
| **Configurable** | Enable/disable via `enableAgentTool` setting |

### 🛡️ Robust Process Management

Enterprise-grade subprocess management for reliability.

| Feature | Description |
|---------|-------------|
| **Isolated Process Groups** | `detached: true` on Unix prevents accidental signal kills |
| **Two-Phase Termination** | SIGTERM → 5s → SIGKILL for graceful shutdown |
| **Concurrency Control** | Configurable max concurrent CLI processes |
| **Gateway Exit Cleanup** | All subprocesses cleaned up automatically on exit |
| **No-Output Timeout** | Detects hung processes when no output is produced |

## Prerequisites

| Dependency | Description |
|------------|-------------|
| Cursor Agent CLI | Must be installed locally (`agent` command) |
| Cursor Subscription | CLI uses model quota from your Cursor subscription |
| OpenClaw Gateway | v2026.2.24+ |

## Quick Start

### 1. Install Cursor Agent CLI

**Linux / macOS:**

```bash
curl https://cursor.com/install -fsSL | bash
```

You may need to add `$HOME/.local/bin` to your PATH:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

**Windows (PowerShell):**

```powershell
irm https://cursor.com/install | iex
```

**Verify installation:**

```bash
agent --version
```

### 2. Authenticate

```bash
agent login
```

Or set the API key via environment variable:

```bash
export CURSOR_API_KEY="your-api-key"
```

### 3. Install the Plugin

**Option A: Source Path Loading (Development)**

Add the plugin source path to `plugins.load.paths` in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/cursor-agent"]
    }
  }
}
```

**Option B: tgz Package Install**

```bash
npm ci && npm run build && npm pack
openclaw plugins install cursor-agent-0.1.0.tgz
```

### 4. Configure

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

### 5. Configure Command Authorization

The `/cursor` command requires authorization by default (`requireAuth: true`). You need to configure `commands.allowFrom` in OpenClaw before using it. There are two ways:

**Option A: Via Control UI (Recommended)**

1. Open the OpenClaw Control UI in your browser: `http://127.0.0.1:<port>/config?token=<your-gateway-token>`
2. Click **Commands** in the left navigation panel
3. Find the **Command Elevated Access Rules** section
4. Click **+ Add Entry** to add a rule:
   - Set **Key** to a channel ID (use `*` for all channels)
   - Click **+ Add** below to add allowed sender IDs (use `*` for all users)
5. Click **Save** at the top, then **Apply** to activate the configuration

![Command Elevated Access Rules UI](docs/config-commands-allowfrom.png)

**Option B: Edit Config File Directly**

Add the `allowFrom` field to the `commands` section in `~/.openclaw/openclaw.json`:

```json
{
  "commands": {
    "allowFrom": {
      "*": ["*"]
    }
  }
}
```

**`allowFrom` Reference:**

| Key (Channel ID) | Value (Sender List) | Effect |
|-------------------|---------------------|--------|
| `"*"` | `["*"]` | All users on all channels can execute authorized commands |
| `"*"` | `["user1", "admin"]` | Only specified users on all channels |

> **Production Tip**: In production, restrict `allowFrom` to specific channels and users instead of using the `"*"` wildcard to ensure only authorized personnel can execute code modification operations.

### 6. Start Using

```
/cursor my-project analyze the auth module and find potential security issues
```

## Usage

### Command Format

```
/cursor <project> [options] <prompt>
```

| Parameter | Description |
|-----------|-------------|
| `<project>` | Project name (key from mapping table) or absolute path |
| `<prompt>` | Detailed description of the analysis task |
| `--mode <mode>` | Execution mode: `agent` (default) / `ask` / `plan` |
| `--continue` | Continue previous session |
| `--resume <chatId>` | Resume a specific session |

### Examples

```bash
# Read-only analysis
/cursor my-project --mode ask explain the architecture of src/auth

# Generate a plan
/cursor my-project --mode plan design a new caching layer

# Continue previous session
/cursor my-project --continue are there other security issues?

# Resume a specific session (ID shown in result footer)
/cursor my-project --resume abc123 add unit tests based on this analysis
```

### Session History

Each execution result footer displays a session ID (e.g., `💬 97fe5ea8-...`). Use it with `--resume` to continue that session.

To browse sessions in terminal:

```bash
cd /path/to/project
agent ls            # List sessions
agent resume        # Interactive resume
agent --resume <id> # Resume by ID
```

See the [Cursor Agent CLI documentation](https://cursor.com/docs/cli/using) for more.

## Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `projects` | `object` | `{}` | Project name to local absolute path mapping |
| `agentPath` | `string` | auto-detect | Full path to Cursor Agent CLI |
| `defaultTimeoutSec` | `number` | `600` | Maximum execution time per invocation (seconds) |
| `noOutputTimeoutSec` | `number` | `120` | No-output timeout; process considered hung after this duration |
| `model` | `string` | CLI default | Model for Cursor Agent to use |
| `enableMcp` | `boolean` | `true` | Enable MCP servers (`--approve-mcps`) |
| `maxConcurrent` | `number` | `3` | Maximum concurrent Cursor CLI processes |
| `enableAgentTool` | `boolean` | `true` | Register Agent Tool for PI Agent auto-invocation |

## Agent Tool vs /cursor Command

| Feature | `/cursor` Command | Agent Tool |
|---------|-------------------|------------|
| Trigger | User explicitly types | PI Agent auto-determines |
| Result handling | Returned directly, bypasses LLM | Returned as tool result |
| Default mode | `agent` (can modify files) | `ask` (read-only analysis) |
| Session management | Supports --continue/--resume | Not supported |

To enable Agent Tool:

1. Ensure `enableAgentTool` is `true` (default)
2. Add `cursor_agent` or `group:plugins` to `tools.allow` in OpenClaw configuration

## Architecture

```
src/
├── index.ts              # Plugin entry, registers /cursor command + cursor_agent tool
├── types.ts              # Type definitions (config, events, parsed command)
├── parser.ts             # Cursor Agent stream-json output parser
├── runner.ts             # CLI process management, timeout control, event stream
├── formatter.ts          # Event stream formatting to Markdown output
├── process-registry.ts   # Global process registry, concurrency control, cleanup
└── tool.ts               # Agent Tool factory function
```

### Invocation Paths

```
User Message
  ├─ /cursor command ──→ registerCommand handler ──→ runCursorAgent ──→ result returned to user
  └─ Regular chat ──→ PI Agent ──→ cursor_agent tool ──→ runCursorAgent ──→ tool result
```

## Development

```bash
# Install dependencies
npm install

# Development mode (watch)
npm run dev

# Build
npm run build

# Run tests
npm test

# Pack for distribution
npm pack
```

## License

[Apache-2.0](LICENSE)
