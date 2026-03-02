/**
 * Antigravity MCP Connector for Helots
 *
 * This provides a bridge for Antigravity to quickly spawn the Helots server,
 * inject surgical exact context into tasks (bypassing Slinger/Scout),
 * and run live executions deterministically.
 */

import { spawn } from 'child_process';
import * as readline from 'readline';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SEP = '═'.repeat(70);
const STATE_DIR = '.helot-mcp-connector';

function log(msg: string) { process.stderr.write(msg + '\n'); }

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
    log(`\n${SEP}`);
    log(`🛡️  ANTIGRAVITY → HELOTS MCP CONNECTOR`);
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

    const engineSrc = readFileSync('src/core/engine.ts', 'utf-8');
    const pickNameCode = extractMethod(engineSrc, /private pickName\([^)]*\)\s*\{/);
    const getGlobalContextCode = extractMethod(engineSrc, /private async getGlobalContext\([^)]*\)[^{]*\{/);

    log(`[Extracted] pickName (${pickNameCode.length} chars)`);
    log(`[Extracted] getGlobalContext (${getGlobalContextCode.length} chars)`);
    log(SEP);

    // ── Phase 2: Live Execution ────────────────────────────────────
    log(`\n${SEP}`);
    log(`[PHASE 2] 🏛️  helot_run — Live Execution`);
    log(SEP);

    const implementationPlan = `
Laconic refactoring: extract pickName and getGlobalContext from engine.ts into separate modules.

Each Builder task carries its own exact context. No large files will be read.

TASKS:

- [ ] 1. Create src/core/persona.ts with the exported pickName function (Target: src/core/persona.ts, Action: CREATE) [DEPENDS: none]

  Builder context for Task 1 — create this file from scratch:
  \`\`\`typescript
  // src/core/persona.ts
  ${pickNameCode}
  // MUST MAKE IT A STANDALONE EXPORT: remove 'private' keyword and 'this.' refs. Export it!
  \`\`\`

- [ ] 2. Update src/core/engine.ts: remove private pickName method, add import from ./persona.js (Target: src/core/engine.ts, Symbol: pickName, Action: EDIT) [DEPENDS: 1]

  Builder context for Task 2 — the existing method to remove from class HelotEngine:
  \`\`\`typescript
  ${pickNameCode}
  \`\`\`
  Replace it with: import { pickName } from './persona.js';
  Update calls: this.pickName(...) -> pickName(...)

- [ ] 3. Create src/core/context.ts with the exported getGlobalContext function (Target: src/core/context.ts, Action: CREATE) [DEPENDS: none]

  Builder context for Task 3 — create this file from scratch:
  \`\`\`typescript
  // src/core/context.ts
  import * as path from 'path';
  import { existsSync, readFileSync } from 'fs';
  ${getGlobalContextCode}
  // MUST MAKE IT A STANDALONE EXPORT: remove 'private' keyword and 'this.' refs. Export it!
  \`\`\`

- [ ] 4. Update src/core/engine.ts: remove private getGlobalContext, add import from ./context.js (Target: src/core/engine.ts, Symbol: getGlobalContext, Action: EDIT) [DEPENDS: 3]

  Builder context for Task 4 — the existing method to remove from class HelotEngine:
  \`\`\`typescript
  ${getGlobalContextCode}
  \`\`\`
  Replace it with: import { getGlobalContext } from './context.js';
  Update calls: this.getGlobalContext() -> getGlobalContext()

BUILDER NOTES:
- Output format must be exclusively:
### [path/to/file.ts]
\`\`\`typescript
[code]
\`\`\`
- Do not output any thinking tags.
`;

    const helotRes = await call('tools/call', {
        name: 'helot_run',
        arguments: {
            taskSummary: 'Extract pickName and getGlobalContext from engine.ts',
            implementationPlan
        }
    });

    const helotText: string = helotRes?.result?.content?.[0]?.text ?? helotRes?.error?.message ?? 'No result';
    log(`\n${SEP}`);
    log(`[helot_run Result]\n${helotText.slice(0, 800)}`);
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
