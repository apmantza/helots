/**
 * debug-slinger.mjs
 * Spawns the Helots MCP server and fires a single helot_slinger call.
 * Run: node debug-slinger.mjs
 */
import { spawn } from 'child_process';
import * as readline from 'readline';

const SEP = '─'.repeat(60);

function log(msg) {
  process.stdout.write(msg + '\n');
}

let msgId = 1;
function rpc(method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id: msgId++, method, params }) + '\n';
}
function notif(method, params) {
  return JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
}

async function main() {
  log(`\n${SEP}`);
  log('🏹  HELOTS SLINGER DEBUG');
  log(`   ${new Date().toISOString()}`);
  log(SEP);

  // Spawn the MCP server
  const server = spawn('npx', ['jiti', 'src/adapters/mcp-server.ts'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    env: {
      ...process.env,
      HELOT_STATE_DIR: '.helot-debug-slinger',
      HELOT_LLM_URL: 'http://127.0.0.1:8081',
      HELOT_DENSE_MODEL: 'qwen27b',
      HELOT_MOE_MODEL: 'qwen27b',
    }
  });

  log(`[MCP] Server spawned (pid ${server.pid})`);

  // Stream all stderr (Helot updates + server logs)
  const errRl = readline.createInterface({ input: server.stderr });
  errRl.on('line', line => {
    log(`[stderr] ${line}`);
  });

  server.on('error', e => log(`[server error] ${e.message}`));
  server.on('exit', (code) => log(`\n[server exited] code=${code}`));

  // Pending RPC responses
  const pending = new Map();
  const rl = readline.createInterface({ input: server.stdout });
  rl.on('line', line => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      log(`[stdout raw] ${line}`);
    }
  });

  function call(method, params) {
    return new Promise(resolve => {
      const id = msgId;
      pending.set(id, resolve);
      server.stdin.write(rpc(method, params));
    });
  }

  // Give server 1.5s to start
  await new Promise(r => setTimeout(r, 1500));

  // Initialize MCP handshake
  log(`\n[MCP] Initializing...`);
  const init = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    clientInfo: { name: 'debug-slinger', version: '1.0' }
  });
  log(`[MCP] Server info: ${JSON.stringify(init?.result?.serverInfo)}`);
  server.stdin.write(notif('notifications/initialized', {}));

  // List tools to confirm registration
  log(`\n[MCP] Listing tools...`);
  const toolsList = await call('tools/list', {});
  const tools = toolsList?.result?.tools || [];
  log(`[MCP] Tools registered: ${tools.map(t => t.name).join(', ')}`);

  // Fire the slinger
  log(`\n${SEP}`);
  log(`[SLINGER] Dispatching research task...`);
  log(SEP);

  const start = Date.now();
  const slingerRes = await call('tools/call', {
    name: 'helot_slinger',
    arguments: {
      researchTask: 'Find all exported classes in the src/ directory. For each class, tell me which file it lives in, what line it is on, and what its constructor takes as arguments.'
    }
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`\n${SEP}`);
  log(`[SLINGER RESULT] (${elapsed}s)`);
  log(SEP);

  if (slingerRes?.error) {
    log(`❌ RPC ERROR: ${JSON.stringify(slingerRes.error)}`);
  } else {
    const text = slingerRes?.result?.content?.[0]?.text ?? 'no content';
    log(text);
  }

  log(`\n${SEP}`);
  log('Done. Shutting down server.');
  server.stdin.end();
  setTimeout(() => { server.kill(); process.exit(0); }, 500);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
