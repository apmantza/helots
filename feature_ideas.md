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

---

## 4. Session Checkpoint (`helot_checkpoint`)
**Inspired by:** ksenxx/kiss_ai `RelentlessAgent`

At end of session (or on demand), synthesise `events.jsonl` + recent commits + `MEMORY.md` into a structured resumable brief at `.helot-mcp-connector/session-brief.md`. The `SessionStart` hook auto-injects it into context so the next session starts already oriented — no re-explanation needed.

**Problem it solves:** Currently 5-6 sessions per day restart cold. Each requires re-reading commits, re-explaining context, re-orienting. This is pure waste.

**Brief structure:**
```
## What was built this session
## What's in progress / half-done
## Decisions made and why
## Files changed
## Next steps
```

**Implementation sketch:**

**Triggers (multiple, layered):**
- Manual: `helot_checkpoint` MCP tool call
- Automatic: when `ctxPct` exceeds threshold (already tracked in engine)
- Post-run: after every `helot_run` / `helot_queue` completes, append a run summary block
- Post-commit: git hook appends what was committed and why

**Brief structure (strict schema so SessionStart can parse it reliably):**
```
## Session: <date>
## What was built (completed runs + commits)
## What's in progress / half-done
## Decisions made and why (with file refs)
## Files changed (with brief per-file note)
## Known issues / blockers
## Next steps (ordered)
```

**Layered persistence:**
- `session-brief.md` — current session, ephemeral, overwritten each checkpoint
- `session-archive/YYYY-MM-DD-HH.md` — snapshot per checkpoint, never deleted
- `MEMORY.md` — stable patterns only, updated manually or by explicit `remember` commands
- Clear boundary: session-brief = "what happened today", MEMORY.md = "what's always true"

**SessionStart hook integration:**
- Hook reads `session-brief.md` if present, injects as first system message
- Includes last N archived briefs if current session is a continuation (detected via git branch/last commit time)
- Claude sees: "Last session ended with X in progress, next steps were Y" — zero re-explanation

**Diff-aware updates:**
- Checkpoint appends to current brief rather than overwriting — preserves intra-session history
- Each append block timestamped so you can see session evolution

- Lightweight — no sub-session spawning needed, fits existing infrastructure exactly

---

## 5. Per-Run Token Budget (`helot_queue` safety)
**Inspired by:** paperclipai/paperclip budget enforcement

Add an optional `maxTokensPerRun` parameter to `helot_queue`. If a run exceeds the budget, abort it, report what was completed, and continue with the next run rather than letting a runaway loop consume the entire queue.

**Problem it solves:** A `helot_queue` of 10 runs with no cap could run for hours unattended. Explicit budgets make cost predictable and prevent a single bad run from burning the whole queue.

**Implementation sketch:**
- `maxTokensPerRun?: number` field on each queue run (or a global default on the queue)
- `executeQueue` checks `sessionTotalTokens` after each task — abort run if exceeded
- Aborted run reported as `⚠️ Run N: budget exceeded after X tokens (Y tasks completed)`
- Queue continues to next run unaffected
