
import { spawn } from 'child_process';
import * as readline from 'readline';
import { existsSync, readFileSync } from 'fs';

const SEP = '═'.repeat(70);
const STATE_DIR = '.helot-mcp-connector';

function log(msg: string) { process.stderr.write(msg + '\n'); }

let msgId = 1;
function req(method: string, params: any) {
    return JSON.stringify({ jsonrpc: '2.0', id: msgId++, method, params }) + '\n';
}

async function main() {
    log(`\n${SEP}`);
    log(`🛡️  SLINGER NATIVE DEBUGGER`);
    log(SEP);

    const server = spawn('npx', ['jiti', 'src/adapters/mcp-server.ts'], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'inherit'],
        shell: true,
        env: { ...process.env, HELOT_STATE_DIR: STATE_DIR }
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
        } catch { log(`[Server Log] ${line}`); }
    });

    function call(method: string, params: any): Promise<any> {
        return new Promise(resolve => {
            const id = msgId;
            pending.set(id, resolve);
            server.stdin!.write(req(method, params));
        });
    }

    await new Promise(r => setTimeout(r, 1000));

    log(`[MCP] Initializing...`);
    await call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'antigravity-debug', version: '1.0' }
    });
    server.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

    log(`\n[MCP] Triggering helot_slinger directly...`);

    const slingerRes = await call('tools/call', {
        name: 'helot_slinger',
        arguments: {
            researchTask: 'Analyze the src/core/ directory. Explain how HelotEngine, LlamaClient, and McpServer interact. Find the exact lines where they are instantiated.',
        }
    });

    const result = slingerRes?.result?.content?.[0]?.text ?? slingerRes?.error?.message ?? 'No result';

    log(`\n${SEP}`);
    log(`🏹 SLINGER DEBUG REPORT:`);
    log(result);
    log(SEP);

    server.stdin!.end();
    setTimeout(() => { server.kill(); process.exit(0); }, 500);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
