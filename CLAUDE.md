# Helots-Pi — Claude Code Instructions

## What this project is
A local LLM orchestration framework. Exposes `helot_slinger` (code research) and `helot_run` (code execution) as MCP tools that delegate to a local Qwen model at `http://127.0.0.1:8081`.

Architecture: Scout → Builder → Peltast pipeline. Aristomenis is deprecated — `replanTaskWithAristomenis` exists in task-runner.ts but is never called. Claude (frontier) is responsible for planning tasks.

## Tool Usage Policy

### Use `helot_slinger` for code searches and exploration

| Intent | Tool |
|--------|------|
| Research / understand code | `helot_slinger` + `outputFile: ".helot-mcp-connector/research.md"` |
| Edit prep — need exact lines for `old_string` | `helot_slinger` with `researchTask: "READLINES file.ts <start>-<end>"` |
| Single file, targeted edit, <50 lines, no ambiguity | Direct `Read` |
| Pure pattern search, need location only | Direct `Grep` |

**Never Read a full file you haven't already slingered**, unless it's a trivial single-purpose file or an immediate targeted edit with no ambiguity.

**Always set `outputFile`** — writes full report to disk, returns only compact summary to frontier. Use `.helot-mcp-connector/research.md`.

**READLINES is the edit-prep path** — before editing a function, issue `READLINES file.ts <start>-<end>` through slinger instead of `Read(file)`. Returns verbatim lines via `readFileSync` — exact whitespace, ready for `Edit old_string`, zero full-file context cost. Bundle into the same slinger call as any research questions.

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
## Helots
`.helot-tools.json` auto-created from project detection — review and adjust format/lint/typecheck tools as needed.
