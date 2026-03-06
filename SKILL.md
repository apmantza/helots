---
name: helots
description: Delegate a coding task to the Helots local AI swarm. Use when the user wants to run helots, fire up the local model, offload refactoring/implementation to psiloi, or use helot_run/helot_slinger. Triggers on phrases like "fire helots", "run helots", "let helots handle it", "delegate to helots".
---

# Helots Delegation Workflow

The user wants to run: **$ARGUMENTS**

Follow this exact workflow — do not skip steps.

## Step 1 — Sanity check

Confirm `helot_slinger` and `helot_run` are in the MCP tools list. If not: "Helots MCP not connected — run `/mcp` to reconnect."

If a previous run ended with "empty response (0 tokens)" or "server failed", tell the user to restart llama.cpp first.

## Step 2 — Research with helot_slinger

Call `helot_slinger` to gather exact ground truth:
- Function names that need changing (exact, from the file)
- Current line counts per file
- The exact lines to replace (copy-paste from source)

Pass `targetFiles` for all files mentioned in the task plus direct neighbours.

Do NOT skip this — precise diffs prevent Builder failures.

## Step 3 — Build structured tasks

Using the slinger output, construct a `tasks` JSON array for `helot_run`.
**This bypasses Aristomenis entirely — you are the architect.**

### Task object shape
```json
{
  "id": "1",
  "description": "Imperative description of what changes",
  "file": "src/relative/path/to/file.ts",
  "symbol": "exact_function_name",
  "dependsOn": [],
  "changes": "Exact instructions:\n- Replace `old line` → `new line`"
}
```

### Hard rules
- One task = one symbol
- `changes` must be exact — literal old line and new line
- `symbol` must match the codebase (confirmed by slinger)
- `dependsOn` must be consistent

## Step 4 — Fire helot_run

Call `helot_run` with `taskSummary` and `tasks`.

### Handle escalations

| Signal | Action |
|---|---|
| `VERDICT: FAIL` + syntax ✅ | CONTINUE — Peltast over-grading |
| `empty response (0 tokens)` | Server crashed — tell user to restart llama.cpp |
| Genuine wrong code | Read diff, decide RETRY vs direct Edit |

## Step 5 — Mop up

After the run: grep for old patterns, verify line counts, fix stragglers with direct Edit.

---
name: explore
description: Generate a full project structure document using the helots slinger. Use when the user wants to understand a codebase, onboard to a new project, or generate CLAUDE.md / project-structure.md. Triggers on phrases like "explore the codebase", "map the project", "generate project docs", "init this project".
---

# Helots Explore Workflow

The user wants to explore: **$ARGUMENTS**

Call `helot_slinger` with `outputFile` to generate a project structure document off-frontier:

```
helot_slinger(
  researchTask: "Survey this project: 1) full directory tree excluding node_modules/.git/dist, 2) purpose of each top-level directory, 3) key architectural patterns and entry points",
  outputFile: "docs/project-structure.md",   // or CLAUDE.md if onboarding
  batchDir: "src"                             // to batch-summarize all source files
)
```

If the user wants a CLAUDE.md for onboarding, use `outputFile: "CLAUDE.md"` and add to the research task: "Format as a CLAUDE.md with sections: What this project is, Project Structure, Key files, and Development workflow."

The result is written to file — the full research never hits the frontier context.

---
name: review
description: Generate a code review document for staged git changes using the helots slinger. Use when the user wants a review of their changes, a summary of what was modified, or wants to write a review.md. Triggers on phrases like "review my changes", "summarize the diff", "write a review".
---

# Helots Review Workflow

The user wants to review: **$ARGUMENTS**

Call `helot_slinger` with `outputFile` to generate a review document off-frontier:

```
helot_slinger(
  researchTask: "Review the staged git changes in this repository: 1) run git diff --staged to see what changed, 2) summarize each changed file and what was modified, 3) flag any potential issues, regressions, or missing tests, 4) give an overall assessment",
  outputFile: "review.md"
)
```

The slinger will run `git diff --staged` via its shell toolkit, analyze all changed files, and write the review directly to `review.md`. The full diff never hits the frontier context.
