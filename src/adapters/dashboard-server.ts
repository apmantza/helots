import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { SpartaRecordManager } from '../core/sparta-record.js';
import { HelotEngine } from '../core/engine.js';

const DASHBOARD_HTML = path.resolve(__dirname, '../../src/dashboard/index.html');

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

function serveSSE(
  res: http.ServerResponse,
  logFile: string,
  intervalMs = 200
): () => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  let offset = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;

  const ping = setInterval(() => {
    try { res.write(':ping\n\n'); } catch {}
  }, 15000);

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
    for (const line of lines) {
      try { res.write(`data: ${line}\n\n`); } catch {}
    }
  }, intervalMs);

  return () => {
    clearInterval(ping);
    clearInterval(poll);
  };
}

export function startDashboard(
  engine: HelotEngine,
  stateDir: string,
  port = 7771
): void {
  const spartaRecord = new SpartaRecordManager(stateDir);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');

    if (pathname === '/') {
      fs.readFile(DASHBOARD_HTML, 'utf-8', (err, data) => {
        if (err) { res.writeHead(500); res.end('Error'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      });
    } else if (pathname === '/api/stats') {
      const record = spartaRecord.getRecord();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(record));
    } else if (pathname === '/api/frontier') {
      const estimate = readFrontierEstimate();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ estimate }));
    } else if (pathname === '/api/logs') {
      const logFile = path.join(stateDir, 'helot-engine.log');
      const cleanup = serveSSE(res, logFile);
      req.on('close', cleanup);
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(port, () => {
    console.log(`Dashboard listening on port ${port}`);
  });
}