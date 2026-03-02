/**
 * Helots End-to-End Debug Runner
 * Uses jiti-compatible ESM import to exercise the full Helots flow.
 * 
 * Run with: npx jiti debug-helots.ts
 */

import { HelotEngine } from './src/core/engine.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// ─── Config ──────────────────────────────────────────────────────────────────
const config = {
    llamaUrl: process.env.HELOT_LLM_URL || "http://127.0.0.1:8080",
    apiKey: process.env.HELOT_API_KEY || "",
    denseModel: process.env.HELOT_DENSE_MODEL || "Qwen/Qwen3.5-27B",
    moeModel: process.env.HELOT_MOE_MODEL || "Qwen/Qwen3.5-35B-A3B",
    stateDir: ".helot-debug",
    projectRoot: process.cwd()
};

const SEP = "═".repeat(60);
const stateDir = config.stateDir;

function log(msg: string) { process.stderr.write(msg + "\n"); }
function onUpdate(data: { text: string }) { log(`  ↳ ${data.text}`); }

function checkArtifacts(label: string) {
    log(`\n[ARTIFACTS: ${label}]`);
    if (!existsSync(stateDir)) {
        log(`  ❌ State dir '${stateDir}' does NOT exist!`);
        return;
    }
    const entries = readdirSync(stateDir);
    if (entries.length === 0) {
        log(`  ⚠️  State dir exists but is EMPTY.`);
        return;
    }
    for (const entry of entries) {
        const fullPath = join(stateDir, entry);
        try {
            const stat = statSync(fullPath);
            if (stat.isFile()) {
                log(`  ✅ ${entry} (${stat.size} bytes)`);
                if (entry === 'progress.md' || entry === 'workspace-manifest.json') {
                    const preview = readFileSync(fullPath, 'utf-8').slice(0, 500);
                    const lines = preview.split('\n').map(l => '     | ' + l).join('\n');
                    log(`     Preview:\n${lines}\n`);
                }
            }
        } catch { }
    }
}

async function main() {
    log(`\n${SEP}`);
    log(`🛡️  HELOTS DEBUG RUN  — ${new Date().toISOString()}`);
    log(`    State Dir: ${stateDir}`);
    log(SEP);

    const engine = new HelotEngine(config);

    // ── PHASE 1: SLINGER ─────────────────────────────────────────────────────
    log(`\n[PHASE 1] 🏹 Deploying Slinger...`);

    const researchTask =
        `Analyze the Helots codebase for modularity, simplicity, and non-monolithic code opportunities.
Focus on:
1. src/core/engine.ts — is it too large? Which logical sections could be extracted into sub-modules?
2. Functions exceeeding ~50 lines that violate single-responsibility
3. Code duplication or patternsthat could be shared utilities
4. The top 3 most impactful refactoring recommendations (file.ts + symbol name).`;

    let slingerResult = '';
    try {
        slingerResult = await engine.executeSlinger(researchTask, [
            'src/core/engine.ts',
            'src/adapters/mcp-server.ts',
            'src/config.ts'
        ], onUpdate);
        log(`\n${SEP}`);
        log(`[SLINGER RESULT]\n${slingerResult}`);
        log(SEP);
    } catch (e: any) {
        log(`\n❌ Slinger FAILED: ${e.message}`);
        process.exit(1);
    }

    checkArtifacts("After Slinger");

    // ── PHASE 2: HELOT RUN (PLAN ONLY, no Builder execution) ─────────────────
    log(`\n${SEP}`);
    log(`[PHASE 2] 🏛️  Deploying Aristomenis (Plan Only mode)...`);
    log(SEP);

    const implementationPlan = `[PLAN ONLY]
Based on the following Slinger analysis, create a laconic, surgical implementation checklist:

${slingerResult}

Requirements for the checklist: 
- Target one file and one specific symbol per task
- Mark inter-task dependencies clearly [DEPENDS: N]
- Prioritize: split large files first, then clean functions, then remove duplication`;

    let helotResult = '';
    try {
        helotResult = await engine.executeHelots("Helots modular refactoring", implementationPlan, onUpdate);
        log(`\n${SEP}`);
        log(`[HELOT RUN RESULT]\n${helotResult}`);
        log(SEP);
    } catch (e: any) {
        log(`\n❌ Helot Run FAILED: ${e.message}\n${e.stack}`);
    }

    checkArtifacts("After Aristomenis");

    log(`\n${SEP}`);
    log(`🏁  DEBUG COMPLETE`);
    log(SEP);
}

main().catch(e => {
    log(`FATAL: ${e.message}\n${e.stack}`);
    process.exit(1);
});
