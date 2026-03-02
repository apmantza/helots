/**
 * Helots MCP Client — Antigravity LIVE EXECUTION Runner
 * 
 * Full pipeline: Slinger → Aristomenis → Builder → Peltast
 * Verifies all generated artifacts at the end.
 *
 * Run with: npx jiti mcp-client.ts
 */

import { spawn } from 'child_process';
import * as readline from 'readline';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SEP = '═'.repeat(70);
const STATE_DIR = '.helot-mcp-live';

function log(msg: string) { process.stderr.write(msg + '\n'); }

// ─── JSON-RPC helpers ──────────────────────────────────────────
let msgId = 1;
function req(method: string, params: any) {
    return JSON.stringify({ jsonrpc: '2.0', id: msgId++, method, params }) + '\n';
}
function notif(method: string, params: any) {
    return JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
}

async function main() {
    log(`\n${SEP}`);
    log(`🛡️  ANTIGRAVITY → HELOTS LIVE EXECUTION`);
    log(`   ${new Date().toISOString()}`);
    log(`   State: ${STATE_DIR}`);
    log(SEP);

    // ── Spawn MCP server ─────────────────────────────────────────
    const server = spawn('npx', ['jiti', 'src/adapters/mcp-server.ts'], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'inherit'],
        shell: true,
        env: { ...process.env, HELOT_STATE_DIR: STATE_DIR }
    });

    log(`\n[MCP] Server spawned (pid ${server.pid})`);

    const pending = new Map<number, (r: any) => void>();
    const rl = readline.createInterface({ input: server.stdout! });
    rl.on('line', line => {
        if (!line.trim()) return;
        try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && pending.has(msg.id)) {
                pending.get(msg.id)!(msg);
                pending.delete(msg.id);
            }
        } catch {
            log(`[Server] ${line}`);
        }
    });
    server.on('error', e => log(`[Server Error] ${e.message}`));

    function call(method: string, params: any): Promise<any> {
        return new Promise(resolve => {
            const id = msgId;
            pending.set(id, resolve);
            server.stdin!.write(req(method, params));
        });
    }

    await new Promise(r => setTimeout(r, 1000));

    // ── Initialize ────────────────────────────────────────────────
    log(`\n[MCP] Initializing...`);
    const init = await call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'antigravity', version: '1.0' }
    });
    log(`[MCP] Connected: ${JSON.stringify(init?.result?.serverInfo)}`);
    server.stdin!.write(notif('notifications/initialized', {}));

    // ── Phase 1: helot_slinger ────────────────────────────────────
    log(`\n${SEP}`);
    log(`[PHASE 1] 🏹 helot_slinger — reconnaissance`);
    log(SEP);

    const slingerRes = await call('tools/call', {
        name: 'helot_slinger',
        arguments: {
            researchTask: `Read src/core/engine.ts and return the EXACT current implementations of:
1. The pickName() private method (full code)
2. The getGlobalContext() private method (full code)
Return each method verbatim so the Builder can extract them accurately.`,
            targetFiles: ['src/core/engine.ts']
        }
    });

    const slingerText: string = slingerRes?.result?.content?.[0]?.text ?? slingerRes?.error?.message ?? '';
    log(`\n[Slinger Result — ${slingerText.length} chars]\n${slingerText.slice(0, 600)}...`);

    // ── Phase 2: helot_run LIVE ────────────────────────────────────
    log(`\n${SEP}`);
    log(`[PHASE 2] 🏛️  helot_run — LIVE (Builder + Peltast active)`);
    log(SEP);

    const helotRes = await call('tools/call', {
        name: 'helot_run',
        arguments: {
            taskSummary: 'Laconic refactoring: extract pickName and getGlobalContext from engine.ts',
            implementationPlan: `
Slinger has retrieved the exact implementations. Now execute the following:

SLINGER REPORT:
${slingerText.slice(0, 1200)}

TASKS:
- [ ] 1. Create src/core/persona.ts — export the pickName function extracted from engine.ts (Target: src/core/persona.ts, Symbol: pickName) [DEPENDS: none]
- [ ] 2. Update src/core/engine.ts — remove the private pickName method, add import from ./persona.js (Target: src/core/engine.ts, Symbol: pickName) [DEPENDS: 1]
- [ ] 3. Create src/core/context.ts — export the getGlobalContext function extracted from engine.ts (Target: src/core/context.ts, Symbol: getGlobalContext) [DEPENDS: none]
- [ ] 4. Update src/core/engine.ts — remove the private getGlobalContext method, add import from ./context.js (Target: src/core/engine.ts, Symbol: getGlobalContext) [DEPENDS: 3]

BUILDER NOTES:
- persona.ts must export: function pickName(runId: string, role: string): { name: string; city: string }
- context.ts must export: async function getGlobalContext(): Promise<string>
- engine.ts: replace this.pickName(...) with imported pickName(...)
- engine.ts: replace this.getGlobalContext() with imported getGlobalContext()
- Use Markdown block format: ### [path/to/file.ts] followed by a typescript code block`
        }
    });

    const helotText: string = helotRes?.result?.content?.[0]?.text ?? helotRes?.error?.message ?? 'No result';
    log(`\n${SEP}`);
    log(`[helot_run Result]\n${helotText.slice(0, 1000)}`);
    log(SEP);

    // ── Artifact Verification ─────────────────────────────────────
    log(`\n${SEP}`);
    log(`[VERIFY] Checking all generated artifacts...`);
    log(SEP);

    // State dir artifacts
    if (existsSync(STATE_DIR)) {
        log(`\n📁 ${STATE_DIR}/`);
        for (const f of readdirSync(STATE_DIR)) {
            const p = join(STATE_DIR, f);
            const size = statSync(p).size;
            log(`  ✅ ${f} (${size} bytes)`);
            if (f === 'progress.md') {
                log(`\n  [progress.md]\n${readFileSync(p, 'utf-8').split('\n').map(l => '  | ' + l).join('\n')}\n`);
            }
            if (f === 'trace.jsonl') {
                const lines = readFileSync(p, 'utf-8').trim().split('\n');
                log(`  [trace.jsonl — ${lines.length} entries]`);
                lines.forEach(l => log(`    ${l}`));
            }
            if (f === 'review.md') {
                log(`\n  [review.md]\n${readFileSync(p, 'utf-8').split('\n').map(l => '  | ' + l).join('\n')}\n`);
            }
        }
    } else {
        log(`  ❌ State dir ${STATE_DIR} not found!`);
    }

    // Extracted modules
    log(`\n📁 src/core/ — new modules:`);
    const newFiles = ['src/core/persona.ts', 'src/core/context.ts', 'src/core/file-utils.ts'];
    for (const f of newFiles) {
        if (existsSync(f)) {
            const size = readFileSync(f).length;
            log(`  ✅ ${f} (${size} bytes)`);
            log(`\n${readFileSync(f, 'utf-8').split('\n').map(l => '     | ' + l).join('\n')}\n`);
        } else {
            log(`  ❌ MISSING: ${f}`);
        }
    }

    log(`\n${SEP}`);
    log(`🏁  LIVE EXECUTION COMPLETE`);
    log(SEP);

    server.stdin!.end();
    setTimeout(() => { server.kill(); process.exit(0); }, 500);
}

main().catch(e => { log(`FATAL: ${e.message}\n${e.stack}`); process.exit(1); });
