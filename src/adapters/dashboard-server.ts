import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { SpartaRecordManager } from '../core/sparta-record.js';
import { HelotEngine } from '../core/engine.js';

function readFrontierEstimate(): number {
  try {
    const p = path.join(os.homedir(), '.claude', 'helots-frontier-calls.json');
    if (!fs.existsSync(p)) return 0;
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return (data.toolCalls || 0) * 500;
  } catch {
    return 0;
  }
}

function serveSSE(res: http.ServerResponse, logFile: string, intervalMs = 200): () => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  let offset = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  const ping = setInterval(() => { try { res.write(':ping\n\n'); } catch {} }, 15000);
  const poll = setInterval(() => {
    if (!fs.existsSync(logFile)) return;
    const size = fs.statSync(logFile).size;
    if (size <= offset) return;
    const buf = Buffer.alloc(size - offset);
    const fd = fs.openSync(logFile, 'r');
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    const lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
    for (const line of lines) { try { res.write(`data: ${line}\n\n`); } catch {} }
  }, intervalMs);
  return () => { clearInterval(ping); clearInterval(poll); };
}

export function startDashboard(engine: HelotEngine, stateDir: string, port = 7771): void {
  const spartaRecord = new SpartaRecordManager(stateDir);
  const htmlPath = path.resolve(process.cwd(), 'src', 'dashboard', 'index.html');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const pathname = url.pathname;
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && pathname === '/') {
      if (fs.existsSync(htmlPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fs.readFileSync(htmlPath));
      } else {
        res.writeHead(404);
        res.end('Dashboard HTML not found: ' + htmlPath);
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/events') {
      const eventsFile = path.join(stateDir, 'events.jsonl');
      const cleanup = serveSSE(res, eventsFile);
      req.on('close', cleanup);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/stream') {
      const streamFile = path.join(stateDir, 'stream.log');
      const cleanup = serveSSE(res, streamFile);
      req.on('close', cleanup);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/stats') {
      const record = spartaRecord.getRecord();
      const frontierEstimate = readFrontierEstimate();
      let localTokens = { in: 0, out: 0, tps: 0 };
      let currentRun: any = null;
      try {
        const eventsFile = path.join(stateDir, 'events.jsonl');
        if (fs.existsSync(eventsFile)) {
          const lines = fs.readFileSync(eventsFile, 'utf-8').split('\n').filter(l => l.trim());
          for (const line of lines) {
            try {
              const ev = JSON.parse(line);
              if (ev.type === 'run_start') currentRun = ev;
              if (ev.type === 'subagent_done' && ev.psiloiMetrics) {
                const m = ev.psiloiMetrics;
                let totalIn = 0, totalOut = 0, totalTps = 0, count = 0;
                for (const r of ['scout','builder','peltast','aristomenis','slinger'] as const) {
                  if ((m as any)[r]) { totalIn += (m as any)[r].in || 0; totalOut += (m as any)[r].out || 0; totalTps += (m as any)[r].tps || 0; count++; }
                }
                localTokens = { in: totalIn, out: totalOut, tps: count > 0 ? totalTps / count : 0 };
              }
            } catch {}
          }
        }
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ localTokens, frontierEstimate, record, currentRun }));
      return;
    }

    // TODO: /api/runs
    // TODO: /api/file
    // TODO: POST /api/run, /api/slinger, /api/hoplite

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, () => {
    process.stderr.write(`[dashboard] Running at http://localhost:${port}\n`);
    if (process.platform === 'win32') exec(`start http://localhost:${port}`);
    else if (process.platform === 'darwin') exec(`open http://localhost:${port}`);
  });
}
