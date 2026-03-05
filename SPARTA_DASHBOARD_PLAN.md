# Helots Sparta Dashboard — Implementation Plan

## Context
Replace the terminal-based watch.mjs with a web dashboard that auto-launches alongside the MCP server.
Goals: live run monitoring, token stats (local + frontier estimate), persistent Civ6/Gorgo gamification
(war record across sessions), MD file viewer, and action triggers (run/slinger/hoplite from the UI).

---

## Architecture

**3 new files + 2 modified:**

| File | Action | Purpose |
|------|--------|---------|
| `src/adapters/dashboard-server.ts` | CREATE | HTTP + SSE + REST server on port 7771 |
| `src/dashboard/index.html` | CREATE | Single-page vanilla JS + Tailwind CDN dashboard |
| `src/core/sparta-record.ts` | CREATE | Persistent war record (JSON file in stateDir) |
| `src/adapters/mcp-server.ts` | EDIT | Import + start dashboard server on MCP launch |
| `~/.claude/hooks/helots-delegate.py` | EDIT | Add frontier tool-call counter |

---

## Data Sources (already available)

- **Events:** `stateDir/events.jsonl` — 7 event types with token metrics
- **Stream:** `stateDir/stream.log` — live builder token output
- **Runs:** `stateDir/runs/run-<id>/` — progress.md, review.md, trace.jsonl per run
- **psiloiMetrics:** `{ scout, builder, peltast }` each `{ in, out, tps }` — per-role token breakdown
- **War record:** `stateDir/sparta-record.json` (new, persisted)
- **Frontier estimate:** `~/.claude/helots-frontier-calls.json` (new, written by hook)

**Event types consumed by dashboard:**
```
run_start      → { runId, model, projectRoot }
task_list      → { tasks: [{id, desc, file, status}] }
task_status    → { taskId, status }
phase_change   → { phase, name }
subagent_done  → { phase, name, tps, genTokens, promptTokens, ctxPct }
verdict        → { taskId, result: PASS|FAIL, tryNum, reason }
run_end        → { passed, failed }
```

---

## File 1: `src/core/sparta-record.ts`

```typescript
interface SpartaRecord {
  totalBattles: number;       // total run_end events
  victories: number;          // run_end where failed === 0
  defeats: number;            // run_end where passed === 0 or escalation
  wondersBuilt: number;       // triggered on 5+ consecutive victories
  citiesLost: number;         // triggered on 3+ consecutive defeats
  currentStreak: number;      // positive = win streak, negative = loss streak
  greatGenerals: number;      // runs where all tasks passed on first try
  lastUpdated: string;        // ISO timestamp
}
```

**Methods:**
- `load(stateDir)` → reads/creates sparta-record.json
- `recordRunEnd(passed, failed, allFirstTry)` → updates record, returns triggered events
- `save()` → writes JSON file

**Triggered events returned by recordRunEnd:**
- `"BATTLE_WON"` — passed > 0 and failed === 0
- `"BATTLE_LOST"` — passed === 0
- `"WONDER_BUILT"` — currentStreak reaches 5
- `"CITY_LOST"` — loss streak reaches 3
- `"GREAT_GENERAL"` — allFirstTry === true

---

## File 2: `src/adapters/dashboard-server.ts`

**HTTP server (Node `http` module, no express needed):**

```
GET  /                          → serve index.html
GET  /events                    → SSE: tail events.jsonl from current position
GET  /api/stream                → SSE: tail stream.log from current position
GET  /api/stats                 → { localTokens, frontierEstimate, record, currentRun }
GET  /api/runs                  → list stateDir/runs/* sorted by mtime
GET  /api/file?path=X           → read .md file content (whitelist: .md only)
POST /api/run                   → call engine.executeHelots(...)
POST /api/slinger               → call engine.executeSlinger(...)
POST /api/hoplite               → call engine.executeHoplite(...)
```

**SSE implementation:**
- Clients connect to `/events`, server sends `data: <json>\n\n`
- Server polls `events.jsonl` every 200ms, tracks byte offset, sends only new lines
- Same for `/api/stream` with `stream.log`
- Keep-alive ping every 15s to prevent connection drops

**Frontier estimate:**
- Read `~/.claude/helots-frontier-calls.json` → `{ toolCalls: N }`
- Estimate: `N × 500` tokens (conservative avg per tool call)
- Display as `~Xk frontier (est.)`

