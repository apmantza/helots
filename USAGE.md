# Helots: Operational Guide 🛡️🏹

Helots is a highly modular Spartan orchestration framework, usable as a **Pi Extension** or a **Standalone MCP Server**.

## 🏗️ Core Architecture: The Triad

1. **Aristomenis (Architect)**: Designs the `progress.md` task checklist based on a project map.
2. **Builder (Worker)**: Executes granular tasks with **Smart Read** context.
3. **Peltast (Verifier)**: Uses **Thinking/Reasoning** to validate changes.
4. **Slinger (Recon)**: Specialized subagent for deep codebase research.

---

## 🚀 Getting Started

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

To expose Helot tools to your desktop assistant:

1. **Install dependencies**:

    ```bash
    npm install
    ```

2. **Launch the MCP Server**:

    ```bash
    npm run mcp
    ```

3. **Register Tools**: Add the command above to your MCP client settings.

### 3. Usage as a Pi Extension

1. Navigate to your Pi Agent extension directory.
2. Link or copy this project folder.
3. The agent will automatically detect `helot_slinger` and `helot_run`.

---

## 🛠️ Available Tools

### `helot_slinger`

**When to use**: Code review, mapping architecture, or answering "where is X?"

- **Input**: `researchTask` (Question), `targetFiles` (Optional list).
- **Output**: Deep technical report.

### `helot_run`

**When to use**: To execute an implementation plan.

- **Input**: `taskSummary`, `implementationPlan`.
- **Flow**: Gatherer (Map) -> Aristomenis (Checklist) -> Builder/Peltast Loop -> Git Commit.

---

## 🛡️ Fail-Safe Features

- **Git Rollbacks**: If a task fails verification 3 times, Helots automatically runs `git reset --hard HEAD~1` to prevent a broken workspace.
- **Automatic Checkpointing**: Verification success triggers an automatic git commit with the task description.
- **Smart Context**: Builders only read the specific file they are targeting to preserve the 66k context window.
