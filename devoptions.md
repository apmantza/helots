# Helots Dev Options — Open Problems & Approaches

## Problem: Two-Change Coordination in Large File Refactoring

### Root Cause

When refactoring a large function (e.g. `get_all_benchmarking_metrics`, 740 lines) into a lean orchestrator,
two coordinated changes are required:

1. **Function body** — replaced with ~70-line orchestrator (surgical mode)
2. **Module-level imports** — stale names removed (e.g. `PROFITABILITY_ITEMS` moved to helpers file)

Surgical mode can only patch one. Peltast evaluates the file after each task — so after the function
body replacement, the module-level import is stale → F401 → FAIL, before the import cleanup task runs.

This is a **peltast-too-early** problem: intermediate state after step 1 is technically broken,
but would be correct after step 2 completes.

The same class of problem arises any time a refactoring:
- Moves symbols between files (imports become stale in source)
- Splits a large function across tasks
- Introduces temporary unused variables that a later task cleans up

---

## Option 1 — `skipLintCodes` Task Field ✅ CHOSEN

**Mechanism:** Add a `SkipLintCodes: F401,F811` field to the task spec. Peltast ignores matching
ruff error codes when evaluating that task's output.

**Implementation:** Parse `SkipLintCodes:` in `parseChecklist`. In the ruff diff logic, filter
`introduced` errors by the declared skip codes before pushing to `groundTruth`.

**Pros:**
- Minimal engine change (~10 lines)
- Surgical — only suppresses what the task author explicitly declares
- Composable with dependsOn chains: the downstream task fixes what upstream suppressed

**Cons:**
- Author must know which codes to suppress upfront
- Risk of masking real errors if used carelessly

**Usage example:**
```
SkipLintCodes: F401
```
In a surgical refactoring task that intentionally makes module-level imports stale.

---

## Option 2 — Deferred Peltast (evaluate after full dependency chain) 🤔 INTERESTING

**Mechanism:** When a task has `dependsOn`, peltast does not run after each individual task.
Instead, it accumulates ground truth and only fires peltast once after the last dependent task completes.

**Why it's appealing:**
- Mirrors how humans think about refactoring: "these 3 tasks together produce a correct result"
- No annotation burden — works automatically for chained tasks
- Fixes the coordination problem structurally, not symptomatically

**Implementation sketch:**
- In the Governor/task runner, track "peltast deferred" flag on tasks that are in a dependency chain
- After the last task in a chain completes (no dependents pending), collect accumulated ground truth
  from all tasks and run peltast once against the final file state
- Requires: knowing the full dependency graph upfront (already available in the task list)
- Edge case: what if a mid-chain task has a syntax error? Probably still fail immediately on syntax,
  defer only lint checks

**Cons:**
- More complex engine change — requires governor-level coordination
- Error attribution becomes harder: which task introduced the bug?
- Needs careful handling of partial failure (task 2 of 4 fails syntactically)

---

## Option 3 — Pre-task Import Fix (rejected)

Run the import cleanup as task N, function body replacement as task N+1.
Doesn't work: removing `PROFITABILITY_ITEMS` from the import before the function body is replaced
would cause the same F401 (now unused inside the still-present original function body).

---

## Option 4 — Chunked Full-File Output 🤔 INTRIGUING

**The real problem:** Full-file mode fails on files >~600 lines because the builder hits
`max_tokens` and truncates output mid-file. This forces surgical mode, which can't touch
module-level imports.

**Mechanism:** Instead of asking the builder to output the complete file in one pass,
split the file into chunks, process each chunk independently, and stitch them back together.

**Implementation sketch:**

1. **Identify change zones:** Before calling the builder, diff the task instructions against
   the file to identify which line ranges need to change (e.g. lines 1-30 for imports,
   lines 136-858 for function body). Call these "hot zones".

2. **Chunk strategy:** Split the file at natural boundaries (function definitions, class boundaries)
   into chunks of ~200-300 lines each. Mark each chunk as "hot" (needs builder attention) or
   "cold" (pass through unchanged).

3. **Parallel builder calls:** Send each hot chunk to the builder with its surrounding context
   (a few lines before/after for continuity). Cold chunks are copied verbatim.

4. **Stitching:** Reassemble chunks in order. Run py_compile on the result before committing.

