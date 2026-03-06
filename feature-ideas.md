# Helots — Feature Ideas Backlog

Future features not yet implemented. Ordered roughly by value/effort ratio.

---

## 1. PostToolUse on Read — Large File Compression (HIGH)

**Source:** rtk_features_port.md §1  
**Status:** Not implemented — current hook only nudges on offset-based Reads, full plain Reads still flood context.

Trigger when a `Read` tool call exceeds ~200 lines. Compress to:
- Exports / imports
- Function signatures (name, args, return type)
- Class names and inheritance
- Top-level constants

LLM gets structural summary first; requests specific line ranges only when needed.  
**Potential savings:** Largest single win available. Closes the biggest uncovered gap.

**Portability:** Core logic in `helots-compress.py --type read_large_file` (stdin/pipe mode). Hook wires it for Claude Code; CLI wrapper for Cursor/Aider.

---

## 2. Engine-Side Test Runner (After Peltast PASS)

**Source:** Session discussion (2026-03-06)  
**Status:** Not implemented — requires solving "which tests to run" scoping problem first.

After Peltast passes a diff, run tests scoped to changed files before committing:
- `tsc --noEmit` always (fast, no scoping needed)
- `pytest path/to/changed_module_test.py` — derive from changed file path
- `npm test -- --testPathPattern=<changed file>` for Jest

If tests fail → feed failures into `lastPeltastFeedback` → Builder retries in same run. Nothing broken ever lands on disk.

**Prerequisite:** Analytics (§4 below) should confirm test output is worth the latency cost before building.

---

## 3. Test-on-Change Hook — PostToolUse on `helot_run` (MEDIUM)

**Source:** Session discussion (2026-03-06)  
**Status:** Next to implement (safety net before engine-side test runner).

PostToolUse hook on `mcp__helots__helot_run`:
- Auto-detect test runner (jest/vitest/pytest/cargo test/go test)
- Run tests, compress output via existing `helots-compress.py` patterns
- Inject failures as `additionalContext` for Claude to see and decide on re-run
- Toggle-aware via `helots_common.is_enabled()`

Complements LSP pre-flight (type errors) — adds runtime/behavioral verification layer.

---

## 4. Session Analytics — Token Consumption Discovery (MEDIUM)

**Source:** rtk_features_port.md §3  
**Status:** Not implemented.

Parse session JSONL to rank tool invocations by output token cost:
- Correlate tool calls with output sizes
- Estimate token consumption per command type
- Surface top offenders ("Read on engine.ts consumed 8k tokens 4 times today")

**Must build before** investing in Bash compression (§5) — analytics validates whether the frontier model is actually running test commands directly, or whether helots handles it all.

**Note:** Parser is harness-specific (Claude Code JSONL format). Insights are universal.

---

## 5. PostToolUse on Bash — Build Output Compression (CONDITIONAL)

**Source:** rtk_features_port.md §2  
**Status:** Partially implemented — `helots-compress.py` already compresses tsc/pytest/npm_test/cargo/go_test output when piped. Gap: no PostToolUse hook wiring for `Bash` tool yet.

Wire PostToolUse on `Bash` to pipe output through `helots-compress.py` when the command matches test/build patterns. **Only build after analytics (§4) confirms ROI** — if helots handles all execution, the frontier model rarely runs these directly.

---

## 6. Harness-Agnostic Compression Library (BUILD ALONGSIDE)

**Source:** rtk_features_port.md §4  
**Status:** Partially implemented — `helots-compress.py` has stdin/pipe mode. Missing: Python library import interface.

Add importable interface to `helots-compress.py`:
```python
from helots_compress import compress
result = compress(content, type="read_large_file")  # returns (compressed_str, token_delta)
```

Enables Cursor/Aider/raw API agents to use compression without Claude Code hooks.  
**Build this alongside** §1 (Read compression) and §5 (Bash compression), not as a standalone initiative.

---

