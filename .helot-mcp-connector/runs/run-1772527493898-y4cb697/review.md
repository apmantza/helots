# Aristomenis Review Report
Plan: Fix 4 UX issues: war record missing scout/peltast, aggregated stats don't auto-update, watch terminal fires on every helot_run, browser reopens on every MCP restart


## Task: Fix war record phase matching to be case-insensitive (Try 1)
**Ground Truth:**
src/dashboard/index.html: +0 lines (413 → 413)

**Peltast:**
VERDICT: PASS

## Task: Remove ensureWatchOpen() call from helot_run handler — watch terminal is replaced by browser dashboard (Try 1)
**Ground Truth:**
src/adapters/mcp-server.ts: -1 lines (418 → 417)
Syntax (tsc): ❌ ERRORS — 

**Peltast:**
VERDICT: FAIL — syntax error

## Task: Prevent browser from reopening on every MCP server restart (Try 3)
**Ground Truth:**
src/adapters/dashboard-server.ts: +5 lines (180 → 185)
Symbol check — "startDashboard" in src/adapters/dashboard-server.ts: ✅ FOUND
Syntax (tsc): ❌ ERRORS — 

**Peltast:**
VERDICT: FAIL — syntax error
