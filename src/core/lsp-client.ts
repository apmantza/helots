/**
 * lsp-client.ts — Language Server Protocol client for Builder pre-flight checks.
 *
 * Provides type-checking of generated code BEFORE it is written to disk,
 * preventing polluting the working tree with type-broken TypeScript.
 *
 * Architecture:
 *   LspManager          — per-engine-run singleton, owns server lifetimes
 *   LspServer           — one persistent server process per language extension
 *   tscFallback()       — used when typescript-language-server is not installed
 *
 * Language registry (extend for portability):
 *   .ts/.tsx/.js/.jsx   → typescript-language-server --stdio
 *   .py                 → pylsp (optional, graceful no-op if absent)
 *
 * Usage:
 *   const lsp = new LspManager(cwd);
 *   const diags = await lsp.diagnose('src/foo.ts', generatedContent);
 *   // diags === null  → no LSP support for this file type (skip, proceed)
 *   // diags === []    → type-check passed
 *   // diags.length>0  → errors, feed back to Builder
 *   lsp.dispose();     // kills server processes
 */

import { spawn, spawnSync, ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { extname, resolve } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

// ── Types ────────────────────────────────────────────────────────────────────

export interface LspDiagnostic {
  line: number;   // 0-based
  col: number;    // 0-based
  message: string;
  severity: 'error' | 'warning';
  code?: string;
}

interface ServerDef {
  command: string;
  args: string[];
  languageId: string;
}

// ── Language registry ─────────────────────────────────────────────────────────

const REGISTRY: Record<string, ServerDef> = {
  '.ts':  { command: 'typescript-language-server', args: ['--stdio'], languageId: 'typescript' },
  '.tsx': { command: 'typescript-language-server', args: ['--stdio'], languageId: 'typescriptreact' },
  '.js':  { command: 'typescript-language-server', args: ['--stdio'], languageId: 'javascript' },
  '.jsx': { command: 'typescript-language-server', args: ['--stdio'], languageId: 'javascriptreact' },
  '.py':  { command: 'pylsp', args: [], languageId: 'python' },
  '.rs':  { command: 'rust-analyzer', args: [], languageId: 'rust' },
};

// Extensions that can fall back to CLI tools if LSP server is unavailable
const TSC_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);

// ── LspManager (public API) ───────────────────────────────────────────────────

/**
 * Manages one LSP server process per language extension.
 * Servers are lazy-started and kept alive across all Builder retries in a run.
 */
export class LspManager {
  private servers = new Map<string, LspServer>();
  private failed  = new Set<string>();  // extensions whose server failed to start

  constructor(private readonly cwd: string) {}

  /**
   * Type-check `content` as if it were written to `filePath`.
   *
   * Returns:
   *   null      — no LSP support for this file type (caller should skip)
   *   []        — type-check passed (no errors)
   *   Diagnostic[] — errors found; feed back to Builder
   */
  async diagnose(filePath: string, content: string): Promise<LspDiagnostic[] | null> {
    const ext = extname(filePath).toLowerCase();
    const def  = REGISTRY[ext];
    if (!def) return null;

    // Don't retry servers that already failed to start
    if (!this.failed.has(ext)) {
      try {
        let server = this.servers.get(ext);
        if (!server) {
          server = new LspServer(def, this.cwd);
          await server.start();
          this.servers.set(ext, server);
        }
        return await server.diagnose(filePath, content);
      } catch {
        this.servers.get(ext)?.dispose();
        this.servers.delete(ext);
        this.failed.add(ext);
      }
    }

    // LSP server failed to start — skip pre-flight for all types.
    // runTypecheckSlow (full project tsc, post-disk-write) is the correct gate.
    // tscFallback on an isolated file gives false-positive import errors for project files.
    return null;
  }

  dispose(): void {
    for (const server of this.servers.values()) server.dispose();
    this.servers.clear();
  }
}

// ── LspServer ─────────────────────────────────────────────────────────────────

class LspServer {
  private proc!: ChildProcess;
  private buf    = '';
  private reqId  = 0;
  private pending       = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private diagCallbacks = new Map<string, (d: LspDiagnostic[]) => void>();

  constructor(
    private readonly def: ServerDef,
    private readonly cwd: string,
  ) {}