**Why this is hard:**
- Chunk boundaries must respect Python/TS syntax (can't split mid-function)
- Builder needs enough context per chunk to understand what to change
- Stitching errors (duplicate lines, missing blank lines) are hard to detect without running the code
- "Hot zone" detection is essentially a mini-diff problem

**Simpler variant — "top + bottom passthrough":**
For the common case of "change imports at top + change one function in the middle":
- Builder outputs ONLY the changed sections, delimited by markers
- Engine splices them into the original file at the correct line ranges
- This is essentially surgical mode but for multiple disjoint zones

This "multi-zone surgical" variant is much more tractable than full chunking and directly
solves the two-change coordination problem without option 1's annotation burden OR option 2's
deferred evaluation complexity.

---

## Option 5 — Aristomenis + Slinger Pre-step (Future)

**Problem:** Aristomenis plans tasks from prose without codebase access — produces incorrect file paths
and missed dependencies. Giving him inline slinger tool use exhausts his 32K context (8 turns of
slinger history ≈ 10-15K tokens + system prompt + output ≈ full budget).

**Better approach — pre-step injection:**
Run slinger before Aristomenis, feed only the compact summary (~1.5K tokens) into his context:

```
[slinger research] → summary (1.5K tokens)
        ↓
[Aristomenis] system_prompt + prose + summary → structured task list
```

Total Aristomenis budget: ~6K tokens — well within 32K.

**Remaining issue:** Someone must decide what to ask slinger before Aristomenis runs.
Options: (a) frontier model emits the slinger query, (b) a fixed "explore the files mentioned
in the prose" heuristic. Either way adds one extra round-trip.

**Practical recommendation:** Keep Aristomenis as-is for vague-prose fallback.
Frontier always supplies structured tasks when precision matters — this is the settled workflow.
Pre-step slinger upgrade is low priority; document for future.

**Status:** ✅ Implemented. `helot_hoplite` tool added to engine.ts + mcp-server.ts. Hook fires on Edit/Write to .md files.

---

## Option 6 — Dynamic Slinger FILE_CAP (Future)

**Problem:** The slinger's per-file preload cap (`FILE_CAP`) was previously hardcoded at 25000 chars,
tuned for Q8 KV + 32K context. This is now computed dynamically from `getProps().maxTokens` and
the number of target files — but a hardcoded ceiling of 20K chars was still clamping the result.

**Fix applied:** Removed the `Math.min(20000, ...)` ceiling. The formula now uses the full available
headroom:

```
availableChars = max(2000 * numFiles, (maxTokens - 10000) * 4)
FILE_CAP = floor(availableChars / numFiles)
```

For 1 file on 32K context: `(32000 - 10000) × 4 = 88K chars` — enough to preload engine.ts in full.

**Status:** ✅ Implemented. Ceiling removed. `slinger-orchestrator.ts` deleted (was dead code).

---

## Option 6b — Dynamic Builder max_tokens ✅ IMPLEMENTED

**Problem:** Builder profiles hardcode `max_tokens: 8192`. In full-file mode the builder must
OUTPUT the entire file. A 1553-line file ≈ 19K output tokens — physically can't fit in 8192,
so the builder truncates mid-file. Every large-file content loss bug traces back to this.

Surgical mode is unaffected (outputs only the function body, well within 8192).

**Fix:**
Before calling `streamCompletion` in full-file mode, override `max_tokens` based on actual file size:

```typescript
if (!isSurgical && contextContent && this.serverMaxTokens > 0) {
    const fileLines = contextContent.split('\n').length;
    const estimatedOutputTokens = Math.ceil(fileLines * 15); // ~15 tokens/line is conservative
    const safeMax = this.serverMaxTokens - 4096; // leave headroom for prompt
    const dynamicBudget = Math.min(Math.max(estimatedOutputTokens, 8192), safeMax);
    if (dynamicBudget > 8192) builderMaxTokensOverride = dynamicBudget;
}
```

`serverMaxTokens` stored as instance variable, set from `getProps()` at run start.
Override passed through `runSubagent` → `streamCompletion` → `attemptStream` → request body.

**Status:** ✅ Implemented. Changes in `engine.ts` + `llama-client.ts`.

---

## Option 7 — Hoplite: Lightweight Read+Write Agent (No Review)

**Problem:** `helot_run` is the only write path, but it spins up the full peltast review cycle
(ruff, py_compile, lint diff) even for markdown or config file updates. This wastes local model
cycles and forces the frontier model to read files before editing (adding content to context).

**Mechanism:** A new `helot_hoplite` tool — a stripped-down agent that:
1. Reads the target file(s) locally
2. Applies the described edits
3. Returns "done" — **no peltast, no lint, no review**

**Use cases:**
- MEMORY.md, devoptions.md, README updates
- Config file tweaks (non-code)
- Any write where correctness is obvious and review adds no value

**Token savings vs current:**
- Frontier no longer reads the file (avoids ~800-2000 tokens per MD entering context)
- Savings are modest per call but compound across a session with multiple doc updates

**Hook integration:** PreToolUse hook fires on `Edit`/`Write` targeting `.md` files → reminds to use `helot_hoplite`.

**Status:** ✅ Implemented. `executeHoplite` in `engine.ts`, `helot_hoplite` tool in `mcp-server.ts`.
Hook fires on Edit/Write to .md files. Bug fixed: greedy regex + `$` anchor prevents early fence match on files containing code blocks.

---

## Option 8 — Slinger as Bash Output Summarizer

**Problem:** Verbose Bash commands (git diff, git log, git show) dump raw output directly into frontier context, consuming tokens that persist for the rest of the session.

**Mechanism:** Extend slinger's SAFE_PATTERNS allowlist to include read-only git commands and linting tools. Frontier routes verbose commands through slinger instead of Bash — slinger runs the command, interprets the output, and returns a compact summary.

**Allowlist additions (engine.ts SAFE_PATTERNS):**
- `git status|diff|log|show|branch|shortlog|stash list` (read-only git)
- `ruff`, `python`, `python3` (linting + syntax checks)

**Hook integration:** PreToolUse hook fires on Bash calls starting with `git diff`, `git log`, `git show`, `git shortlog` → reminds to use helot_slinger instead.

**Example:**
Instead of `Bash("git diff") → raw diff in context`, use `helot_slinger("summarize what changed in git diff and git status") → "3 files changed: engine.ts (+45/-12), mcp-server.ts (+18), devoptions.md updated."`

**Status:** ✅ Implemented. SAFE_PATTERNS updated in engine.ts. Hook added for verbose git commands.

---

## Option 9 — Cross-file Context Injection for CREATE Tasks

**Problem:** The builder is file-local — it reads only the file it is editing. In greenfield/scaffolding workflows, task 5 (implement `AuthService`) needs to know the interface defined in task 1 (create `types.ts`). Without this, the builder guesses imports and type signatures, producing incorrect code.

**Mechanism:** When a task has `dependsOn`, `runOneTask` preloads the files from those upstream tasks and injects them into the builder prompt as read-only context:

```
UPSTREAM DEPENDENCIES (read-only — use for correct imports/interfaces):
=== Task 1 → src/types.ts ===
[content]
=== Task 2 → src/models/user.ts ===
[content]
```

**Implementation:**
- `runOneTask` gains `allTasks: HelotTask[] = []` parameter
- Before the retry loop, resolves `task.dependsOn` IDs → reads their files → builds `upstreamContext` string (3000 chars/file cap)
- Injected into both surgical and full-file builder prompts
- Call site in `runTaskLoop` passes `taskNodes`
- Logged as `🔗 Builder: injecting N upstream file(s) as context`

**Impact:** Enables reliable greenfield scaffolding — task dependencies now carry actual file content, not just ordering constraints. Builder produces correct imports and matching interfaces on first attempt.

**Status:** ✅ Implemented. Changes in `engine.ts` only.

---

## Option 10 — Parallel Builder Execution (vLLM / docker)

**Concept:** For greenfield builds, many tasks are independent (no dependsOn relationship). A wave-based executor could identify all unblocked tasks at each round, launch them concurrently, wait for the batch, then find newly unblocked tasks and repeat — like a topological sort with parallel waves.

**Hard constraint — single GPU + llama.cpp:**
Not implementable with llama.cpp on a single card. Parallel requests queue on the server and serialize anyway. `--parallel N` splits VRAM between N KV cache slots — each slot gets less context, throughput does not increase.

**When this becomes relevant:** Switching to a docker + vLLM setup. vLLM supports continuous batching and genuine concurrent request handling, so independent tasks in the same dependency wave would run truly in parallel. At 90 t/s on the 35B MoE, a 5-task parallel wave would complete in the same time as a single sequential task.

**Implementation sketch (engine.ts `runTaskLoop`):**
- Instead of a flat for loop, run in waves: find all tasks with no pending blockers → `Promise.all(wave.map(runOneTask))` → mark completed → repeat
- `sessionTotalTokens` tracking needs atomic updates (simple accumulator with post-wave sum)
- No changes needed to `runOneTask` itself — it's already self-contained

**Status:** Not implemented. Revisit when moving to docker + vLLM.

---

## Priority

| Option | Effort | Impact | Status |
|--------|--------|--------|--------|
| 1 — skipLintCodes | Low | Fixes immediate problem | ✅ Done |
| 2 — Deferred peltast | Medium | Fixes class of problems structurally | Backlog |
| 4 — Multi-zone surgical | High | Fixes large-file refactoring fundamentally | Backlog |
| 5 — Aristomenis + Slinger pre-step | Medium | Better task planning | Backlog |
| 6 — Dynamic slinger FILE_CAP | Low | Full file preloads | ✅ Done |
| 6b — Dynamic builder max_tokens | Low | Fixes large-file truncation | ✅ Done |
| 7 — Hoplite | Low | Fast MD/config writes, saves frontier tokens | ✅ Done |
| 8 — Slinger Bash summarizer | Low | Reduces verbose command output in context | ✅ Done |
| 9 — Cross-file context injection | Low | Enables reliable greenfield builds | ✅ Done |
| 10 — Parallel builder waves | High effort | 2-5x greenfield throughput (vLLM only) | Backlog — needs vLLM |