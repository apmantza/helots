import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    CallToolRequest
} from "@modelcontextprotocol/sdk/types.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { HelotEngine } from "../core/engine.js";
import { HelotConfig } from "../config.js";
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { startDashboard } from './dashboard-server.js';

/**
 * Helot MCP Server
 * Exposes Helot Psiloi orchestration tools via Model Context Protocol.
 */

const config: HelotConfig = {
    llamaUrl: process.env.HELOT_LLM_URL || "http://127.0.0.1:8080",
    llamaUrlFallbacks: ["http://127.0.0.1:8081", "http://127.0.0.1:11434"],
    apiKey: process.env.HELOT_API_KEY || "",
    denseModel: process.env.HELOT_DENSE_MODEL || "Qwen/Qwen3.5-27B",
    moeModel: process.env.HELOT_MOE_MODEL || "Qwen/Qwen3.5-35B-A3B",
    stateDir: process.env.HELOT_STATE_DIR || ".helots",
    projectRoot: process.cwd()
};

// Load optional config override
try {
    const configPath = path.join(process.cwd(), ".helots", "config.json");
    if (fs.existsSync(configPath)) {
        const overrideRaw = fs.readFileSync(configPath, "utf-8");
        const overrides = JSON.parse(overrideRaw);
        Object.assign(config, overrides);
    }
} catch { }

const engine = new HelotEngine(config);
startDashboard(engine, config.stateDir, 7771);

// Mirror stderr to a log file so it's visible outside Claude Code's internal capture
const LOG_FILE = path.join(config.stateDir, 'server.log');
try { fs.mkdirSync(config.stateDir, { recursive: true }); } catch { }
const _origStderrWrite = process.stderr.write.bind(process.stderr);
(process.stderr as any).write = (data: any, encoding?: any, cb?: any) => {
    try { fs.appendFileSync(LOG_FILE, typeof data === 'string' ? data : data.toString()); } catch { }
    return _origStderrWrite(data, encoding, cb);
};
process.stderr.write(`[startup] Helots MCP server starting. cwd=${process.cwd()} stateDir=${config.stateDir} model=${config.moeModel}\n`);

// ── Watch UI auto-launch ──────────────────────────────────────────────────────
// stateDir defaults to ".helots" — one level deep from cwd, so ".." gives us the helots-pi root where watch.mjs lives.
const HELOTS_ROOT  = path.resolve(config.stateDir, '..');
const WATCH_SCRIPT = path.join(HELOTS_ROOT, 'watch.mjs');
const WATCH_PID    = path.join(config.stateDir, 'watch.pid');

function isWatchRunning(): boolean {
    if (!fs.existsSync(WATCH_PID)) return false;
    try {
        const pid = parseInt(fs.readFileSync(WATCH_PID, 'utf-8').trim(), 10);
        if (isNaN(pid)) return false;
        process.kill(pid, 0);   // throws if PID doesn't exist
        return true;
    } catch {
        try { fs.unlinkSync(WATCH_PID); } catch {}
        return false;
    }
}

function ensureWatchOpen(): void {
    if (isWatchRunning()) return;
    if (!fs.existsSync(WATCH_SCRIPT)) {
        process.stderr.write(`[watch] watch.mjs not found at ${WATCH_SCRIPT}\n`);
        return;
    }

    try {
        const nodePath = process.execPath;   // full path to node — reliable in any PATH env
        const stateArg = config.stateDir;
        let child: ReturnType<typeof spawn> | undefined;

        if (process.platform === 'win32') {
            // Write a bat file to avoid quoting issues with cmd /c start
            const launchBat = path.join(path.resolve(config.stateDir), '_launch_watch.bat');
            try {
                fs.writeFileSync(launchBat, `@echo off\r\ntitle Helots Watch\r\n"${nodePath}" "${WATCH_SCRIPT}" "${stateArg}"\r\n`);
            } catch { }
            child = spawn('cmd', ['/c', 'start', 'cmd', '/k', launchBat],
                { detached: true, stdio: 'ignore' });
        } else if (process.platform === 'darwin') {
            const script = `tell application "Terminal" to do script "node '${WATCH_SCRIPT}' '${stateArg}'"`;
            child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
        } else {
            // Linux: try common terminals in order
            for (const term of ['gnome-terminal', 'xterm', 'konsole', 'xfce4-terminal']) {
                try {
                    child = spawn(term, ['--', nodePath, WATCH_SCRIPT, stateArg],
                        { detached: true, stdio: 'ignore' });
                    break;
                } catch {}
            }
        }

        if (child) {
            child.unref();
            process.stderr.write(`[watch] Launched Helots Watch UI (${WATCH_SCRIPT})\n`);
        }
    } catch (e: any) {
        process.stderr.write(`[watch] Could not open watch window: ${e.message}\n`);
    }
}

