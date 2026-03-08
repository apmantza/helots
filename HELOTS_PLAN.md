# Helots Implementation Plan

## Implementation Status

### ✅ Already existed (discovered during implementation)
- **Layer 3 (Full LSP)** — `src/core/lsp-client.ts` (`LspManager`) already implemented. Pre-flight type checking runs before disk write. Falls back to `tsc` CLI if LSP server unavailable. Wired into `task-runner.ts` with Builder retry loop on type errors.
- **`validateCmd`** in `HelotConfig` — post-Peltast shell command hook already exists. Layer 2's `typecheck_slow` can use this directly via `.helot-tools.json` populating it.
- **`SkillInjector`** — `src/core/skill-injector.ts` exists, loads `skill-rules.json` for domain-specific Builder prompt injection. Not yet wired (declared but unused).

### ✅ Implemented this session
- **`src/core/env-check.ts`** — NEW. Reads `.helot-tools.json`, checks tool availability on PATH, reports missing tools. `runEnvCheck()` + `formatEnvReport()`.
- **`src/core/worktree-manager.ts`** — NEW. `WorktreeManager.create/remove`, `branchName(runId)`, `worktreePath(stateDir, runId)`.
- **`src/core/helots-orchestrator.ts`** — env check + worktree creation at run start. All `process.cwd()` replaced with `governor.config.projectRoot`. Branch name returned in run response. `projectRoot` restored after run.
- **`src/core/task-runner.ts`** — All `process.cwd()` replaced with `this.governor.config.projectRoot`. All `resolve(file)` calls replaced with `resolve(this.governor.config.projectRoot, file)`. `LspManager`, `SkillInjector`, `validateCmd`, git commit, runVerification all use projectRoot.

### 🔲 Remaining
- **Layer 1 (Tool Config)** — `.helot-tools.json` loading done (`loadToolConfig` in env-check.ts). Need to wire `typecheck_fast` into Builder post-write loop (or populate `validateCmd` from it). `typecheck_slow` → wire into Peltast pre-LLM gate.
- **Layer 2 (Format/Lint loop)** — Run `format` and `lint_fix` tools from `.helot-tools.json` after Builder writes, before LSP check.
- **Layer 4 (Peltast upgrade)** — Add `typecheck_slow` gate before LLM Peltast call.
- **Layer 5 (Run Report)** — Structured markdown report instead of plain string. `src/core/run-reporter.ts`.
- **Layer 6 (plan.md)** — Scout reads `.helot-mcp-connector/plan.md` if present as authoritative file target source.
- **Layer 7 (Claude LSP)** — Workflow convention only, no code changes needed.

## Goal
Full autonomous local execution: frontier (Claude) plans once, helots executes, self-corrects, and reports back. No mid-run frontier escalation. Language-agnostic via tool config. LSP-powered synchronous error detection before any disk write.

## Execution Order
0 → 1 → 2 → 5 → 4 → 3 → 6 → 7

First pass (0→1→2→5): isolated runs, self-correcting Builder, environment transparency, clean post-run report with no frontier escalation.

---

## Layer 0 — Git Worktree Isolation
**Dependency:** none | **Effort:** medium | **Win:** run isolation, safe autonomy

- New `src/core/worktree-manager.ts`: `createWorktree(branch)`, `removeWorktree()`, `mergeWorktree()`
- `engine.ts`: create worktree before run starts, pass worktree path to all agents
- `mcp-server.ts`: return worktree branch name in run response
- All Builder writes target the worktree path, not main working tree
- Bad run recovery = `git branch -D`. No damage to main branch possible.

---

## Layer 1 — Tool Config + Environment Check
**Dependency:** none | **Effort:** small | **Win:** language-agnostic, honest reporting

**`.helot-tools.json`** at project root (optional, auto-detected):
```json
{
  "format": ["prettier --write {{file}}"],
  "lint_fix": ["eslint --fix {{file}}"],
  "typecheck_fast": ["tsc --noEmit --pretty false"],
  "typecheck_slow": ["mypy src/"]
}
```

- New `src/core/env-check.ts`: runs at the start of every `helot_run`
  - Reads `.helot-tools.json` (falls back to defaults based on detected language)
  - Checks each configured tool is available on PATH
  - Checks git worktree support (git >= 2.5)
  - Checks LLM server reachable
  - Returns structured `EnvReport`: `{ available: string[], missing: string[], warnings: string[] }`
- Missing tools skip their step silently and log to report — never block the run
- Missing LLM is the only hard failure

**Report header example:**
```
## Environment
✅ prettier, eslint, tsc
⚠️  mypy not found — slow type check skipped
✅ git worktrees supported
✅ LLM reachable at 127.0.0.1:8081
```

---

## Layer 2 — Post-Write Format / Lint / Typecheck Loop in Builder
**Dependency:** 0 + 1 | **Effort:** small | **Win:** self-correcting Builder, fewer Peltast LLM calls

Post-write sequence in `builder-orchestrator.ts` (fallback path before full LSP):

```
Builder writes file
    ↓
1. format tools       — deterministic transform, always run, silent
2. lint_fix tools     — deterministic transform, always run, silent
    ↓
3. typecheck_fast     — tsc --noEmit / pyright
    ├── errors → inject structured errors into Builder prompt → retry (max 2×)
    └── clean → continue to next task
```

- Format/lint errors never surfaced to Builder — they fix silently
- Type errors injected as: "tsc reported: Cannot find name 'X' at line 42 — fix it"
- After 2 failed retries → mark task `failed`, record diagnostics, continue to next task (no escalation)

---

## Layer 3 — Full LSP: Synchronous In-Memory Editing
**Dependency:** 2 | **Effort:** large | **Win:** errors caught before disk write, cross-file awareness