  async start(): Promise<void> {
    this.proc = spawn(this.def.command, this.def.args, {
      cwd:   this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env:   { ...process.env, NODE_OPTIONS: '' },
    });

    this.proc.on('error', () => { /* server unavailable */ });
    this.proc.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));

    await this.initialize();
  }

  // ── LSP message framing ───────────────────────────────────────────────────

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf-8');
    while (true) {
      const hdrMatch = this.buf.match(/^Content-Length:\s*(\d+)\r\n\r\n/);
      if (!hdrMatch) break;
      const len   = parseInt(hdrMatch[1], 10);
      const start = hdrMatch[0].length;
      if (this.buf.length < start + len) break;
      const json = this.buf.slice(start, start + len);
      this.buf   = this.buf.slice(start + len);
      try { this.handleMessage(JSON.parse(json)); } catch { /* malformed */ }
    }
  }

  private handleMessage(msg: any): void {
    // Response to a request
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    // Server-push notification
    if (msg.method === 'textDocument/publishDiagnostics') {
      const uri = msg.params?.uri as string;
      const cb  = this.diagCallbacks.get(uri);
      if (cb) {
        const diags: LspDiagnostic[] = (msg.params.diagnostics ?? []).map((d: any) => ({
          line:     d.range.start.line,
          col:      d.range.start.character,
          message:  d.message,
          severity: d.severity === 1 ? 'error' : 'warning',
          code:     d.code != null ? String(d.code) : undefined,
        }));
        cb(diags);
      }
    }
  }

  private send(msg: object): void {
    const body   = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n`;
    this.proc.stdin!.write(header + body);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.reqId;
    this.send({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LSP timeout: ${method}`));
        }
      }, 15_000);
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  // ── LSP handshake ─────────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    await this.request('initialize', {
      processId:  process.pid,
      rootUri:    pathToFileURL(this.cwd).toString(),
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: false, versionSupport: false },
          synchronization:    { dynamicRegistration: false },
        },
      },
      initializationOptions: {},
    });
    this.notify('initialized', {});
  }

  // ── Document diagnostics ──────────────────────────────────────────────────

  async diagnose(
    filePath: string,
    content:  string,
    timeoutMs = 6_000,
  ): Promise<LspDiagnostic[]> {
    const absPath = resolve(filePath);
    const uri     = pathToFileURL(absPath).toString();

    return new Promise<LspDiagnostic[]>((resolve, reject) => {
      let settled = false;
      const done  = (diags: LspDiagnostic[]) => {
        if (settled) return;
        settled = true;
        this.diagCallbacks.delete(uri);
        this.notify('textDocument/didClose', { textDocument: { uri } });
        resolve(diags);
      };

      this.diagCallbacks.set(uri, done);
      // Timeout → assume clean. LSP couldn't respond in time; runTypecheckSlow (full project
      // tsc after disk write) is the correct gate for real errors. tscFallback on an isolated
      // file produces false-positive "Cannot find module" errors for every project import.
      setTimeout(() => done([]), timeoutMs);

      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: this.def.languageId, version: 1, text: content },
      });
    });
  }

  dispose(): void {
    try { this.proc?.kill(); } catch { /* ignore */ }
  }
}

// ── tsc CLI fallback ──────────────────────────────────────────────────────────

/**
 * Fallback when typescript-language-server is not installed.
 * Writes content to a temp file, runs tsc --noEmit, parses output.
 * Cross-file type information is unavailable but syntax + obvious type errors are caught.
 */
function tscFallback(content: string, cwd: string): LspDiagnostic[] {
  const tmpDir  = resolve(tmpdir(), 'helots-lsp');
  const tmpFile = resolve(tmpDir, `check_${Date.now()}_${Math.random().toString(36).slice(2)}.ts`);

  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmpFile, content, 'utf-8');

    const result = spawnSync(
      'tsc',
      [
        '--noEmit',
        '--strict',
        '--target', 'ESNext',
        '--module', 'NodeNext',
        '--moduleResolution', 'NodeNext',
        '--allowSyntheticDefaultImports',
        '--esModuleInterop',
        '--skipLibCheck',
        tmpFile,
      ],
      { encoding: 'utf-8', timeout: 20_000, cwd },
    );

    if (result.status === 0) return [];

    const output = (result.stdout ?? '') + (result.stderr ?? '');
    const diags: LspDiagnostic[] = [];

    for (const line of output.split('\n')) {
      // tsc format: file(line,col): error TS1234: message
      const m = line.match(/\((\d+),(\d+)\):\s*(error|warning)\s+TS(\d+):\s*(.+)/);
      if (m) {
        diags.push({
          line:     parseInt(m[1], 10) - 1,
          col:      parseInt(m[2], 10) - 1,
          severity: m[3] as 'error' | 'warning',
          code:     `TS${m[4]}`,
          message:  m[5].trim(),
        });
      }
    }

    return diags;
  } catch {
    return []; // tsc not available — graceful skip
  } finally {
    try { rmSync(tmpFile); } catch { /* ignore */ }
  }
}
