import { HelotEngine, LlamaClient } from "./src/core/engine.js";
import * as path from "node:path";

async function main() {
    const llmUrl = process.env.HELOT_LLM_URL || "http://127.0.0.1:8080";
    const engine = new HelotEngine(new LlamaClient(llmUrl));

    const targetFiles = [
        path.resolve("src/core/engine.ts"),
        path.resolve("src/adapters/mcp.ts"),
        path.resolve("src/adapters/pi.ts")
    ];

    console.log("🚀 Starting Slinger Code Review...");
    const report = await engine.executeSlinger(
        "Perform a technical code review of the new modular architecture. Focus on separation of concerns, portability, and any potential threading or concurrency issues with the SSE buffering.",
        targetFiles,
        (data) => {
            // Print updates to stderr to keep them separate from the final report
            process.stderr.write(`[DEBUG] ${data.text}\n`);
        }
    );

    console.log("\n--- FINAL REPORT ---");
    console.log(report);
}

main().catch(console.error);
