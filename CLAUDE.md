# Helots-Pi — Claude Code Instructions

## What this project is
A local LLM orchestration framework. Exposes `helot_slinger` (code research) and `helot_run` (code execution) as MCP tools that delegate to a local Qwen model at `http://127.0.0.1:8081`.

## Tool Usage Policy

### Use `helot_slinger` for code searches and exploration
Prefer `helot_slinger` over Grep/Glob/Read when:
- Reading and synthesizing file content across multiple files
- Exploring an unfamiliar area of the codebase
- Answering questions that require understanding code, not just locating it

Use direct Grep/Read when:
- Pure string/pattern search where you only need the location, not the content analyzed — Grep returns a compact result, slinger wraps it in SUMMARY/EVIDENCE overhead
- Reading a single known file you already have a path for
- Simple lookups where the raw result IS the answer (one match, one line)

### Use `helot_run` for non-trivial code changes
Prefer `helot_run` over Edit/Write when:
- A task touches more than one file
- The task requires understanding existing code before writing new code
- The implementation is substantial enough that an LLM planning step adds value

Use direct Edit/Write for:
- Single-line fixes, typos, obvious one-liners
- Changes explicitly described in detail by the user with no ambiguity

### When in doubt, delegate
The local model is fast (~30 t/s). Delegating a search costs a few seconds and saves context. Prefer it.

## Project Structure
- `src/core/engine.ts` — main orchestration (Scout → Aristomenis → Builder → Peltast)
- `src/core/llama-client.ts` — SSE streaming client, model swap, retry
- `src/core/model-registry.ts` — sampling profiles per model
- `src/adapters/mcp-server.ts` — MCP stdio server
- `src/core/governor.ts` — state, strikes, commit gate
- `src/core/persona-utils.ts` — name picker, global context
- `debug-run.mjs` / `debug-slinger.mjs` — local test harnesses

## Active profiles (confirmed working)
- Aristomenis: `INSTRUCT_GENERAL`
- Builder: `INSTRUCT_GENERAL`
- Peltast: `INSTRUCT_REASONING`
- Slinger: `INSTRUCT_GENERAL`

## Debugging this project — Do not use helot_run to debug helots-pi itself. Use direct Grep/Read/Slinger to investigate and direct Edit/Write to fix. helot_run is for feature work only.