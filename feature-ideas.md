# Feature Ideas

## Current State

### Helot
- **Status:** Operational but inefficient
- **Limitations:**
  - Per-step return-to-Claude overhead
  - No native network access (Slinger)
  - Full audit logs returned to frontier
  - `/maintain` requires 6+ tool calls

### Slinger
- **Status:** Local filesystem only
- **Limitations:**
  - No WebFetch capability
  - Cannot pull external docs, GitHub READMEs, or API references

### Workflow Orchestration
- **Status:** Fragmented
- **Limitations:**
  - Requires manual chaining of operations
  - No synthesized result return pattern
  - High token overhead for intermediate steps

## Proposed Features

### 1. `helot_workflow` Tool
- **Description:** Accepts a named sequence of helot tool calls
- **Execution Model:** Runs them fully off-frontier in one chain
- **Return Value:** Only a final summary
- **Benefit:** One frontier call → N chained operations
- **Impact:** Eliminates per-step return-to-Claude overhead
- **Use Case:** Enables `/maintain` as a single MCP call

### 2. Slinger WebFetch
- **Description:** Add WebFetch to Slinger's SEARCH TOOLKIT
- **Capability:** Network access for research chains
- **Sources:** External docs, GitHub READMEs, API references
- **Benefit:** No routing through frontier or hoplite required
- **Impact:** Reduces latency and token overhead for research operations

### 3. `/maintain` as Single Tool Call
- **Description:** Wire the full prune → cleanup → explore sequence into one `helot_workflow` invocation
- **Current State:** Requires Claude to orchestrate 6+ tool calls and read intermediate results
- **New State:** Fires once and returns a summary
- **Benefit:** Dramatically reduces frontier interaction complexity

### 4. Execute Result Compression
- **Description:** Modify `helot_execute` return behavior
- **Current State:** Returns full audit logs (40+ lines) to frontier
- **New State:** Returns a one-liner: "23 OK, 4 PROTECTED, 3 BLOCKED"
- **Audit Handling:** Full log written to audit file only
- **Benefit:** Audit detail stays off-frontier, reducing token usage

## Token Compression (inspired by open-thetokenco)

### 1. Slinger Result Compression
- **Description:** Before returning Slinger output to frontier, run query-relevant sentence extraction.
- **Mechanism:** Score each line by term overlap with the original `researchTask`, drop low-signal lines.
- **Target:** 60-80% token reduction with zero information loss for the specific query.
- **Implementation:** Post-processing step in `SlingerAgent` before returning result.

### 2. Execute Audit Compression
- **Description:** Validate the `tokenco` approach for audit logs.
- **Mechanism:** Only return `BLOCKED`, `PROTECTED`, or `ERROR` lines to the frontier. `OK` lines are boilerplate.
- **Storage:** Full `OK` lines written to audit file only.
- **Format:** "23 OK, 4 PROTECTED, 3 BLOCKED" as the frontier-visible summary.

### 3. Slinger Deduplication
- **Description:** Address repetition of identical findings across turns (e.g., "no matches found" × 8).
- **Mechanism:** Hash sentences and deduplicate before returning.
- **Reference:** Mirrors the `tokenco` preprocessing step.
- **Extension:** Could also apply to `hoplite-backups` compression.

### 4. Budget-Constrained Scribe Output
- **Description:** When Slinger writes to `outputFile` via Scribe, apply a compression pass before Hoplite writes.
- **Mechanism:** Score lines by density/relevance to `researchTask`. Cut boilerplate headers and repeated location paths.
- **Benefit:** Makes `docs/project-structure.md` and similar outputs tighter.
- **Impact:** Pays off when Hoplite reads them back, reducing downstream token usage.

### 5. `helots-compress` Hook Extension
- **Description:** Extend the existing `helots-compress.py` hook.
- **Current Scope:** Compresses session context.
- **New Scope:** Apply the same sentence-scoring approach specifically to Slinger log files and tool result payloads, not just session transcripts.

