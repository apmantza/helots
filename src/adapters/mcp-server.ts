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

/**
 * Helot MCP Server
 * Exposes Helot Psiloi orchestration tools via Model Context Protocol.
 */

const config: HelotConfig = {
    llamaUrl: process.env.HELOT_LLM_URL || "http://127.0.0.1:8080",
    apiKey: process.env.HELOT_API_KEY || "",
    denseModel: process.env.HELOT_DENSE_MODEL || "Qwen/Qwen3.5-27B",
    moeModel: process.env.HELOT_MOE_MODEL || "Qwen/Qwen3.5-35B-A3B",
    stateDir: process.env.HELOT_STATE_DIR || ".helot-state",
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
        description: "Delegates the Architect implementation plan to the Psiloi subagent swarm.",
        inputSchema: {
            type: "object",
            properties: {
                taskSummary: {
                    type: "string",
                    description: "High-level summary of the architectural changes.",
                },
                implementationPlan: {
                    type: "string",
                    description: "Extremely detailed, step-by-step technical plan for the subagents.",
                },
            },
            required: ["taskSummary", "implementationPlan"],
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
            const taskSummary = String(args?.taskSummary);
            const implementationPlan = String(args?.implementationPlan);

            const result = await engine.executeHelots(taskSummary, implementationPlan, (data) => {
                console.error(`[Helot Update] ${data.text}`);
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
