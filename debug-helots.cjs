#!/usr/bin/env node
/**
 * Helots End-to-End Debug Runner
 * Directly calls HelotEngine methods to trace the full Slinger -> Aristomenis -> Builder -> Peltast flow.
 * Checks that all expected artifacts are generated.
 * 
 * Usage: node --experimental-vm-modules debug-helots.cjs
 *   OR:  npx jiti debug-helots.cjs
 */

const { HelotEngine } = require('./dist/core/engine.js');
const { existsSync, readFileSync, readdirSync } = require('fs');
const { join } = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
const config = {
    llamaUrl: process.env.HELOT_LLM_URL || "http://127.0.0.1:8080",
    apiKey: process.env.HELOT_API_KEY || "",
    denseModel: process.env.HELOT_DENSE_MODEL || "Qwen/Qwen3.5-27B",
    moeModel: process.env.HELOT_MOE_MODEL || "Qwen/Qwen3.5-35B-A3B",
    stateDir: ".helot-state-debug",
    projectRoot: process.cwd()
};

const SEP = "═".repeat(60);
const stateDir = config.stateDir;

function log(msg) { process.stdout.write(msg + "\n"); }
function onUpdate(data) { log(`  ↳ ${data.text}`); }

async function checkArtifacts(label) {
    log(`\n[CHECK: ${label}]`);
    if (!existsSync(stateDir)) {
        log(`  ❌ State dir '${stateDir}' does NOT exist!`);
        return;
    }
    const files = readdirSync(stateDir, { recursive: true });
    if (files.length === 0) {
        log(`  ⚠️  State dir exists but is empty.`);
        return;
    }
    for (const f of files) {
        const p = join(stateDir, f);
        try {
            const stat = require('fs').statSync(p);
            if (stat.isFile()) {
                const size = stat.size;
                log(`  ✅ ${p} (${size} bytes)`);
                // Dump preview for key files
                if (f === 'progress.md' || f === 'workspace-manifest.json') {
                    const preview = readFileSync(p, 'utf-8').slice(0, 300);
                    log(`     Preview:\n${preview.split('\n').map(l => '     ' + l).join('\n')}\n`);
                }
            }
        } catch { }
    }
}

async function main() {
    log(`\n${SEP}`);
    log(`🛡️  HELOTS DEBUG RUN  — ${new Date().toISOString()}`);
    log(SEP);

    const engine = new HelotEngine(config);

    // ── PHASE 1: SLINGER ─────────────────────────────────────────────────────
    log(`\n[PHASE 1] 🏹 Deploying Slinger...`);
    const researchTask =
        `Analyze the Helots codebase for modularity, simplicity, and laconic (non-monolithic) code opportunities.
Specifically check:
1. src/core/engine.ts — is it too large? which logical sections could be split into sub-modules?
2. Identify any functions exceeding 50 lines that violate single-responsibility
3. Identify any code duplication between orchestration phases 
4. List the top 3 refactoring recommendations with file+symbol targets.`;

    let slingerResult = '';
    try {
        slingerResult = await engine.executeSlinger(researchTask, [
            'src/core/engine.ts',
            'src/adapters/mcp-server.ts',
            'src/config.ts'
        ], onUpdate);
        log(`\n${SEP}`);
        log(`[SLINGER OUTPUT]\n${slingerResult}`);
        log(SEP);
    } catch (e) {
        log(`\n❌ Slinger FAILED: ${e.message}\n${e.stack}`);
        process.exit(1);
    }

    await checkArtifacts("After Slinger");

    // ── PHASE 2: HELOT RUN (PLAN ONLY) ────────────────────────────────────────
    log(`\n${SEP}`);
    log(`[PHASE 2] 🏛️  Deploying Aristomenis (Plan Only mode)...`);
    log(SEP);

    const implementationPlan = `[PLAN ONLY]
Slinger Analysis Report:
${slingerResult}

Based on the above analysis, create a granular task checklist to refactor the Helots engine.ts for:
- Modularity (split large files into sub-modules)
- Simplicity (remove over-engineering, reduce function size)
- Laconic code style (Spartan, surgical, single-responsibility)

Use the correct checklist format:
- [ ] 1. Task (Target: file.ts, Symbol: FunctionName) [DEPENDS: none]`;

    let helotResult = '';
    try {
        helotResult = await engine.executeHelots("Helots modular refactoring", implementationPlan, onUpdate);
        log(`\n${SEP}`);
        log(`[HELOT RUN OUTPUT]\n${helotResult}`);
        log(SEP);
    } catch (e) {
        log(`\n❌ Helot Run FAILED: ${e.message}\n${e.stack}`);
    }

    await checkArtifacts("After Aristomenis");

    log(`\n${SEP}`);
    log(`🏁 DEBUG COMPLETE`);
    log(SEP);
}

main().catch(e => {
    console.error("FATAL:", e);
    process.exit(1);
});