LSP operates on virtual document state — Builder never writes to disk until the code is clean.

**In-memory edit loop:**
```
LLM generates edit (string)
    ↓
LSP: textDocument/didChange  ← send content in memory, no disk write
    ↓
LSP: textDocument/diagnostic ← pull synchronously (LSP 3.17+)
                               or await publishDiagnostics (older servers)
    ├── errors → inject into LLM → regenerate (loop, max 3×)
    └── clean → write to disk (textDocument/didSave)
```

**Cross-file awareness:**
After each in-memory edit, check references for downstream breakage → queue broken callers for editing → resolve all in memory → write all files at once when globally clean.

**New `src/core/lsp-client.ts`:**
- `connect(rootPath)` — spawn tsserver / pyright LSP via JSON-RPC stdio
- `openDocument(file, content)` — textDocument/didOpen
- `updateDocument(file, content)` — textDocument/didChange (in-memory)
- `getDiagnostics(file)` — textDocument/diagnostic (pull, with push fallback)
- `resolveSymbol(file, symbol)` — go-to-definition → exact line range
- `getHover(file, line, col)` — type signature
- `getReferences(file, line, col)` — find all callers
- `closeDocument(file)` — textDocument/didClose
- `detectCapabilities()` — check if pull diagnostics (3.17+) supported

**`builder-orchestrator.ts` updates:**
- Pre-edit: `resolveSymbol` → extract just the target function, not whole file → smaller LLM context
- Post-generation: in-memory check loop (replaces Layer 2 shell calls when LSP active)
- Write only when `getDiagnostics` returns empty

**Note:** Layer 2 (tsc shell call) remains as bootstrap fallback for projects without LSP configured.

---

## Layer 4 — Peltast as Judgment-Only Agent
**Dependency:** 2 | **Effort:** small | **Win:** LLM only for spec compliance and logic

Updated check order in `peltast-orchestrator.ts`:
1. `typecheck_slow` from `.helot-tools.json` — deterministic gate; FAIL immediately if errors
2. Diff vs `plan.md` task spec — did Builder touch the right symbol in the right file?
3. LLM only if (1) and (2) pass and logic correctness needs judgment

Most passing tasks never reach the LLM. Most type failures caught in Builder's Layer 2/3 loop before Peltast sees them.

---

## Layer 5 — Run Completion + Structured Report
**Dependency:** 0 + 2 | **Effort:** small | **Win:** zero mid-run frontier interruptions

- `helots-orchestrator.ts`: remove all throw/escalation paths; accumulate `TaskResult[]`:
  `{ id, status, diff, diagnostics, formattingApplied, peltastVerdict, retryCount }`
- New `src/core/run-reporter.ts`: formats results into markdown report:

```markdown
## Run Report — <taskSummary>
Branch: helots/<id>

### Environment
✅ prettier, tsc  ⚠️ mypy not found

### Results
✅ task-1: added WebFetch handler (0 diagnostics, prettier applied)
❌ task-2: type error after 2 retries — string vs string[] at line 42
   tsc: error TS2345 at src/core/slinger-agent.ts:42
⚠️  task-3: peltast flagged — logic diverges from spec

### Suggested Actions
- merge task-1
- fix task-2: type mismatch (detail above)
- review task-3: spec excerpt attached
```

- `mcp-server.ts`: always return the report as the `helot_run` response
- Claude reads report and acts: merge worktree / retry specific tasks / discard
- No mid-run frontier interruptions. One frontier review per run, post-completion.

---

## Layer 6 — `plan.md` Persistence
**Dependency:** none | **Effort:** trivial | **Win:** cross-session re-exploration eliminated

- Convention: Claude writes `.helot-mcp-connector/plan.md` before every non-trivial `helot_run`
- Format mirrors `tasks[]` schema: task ID, file, symbol, change description
- `scout.ts`: if `plan.md` exists, use it as authoritative source for file targets (replaces regex parsing)
- Peltast Layer 4 diff check reads `plan.md` as the spec
- Next session starts from `plan.md` — no re-slingering required

---

## Layer 7 — Claude Uses LSP Pre-`tasks[]`
**Dependency:** none | **Effort:** trivial | **Win:** precise tasks[], no Builder fallback to full-file mode

- Workflow convention only — no helots code changes needed
- Before constructing `tasks[]`, Claude uses LSP tool to resolve exact file + line for each target symbol
- Passes `file + line` into tasks → Builder never falls back to full-file mode
- Reduces Builder LLM context size and Scout file-mapping work

---

## Language Tool Matrix

| Language | format | lint_fix | typecheck_fast | typecheck_slow |
|---|---|---|---|---|
| TypeScript | prettier | eslint --fix | tsc --noEmit | — |
| Python | black | ruff --fix | pyright | mypy |
| Rust | rustfmt | — | cargo check | cargo clippy |
| Go | gofmt | — | go vet | staticcheck |

---

## File Change Summary

| File | Layers | Change |
|---|---|---|
| `src/core/worktree-manager.ts` | 0 | NEW |
| `src/core/env-check.ts` | 1 | NEW |
| `src/core/lsp-client.ts` | 3 | NEW |
| `src/core/run-reporter.ts` | 5 | NEW |
| `src/core/engine.ts` | 0 | worktree init/cleanup |
| `src/core/builder-orchestrator.ts` | 2, 3 | format/lint/typecheck loop + LSP in-memory loop |
| `src/core/peltast-orchestrator.ts` | 4 | typecheck_slow + plan.md diff + LLM gate |
| `src/core/scout.ts` | 6 | read plan.md if present |
| `src/core/helots-orchestrator.ts` | 5 | remove escalation, accumulate TaskResult[] |
| `src/adapters/mcp-server.ts` | 0, 5 | return worktree branch + run report |