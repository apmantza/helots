/**
 * Helots MCP Client — Antigravity LIVE EXECUTION Runner
 *
 * Full pipeline: Slinger (retrieves exact method bodies) → Aristomenis → Builder → Peltast
 * Slinger output is injected directly into task descriptions so Builder never needs to load
 * large files — each task carries its own surgical context, bypassing the Context Guard.
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

    // ── Initialize ────────────────────────────────────────────────
    log(`\n[MCP] Initializing...`);
    const init = await call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'antigravity', version: '1.0' }
    });
    log(`[MCP] Connected: ${JSON.stringify(init?.result?.serverInfo)}`);
    server.stdin!.write(notif('notifications/initialized', {}));

    // ── Phase 1: helot_slinger — retrieve exact method bodies ─────
    log(`\n${SEP}`);
    log(`[PHASE 1] 🏹 helot_slinger — retrieving exact method implementations`);
    log(SEP);

    const slingerRes = await call('tools/call', {
        name: 'helot_slinger',
        arguments: {
            researchTask: `From src/core/engine.ts, return the COMPLETE verbatim code for these two private methods:

1. The pickName() private method — include the full function signature and body
2. The getGlobalContext() private method — include the full function signature and body

Format your response EXACTLY as:

=== pickName ===
[paste complete method code here]

=== getGlobalContext ===
[paste complete method code here]

Return NOTHING else.`,
            targetFiles: ['src/core/engine.ts']
        }
    });

    const slingerText: string = slingerRes?.result?.content?.[0]?.text ?? '';
    log(`\n[Slinger] Retrieved ${slingerText.length} chars`);
    log(`[Slinger Preview]\n${slingerText.slice(0, 400)}...`);

    // Extract the two method bodies from Slinger output
    const extractSection = (text: string, name: string): string => {
        const marker = `=== ${name} ===`;
        const start = text.indexOf(marker);
        if (start === -1) return `// ${name} not found in Slinger output`;
        const afterMarker = text.slice(start + marker.length);
        // Find the next === marker or end of string
        const nextMarker = afterMarker.indexOf('\n===');
        return (nextMarker === -1 ? afterMarker : afterMarker.slice(0, nextMarker)).trim();
    };

    const pickNameCode = extractSection(slingerText, 'pickName');
    const getGlobalContextCode = extractSection(slingerText, 'getGlobalContext');

    log(`\n[Extracted] pickName (${pickNameCode.length} chars), getGlobalContext (${getGlobalContextCode.length} chars)`);

    // ── Phase 2: helot_run LIVE — Builder tasks carry their own context ──
    log(`\n${SEP}`);
    log(`[PHASE 2] 🏛️  helot_run — LIVE execution with injected Builder context`);
    log(SEP);

    // Craft the plan so that each Builder task has the verbatim code injected.
    // This means Builder NEVER needs to load engine.ts — it gets exactly what it needs.
    const implementationPlan = `
Laconic refactoring: extract pickName and getGlobalContext from engine.ts into separate modules.

SLINGER HAS RETRIEVED THE EXACT METHOD IMPLEMENTATIONS BELOW.
Each Builder task carries its own context — no file loading required.

TASKS:

- [ ] 1. Create src/core/persona.ts with the exported pickName function (Target: src/core/persona.ts, Action: CREATE) [DEPENDS: none]

  Builder context for Task 1 — create this file from scratch:
  \`\`\`typescript
  // src/core/persona.ts
  // Extracted from engine.ts — Helot persona naming utility

  ${pickNameCode}

  // Make it a standalone export (remove 'private', remove 'this' references)
  // Exported signature: export function pickName(runId: string, role: string): { name: string; city: string }
  \`\`\`

- [ ] 2. Update src/core/engine.ts: remove private pickName method, add import from ./persona.js (Target: src/core/engine.ts, Symbol: pickName, Action: EDIT) [DEPENDS: 1]

  Builder context for Task 2 — the existing method to remove:
  \`\`\`typescript
  ${pickNameCode}
  \`\`\`
  Replace with: import { pickName } from './persona.js';
  Then replace all calls from this.pickName(...) to pickName(...)

- [ ] 3. Create src/core/context.ts with the exported getGlobalContext function (Target: src/core/context.ts, Action: CREATE) [DEPENDS: none]

  Builder context for Task 3 — create this file from scratch:
  \`\`\`typescript
  // src/core/context.ts
  // Extracted from engine.ts — Helot global context provider

  ${getGlobalContextCode}

  // Make it a standalone export (remove 'private', remove 'this' references)
  // Exported signature: export async function getGlobalContext(): Promise<string>
  \`\`\`

- [ ] 4. Update src/core/engine.ts: remove private getGlobalContext method, add import from ./context.js (Target: src/core/engine.ts, Symbol: getGlobalContext, Action: EDIT) [DEPENDS: 3]

  Builder context for Task 4 — the existing method to remove:
  \`\`\`typescript
  ${getGlobalContextCode}
  \`\`\`
  Replace with: import { getGlobalContext } from './context.js';
  Then replace all calls from this.getGlobalContext() to getGlobalContext()

BUILDER NOTES:
- For CREATE tasks: write only the exported function, minimal imports, no class wrapper
- For EDIT tasks: output ONLY the import line addition and the specific symbol removal
- Spartan Simplicity: no JSDoc, no extra comments beyond what's already there
- Output format: ### [path/to/file.ts] followed by a typescript code fence`;

    const helotRes = await call('tools/call', {
        name: 'helot_run',
        arguments: {
            taskSummary: 'Extract pickName and getGlobalContext from engine.ts into persona.ts and context.ts',
            implementationPlan
        }
    });

    const helotText: string = helotRes?.result?.content?.[0]?.text ?? helotRes?.error?.message ?? 'No result';
    log(`\n${SEP}`);
    log(`[helot_run Result]\n${helotText.slice(0, 800)}`);
    log(SEP);

    // ── Artifact Verification ─────────────────────────────────────
    log(`\n${SEP}`);
    log(`[VERIFY] Checking generated artifacts...`);
    log(SEP);

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
        }
    } else {
        log(`  ❌ State dir ${STATE_DIR} not found!`);
    }

    log(`\n📁 src/core/ — new modules:`);
    for (const f of ['src/core/persona.ts', 'src/core/context.ts', 'src/core/file-utils.ts']) {
        if (existsSync(f)) {
            log(`  ✅ ${f} (${readFileSync(f).length} bytes)`);
            log(`${readFileSync(f, 'utf-8').split('\n').map(l => '     | ' + l).join('\n')}\n`);
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