const server = new Server(
    {
        name: "helots",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

/**
 * Define available tools
 */
const TOOLS: Tool[] = [
    {
        name: "helot_slinger",
        description: "Delegates deep codebase research or analysis to the local Slinger subagent.",
        inputSchema: {
            type: "object",
            properties: {
                researchTask: {
                    type: "string",
                    description: "The specific research objective or question about the codebase.",
                },
                targetFiles: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional list of absolute file paths to analyze.",
                },
            },
            required: ["researchTask"],
        },
    },
    {
        name: "helot_run",
        description: "Delegates implementation to the Psiloi subagent swarm. Pass structured `tasks` (frontier-planned, bypasses Aristomenis) or `implementationPlan` prose (Aristomenis plans). Prefer `tasks` for reliability.",
        inputSchema: {
            type: "object",
            properties: {
                taskSummary: {
                    type: "string",
                    description: "High-level summary of the changes.",
                },
                implementationPlan: {
                    type: "string",
                    description: "Prose plan for Aristomenis to parse into tasks. Used only when `tasks` is not provided.",
                },
                tasks: {
                    type: "array",
                    description: "Structured task list from the frontier. When provided, Aristomenis is bypassed entirely.",
                    items: {
                        type: "object",
                        properties: {
                            id:          { type: "string", description: "Task number, e.g. '1'" },
                            description: { type: "string", description: "Short imperative description" },
                            file:        { type: "string", description: "Relative path to target file" },
                            symbol:      { type: "string", description: "Exact function or class name (omit for CREATE tasks)" },
                            dependsOn:   { type: "array", items: { type: "string" }, description: "Task IDs that must complete first" },
                            changes:     { type: "string", description: "Exact before→after diff instructions for the Builder" },
                        },
                        required: ["id", "description", "file", "changes"],
                    },
                },
            },
            required: ["taskSummary"],
        },
    },
    {
        name: "helot_hoplite",
        description: "Lightweight file editor for non-code files (markdown, config, docs). Reads the file locally, applies the instruction via LLM, writes the result — no peltast review, no lint. Use for MEMORY.md, README, devoptions.md, and any doc/config update where lint review is irrelevant. Faster than helot_run for pure writing tasks.",
        inputSchema: {
            type: "object",
            properties: {
                file: {
                    type: "string",
                    description: "Relative or absolute path to the file to edit or create.",
                },
                instruction: {
                    type: "string",
                    description: "What to write or change in the file. Be specific about the section and content.",
                },
            },
            required: ["file", "instruction"],
        },
    },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    const { name, arguments: args } = request.params;

    try {
        if (name === "helot_slinger") {
            const researchTask = String(args?.researchTask);
            const targetFiles = Array.isArray(args?.targetFiles) ? (args.targetFiles as string[]) : undefined;

            const result = await engine.executeSlinger(researchTask, targetFiles, (data: { text: string }) => {
                // MCP usually handles progress via specific notifications,
                // for now we'll just log or return the final result.
                console.error(`[Slinger Update] ${data.text}`);
            });

            return {
                content: [{ type: "text", text: result }],
            };
        }

        if (name === "helot_run") {
            ensureWatchOpen();
            const taskSummary = String(args?.taskSummary);
            const implementationPlan = String(args?.implementationPlan ?? '');
            const frontierTasks = Array.isArray(args?.tasks) ? args.tasks as any[] : undefined;

            const result = await engine.executeHelots(taskSummary, implementationPlan, (data) => {
                console.error(`[Helot Update] ${data.text}`);
            }, frontierTasks);

            return {
                content: [{ type: "text", text: result }],
            };
        }

        if (name === "helot_hoplite") {
            const file = String(args?.file);
            const instruction = String(args?.instruction);

            const result = await engine.executeHoplite(file, instruction, (data: { text: string }) => {
                console.error(`[Hoplite Update] ${data.text}`);
            });

            return {
                content: [{ type: "text", text: result }],
            };
        }

        throw new Error(`Unknown tool: ${name}`);
    } catch (error: any) {
        return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
        };
    }
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Helots MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});