import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    CallToolRequest
} from "@modelcontextprotocol/sdk/types.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { HelotEngine } from "../core/engine.js";
import { executeWorkflow } from '../core/workflow-engine.js';
import type { WorkflowStep } from '../core/workflow-engine.js';
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
        description: "Delegates deep codebase research or analysis to the local Slinger subagent. With `outputFile`, chains to Hoplite to write the result to a file — the research never hits the frontier context. Use this mode for project surveys, dependency maps, code reviews, and any research-then-write workflow (replaces helot_scribe). Without `outputFile`, returns the research result directly.",
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
                outputFile: {
                    type: "string",
                    description: "If provided, Hoplite writes the research result to this file. The result never returns to the frontier. Use for any research-then-write workflow.",
                },
                batchDir: {
                    type: "string",
                    description: "Optional directory to batch-summarize. Slinger lists all files, summarizes them in groups, and appends a Source File Summaries section to outputFile.",
                },
                maxFilesPerBatch: {
                    type: "number",
                    description: "Hard cap on files per batch. Default 8. Batch size is otherwise determined dynamically from the server context window.",
                },
            },
            required: ["researchTask"],
        },
    },
    {
        name: "helot_run",
        description: "Delegates implementation to the Psiloi subagent swarm. Pass structured `tasks` (frontier-planned). ALWAYS use `tasks` — `implementationPlan` is deprecated and will be removed.",
        inputSchema: {
            type: "object",
            properties: {
                taskSummary: {
                    type: "string",
                    description: "High-level summary of the changes.",
                },
                implementationPlan: {
                    type: "string",
                    description: "DEPRECATED. Has no effect. Use `tasks` instead.",
                },
                tasks: {
                    type: "array",
                    description: "Structured task list from the frontier. Required — always use this.",
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
        name: "helot_execute",
        description: "Executes pre-planned file operations (mv, mkdir, cp) fully off-frontier. Validates every line against an allowlist and blocks path traversal and shell injection. Appends each operation to an audit log. Use after helot_slinger plans a folder cleanup or reorganization.",
        inputSchema: {
            type: "object",
            properties: {
                script: {
                    type: "string",
                    description: "Newline-separated operations. Supported commands: mv <src> <dst>, mkdir <dir>, cp <src> <dst>. Lines starting with # are ignored.",
                },
                auditLog: {
                    type: "string",
                    description: "File path to append audit entries. Defaults to .helot-mcp-connector/execute-audit.log.",
                },
                dryRun: {
                    type: "boolean",
                    description: "If true, logs what would happen without executing anything. Defaults to false.",
                },
                scriptFile: {
                    type: "string",
                    description: "If provided, reads the script from this file path instead of the script param.",
                },
                protectedFiles: {
                    type: "array",
                    items: { type: "string" },
                    description: "Files that must not be moved or copied. Pass [\"auto\"] to derive protected files from package.json and tsconfig.json automatically.",
                },
                remapRules: {
                    type: "array",
                    description: "Override destination for files matching a pattern. Each rule: { pattern: regex string, dir: target directory }. Applied before execution — LLM plan is overridden deterministically.",
                    items: {
                        type: "object",
                        properties: {
                            pattern: { type: "string", description: "Regex pattern matched against the source filename (basename only)." },
                            dir:     { type: "string", description: "Target directory to move matching files into." },
                        },
                        required: ["pattern", "dir"],
                    },
                },
                pruneRules: {
                    type: "array",
                    description: "Glob-based rules to move operational artifacts (logs, backups, temp files) to an archive destination. Each rule: { glob: path pattern, dest: target directory }. Supports dir/*, dir/**, *.ext patterns. Runs independently of the script param.",
                    items: {
                        type: "object",
                        properties: {
                            glob: { type: "string", description: "Glob pattern: 'dir/*' (direct children), 'dir/**' (recursive), '*.ext' (root-level by extension)." },
                            dest: { type: "string", description: "Destination directory for matched files." },
                        },
                        required: ["glob", "dest"],
                    },
                },
            },
            required: [],
        },
    },
    {
        name: "helot_hoplite",
        description: "Lightweight file editor for non-code files (markdown, config, docs, HTML). Reads the file locally, applies the instruction via LLM, writes the result — no peltast review, no lint. Use for MEMORY.md, README, devoptions.md, index.html, and any doc/config/HTML update where lint review is irrelevant. Faster than helot_run for pure writing tasks.",
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
    {
        name: "helot_workflow",
        description: "Runs a named sequence of helot tool steps fully off-frontier. Steps chain via the filesystem (outputFile → scriptFile). Returns only a final summary — no intermediate results hit the frontier context. Use for /maintain, /cleanup, /prune, /docs and any multi-step operation.",
        inputSchema: {
            type: "object",
            properties: {
                workflowName: {
                    type: "string",
                    description: "Name for this workflow run, used in log filenames. e.g. 'maintain', 'cleanup', 'docs'.",
                },
                steps: {
                    type: "array",
                    description: "Ordered list of tool steps. Steps with dependsOn are skipped if a dependency failed.",
                    items: {
                        type: "object",
                        properties: {
                            id:           { type: "string",  description: "Unique step identifier, e.g. 'prune', 'cleanup-plan'" },
                            tool:         { type: "string",  description: "'slinger' | 'execute' | 'hoplite'" },
                            dependsOn:    { type: "array", items: { type: "string" }, description: "Step IDs that must succeed before this step runs" },
                            researchTask: { type: "string",  description: "[slinger] Research question or task description" },
                            outputFile:   { type: "string",  description: "[slinger] If set, writes result to file (chains to execute via scriptFile)" },
                            batchDir:     { type: "string",  description: "[slinger] Directory to batch-summarize" },
                            scriptFile:   { type: "string",  description: "[execute] Path to shell script file (e.g. outputFile from prior slinger step)" },
                            script:       { type: "string",  description: "[execute] Inline script (alternative to scriptFile)" },
                            auditLog:     { type: "string",  description: "[execute] Path for audit log output" },
                            protectedFiles: { type: "array", items: { type: "string" }, description: "[execute] Files to protect. Use ['auto'] for config-derived protection." },
                            remapRules:   { type: "array",   description: "[execute] Pattern→dir remapping rules" },
                            pruneRules:   { type: "array",   description: "[execute] Glob→dest archival rules" },
                            file:         { type: "string",  description: "[hoplite] File to edit or create" },
                            instruction:  { type: "string",  description: "[hoplite] Edit instruction for hoplite" },
                        },
                        required: ["id", "tool"],
                    },
                },
            },
            required: ["workflowName", "steps"],
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
            const outputFile = args?.outputFile ? String(args.outputFile) : undefined;

            if (outputFile) {
                const batchDir = args?.batchDir ? String(args.batchDir) : undefined;
                const batchSize = args?.maxFilesPerBatch ? Number(args.maxFilesPerBatch) : 8;
                const result = await engine.executeScribe(researchTask, outputFile, (data: { text: string }) => {
                    console.error(`[Slinger Update] ${data.text}`);
                }, batchDir, batchSize);
                return { content: [{ type: "text", text: result }] };
            }

            const result = await engine.executeSlinger(researchTask, targetFiles, (data: { text: string }) => {
                console.error(`[Slinger Update] ${data.text}`);
            });
            return { content: [{ type: "text", text: result }] };
        }

        if (name === "helot_run") {
            ensureWatchOpen();
            const taskSummary = String(args?.taskSummary);
            const frontierTasks = Array.isArray(args?.tasks) ? args.tasks as any[] : undefined;

            if (!frontierTasks || frontierTasks.length === 0) {
                return {
                    content: [{ type: "text", text: '[ERROR] helot_run requires a `tasks` array. Use helot_slinger to research the codebase first, then call helot_run with structured tasks. See CLAUDE.md for the task format.' }],
                    isError: true,
                };
            }

            const result = await engine.executeHelots(taskSummary, '', (data) => {
                console.error(`[Helot Update] ${data.text}`);
            }, frontierTasks);

            return {
                content: [{ type: "text", text: result }],
            };
        }

        if (name === "helot_execute") {
            const script         = args?.script         ? String(args.script)                       : '';
            const auditLog       = args?.auditLog       ? String(args.auditLog)                     : path.join(config.stateDir, 'execute-audit.log');
            const dryRun         = args?.dryRun         ? Boolean(args.dryRun)                      : false;
            const scriptFile     = args?.scriptFile     ? String(args.scriptFile)                   : undefined;
            const protectedFiles = Array.isArray(args?.protectedFiles) ? args.protectedFiles as string[] : undefined;
            const remapRules     = Array.isArray(args?.remapRules)     ? args.remapRules as Array<{ pattern: string; dir: string }>   : undefined;
            const pruneRules     = Array.isArray(args?.pruneRules)     ? args.pruneRules as Array<{ glob: string; dest: string }>     : undefined;

            const result = await engine.executeScript(script, auditLog, dryRun, scriptFile, protectedFiles, remapRules, pruneRules);
            return { content: [{ type: "text", text: result }] };
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

        if (name === "helot_workflow") {
            const workflowName = String(args?.workflowName ?? 'workflow');
            const steps = Array.isArray(args?.steps) ? args.steps as WorkflowStep[] : [];
            if (steps.length === 0) {
                return { content: [{ type: "text", text: '[ERROR] helot_workflow requires a non-empty steps array.' }], isError: true };
            }
            const result = await executeWorkflow(workflowName, steps, engine, (data) => {
                console.error(`[Workflow Update] ${data.text}`);
            });
            return { content: [{ type: "text", text: result }] };
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