**Auto-open browser on start (Windows):**
```typescript
import { exec } from 'child_process';
exec(`start http://localhost:7771`);
```

---

## File 3: `src/dashboard/index.html`

**Single file, no build step. Tailwind CDN + vanilla JS.**

**Layout:**
```
┌──────────────────────────────────────────────────────────────────┐
│  [Spartan helm icon]  GORGO OF SPARTA  [model] [project]        │
│  Local: in:Xk out:Yk  |  Frontier: ~Zk (est.)  |  TPS: N.N    │
│  ⚔️  Victories: N  🏛️  Wonders: N  🗡️  Defeats: N  streak: ±N  │
├────────────────────────────┬─────────────────────────────────────┤
│  LIVE FEED                 │  WAR RECORD / EVENTS               │
│  Phase: [current phase]    │  [Civ6-style toast notifications]  │
│  ─ task 1 ✅               │  "SPARTA WINS A BATTLE"            │
│  ─ task 2 🔄               │  "A WONDER IS BUILT"               │
│  ─ task 3 ⏳               │                                     │
│  [live token stream]       │                                     │
├────────────────────────────┼─────────────────────────────────────┤
│  RUN HISTORY               │  ACTIONS                           │
│  run-abc123  5✅ 0❌  12s  │  [▶ RUN]  task summary + plan     │
│  run-def456  3✅ 1❌  8s   │  [🔍 SLINGER]  research task      │
│  > click → opens MD        │  [✏️ HOPLITE]  file + instruction  │
└────────────────────────────┴─────────────────────────────────────┘
```

**Civ6-style event overlay (bottom-right toast):**
```
┌─────────────────────────────────────┐
│  ⚔️  SPARTA WINS A BATTLE            │
│  The Phalanx holds the line!        │
│  5 tasks completed, 0 failed        │
└─────────────────────────────────────┘
```

**Event-to-notification mapping:**
| Engine event | Civ6 notification | Gorgo flavour |
|---|---|---|
| `run_end` all pass | ⚔️ BATTLE WON | "The phalanx holds the line!" |
| `run_end` all fail | 💀 BATTLE LOST | "Sparta mourns her fallen." |
| `run_end` partial | ⚔️ PYRRHIC VICTORY | "Victory, but at a cost." |
| 5-win streak | 🏛️ WONDER BUILT | "With your shield or on it." |
| 3-loss streak | 🏚️ CITY LOST | "Athens advances on Sparta." |
| all first-try | 🦅 GREAT GENERAL | "A general worthy of Sparta." |
| `run_start` | 📯 NEW CAMPAIGN | "Sparta marches to war." |

**JS architecture:**
- `EventSource('/events')` → applies events to DOM state
- `EventSource('/api/stream')` → appends to stream panel
- `fetch('/api/stats')` on load + after each `run_end`
- `fetch('/api/runs')` on load → populate run history
- Click on run → `fetch('/api/file?path=...')` → modal MD viewer (marked.js CDN)

---

## File 4: `src/adapters/mcp-server.ts` (EDIT)

Add import at top:
```typescript
import { startDashboard } from './dashboard-server.js';
```

Add after line 40 (`const engine = new HelotEngine(config);`):
```typescript
startDashboard(engine, config.stateDir, 7771);
```

---

## File 5: `~/.claude/hooks/helots-delegate.py` (EDIT)

Add frontier tool-call counter at the end of the script (always fires, regardless of reminder):
```python
# Always increment frontier tool-call counter
import pathlib, json as _json
_counter_path = pathlib.Path.home() / '.claude' / 'helots-frontier-calls.json'
try:
    _data = _json.loads(_counter_path.read_text()) if _counter_path.exists() else {}
    _data['toolCalls'] = _data.get('toolCalls', 0) + 1
    _counter_path.write_text(_json.dumps(_data))
except Exception:
    pass
```

---

## Implementation Order

```
Task 1: CREATE src/core/sparta-record.ts          (no deps)
Task 2: CREATE src/adapters/dashboard-server.ts   (depends on Task 1)
Task 3: CREATE src/dashboard/index.html           (depends on Task 2)
Task 4: EDIT   src/adapters/mcp-server.ts         (depends on Task 2)
Task 5: EDIT   ~/.claude/hooks/helots-delegate.py (independent)
```

**Method per task:**
- Tasks 1–4: direct Write/Edit (TypeScript + HTML code files)
- Task 5: helot_hoplite (Python hook script)

---

## Verification

1. `npm run mcp` → console shows "Dashboard running at http://localhost:7771"
2. Browser auto-opens to dashboard
3. Trigger a `helot_run` → live feed updates in real time via SSE
4. `run_end` → Civ6 toast appears, war record updates in `sparta-record.json`
5. Click past run → MD viewer opens `review.md`
6. Frontier estimate increments as Claude tool calls happen

---

## Implementation Log

### Changes made beyond original plan

**grep-utils.ts**
- Normalized `\|` → `|` before `new RegExp()` to fix BRE alternation silent failure
- `(no matches)` now reports searched path + pattern with normalization hint

**mcp-server.ts**  
- Added HTML to `helot_hoplite` tool description (was markdown/config only)

**engine.ts**
- Set `this.currentPhase = 'Slinger'` before slinger loop in `executeSlinger`
- Set `this.currentPhase = 'Hoplite'` before `runSubagent` in `executeHoplite`
- Without these, all slinger/hoplite `subagent_done` events had `phase: "Setup"` → broke aggregated stats

**dashboard/index.html**
- War record is now session-only (removed `loadHistory()`)
- Added AGGREGATED STATS panel: per-role counts, total tokens, avg TPS, reads from `events.jsonl` via `/api/events-history`
- Aggregated stats refresh every 15s and on each `subagent_done` event

### Naming fixes (engine.ts)
- Slingers: `pickName(Date.now().toString(), "Slinger")` — timestamp seed so each slinger gets a unique name instead of always "Agesilaus"
- Hoplites: Added `pickName(Date.now().toString(), 'Hoplite')` call and pass persona name to `runSubagent` — previously hardcoded the string 'Hoplite' as the name
- `subagent_done` writeEvent now includes `role` field alongside `phase` and `name`

### War record display (index.html)
- Updated `addWarRecord()` to show `[HELOT TYPE] [HELOT NAME]` format with colour-coded type labels (⚙️ Builder, 🛡️ Peltast, 🔍 Slinger, ✏️ Hoplite, 👁️ Scout)
- Uses both `ev.role` and `ev.phase` for robust type detection

### Known limitation
`events.jsonl` is cleared on every `executeHelots` run, so standalone slinger/hoplite events are lost when a build run starts. Aggregated stats only reflect the current `events.jsonl` content.