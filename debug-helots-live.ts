/**
 * Helots Live Run Debug — Phase 2
 * Runs the real helot_run (no PLAN ONLY) so we can observe
 * the full Builder -> Peltast pipeline on the modular refactoring plan.
 * 
 * Run with: npx jiti debug-helots-live.ts
 */

import { HelotEngine } from './src/core/engine.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const config = {
    llamaUrl: process.env.HELOT_LLM_URL || "http://127.0.0.1:8080",
    apiKey: process.env.HELOT_API_KEY || "",
    denseModel: process.env.HELOT_DENSE_MODEL || "Qwen/Qwen3.5-27B",
    moeModel: process.env.HELOT_MOE_MODEL || "Qwen/Qwen3.5-35B-A3B",
    stateDir: ".helot-live",
    projectRoot: process.cwd()
};

const SEP = "═".repeat(60);
const stateDir = config.stateDir;

function log(msg: string) { process.stderr.write(msg + "\n"); }
function onUpdate(data: { text?: string }) {
    if (data.text) log(`  ↳ ${data.text.slice(0, 200)}`);
}

function checkArtifacts(label: string) {
    log(`\n[ARTIFACTS: ${label}]`);
    if (!existsSync(stateDir)) { log(`  ❌ stateDir missing!`); return; }
    for (const f of readdirSync(stateDir)) {
        const p = join(stateDir, f);
        const size = statSync(p).size;
        log(`  ✅ ${f} (${size} bytes)`);
        if (f === 'progress.md') {
            const content = readFileSync(p, 'utf-8');
            log(`\n  [progress.md preview]\n${content.slice(0, 600).split('\n').map(l => '  | ' + l).join('\n')}\n`);
        }
        if (f === 'trace.jsonl') {
            const lines = readFileSync(p, 'utf-8').trim().split('\n');
            log(`  [trace.jsonl] ${lines.length} entries:`);
            lines.forEach(l => log(`    ${l.slice(0, 120)}`));
        }
    }
}

async function main() {
    log(`\n${SEP}`);
    log(`🛡️  HELOTS LIVE RUN DEBUG — ${new Date().toISOString()}`);
    log(`    StateDir: ${stateDir}`);
    log(SEP);

    const engine = new HelotEngine(config);

    // Phase 1: Slinger — gather context on engine.ts
    log(`\n[PHASE 1] 🏹 Slinger reconnaissance...`);
    const slingerResult = await engine.executeSlinger(
        `Analyze src/core/engine.ts and identify the top 3 most self-contained pieces of logic 
that can be extracted into separate files without breaking anything. For each, provide:
- The symbol name to extract
- The proposed new file path
- Any dependencies it has on other functions in engine.ts`,
        ['src/core/engine.ts'],
        onUpdate
    );
    log(`\n[Slinger done]\n${slingerResult.slice(0, 400)}`);
    checkArtifacts("After Slinger");

    // Phase 2: helot_run — LIVE (no PLAN ONLY)
    // Use a highly constrained task so builder only touches 1 small thing
    log(`\n${SEP}`);
    log(`[PHASE 2] 🏛️  helot_run LIVE (Builder + Peltast active)...`);
    log(SEP);

    const implementationPlan = `
Based on the Slinger analysis:
${slingerResult.slice(0, 1500)}

TASK: Extract ONLY the \`getAllFiles\` function from src/core/engine.ts into a new file: src/core/file-utils.ts.
- Create src/core/file-utils.ts with the getAllFiles function exported
- Update the import in engine.ts to use the new file
- Do NOT modify any other logic
- Keep changes minimal and surgical (Spartan approach)`;

    let result = '';
    try {
        result = await engine.executeHelots("Extract getAllFiles to file-utils.ts", implementationPlan, onUpdate);
        log(`\n${SEP}`);
        log(`[helot_run result]\n${result}`);
        log(SEP);
    } catch (e: any) {
        log(`\n❌ helot_run FAILED: ${e.message}\n${e.stack}`);
    }

    checkArtifacts("After Builder/Peltast run");

    // Verify the new file was created
    log(`\n[VERIFY] Checking if file-utils.ts was created...`);
    const newFile = 'src/core/file-utils.ts';
    if (existsSync(newFile)) {
        log(`  ✅ ${newFile} created! (${readFileSync(newFile).length} bytes)`);
        log(`\n  [file-utils.ts content]\n${readFileSync(newFile, 'utf-8').split('\n').map(l => '  | ' + l).join('\n')}`);
    } else {
        log(`  ❌ ${newFile} NOT created`);
    }

    log(`\n${SEP}`);
    log(`🏁  LIVE RUN DEBUG COMPLETE`);
    log(SEP);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
