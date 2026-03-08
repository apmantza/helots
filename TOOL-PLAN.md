# Helots Tool Calling — Implementation Plan

## Current State

All helot agents (Slinger, Builder, Peltast) communicate via text-parsed commands:
- Slinger outputs `### COMMAND: LSP_DEFINITION ...` → regex extraction → local dispatch
- Builder outputs a full file inside a markdown fence → extracted and written to disk
- Peltast outputs `VERDICT: PASS/FAIL` → regex match

This works but is fragile (prompt format drift, regex failures) and limits what models can express.
Qwen3-27B supports native ChatML tool calling (`<tool_call>` / `tool` role messages) — we should use it.

---

## Impact Assessment

| Change | Agent | Impact | Effort |
|--------|-------|--------|--------|
| Native tool call infrastructure | All | High — eliminates text parsing fragility | Medium |
| `patch_file` for Builder | Builder | **Highest** — surgical edits without full-file output | Medium |
| Formalize Slinger commands as tools | Slinger | Medium — reliability, no new capability | Low |
| Builder reads on demand | Builder | High — removes need for full contextContent injection | Medium |
| Peltast structured verdict | Peltast | Low — already works reliably | Low |
| MCP client pass-through | All | Very High — full tool universe | High |

---

## Phase 1 — Native Tool Call Infrastructure

**Target files:** `src/core/llama-client.ts`, `src/core/types.ts`

Add `tools?: ToolSchema[]` parameter to `runSubagent()` / the LLM request body.
Parse `tool_calls` array from the assistant message alongside/instead of text content.
Return tool calls to the caller as structured objects rather than raw text.

```typescript
// llama-client.ts request body addition
tools?: Array<{
  type: 'function';
  function: { name: string; description: string; parameters: JSONSchema };
}>;

// Response parsing: check message.tool_calls[] before text extraction
```

The command loop in `slinger-agent.ts` and the output parser in `task-runner.ts` become tool-call dispatchers instead of regex parsers. Text-command fallback stays in place during transition.

---

## Phase 2 — Slinger Tool Set (formalize existing commands)

Formalizes the existing text commands as typed schemas. Handler implementations already exist — this is mostly plumbing.

| Tool name | Replaces | Handler |
|-----------|----------|---------|
| `read_file(path, start?, end?)` | READLINES | `readFileSync` (existing) |
| `search(pattern, path, options?)` | grep commands | `nodeGrepCommand` (existing) |
| `list_dir(path)` | ls / Get-ChildItem | `readdirSync` (new, trivial) |
| `lsp_navigate(op, file, line, col, query?)` | LSP_* commands | `LspManager.navigate()` (existing) |
| `fetch_url(url)` | WEBFETCH | `fetch()` (existing) |

Slinger gets a `tools[]` array, the turn loop dispatches `tool_calls` to these handlers, and injects results as `tool` role messages. Max turns stays the same.

---

## Phase 3 — Builder Tool Set (highest impact)

### 3a. `patch_file` — surgical edit without full-file output

The single most impactful change. Currently Builder outputs the entire file (potentially thousands of tokens) even when changing 5 lines. With `patch_file`:

```typescript
patch_file({
  path: string;
  patches: Array<{ old_string: string; new_string: string }>;
})
```

Builder receives `contextContent` (read-only), emits one or more `patch_file` calls.
Helots applies patches with exact string replacement (same semantics as Claude's Edit tool).
Falls back to full-file output if Builder doesn't emit tool calls (backwards compat).

**Effect:** Large-file edits go from 8k–24k token outputs to ~200 token tool calls. Accuracy improves because the model isn't regenerating unchanged code.

### 3b. `read_file` — on-demand context loading

Currently `contextContent` and `upstreamContext` are injected into the system prompt unconditionally. With `read_file` as a tool, Builder can request additional files it discovers it needs mid-task. Reduces prompt bloat for tasks that don't need full upstream context.

### 3c. `lsp_navigate` — symbol verification before patching

Builder calls `lsp_navigate(goToDefinition, ...)` to confirm a symbol's exact line before issuing a `patch_file`. Eliminates "old_string not found" failures on surgical edits.

**Builder tool set:**
```
read_file, lsp_navigate, patch_file, write_file (for CREATE tasks)
```

---

## Phase 4 — MCP Client Pass-through *(later integration)*

**Goal:** Qwen can call the same MCP tools Claude Code uses — filesystem, browser, database, custom MCPs — without helots needing to reimplement each one.

**Architecture:**
```
Claude Code
  → helot_run({ mcpServers?: MCPServerConfig[] })
      → HelotsMCPClient connects to each server
      → lists tools → builds tools[] for Qwen
      → Qwen emits tool_call { name: "mcp__fs__read_file", args: {...} }
      → HelotsMCPClient routes to correct server
      → result injected as tool response
```

**Implementation steps:**
1. Add `@modelcontextprotocol/sdk` client to helots dependencies
2. Accept `mcpServers` config in `helot_run` input (or read from Claude's `settings.json` directly)
3. `HelotsMCPClient` class: connect → `tools/list` → cache schemas → dispatch `tools/call`
4. Merge MCP tool schemas with local tool schemas before passing to Qwen
5. On tool call: route to MCP client if name matches, local handler otherwise

**Key decisions to make at integration time:**
- **Tool budget:** Too many tools hurts Qwen's tool selection. Either pass a curated subset or let the calling agent specify `allowedTools: string[]`
- **Auth/secrets:** MCP servers may require env vars — those need to propagate from Claude's environment to helots
- **Stdio vs SSE servers:** Stdio servers need to be spawned as child processes; SSE servers connect over HTTP. Both modes need handling.
- **Error isolation:** An MCP server crashing should not crash the helots run — each call needs a timeout and fallback

**What this unlocks:** A helots run that can browse the web, query a database, read/write files via a remote filesystem MCP, or call any custom tool the user has configured — with no changes to helots' core logic per new MCP.

---

## Implementation Order

1. **Phase 1** — infrastructure (unblocks everything else, no behaviour change yet)
2. **Phase 3a** — `patch_file` (highest ROI, Builder accuracy on large files)
3. **Phase 2** — formalize Slinger tools (reliability improvement)
4. **Phase 3b/3c** — Builder `read_file` + `lsp_navigate`
5. **Phase 4** — MCP client (separate project, design separately)
