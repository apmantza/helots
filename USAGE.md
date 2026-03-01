# Launching Helots with Cloud Agents

This guide explains how to enforce the **"Gorgo of Sparta"** doctrine (Cloud Strategic Brain + Local Execution Swarm) with popular desktop agents.

Helots works by utilizing **Soft Constraints**—prompting the cloud model into an "Architect" persona that intentionally refuses to write code directly and instead delegates all work to the local GPU.

---

## 🚀 1. Antigravity & Pi Coding Agent Setup

If you are using Antigravity or the locally installed Pi Coding Agent, the setup is fully automated.

### Extension Installation

1. Navigate to your local Pi extensions directory (usually `~/.pi/agent/extensions/`).
2. Copy `index.ts` from this repository and save it as `helots.ts`.
3. Copy the entire `src/` directory from this repository into the extensions directory (so that `~/.pi/agent/extensions/src/core/engine.ts` exists).
4. The Pi Coding Agent will automatically load the extension, granting the UI tools `helot_run` and `helot_slinger` to the LLM context.

### The Agent Prompt (Workflow)

Antigravity locally scans your directories for `.agents/workflows/` and `.pi/system/` to ingest specific operational rules.

1. **Workspace Scope**: To enforce the Helot Doctrine only on your current project, copy the `helots.md` prompt into a `.agents/workflows/` folder in your project root.
2. **Global Scope**: To enforce the Helot Doctrine universally across all projects, copy the `helots.md` prompt into your global `~/.pi/system/helots_workflow.md` directory.

The agent will instantly adopt the **Gorgo of Sparta** persona.

---

## 🤖 2. Claude Desktop (via MCP) Setup

Anthropic's Claude Desktop app supports the Model Context Protocol (MCP), meaning it natively supports the Helots architecture.

### MCP Configuration

Update your `claude_desktop_config.json` to expose the local Helots MCP server.

* **Note**: Ensure you have configured the `mcp.ts` adapter within your local workspace to expose the `/v1/chat/completions` API logic.

```json
{
  "mcpServers": {
    "helots": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/helots-pi/src/adapters/mcp.ts"]
    }
  }
}
```

Restart Claude Desktop. You should now see the `helot_run` and `helot_slinger` tools available in the UI.

### The Agent Prompt (Project Instructions)

Claude Desktop requires you to manually instruct the LLM on how to behave.

1. Open **Claude Desktop** and navigate to your specific Claude Project.
2. Under **Custom Instructions**, paste the contents of `helots.md` (The Gorgo of Sparta Workflow).

Claude will now execute complex refactors by designing the architectural checklist in the cloud, while silently delegating the grunt work to your local `llama.cpp` instance!
