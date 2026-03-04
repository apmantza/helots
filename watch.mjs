/**
 * Helots Live Watch — Interactive Terminal UI
 * Usage: node watch.mjs [stateDir]
 *
 * Keys:
 *   ↑ / ↓     Navigate task list
 *   Enter      Open selected task's file in VS Code
 *   p          Open progress.md (Aristomenis plan)
 *   r          Open review.md (Peltast verdicts)
 *   n          Open slinger-notes.md
 *   l          Open server.log
 *   s          Toggle full-screen stream view
 *   q / Ctrl+C Quit
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from 'fs';
import { join, resolve, basename } from 'path';
import { spawn } from 'child_process';

const stateDir = process.argv[2] || '.helot-mcp-connector';
const eventsFile = join(stateDir, 'events.jsonl');
const streamFile  = join(stateDir, 'stream.log');
const pidFile     = join(stateDir, 'watch.pid');
const POLL_MS = 150;

// Register presence so the MCP server won't spawn a duplicate
try { writeFileSync(pidFile, String(process.pid)); } catch {}

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const A = {
  bold:    s => `\x1b[1m${s}\x1b[0m`,
  dim:     s => `\x1b[2m${s}\x1b[0m`,
  green:   s => `\x1b[32m${s}\x1b[0m`,
  red:     s => `\x1b[31m${s}\x1b[0m`,
  yellow:  s => `\x1b[33m${s}\x1b[0m`,
  cyan:    s => `\x1b[36m${s}\x1b[0m`,
  magenta: s => `\x1b[35m${s}\x1b[0m`,
  white:   s => `\x1b[97m${s}\x1b[0m`,
  sel:     s => `\x1b[48;5;236m\x1b[97m${s}\x1b[0m`,   // selected row: dark bg + white fg
};
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*[mGKHJABCDsuhl]/g, '');
const vlen      = s => [...stripAnsi(s)].length;

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  runId:             '',
  model:             '',
  currentPhase:      'Waiting for run...',
  currentSubagent:   '',
  personas:          [],   // { name, phase, tps, genTokens, promptTokens, ctxPct, done }
  tasks:             [],   // { id, desc, file, status }
  startTime:         null,
  done:              false,
  totalGenTokens:    0,    // session-lifetime out tokens (gen)
  totalPromptTokens: 0,    // session-lifetime in tokens (prompt)
  lastTps:           0,
  projectRoot:       '',
};

let ui = {
  selectedIdx: 0,
  fullStream:  false,
};

let streamContent   = '';
let lastEventsMtime = 0;
let lastEventsSize  = 0;
let lastStreamMtime = 0;
let statusMsg       = '';
let statusTimer     = null;

// ── Open files ────────────────────────────────────────────────────────────────
function openInEditor(filePath) {
  if (!filePath) { flash('No file associated with this task'); return; }
  const abs = resolve(filePath);
  if (!existsSync(abs)) { flash(`Not found: ${filePath}`); return; }

  // Try VS Code first; fall back to OS default
  try {
    const c = spawn('code', [abs], { shell: true, detached: true, stdio: 'ignore' });
    c.unref();
    flash(`Opened in VS Code: ${basename(abs)}`);
  } catch {
    try {
      const cmd = process.platform === 'win32' ? 'start'
                : process.platform === 'darwin' ? 'open'
                : 'xdg-open';
      const c = spawn(cmd, process.platform === 'win32' ? ['', abs] : [abs], {
        shell: true, detached: true, stdio: 'ignore'
      });
      c.unref();
      flash(`Opened: ${basename(abs)}`);
    } catch (e) {
      flash(`Cannot open: ${e.message}`);
    }
  }
}

function openStateFile(name) {
  const p = join(stateDir, name);
  if (existsSync(p)) { openInEditor(p); return; }
  // slinger-notes lives in the target project, not stateDir
  if (name === 'slinger-notes.md' && state.projectRoot) {
    const alt = join(state.projectRoot, '.helots', 'slinger-notes.md');
    if (existsSync(alt)) { openInEditor(alt); return; }
  }
  flash(`${name} not found yet`);
}

function flash(msg) {
  statusMsg = msg;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusMsg = ''; render(); }, 3000);
}

// ── Event application ─────────────────────────────────────────────────────────
function applyEvent(ev) {
  switch (ev.type) {
    case 'run_start':
      state = {
        runId:             ev.runId || '',
        model:             (ev.model || '').split('/').pop() || ev.model || '',
        currentPhase:      'Starting',
        currentSubagent:   '',
        personas:          [],
        tasks:             [],
        startTime:         Date.now(),
        done:              false,
        // Carry over session tokens — slinger runs before helot_run count too
        totalGenTokens:    state.totalGenTokens    || 0,
        totalPromptTokens: state.totalPromptTokens || 0,
        lastTps:           0,
        projectRoot:       ev.projectRoot || '',
      };
      streamContent = '';
      ui.selectedIdx = 0;
      break;

    case 'task_list':
      state.tasks = (ev.tasks || []).map(t => ({ ...t, status: 'pending' }));
      ui.selectedIdx = Math.min(ui.selectedIdx, Math.max(0, state.tasks.length - 1));
      break;

    case 'task_status':
      patchTask(ev.taskId, { status: ev.status });
      break;

    case 'phase_change':
      state.currentPhase    = ev.phase || state.currentPhase;
      state.currentSubagent = ev.name  || '';
      // Add a "running" entry for this persona
      state.personas.push({ name: ev.name || '', phase: ev.phase || '', tps: 0, genTokens: 0, promptTokens: 0, ctxPct: 0, done: false });
      break;

    case 'subagent_done':
      state.lastTps          = ev.tps || 0;
      state.totalGenTokens    += (ev.genTokens    || 0);
      state.totalPromptTokens += (ev.promptTokens || 0);
      // Mark the last matching running persona as done with full metrics
      for (let i = state.personas.length - 1; i >= 0; i--) {
        if (state.personas[i].name === ev.name && !state.personas[i].done) {
          state.personas[i] = {
            ...state.personas[i],
            tps:          ev.tps          || 0,
            genTokens:    ev.genTokens    || 0,
            promptTokens: ev.promptTokens || 0,
            ctxPct:       ev.ctxPct       || 0,
            done:         true,
          };
          break;
        }
      }
      break;

    case 'verdict':
      patchTask(ev.taskId, { status: ev.result === 'PASS' ? 'passed' : 'failed' });
      // Auto-advance cursor to the next running/pending task
      const next = state.tasks.findIndex(t => t.status === 'running' || t.status === 'pending');
      if (next >= 0) ui.selectedIdx = next;
      break;

    case 'run_end':
      state.phase = 'Done';
      state.done  = true;
      break;
  }
}

function patchTask(taskId, patch) {
  const t = state.tasks.find(t => t.id === taskId);
  if (t) Object.assign(t, patch);
}

// ── Polling ───────────────────────────────────────────────────────────────────
function pollEvents() {
  if (!existsSync(eventsFile)) return false;
  try {
    const st = statSync(eventsFile);
    if (st.mtimeMs === lastEventsMtime && st.size === lastEventsSize) return false;
    lastEventsMtime = st.mtimeMs;
    lastEventsSize  = st.size;
    for (const line of readFileSync(eventsFile, 'utf-8').trim().split('\n').filter(Boolean)) {
      try { applyEvent(JSON.parse(line)); } catch {}
    }
    return true;
  } catch { return false; }
}

function pollStream() {
  if (!existsSync(streamFile)) return false;
  try {
    const st = statSync(streamFile);
    if (st.mtimeMs === lastStreamMtime) return false;
    lastStreamMtime = st.mtimeMs;
    streamContent   = readFileSync(streamFile, 'utf-8');
    return true;
  } catch { return false; }
}

// ── Rendering helpers ─────────────────────────────────────────────────────────
function pad(content, width) {
  return content + ' '.repeat(Math.max(0, width - vlen(content)));
}
function row(content, w) {
  return A.cyan('║') + pad(' ' + content, w - 2) + A.cyan('║');
}
function div(w) {
  return A.cyan('╠' + '═'.repeat(w - 2) + '╣');
}
function taskIcon(status) {
  return status === 'passed'  ? A.green('✅')
       : status === 'failed'  ? A.red('❌')
       : status === 'running' ? A.yellow('🔄')
       : status === 'blocked' ? A.dim('🚫')
       : A.dim('⏳');
}

// ── Main render ───────────────────────────────────────────────────────────────
function render() {
  const w = Math.min(process.stdout.columns || 100, 130);
  const lines = ui.fullStream ? renderStream(w) : renderMain(w);
  process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n') + '\n');
}

function renderMain(w) {
  const lines = [];

  // ── Header: run info + live metrics ────────────────────────────────────────
  const elapsed = state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0;
  const fmtK = n => n > 999 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const tokStr = (state.totalGenTokens + state.totalPromptTokens) > 0
    ? `in:${fmtK(state.totalPromptTokens)}  out:${fmtK(state.totalGenTokens)}`
    : '';
  const parts = [
    state.model,
    elapsed > 0 ? `${Math.floor(elapsed / 60)}m${String(elapsed % 60).padStart(2, '0')}s` : '',
    tokStr,
  ].filter(Boolean);
  const right = A.dim(parts.join(' · '));
  const left  = A.bold(A.cyan(`HELOTS${state.runId ? ` [${state.runId}]` : ''}`));
  const gap   = Math.max(1, w - 4 - vlen(left) - vlen(right));

  lines.push(A.cyan('╔' + '═'.repeat(w - 2) + '╗'));
  lines.push(row(left + ' '.repeat(gap) + right, w));

  // ── Agents (persisted persona list) ────────────────────────────────────────
  const running = state.personas.slice().reverse().find(p => !p.done);
  const agentHdr = A.bold('Agents')
    + (running   ? A.yellow(` · ⚡ ${running.name} running...`)
     : state.done ? A.green(' · run complete')
     : A.dim(' · idle'));
  lines.push(div(w));
  lines.push(row(agentHdr, w));

  if (state.personas.length === 0) {
    lines.push(row(A.dim('Waiting for first agent...'), w));
  } else {
    // Show last 6 personas (enough to see full run without overwhelming)
    for (const p of state.personas.slice(-6)) {
      const icon   = p.done ? A.green('✅') : A.yellow('⚡');
      const genStr = p.genTokens    > 999 ? `${(p.genTokens    / 1000).toFixed(1)}k` : String(p.genTokens    || '–');
      const prmStr = p.promptTokens > 999 ? `${(p.promptTokens / 1000).toFixed(1)}k` : String(p.promptTokens || '–');
      const tpsStr = p.tps   > 0    ? `${p.tps.toFixed(1)} t/s`  : '';
      const ctxStr = p.ctxPct > 0   ? `ctx:${p.ctxPct}%`         : '';
      const stats  = [
        p.done ? `${genStr} out + ${prmStr} in` : '',
        tpsStr,
        ctxStr,
      ].filter(Boolean).join('  ');
      lines.push(row(
        `${icon} ${A.bold(p.name.padEnd(14))} ${A.dim(`[${p.phase}]`).padEnd(20)}  ${A.dim(stats)}`,
        w
      ));
    }
  }

  // ── Task list ───────────────────────────────────────────────────────────────
  lines.push(div(w));
  const hint = A.dim('↑↓ navigate  Enter open file  p plan  r review  n slinger  l log  s stream  q quit');
  lines.push(row(A.bold('Tasks') + '  ' + hint, w));

  if (state.tasks.length === 0) {
    lines.push(row(A.dim('Waiting for tasks...'), w));
  } else {
    for (let i = 0; i < state.tasks.length; i++) {
      const t        = state.tasks[i];
      const selected = i === ui.selectedIdx;
      const cursor   = selected ? A.yellow('▶') : ' ';
      const icon     = taskIcon(t.status);
      const fileTag  = t.file ? A.dim(` [${basename(t.file)}]`) : '';
      const label    = `${icon} ${t.id}. ${t.desc}`;
      const maxLabel = w - 8 - vlen(fileTag);
      const clipped  = vlen(label) > maxLabel ? label.slice(0, maxLabel - 1) + '…' : label;
      const content  = `${cursor} ${clipped}${fileTag}`;

      if (selected) {
        // Dark highlight for selected row — compute exact inner width
        const inner = ' ' + stripAnsi(content) + ' '.repeat(Math.max(0, w - 4 - vlen(content)));
        lines.push(A.cyan('║') + A.sel(inner) + A.cyan('║'));
      } else {
        lines.push(row(content, w));
      }
    }
  }

  // ── Footer ──────────────────────────────────────────────────────────────────
  lines.push(A.cyan('╚' + '═'.repeat(w - 2) + '╝'));
  lines.push(statusMsg ? A.yellow(` ${statusMsg}`) : A.dim(` stateDir: ${stateDir}`));

  return lines;
}

function renderStream(w) {
  const h     = process.stdout.rows || 30;
  const lines = [];

  lines.push(A.cyan('╔' + '═'.repeat(w - 2) + '╗'));
  lines.push(row(A.bold('Stream — full screen') + A.dim('  s → back  q quit'), w));
  lines.push(div(w));

  const slines = streamContent
    .split('\n')
    .filter(l => l.trim())
    .slice(-(h - 6));

  for (const l of slines) {
    lines.push(row(A.dim(l.slice(0, w - 4)), w));
  }
  // Fill remaining height
  for (let i = slines.length; i < h - 6; i++) {
    lines.push(row('', w));
  }

  lines.push(A.cyan('╚' + '═'.repeat(w - 2) + '╝'));
  lines.push(statusMsg ? A.yellow(` ${statusMsg}`) : '');

  return lines;
}

// ── Keyboard input ────────────────────────────────────────────────────────────
function setupInput() {
  if (!process.stdin.isTTY) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  process.stdin.on('data', key => {
    // Always handle quit
    if (key === '\x03' || key === 'q') { cleanup(); process.exit(0); }

    // Full-stream mode: only exit key works
    if (ui.fullStream) {
      if (key === 's' || key === '\x1b') { ui.fullStream = false; render(); }
      return;
    }

    switch (key) {
      case '\x1b[A': // Up
        if (state.tasks.length > 0)
          ui.selectedIdx = Math.max(0, ui.selectedIdx - 1);
        render(); break;

      case '\x1b[B': // Down
        if (state.tasks.length > 0)
          ui.selectedIdx = Math.min(state.tasks.length - 1, ui.selectedIdx + 1);
        render(); break;

      case '\r':
      case '\n': { // Enter — open selected task's file
        const t = state.tasks[ui.selectedIdx];
        if (t) openInEditor(t.file ? resolve(t.file) : null);
        render(); break;
      }

      case 's': ui.fullStream = true;          render(); break;
      case 'p': openStateFile('progress.md');   render(); break;
      case 'r': openStateFile('review.md');     render(); break;
      case 'n': openStateFile('slinger-notes.md'); render(); break;
      case 'l': openStateFile('server.log');    render(); break;
    }
  });
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
function cleanup() {
  try { unlinkSync(pidFile); } catch {}    // deregister so MCP server can spawn again if needed
  process.stdout.write('\x1b[?25h\x1b[0m\n'); // restore cursor + reset colours
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  } catch {}
}

// ── Boot ──────────────────────────────────────────────────────────────────────
process.stdout.write('\x1b[?25l'); // hide cursor while running
render();
setupInput();

setInterval(() => {
  const a = pollEvents();
  const b = pollStream();
  if (a || b) render();
}, POLL_MS);

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);
