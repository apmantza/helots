import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { HelotEngine, LlamaClient } from "../core/engine.js";

export default function (pi: ExtensionAPI) {
    if (process.env.HELOT_SUBAGENT === "true") return;

    // Unregister native edit to force Helot usage
    if (typeof (pi as any).unregisterTool === "function") {
        try { (pi as any).unregisterTool("edit"); } catch { }
    }

    // The Pi adapter doesn't implement the full config JSON override yet, so we use minimal envs.
    const config = {
        llamaUrl: process.env.HELOT_LLM_URL || "http://127.0.0.1:8080",
        apiKey: process.env.HELOT_API_KEY || "",
        denseModel: process.env.HELOT_DENSE_MODEL || "Qwen/Qwen3.5-27B",
        moeModel: process.env.HELOT_MOE_MODEL || "Qwen/Qwen3.5-35B-A3B",
        stateDir: process.env.HELOT_STATE_DIR || ".helots",
        projectRoot: process.cwd()
    };

    // Engine automatically creates the new LlamaClient inside now.
    const engine = new HelotEngine(config);

    // Tool: Slinger
    pi.registerTool({
        name: "helot_slinger",
        label: "helot: slinger",
        description: "MANDATORY for code review, research, or codebase analysis. Delegates deep reading to the local Slinger.",
        parameters: Type.Object({
            researchTask: Type.String({ description: "The specific research objective or question about the codebase." }),
            targetFiles: Type.Optional(Type.Array(Type.String(), { description: "Optional list of absolute file paths to analyze." }))
        }),
        async execute(_id: string, p: any, _s: any, onUpdate: (data: any) => void, _ctx: any) {
            try {
                const result = await engine.executeSlinger(p.researchTask, p.targetFiles, (data) => {
                    onUpdate({ content: [{ type: "text", text: data.text }] });
                });
                return { content: [{ type: "text", text: result }] };
            } catch (err: any) {
                return { content: [{ type: "text", text: `❌ Slinger failed: ${err.message}` }] };
            }
        }
    });

    // Tool: Run
    pi.registerTool({
        name: "helot_run",
        label: "helot: run",
        description: "MANDATORY for all file modifications and implementation. Delegates the technical execution to the Helot swarm.",
        parameters: Type.Object({
            taskSummary: Type.String({ description: "High-level summary of the architectural changes." }),
            implementationPlan: Type.String({ description: "Extremely detailed, step-by-step technical plan for the subagents." })
        }),
        async execute(_id: string, p: any, _s: any, onUpdate: (data: any) => void, _ctx: any) {
            try {
                const result = await engine.executeRun(p.taskSummary, p.implementationPlan, (data) => {
                    onUpdate({ content: [{ type: "text", text: data.text }] });
                });
                return { content: [{ type: "text", text: result }] };
            } catch (err: any) {
                return { content: [{ type: "text", text: `❌ Helots crashed: ${err.message}` }] };
            }
        }
    });
}
