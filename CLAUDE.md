# Helots-Pi — Claude Code Instructions

## What this project is
A local LLM orchestration framework. Exposes `helot_slinger` (code research) and `helot_run` (code execution) as MCP tools that delegate to a local Qwen model at `http://127.0.0.1:8081`.

Architecture: Scout → Builder → Peltast pipeline. Aristomenis only runs as a repair agent when Builder fails. Claude (frontier) is responsible for planning tasks.

## Tool Usage Policy

### Use `helot_slinger` for code searches and exploration
Prefer `helot_slinger` over Grep/Glob/Read when:
- Reading and synthesizing file content across multiple files
- Exploring an unfamiliar area of the codebase
- Answering questions that require understanding code, not just locating it

**Always set `outputFile`** when the research result is more than a quick lookup — this writes the full report to disk and returns only a compact summary to frontier. Example: `outputFile: ".helot-mcp-connector/research.md"`.

Use direct Grep/Read when:
- Pure string/pattern search where you only need the location, not the content analyzed — Grep returns a compact result, slinger wraps it in SUMMARY/EVIDENCE overhead
- Reading a single known file you already have a path for
- Simple lookups where the raw result IS the answer (one match, one line)

### Use `helot_run` for non-trivial code changes
**helot_run now REQUIRES a `tasks[]` array.** Aristomenis is NOT a planner anymore.

**Pre-run research protocol**

Before constructing `tasks[]` for `helot_run`, always research the target files first:

1. **Slinger the target area** — use `helot_slinger` with `outputFile: ".helot-mcp-connector/research.md"` to extract current function signatures, imports, and patterns from the files you plan to modify. Always set `outputFile` — this keeps the full research on disk and returns only a compact summary to frontier. Then read the summary to construct tasks.
2. **Verify symbols exist** — Builder validates symbols against the codebase. If you reference a symbol that doesn't exist, the task falls back to full-file mode. Confirm names with slinger first.
3. **One slinger call per task group** — if all tasks touch the same module, one targeted slinger call covers them all. Don't over-research.

If the task is ambiguous (unclear which files to change, or what the current implementation looks like), ask one clarifying question before constructing tasks[]. Wasted helot_run calls are expensive — each is 4-6 LLM calls locally.

**Workflow:**
1. Use `helot_slinger` to research the codebase
2. Construct `tasks[]` array (Claude must plan this before calling helot_run)
3. Call `helot_run`

**Task format example:**
```
helot_run({
  taskSummary: "Add WebFetch to slinger toolkit",
  tasks: [
    {
      id: "1",
      description: "Add WEBFETCH command handler to SlingerAgent",
      file: "src/core/slinger-agent.ts",
      symbol: "execute",         // omit for CREATE tasks
      changes: "inside the command dispatch switch, add case 'WEBFETCH': fetch the URL, truncate to 8000 chars, append to results",
      dependsOn: []
    },
    {
      id: "2",
      description: "Add WEBFETCH to SEARCH TOOLKIT prompt",
      file: "src/core/slinger-agent.ts",
      symbol: "buildSlingerPrompt",
      changes: "add WEBFETCH <url> entry to the SEARCH TOOLKIT section with description",
      dependsOn: ["1"]
    }
  ]
})
```

**Field requirements:**
- `changes` is required for EDIT tasks — describe exactly what to add/remove/modify
- `symbol` is optional — only for surgical edits to a specific function/class
- `dependsOn` controls execution order

### When in doubt, delegate
The local model is fast (~30 t/s). Delegating a search costs a few seconds and saves context. Prefer it.

## Project Structure
- `src/core/helots-orchestrator.ts` — Scout + Aristomenis planning + task loop entry point
- `src/core/task-runner.ts` — Builder → Peltast per-task loop, parseChecklist, replanTaskWithAristomenis
- `src/core/task-loop.ts` — task sequencing and dependency resolution
- `src/core/engine.ts` — thin coordinator, public API surface
- `src/core/slinger-agent.ts` — research agent (SEARCH TOOLKIT)
- `src/core/hoplite-agent.ts` — file editor with WebFetch support
- `src/core/file-executor.ts` — mv/mkdir/cp/rmdir execution engine
- `src/core/llama-client.ts` — SSE streaming client, model swap, retry
- `src/core/model-registry.ts` — sampling profiles per model
- `src/adapters/mcp-server.ts` — MCP stdio server
- `src/core/governor.ts` — state, strikes, commit gate
- `debug-run.mjs` / `debug-slinger.mjs` — local test harnesses

## Active profiles (confirmed working)
- Builder (EDIT): `INSTRUCT_CODE`
- Builder (CREATE): `THINKING_CODE`
- Peltast: `PELTAST` (auto-pass/fail on deterministic checks; LLM only when no signal)
- Slinger: `INSTRUCT_GENERAL`
- Aristomenis replan: `THINKING_GENERAL`

## Debugging this project — Do not use helot_run to debug helots-pi itself. Use direct Grep/Read/Slinger to investigate and direct Edit/Write to fix. helot_run is for feature work only.