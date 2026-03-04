# Helots: Operational Guide

Helots is a highly modular Spartan orchestration framework, usable as a **Pi Extension** or a **Standalone MCP Server**.

## Core Architecture: The Triad

1. **Aristomenis (Architect)**: Designs the `progress.md` task checklist based on a project map.
2. **Builder (Worker)**: Executes granular tasks with **Smart Read** context.
3. **Peltast (Verifier)**: Uses **Thinking/Reasoning** to validate changes.
4. **Slinger (Recon)**: Specialized subagent for deep codebase research.

---

## Getting Started

### 1. Environment Configuration

Create or update `.helots/config.json` (or set Environment Variables):

```json
{
  "llamaUrl": "http://127.0.0.1:8080",
  "apiKey": "your-key-here",
  "denseModel": "Qwen/Qwen3.5-27B",
  "moeModel": "Qwen/Qwen3.5-35B-A3B"
}
```

### 2. Usage as an MCP Server (Antigravity / Claude)

**Install dependencies:**

```bash
npm install
```

#### Claude Code Integration

Claude Code reads MCP server registrations from `~/.claude.json`, not `settings.json`. Use the CLI to register:

**macOS / Linux:**

```bash
claude mcp add -s user \
  -e HELOT_LLM_URL=http://127.0.0.1:8081 \
  -e HELOT_DENSE_MODEL=qwen35b \
  -e HELOT_MOE_MODEL=qwen35b \
  -e HELOT_STATE_DIR=/absolute/path/to/helots-pi/.helot-mcp-connector \
  -- helots node \
  /absolute/path/to/helots-pi/node_modules/@mariozechner/jiti/lib/jiti-cli.mjs \
  /absolute/path/to/helots-pi/src/adapters/mcp-server.ts
```

**Windows:**

```bash
claude mcp add -s user \
  -e HELOT_LLM_URL=http://127.0.0.1:8081 \
  -e HELOT_DENSE_MODEL=qwen35b \
  -e HELOT_MOE_MODEL=qwen35b \
  -e "HELOT_STATE_DIR=C:/Users/YOU/Desktop/helots-pi/.helot-mcp-connector" \
  -- helots node \
  "C:/Users/YOU/Desktop/helots-pi/node_modules/@mariozechner/jiti/lib/jiti-cli.mjs" \
  "C:/Users/YOU/Desktop/helots-pi/src/adapters/mcp-server.ts"
```

> **Why absolute paths?** On Windows, Claude Code spawns MCP processes without a predictable cwd. Absolute paths for both the jiti entry point and the server file ensure the process resolves correctly regardless of where Claude Code starts. The `HELOT_STATE_DIR` also needs an absolute path so the state directory is always created inside the helots-pi folder.

> **Why `claude mcp add` and not `settings.json`?** Claude Code's `settings.json` is for permissions and update preferences. MCP server registrations are stored separately in `~/.claude.json`. Entries placed in `settings.json` under `mcpServers` are silently ignored at startup.

> **Why `node` directly and not `npx jiti`?** On Windows, `child_process.spawn` does not resolve `.cmd` wrappers, so `npx` → `npx.cmd` fails silently. Calling `node` directly with the absolute path to `jiti-cli.mjs` bypasses all wrapper layers and keeps stdio intact for the JSON-RPC handshake.

After running `claude mcp add`, restart Claude Code fully. Verify with `/mcp` — `helot_slinger` and `helot_run` should appear under `helots`.

To remove or update the registration:

```bash
claude mcp remove helots
```

Then re-run `claude mcp add` with the new config.

#### CLAUDE.md Delegation Instructions

To make Claude prefer Helots over its own Grep/Edit tools globally, add the following to `~/.claude/CLAUDE.md`:

```markdown
## Tool delegation via Helots MCP

When the `helot_slinger` and `helot_run` tools are available (Helots MCP connected), prefer them over direct tool use:

### Use `helot_slinger` instead of Grep/Glob/Read when:
- Searching across multiple files ("find all usages of X", "which files export Y", "where is Z called")
- Exploring an unfamiliar area of the codebase
- Any search that would require 3 or more Grep/Read/Glob calls to answer

Use direct Grep/Read only for single targeted lookups on a known file path.

### Use `helot_run` instead of Edit/Write when:
- A task touches more than one file
- The task requires reading and understanding existing code before writing
- Implementation is substantial enough that a planning step adds value

Use direct Edit/Write only for single-line fixes or changes with no ambiguity.

### When in doubt, delegate to Helots
The local model runs at ~30 t/s. Delegation costs a few seconds and preserves context window. Default to it.
```

### 3. Usage as a Pi Extension

1. Navigate to your Pi Agent extension directory.
2. Link or copy this project folder.
3. The agent will automatically detect `helot_slinger` and `helot_run`.

---

## Available Tools

### `helot_slinger`

**When to use**: Code review, mapping architecture, or answering "where is X?"

- **Input**: `researchTask` (Question), `targetFiles` (Optional list).
- **Output**: Deep technical report.

### `helot_run`

**When to use**: To execute an implementation plan.

- **Input**: `taskSummary`, `implementationPlan`.
- **Flow**: Gatherer (Map) -> Aristomenis (Checklist) -> Builder/Peltast Loop -> Git Commit.

---

## Fail-Safe Features

- **Git Rollbacks**: If a task fails verification 3 times, Helots automatically runs `git reset --hard HEAD~1` to prevent a broken workspace.
- **Automatic Checkpointing**: Verification success triggers an automatic git commit with the task description.
- **Smart Context**: Builders only read the specific file they are targeting to preserve the 66k context window.
