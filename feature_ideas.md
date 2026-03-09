# Feature Ideas

## 1. Session Compaction
**Inspired by:** vicnaum/vics-agent-skills `session-stripper`

Strip tool content, thinking blocks, and large outputs from Claude Code JSONL sessions when context pressure rises. We already track `ctxPct` in `engine.ts` — hook into that to trigger auto-compaction. Could also be a standalone MCP tool (`helot_compact`) that Claude calls manually when context is getting full.

**Value:** Recover 60%+ context on long sessions without losing conversation thread.

---

## 2. Persistent Directory Context (`helot_map`)
**Inspired by:** vicnaum/vics-agent-skills `layered-summary`

A tool that walks the project tree and writes layered `AGENTS.md` files — detailed in leaf directories, summarised at parent level. Slinger reads these instead of re-crawling on every run.

**Value:** Large projects currently require slinger to re-research the same areas on every `helot_run`. With persistent context files, slinger can orient itself in one read. Big token saving for repeat work.

**Implementation sketch:**
- New `helot_map` MCP tool
- Hoplite walks dirs, writes `AGENTS.md` per directory
- Slinger checks for `AGENTS.md` at target path before issuing READLINES/GREP commands

---

## 3. Project Onboarding (`helot_init`)
**Inspired by:** vicnaum/vics-agent-skills `init-context`

Parallel sub-agent exploration of root docs, source dirs, tests, CI, and git history. Synthesises into architecture brief, open work items, and "where to find things" reference — written to `.helot-mcp-connector/project-context.md`.

**Value:** First-run orientation for new projects. Replaces ad-hoc slinger research at session start. Output feeds into global context for all subsequent runs.

**Implementation sketch:**
- `helot_init` MCP tool (or a skill wrapping `helot_workflow`)
- Multiple parallel slinger calls via `helot_workflow` steps
- Hoplite synthesises into structured `project-context.md`
- Engine auto-loads `project-context.md` into global context if present