## 7. Builder External Tool Loop (LOW / RESEARCH)

**Source:** Session discussion (2026-03-06)  
**Status:** Not implemented — architectural research needed.

Allow Builder to call Claude's MCP tools (Read, Grep, Glob) mid-generation to look up context before writing. Requires:
- Tool call protocol integrated into Builder prompt/response loop
- Context budget management (Q8/32k vs Q4/66k tradeoff)
- Either direct tool dispatch or slinger-mediated lookups

**Context note:** Q4/66k context gives Builder more headroom for tool loop. Worth revisiting if we move to Q4 cache.

---

## 8. Slinger MCP Proxy — Web Search + GitHub (HIGH / FRONTIER SAVER)

**Source:** Session discussion (2026-03-06)
**Status:** Not implemented — architectural design needed.

Extend Slinger's command loop with a `### MCP_CALL: tool_name` block format. Engine intercepts, executes via an MCP client, feeds result back as the next turn. No llama.cpp changes needed — pure text protocol, same pattern as the existing `### COMMAND` loop.

**Target tools (ordered by ROI):**
1. **Web search (Brave/Exa)** — Slinger researches external APIs, library docs, changelogs locally. Eliminates the "Claude researches → summarizes for task description" pattern.
2. **GitHub MCP** — Slinger reads PR descriptions, issue bodies, discussion threads directly. Currently Claude does this and distills it into the implementationPlan.
3. **Browser/screenshot** — for UI tasks where Slinger needs to see the actual rendered output.

**Frontier token savings:** Eliminates the research leg of the "you → helot_slinger → you read → you design tasks → helot_run" loop. With rich enough Slinger output, local Aristomenis plans without Claude as intermediary.

**Implementation:** `mcp-client.ts` (reads MCP server config, spawns stdio servers) + Slinger system prompt extension with available tool schemas + engine intercepts `### MCP_CALL` blocks in the turn loop.

---

## 9. Autonomous Vision via MCP-Equipped Slinger (HIGH / STRATEGIC)

**Source:** Session discussion (2026-03-06)
**Status:** Depends on §8.

With Slinger having local + external MCP access, the full "research → plan → execute" cycle moves off-frontier:

**Target flow:**
- User states intent to Claude (minimal tokens)
- Claude calls `helot_vision` with intent
- Slinger (local) researches codebase + external docs + GitHub context
- Aristomenis (local) creates the checklist against rich context
- Builder + Peltast execute
- Claude only intervenes on escalations

**This is the end-state goal:** frontier tokens spent only on intent specification and unrecoverable failures. Everything else local.

**Prerequisite:** §8 (Slinger MCP Proxy) must be working and proven reliable first.

---

## 10. Hybrid Workflow — Local Plans, Frontier Specs (HIGH / STRATEGIC)

**Source:** Session discussion (2026-03-06)
**Status:** Not implemented — depends on §8 (Slinger MCP Proxy) and §9 (Autonomous Vision).

**The core insight:** Aristomenis' failure mode is precision, not architectural reasoning. It can identify which files to touch and roughly why. What it can't reliably produce is the `changes` field — the exact before→after diff that makes Builder succeed. That's where frontier tokens should be spent: surgical precision on small specs, not broad research and planning.

**The hybrid flow:**
```
1. User states intent                            ← ~50 frontier tokens
2. Slinger (local + web/GitHub MCP) researches   ← 0 frontier tokens
3. Aristomenis (local + file-read MCP):
   - reads relevant files during planning
   - produces task list: file + symbol + rough intent
   - does NOT write the changes field            ← 0 frontier tokens
4. Approval gate (redesigned):
   Claude sees files + rough intent per task
   Claude writes ONLY the changes field          ← ~300 tokens × N tasks
5. Builder executes with Claude-quality changes  ← 0 frontier tokens
6. Peltast verifies                              ← 0 frontier tokens
```

**Token economics:** On a 5-task run: ~2k frontier tokens vs ~15k today. ~85% reduction.

