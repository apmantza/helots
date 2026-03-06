/**
 * Antigravity MCP Connector for Helots
 *
 * This provides a bridge for Antigravity to quickly spawn the Helots server,
 * inject surgical exact context into tasks (bypassing Slinger/Scout),
 * and run live executions deterministically.
 */

import { spawn } from 'child_process';
import * as readline from 'readline';
import { existsSync, readFileSync, readdirSync, statSync, appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const LOG_FILE = 'helot-verification.txt';
// Clear previous log
writeFileSync(LOG_FILE, '');

const SEP = '='.repeat(70);
const STATE_DIR = '.helot-mcp-connector';

function log(msg: string) {
    const clean = msg.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
    process.stderr.write(msg + '\n');
    appendFileSync(LOG_FILE, clean + '\n');
}

// ─── JSON-RPC helpers ──────────────────────────────────────────
let msgId = 1;
function req(method: string, params: any) {
    return JSON.stringify({ jsonrpc: '2.0', id: msgId++, method, params }) + '\n';
}
function notif(method: string, params: any) {
    return JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
}

function extractMethod(content: string, methodPattern: RegExp): string {
    const match = methodPattern.exec(content);
    if (!match) return `// Method not found in source \n`;
    const startIndex = match.index;
    let openBraces = 0;
    let inString = false;
    let stringChar = '';
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = startIndex; i < content.length; i++) {
        const char = content[i];
        const nextChar = content[i + 1] || '';

        // Handle string literals and comments
        if (!inString && !inLineComment && !inBlockComment) {
            if (char === '"' || char === "'" || char === '\`') {
                inString = true;
                stringChar = char;
            } else if (char === '/' && nextChar === '/') {
                inLineComment = true;
            } else if (char === '/' && nextChar === '*') {
                inBlockComment = true;
            } else if (char === '{') {
                openBraces++;
            } else if (char === '}') {
                openBraces--;
                if (openBraces === 0) {
                    return content.substring(startIndex, i + 1);
                }
            }
        } else if (inString) {
            if (char === stringChar && content[i - 1] !== '\\') inString = false;
        } else if (inLineComment) {
            if (char === '\n') inLineComment = false;
        } else if (inBlockComment) {
            if (char === '*' && nextChar === '/') i++; // skip next char
        }
    }
    return content.substring(startIndex);
}

async function main() {
    // --- 0. PURGE STALE INSTANCES ---
    try {
        const { execSync } = require('child_process');
        const isWindows = process.platform === 'win32';
        const purgeCmd = isWindows
            ? `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match 'antigravity-connector|helots' && $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
            : `pkill -f "antigravity-connector|helots"`;

        log("♻️ Purging stale Helot instances...");
        execSync(purgeCmd, { shell: isWindows ? 'powershell.exe' : undefined, stdio: 'ignore' });
    } catch (e) { }

    log(`\n${SEP}`);
    log(`🛡️  ANTIGRAVITY → HELOTS MCP CONNECTOR`);
    log(`   ${new Date().toISOString()}`);
    log(`   State: ${STATE_DIR}`);
    log(SEP);

    const server = spawn('npx', ['jiti', 'src/adapters/mcp-server.ts'], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'], // Pipe stderr to capture updates
        shell: true,
        env: { ...process.env, HELOT_STATE_DIR: STATE_DIR }
    });

    log(`\n[MCP] Server spawned (pid ${server.pid})`);

    // Capture piped stderr for Helot Updates
    const errRl = readline.createInterface({ input: server.stderr! });
    errRl.on('line', line => {
        if (line.includes('[Helot Update]')) {
            log(line);
        } else {
            process.stderr.write(line + '\n');
        }
    });

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
        } catch { log(`[Server] ${line}`); }
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

    log(`\n[MCP] Initializing...`);
    const init = await call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'antigravity', version: '1.0' }
    });
    log(`[MCP] Connected: ${JSON.stringify(init?.result?.serverInfo)}`);
    server.stdin!.write(notif('notifications/initialized', {}));

    // ── Phase 1: Context Extraction ────────────────────────────────
    log(`\n${SEP}`);
    log(`[PHASE 1] 🏹 Deterministic Context Extraction (Bypassing LLM)`);

    // pickName and getGlobalContext live in persona-utils.ts (moved from engine.ts)
    const personaSrc = readFileSync('src/core/persona-utils.ts', 'utf-8');

    const pickNameCode = extractMethod(personaSrc, /^export function pickName\(/m);
    const getGlobalContextCode = extractMethod(personaSrc, /^export async function getGlobalContext\(/m);

    log(`[Extracted] pickName (${pickNameCode.length} chars)`);
    log(`[Extracted] getGlobalContext (${getGlobalContextCode.length} chars)`);
    log(SEP);

    // ── Phase 2: Live Execution ────────────────────────────────────
    log(`\n${SEP}`);
    log(`[PHASE 2] 🏛️  helot_run — Live Execution`);
    log(SEP);

    const helotRes = await call('tools/call', {
        name: 'helot_run',
        arguments: {
            taskSummary: 'Implement a new greeting utility to verify triad flow',
            implementationPlan: `
Modular creation of a greeting utility to prove the hardening is complete.

### PHASE 1: UTILITY CREATION
- [ ] 1. Create src/core/greeting.ts with a saySpartanGreeting function (Target: src/core/greeting.ts, Action: CREATE) [DEPENDS: none]

### PHASE 2: VERIFICATION
- [ ] 2. Verify the new file exists and contains the correct exported symbol (Target: src/core/greeting.ts, Symbol: saySpartanGreeting, Action: EDIT) [DEPENDS: 1]
`
        }
    });

    const helotText: string = helotRes?.result?.content?.[0]?.text ?? helotRes?.error?.message ?? 'No result';
    log(`\n${SEP}`);
    log(`[helot_run Result]\n${helotText.slice(0, 1500)}`);
    log(SEP);

    // ── Verification ───────────────────────────────────────────────
    if (existsSync(STATE_DIR)) {
        log(`\n📁 ${STATE_DIR}/`);
        for (const f of readdirSync(STATE_DIR)) {
            const p = join(STATE_DIR, f);
            const size = statSync(p).size;
            log(`  ✅ ${f} (${size} bytes)`);
        }
    }

    log(`\n📁 src/core/ — new modules:`);
    for (const f of ['src/core/persona.ts', 'src/core/context.ts', 'src/core/file-utils.ts']) {
        if (existsSync(f)) {
            log(`  ✅ ${f} (${readFileSync(f).length} bytes)`);
        } else {
            log(`  ❌ MISSING: ${f}`);
        }
    }

    server.stdin!.end();
    setTimeout(() => { server.kill(); process.exit(0); }, 500);
}

main().catch(e => { log(`FATAL: ${e.message}\n${e.stack}`); process.exit(1); });
