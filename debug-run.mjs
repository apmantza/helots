/**
 * Helots Debug Runner
 * Directly invokes HelotEngine methods to debug the full flow.
 * Run with: node debug-run.mjs
 */

import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// We need to run the compiled JS. Let's build first, then run.
// This script calls the engine through its compiled output.
import { HelotEngine } from './dist/core/engine.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const config = {
    llamaUrl: process.env.HELOT_LLM_URL || "http://127.0.0.1:8080",
    apiKey: process.env.HELOT_API_KEY || "",
    denseModel: process.env.HELOT_DENSE_MODEL || "Qwen/Qwen3.5-27B",
    moeModel: process.env.HELOT_MOE_MODEL || "Qwen/Qwen3.5-35B-A3B",
    stateDir: ".helot-state",
    projectRoot: process.cwd(),
};

const engine = new HelotEngine(config);

const LOG_SEP = "─".repeat(60);

function onUpdate(data) {
    console.log(`  >> ${data.text}`);
}

async function runDebug() {
    console.log(`\n${LOG_SEP}`);
    console.log(`🛡️  HELOTS DEBUG RUN - ${new Date().toISOString()}`);
    console.log(LOG_SEP);

    // === PHASE 1: SLINGER RESEARCH ===
    console.log(`\n[PHASE 1] 🏹 Deploying Slinger for research...`);
    const researchTask = `Analyze the Helots codebase (src/core/engine.ts and related files) for opportunities to improve modularity, simplicity, and maintainability. 
Focus on:
1. Files that are too large (>400 lines) and should be split
2. Functions or classes with single-responsibility violations
3. Circular dependencies or tight-coupling between modules
4. Code duplication or consolidation opportunities
5. Non-laconic patterns (over-engineering, unnecessary complexity)
Provide a prioritized list of refactoring recommendations.`;

    let slingerResult;
    try {
        slingerResult = await engine.executeSlinger(researchTask, undefined, onUpdate);
        console.log(`\n${LOG_SEP}`);
        console.log(`[Slinger Report]\n${slingerResult}`);
        console.log(LOG_SEP);
    } catch (e) {
        console.error(`\n❌ Slinger FAILED: ${e.message}`);
        process.exit(1);
    }

    // Check if progress.md was created
    const stateDir = ".helot-state";
    const progressFile = join(stateDir, "progress.md");
    console.log(`\n[CHECK] Looking for artifacts in '${stateDir}'...`);
    if (existsSync(stateDir)) {
        const { readdirSync } = await import('fs');
        const files = readdirSync(stateDir);
        console.log(`  ✅ .helot-state/ exists with: ${files.join(", ")}`);
    } else {
        console.log(`  ⚠️  .helot-state/ does NOT exist yet (expected after slinger?)`);
    }

    // === PHASE 2: HELOT RUN ==
    console.log(`\n${LOG_SEP}`);
    console.log(`[PHASE 2] 🏛️  Deploying Aristomenis + Builder swarm (helot_run)...`);
    console.log(LOG_SEP);

    const taskSummary = "Improve Helots engine modularity and simplicity via laconic refactoring";
    const implementationPlan = `[PLAN ONLY]
Based on the Slinger analysis above:

${slingerResult}

Create a detailed implementation checklist for refactoring the Helots codebase for better modularity and simplicity.
Focus on the most impactful changes first. Do NOT make changes yet - just draft the plan.
Each task should target one specific file and one specific logic block.`;

    let helotResult;
    try {
        helotResult = await engine.executeHelots(taskSummary, implementationPlan, onUpdate);
        console.log(`\n${LOG_SEP}`);
        console.log(`[Helot Run Result]\n${helotResult}`);
        console.log(LOG_SEP);
    } catch (e) {
        console.error(`\n❌ Helot Run FAILED: ${e.message}`);
    }

    // Post-run artifact check
    console.log(`\n[FINAL CHECK] Checking all generated artifacts...`);
    const artifacts = [
        join(stateDir, "progress.md"),
        join(stateDir, "workspace-manifest.json"),
        join(stateDir, "helot-state.json"),
        join(stateDir, "trace.jsonl"),
        join(stateDir, "review.md"),
    ];
    for (const artifact of artifacts) {
        if (existsSync(artifact)) {
            const size = readFileSync(artifact).length;
            console.log(`  ✅ ${artifact} (${size} bytes)`);
        } else {
            console.log(`  ❌ MISSING: ${artifact}`);
        }
    }
}

runDebug().catch(console.error);