**The approval gate redesign:** Currently the gate asks "APPROVE/MODIFY/ABORT" — Claude reviewing something it didn't produce. New gate: "Aristomenis identified these files to touch. Write the exact changes for each." Claude's input is additive and targeted, not supervisory. It does the one thing local can't do reliably.

**What file-read MCP access fixes in Aristomenis:**
- Hallucinated symbol names → reads the real ones from file content
- Wrong signatures → sees actual function definitions
- Missing import chains → follows actual imports
- Wrong task type (EDIT vs CREATE) → detects whether symbol exists

**Build sequence:**
1. §8 (Slinger MCP proxy with file-read) — Aristomenis inherits via "NEED MORE DATA" pathway
2. Redesign approval gate — from yes/no to "Claude writes changes fields only"
3. Aristomenis prompt: explicitly produce tasks with no changes field, just file + symbol + rough intent

**Why this matters beyond token savings:** Aristomenis failures become cheap — wrong file target gets corrected at the gate without a full re-run. The local/frontier boundary becomes clean: local owns breadth, frontier owns precision.

---

## 11. Slinger EVIDENCE Trimmer — Compress Oversized Evidence Blocks (LOW)

**Source:** Session discussion (2026-03-06)
**Status:** Not implemented — micro-optimization.

The slinger's `### EVIDENCE` section can grow bloated when grep hits return many long code snippets. The existing `helots-compress.py` does generic reduction (whitespace, duplicate lines) but is not slinger-aware.

**Proposed:** Add a slinger-aware compress pass that:
- Detects `### EVIDENCE` blocks in slinger output
- Counts lines per evidence snippet
- Truncates any single snippet exceeding ~30 lines to first 15 + last 5 lines with a `[... N lines trimmed ...]` marker
- Preserves `### SUMMARY` and `### LOCATIONS` sections intact

**When it matters:** Only for `helot_slinger` calls that return to the frontier (no `outputFile`). With `outputFile`, research never hits frontier context — compress is irrelevant.

**Implementation:** `helots-compress.py` — add `--type slinger_evidence` mode, wire into existing PostToolUse hook on `mcp__helots__helot_slinger`.

**Estimated savings:** Small per call but cumulative across multi-slinger research sessions.

---

## 12. Code Quality Review Skill — Hybrid Slinger+Claude Flow (MEDIUM)

**Source:** Session discussion (2026-03-06)
**Status:** Not implemented — gap in current skill coverage.

Current `/review` skill covers staged git diff review (off-frontier). The global `/code-review` skill does deep quality analysis but runs entirely on Claude (full frontier cost). No dedicated path for quality review of specific files/directories via helots.

**Proposed hybrid flow:**
1. `helot_slinger(targetFiles=[...])` — local model reads files, extracts structure, returns SUMMARY/EVIDENCE to Claude
2. Claude performs quality analysis on curated slinger output — security, anti-patterns, architecture smell, complexity

Slinger handles the "read N files and structure the relevant code" leg (saves frontier read tokens). Claude handles the analysis where quality matters. Same pattern as the `/helots` skill — slinger for ground truth, Claude for judgment.

**Skill trigger:** `/quality` or extend `/code-review` to detect when helots MCP is available and delegate the file-reading leg to slinger automatically.

**Why not fully off-frontier:** Deep code quality analysis (subtle security vulns, architectural smell) is one case where local model quality is meaningfully lower than Claude. Hybrid preserves quality while still saving read tokens.

**Implementation:** Update `~/.claude/skills/code-review/SKILL.md` to add a helots-aware path: if `helot_slinger` is available, run slinger on target files first, then use the output as context for Claude's analysis.

---

## What NOT to build

From rtk_features_port.md §5 — still applies:
- `rtk ls` / find wrappers — MCP tools already cover this
- Docker/kubectl wrappers — out of scope
- CLAUDE.md injection (legacy RTK mode) — unnecessary complexity