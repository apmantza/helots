import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { HelotEngine } from "./src/core/engine.js";
import { HelotConfig } from "./src/config.js";
import * as fs from 'fs';
import * as path from 'path';

/**
 * Helot Pi Extension Adapter
 * This is the entry point for the Pi coding agent.
 * It delegates all orchestration to the HelotEngine.
 */
export default function (pi: ExtensionAPI) {
  if (process.env.HELOT_SUBAGENT === "true") return;

  // Unregister native edit to force Helot usage if desired
  if (typeof (pi as any).unregisterTool === "function") {
    try { (pi as any).unregisterTool("edit"); } catch { }
  }

  // Load configuration
  let config: HelotConfig = {
    llamaUrl: process.env.HELOT_LLM_URL || "http://127.0.0.1:8080",
    apiKey: process.env.HELOT_API_KEY || "",
    denseModel: process.env.HELOT_DENSE_MODEL || "Qwen/Qwen3.5-27B",
    moeModel: process.env.HELOT_MOE_MODEL || "Qwen/Qwen3.5-35B-A3B",
    stateDir: process.env.HELOT_STATE_DIR || ".helot-state",
    projectRoot: process.cwd()
  };

  try {
    const configPath = path.join(process.cwd(), ".helots", "config.json");
    if (fs.existsSync(configPath)) {
      const overrideRaw = fs.readFileSync(configPath, "utf-8");
      const overrides = JSON.parse(overrideRaw);
      config = { ...config, ...overrides };
    }
  } catch { }

  const engine = new HelotEngine(config);

  // Tool: helot_slinger
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
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (err: any) {
        return { content: [{ type: "text", text: `❌ Slinger failed: ${err.message}` }], details: { error: err.message } };
      }
    }
  });

  // Tool: helot_run
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
        const result = await engine.executeHelots(p.taskSummary, p.implementationPlan, (data) => {
          onUpdate({ content: [{ type: "text", text: data.text }] });
        });
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (err: any) {
        return { content: [{ type: "text", text: `❌ Helots crashed: ${err.message}` }], details: { error: err.message } };
      }
    }
  });
}
