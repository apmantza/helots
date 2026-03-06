# Helots Hooks

Claude Code hooks that enforce the helots workflow. All hooks are Python scripts and share a common utility module (`helots_common.py`).

## Setup

```bash
python3 hooks/install.py
```

Backs up `~/.claude/settings.json`, then writes the full hooks config pointing at this directory. Safe to re-run after moving the project.

## Per-project opt-out

Create `.claude/hooks.json` in any project root to disable specific hooks:

```json
{ "disabled": ["helots-autocommit", "helots-format"] }
```

---

## Hook Reference

### PreToolUse

| Hook | Matcher | Purpose |
|------|---------|---------|
| `helots-delegate.py` | `.*` | Nudges Claude to prefer `helot_slinger`/`helot_run` over raw Grep/Edit when helots MCP is connected. Covers: broad searches, multi-file edits, `.md` files, large WebFetch URLs. |
| `helots-run-validate.py` | `mcp__helots__helot_run` | Validates task structure before `helot_run` fires — checks for required `symbol` on non-CREATE tasks, non-vague `changes`, valid `dependsOn` references. Injects warnings; never blocks. |
| `helots-filesize.py` | `Write\|Edit` | Warns when a write would exceed 500 lines. Estimates final line count for Edit using current file size + net delta. Never blocks — nudge only. |

### SessionStart

| Hook | Purpose |
|------|---------|
| `helots-session-start.py` | Injects current git branch, last commit message, and uncommitted change count into `additionalContext` at session open. Fast and quiet. |

### PostToolUse

| Hook | Matcher | Purpose |
|------|---------|---------|
| `helots-compress.py` | `mcp__helots__.*` | Compresses MCP tool output to save frontier tokens. Strips repetition, trims noise from tsc/pytest/git diff output. Runs synchronously so Claude sees compressed results. |
| `helots-test-runner.py` | `mcp__helots__helot_run` | Auto-detects and runs the project's test suite after `helot_run` completes. Silent on pass; injects compressed failures into `additionalContext` on failure. |
| `helots-format.py` | `Edit\|Write\|NotebookEdit` | Auto-formats files written by Claude. Detects project formatter in priority order: biome → prettier (TS/JS), ruff → black (Python). |
| `helots-gitstage.py` | `Edit\|Write\|NotebookEdit` | Stages every file Claude writes/edits (`git add <path>`). Runs async. Seeds `helots-autocommit` on Stop. |

### PostToolUseFailure

| Hook | Matcher | Purpose |
|------|---------|---------|
| `helots-error-handler.py` | `.*` | Pattern-matches tool errors and injects targeted debugging hints into `additionalContext`. Prevents Claude from blind-retrying the same failed approach. |

### Stop

| Hook | Purpose |
|------|---------|
| `helots-autocommit.py` | Commits all staged changes using the last user prompt as the commit message. Uses `git add -u` (tracked files only — safe). No-ops if nothing staged. |
| `helots-session-summary.py` | Summarizes the session diff (message text only, no tool I/O) via local LLM and appends a dated block to `MEMORY.md`. Runs async. Throttled by `TURNS_BETWEEN_SUMMARIES`. |

### PreCompact

| Hook | Purpose |
|------|---------|
| `helots-session-summary.py` | Same as Stop variant but always runs (not throttled) — persists discoveries before Claude's context is compressed. |

---

## Shared Library

**`helots_common.py`** — imported by all hooks via `sys.path.insert`.

- `is_enabled(hook_name, cwd)` — checks `.claude/hooks.json` in the project root. Returns `True` if the file doesn't exist (fail open).
