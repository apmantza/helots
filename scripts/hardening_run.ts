import { HelotEngine, LlamaClient } from "./src/core/engine.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

async function main() {
    const llmUrl = process.env.HELOT_LLM_URL || "http://127.0.0.1:8080";
    const engine = new HelotEngine(new LlamaClient(llmUrl));

    const planPath = "C:/Users/R3LiC/.gemini/antigravity/brain/be8206bb-720d-4a18-8611-97778bd58f54/helot_hardening_plan.md";
    const planContent = await fs.readFile(planPath, "utf-8");

    console.log("🛡️ Handing the Hardening Plan to the Swarm...");

    const result = await engine.executeRun(
        "Architecting technical hardening for the Helot modular core.",
        planContent,
        (data) => {
            // Stream updates to stderr
            process.stderr.write(`[SWARM] ${data.text}\n`);
        }
    );

    console.log("\n--- SWARM EXECUTION RESULT ---");
    console.log(result);
}

main().catch(console.error);