**Reference:** https://github.com/jasonkneen/open-thetokenco
- **Performance:** Deterministic sentence scoring, 97-99.8% compression on large contexts, 1.44ms latency.
- **Reliability:** 100% needle-in-haystack pass rate.

## Tool Surface & Agent Capabilities (inspired by localcowork)

### 1. Curated Tool Surface for Accuracy
- **Observation:** LocalCowork runs 75 tools across 14 MCP servers but achieves 80%+ accuracy only when capped at ~20 tools per context.
- **Helots Implication:** Consider a tool budget per task type — expose only the tools relevant to the current workflow phase (e.g., prune phase: filesystem + execute only; research phase: slinger only).
- **Implementation:** Dynamic tool filtering in `mcp-server.ts` based on active task type or explicit mode flag.

### 2. ToolRouter + PermissionStore Pattern
- **Observation:** LocalCowork uses a `ToolRouter` + `PermissionStore` to gate write actions behind human confirmation.
- **Helots Implication:** The current `protectedFiles` allowlist is a primitive version of this. A proper PermissionStore would track which tools/paths are approved per session and persist decisions.
- **Use Case:** Required-confirm for destructive helot_execute operations without blocking read-only slinger operations.

### 3. Single-Turn Tool Dispatch Optimization
- **Observation:** LocalCowork prioritizes single-turn tool calls to minimize latency — the model is prompted to select the correct tool immediately without conversational loops.
- **Helots Implication:** Slinger's command-then-summary loop already does this. Apply same principle to `helot_run`: reduce back-and-forth between Scout → Aristomenis → Builder by collapsing to fewer turns for simple tasks.

### 4. Cross-Server Coordination Pattern
- **Observation:** Cross-server MCP transitions (e.g., security scan → document diff) are a universal challenge — local models fail more on these than single-server chains.
- **Helots Implication:** `helot_workflow` (see above) would be the natural solution — pre-plan the full server sequence off-frontier, execute in one chain, return synthesized result.

### 5. Audit Server Pattern
- **Observation:** LocalCowork has a dedicated MCP server for logging all tool executions to a local audit trail.
- **Helots Implication:** The `execute-audit.log` pattern already approximates this. Could formalize as a persistent event log (append-only JSONL) instead of per-run files — makes cross-session auditing possible.

### 6. Model Selection for Tool Dispatch
- **Observation:** Hybrid MoE architecture (LFM2-24B-A2B) outperforms dense models for tool dispatch — latency under 400ms per call.
- **Helots Implication:** Current Qwen3-27B is dense. If switching models, prioritize MoE variants (e.g., Qwen-MoE, Mixtral variants) for the dispatch/routing layer, keeping a larger dense model only for Builder/Peltast reasoning steps.

**Reference:** Liquid4All LocalCowork cookbook — local multi-agent coordination, 75 tools/14 servers, LFM2-24B-A2B.

## Agentic Workflow Patterns (inspired by superpowers)

### 1. Two-Stage Peltast Review
- **Current State:** Peltast performs a single PASS/FAIL check on the output.
- **Superpowers Pattern:** Runs a spec-compliance check first, then a separate code-quality check.
- **Helots Implementation:** Split Peltast into two sequential passes: (1) does the output match the task spec? (2) is the code quality acceptable?
- **Benefit:** Reduces error propagation in autonomous loops by isolating structural failures from quality issues.

### 2. Bite-Sized Task Decomposition in Aristomenis
- **Current State:** Aristomenis outputs a checklist, but tasks can be large and vague.
- **Superpowers Pattern:** Enforces 2-5 minute tasks with exact file paths and verification steps.
- **Helots Implementation:** Update Aristomenis prompt to enforce "each step must name the target file and a testable success condition".
- **Benefit:** Increases reliability of execution and makes debugging individual steps easier.

### 3. Skill Trigger System
- **Current State:** Helots skills are manually invoked by the user.
- **Superpowers Pattern:** Skills auto-activate based on context (e.g., brainstorming before coding).
- **Helots Implementation:** Add a "task classifier" step that maps the incoming `helot_run` instruction to a pre-defined workflow pattern (CREATE, EDIT, REFACTOR, DEBUG) and auto-selects the appropriate Aristomenis prompt variant.
- **Benefit:** Reduces manual setup and ensures the right context is loaded for the specific task type.

### 4. RED-GREEN-REFACTOR Enforcement in Builder
- **Current State:** Builder writes code without enforcing Test-Driven Development (TDD).
- **Superpowers Pattern:** Explicitly enforces writing failing tests first, then implementation.
- **Helots Implementation:** For tasks that include test files, instruct Builder to write the failing test first, then the implementation.
- **Benefit:** Ensures local model output is always verifiable and reduces hallucinated logic.

### 5. Socratic Pre-Planning Gate
- **Current State:** Ambiguities in instructions propagate silently through the pipeline, often causing Builder failures.
- **Superpowers Pattern:** Adds a clarification pass before execution.
- **Helots Implementation:** Before Scout runs, add an optional clarification pass that identifies ambiguities in the instruction and surfaces them.
- **Benefit:** Particularly useful for local models with limited reasoning on underspecified tasks; prevents wasted compute on incorrect assumptions.

## File-Centric Agent State (inspired by planning-with-files)

### 1. Explicit Inter-Agent Handoff Files
- **Current State:** Scout → Aristomenis → Builder context is passed in-memory as strings within the engine. If a stage fails, prior work is lost.
- **Pattern:** Each pipeline stage writes its output to a named file before handing off. The next stage reads that file as its primary input.
- **Helots Implementation:** Scout writes `discovery.md`, Aristomenis writes `plan.md`, Builder writes `diff.md` — all in `.helot-mcp-connector/run-{id}/`. Peltast reads `diff.md` directly.
- **Benefit:** Crash recovery (resume from last written file), cross-session task continuity, and full traceability of each stage's reasoning.

### 2. Central Task State File
- **Current State:** Task state (strikes, phase, model) lives only in the in-memory `Aristomenis` governor object.
- **Pattern:** Maintain a `task-state.json` in the run directory that all agents can read and update.
- **Helots Implementation:** Governor serializes state to `.helot-mcp-connector/task-state.json` after each phase transition. On restart, engine can resume from last checkpoint.
- **Benefit:** Enables long-running tasks that survive MCP restarts, and makes the current pipeline phase inspectable externally.

### 3. Atomic Writes for Agent Outputs
- **Current State:** Builder writes directly to target files. A crash mid-write corrupts the file.
- **Pattern:** Write to a `.tmp` file first, then rename atomically to the target path.
- **Helots Implementation:** In `file-executor.ts` and Builder output handling, use `writeFileSync(tmp) → renameSync(tmp, target)` pattern.
- **Benefit:** Prevents partial writes from corrupting source files during autonomous operation.

### 4. Explicit Path Injection in Agent Prompts
- **Current State:** Agents receive file content inline in their prompts (full file text).
- **Pattern:** Pass file paths in prompts and have agents reference them by path rather than embedding full content.
- **Helots Implementation:** For large files, Scout writes a `context-summary.md` and Aristomenis receives the path reference rather than the full content. Reduces prompt size for large codebases.
- **Benefit:** Context window preservation for complex tasks; agents can selectively read only what they need.

**Reference:** github.com/OthmanAdi/planning-with-files — file system as primary agent state store, Read-Plan-Write loop, modular file structure for multi-stage pipelines.

## Inspiration

- **Pattern:** Fractals (TinyAGI) recursive DAG orchestration — plan once as a DAG, execute leaf tasks in isolated git worktrees, synthesize results via merge agents
- **Pattern:** LocalCowork — curate tool surface per phase, single-turn dispatch, cross-server coordination via workflow chains
- **Pattern:** Superpowers (obra) — composable skill triggers, two-stage review, bite-sized TDD decomposition, subagent dispatch with guardrails
- **Pattern:** planning-with-files (OthmanAdi) — file system as shared state, explicit inter-agent handoffs, atomic writes, crash recovery via checkpoints
- **Principle:** Plan once, execute fully, only return synthesized result
- **Goal:** Optimize workflow efficiency and token usage