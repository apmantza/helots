/**
 * helots-orchestrator.ts — Full Scout → Aristomenis → Builder → Peltast orchestration.
 *
 * Classic flow: Frontier provides the plan, local LLM executes it.
 * Exports a single executeHelots() function that the engine delegates to.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, relative } from 'path';
import { getAllFiles }    from './file-utils.js';
import { stripThinking } from './text-utils.js';
import { pickName, getGlobalContext } from './persona-utils.js';
import { detectLang }    from './symbol-utils.js';
import { resolveTools }  from './tool-resolver.js';
import { runTaskLoop }   from './task-loop.js';
import { runEnvCheck, formatEnvReport } from './env-check.js';
import { WorktreeManager } from './worktree-manager.js';
import { Aristomenis }   from './governor.js';
import type { SlingerAgent } from './slinger-agent.js';
import type { TaskRunner }   from './task-runner.js';
import type { FrontierTask } from './types.js';
import type { RunSubagentFn, WriteEventFn } from './types.js';

export interface OrchestratorDeps {
  governor:      Aristomenis;
  slingerAgent:  SlingerAgent;
  taskRunner:    TaskRunner;
  runSubagentFn: RunSubagentFn;
  writeEventFn:  WriteEventFn;
  setPhase:      (p: string) => void;
  getModelProps: () => Promise<{ modelName: string; maxTokens: number }>;
}

export async function executeHelots(
  taskSummary:        string,
  implementationPlan: string,
  frontierTasks:      FrontierTask[] | undefined,
  deps:               OrchestratorDeps,
  onUpdate?:          (data: any) => void,
): Promise<string> {
  const { governor, slingerAgent, taskRunner, runSubagentFn, writeEventFn, setPhase, getModelProps } = deps;
  const runId = governor.getRunId();
  const { modelName, maxTokens } = await getModelProps();
  const globalContext = await getGlobalContext();
  const psiloiMetrics = { scout: { in: 0, out: 0, tps: 0 }, builder: { in: 0, out: 0, tps: 0 }, peltast: { in: 0, out: 0, tps: 0 } };

  taskRunner.tools = resolveTools(governor.config.projectRoot, onUpdate);
  taskRunner.serverMaxTokens = maxTokens;

  const CHARS_PER_TOKEN = 4;
  const availableChars = Math.floor(maxTokens * 0.85 * CHARS_PER_TOKEN);
  const MANIFEST_CAP = Math.floor(availableChars * 0.35);
  const PLAN_CAP     = Math.floor(availableChars * 0.30);
  const SLINGER_CAP  = Math.floor(availableChars * 0.20);
  onUpdate?.({ text: `📐 Context budget (${maxTokens} tokens): manifest=${Math.round(MANIFEST_CAP/1000)}k  plan=${Math.round(PLAN_CAP/1000)}k  slinger=${Math.round(SLINGER_CAP/1000)}k chars` });

  const cappedPlan = implementationPlan.length > PLAN_CAP
    ? implementationPlan.slice(0, PLAN_CAP) + `\n...[TRUNCATED — plan exceeded ${PLAN_CAP} chars]`
    : implementationPlan;
  if (implementationPlan.length > PLAN_CAP)
    onUpdate?.({ text: `⚠️ Aristomenis: implementationPlan truncated to ${PLAN_CAP} chars.` });

  const isPlanOnly = implementationPlan.includes('[PLAN ONLY]') || implementationPlan.includes('[PLAN ONLY:]');
  governor.setPlanOnly(isPlanOnly);
  if (isPlanOnly) onUpdate?.({ text: `📋 **PLAN ONLY MODE** — Will generate checklist without executing.` });

  const runDir     = join(governor.config.stateDir, 'runs', runId);
  const contextFile  = join(runDir, 'context.json');
  const progressFile = join(runDir, 'progress.md');
  const reviewFile   = join(runDir, 'review.md');
  const traceFile    = join(runDir, 'trace.jsonl');

  const writeTrace = (data: any) => {
    try { appendFileSync(traceFile, JSON.stringify({ ts: new Date().toISOString(), ...data }) + '\n'); } catch { }
  };

  mkdirSync(governor.config.stateDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });

  try { writeFileSync(join(governor.config.stateDir, 'stream.log'), ''); } catch { }
  try { writeFileSync(join(governor.config.stateDir, 'events.jsonl'), ''); } catch { }
  writeEventFn({ type: 'run_start', runId, model: modelName, projectRoot: governor.config.projectRoot });

  // --- ENV CHECK ---
  const envReport = runEnvCheck(governor.config.projectRoot);
  onUpdate?.({ text: formatEnvReport(envReport) });

  // --- WORKTREE ---
  let worktreeBranch: string | undefined;
  const originalProjectRoot = governor.config.projectRoot;
  if (envReport.available.includes('git-worktrees')) {
    try {
      const wm = new WorktreeManager(governor.config.projectRoot);
      worktreeBranch = WorktreeManager.branchName(runId);
      const wtPath = WorktreeManager.worktreePath(governor.config.stateDir, runId);
      wm.create(worktreeBranch, wtPath);
      governor.config.projectRoot = wtPath;
      onUpdate?.({ text: `🌿 Worktree: ${worktreeBranch}` });
    } catch (e: any) {
      worktreeBranch = undefined;
      onUpdate?.({ text: `⚠️ Worktree failed: ${e.message} — running in main tree` });
    }
  }

  // --- 1. SCOUT ---
  const scoutPersona = pickName(runId, 'Scout');
  setPhase('Scout');
  governor.setPhase('scout');
  onUpdate?.({ text: `### 🛡️ ${scoutPersona.name} is scouting\n**Mapping Workspace Territory**\n---\nScanning workspace...` });

  const IGNORE_DIRS = ['node_modules', 'venv', '.venv', '__pycache__', '.git', 'dist', 'build', '.helot', '.helots'];
  const fileList = getAllFiles(governor.config.projectRoot, governor.config.stateDir)
    .filter(f => !IGNORE_DIRS.some(d => f.replace(/\\/g, '/').includes(`/${d}/`)));
  const manifest = { files: fileList.map(f => ({ path: relative(governor.config.projectRoot, f), size: existsSync(f) ? readFileSync(f).length : 0 })) };
  const manifestRaw = JSON.stringify(manifest, null, 2).slice(0, MANIFEST_CAP);
  writeFileSync(contextFile, manifestRaw);
  await writeTrace({ phase: 'scout', status: 'complete', fileCount: fileList.length });

  // --- 2. PRE-SLINGER: symbol scan ---
  governor.setPhase('aristomenis');
  onUpdate?.({ text: `🏹 Pre-Slinger: scanning source symbols...` });
  let preSlingerReport = '';
  const symbolMap: Record<string, string[]> = {};
  try {
    const srcDir = join(governor.config.projectRoot, 'src');
    const SOURCE_EXTS = /\.(py|ts|tsx|js|jsx|mjs|cjs)$/;
    const srcFiles = existsSync(srcDir)
      ? getAllFiles(srcDir, governor.config.stateDir).filter(f => SOURCE_EXTS.test(f)) : [];
    const sigLines: string[] = [];
    for (const absFile of srcFiles) {
      const relFile = relative(governor.config.projectRoot, absFile).replace(/\\/g, '/');
      const fileLang = detectLang(absFile);
      const lines = readFileSync(absFile, 'utf-8').split('\n');
      const fileSymbols: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let m: RegExpMatchArray | null = null;
        if (fileLang === 'python') {
          m = line.match(/^(?:async\s+)?(?:def|class)\s+(\w+)/);
        } else if (fileLang === 'typescript') {
          if (/^\s/.test(line)) continue;
          m = line.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/) ||
              line.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/) ||
              line.match(/^(?:export\s+)?const\s+(\w+)\s*=/);
        }
        if (m) {
          fileSymbols.push(m[1]);
          sigLines.push(`${relFile}:${i + 1}: ${lines.slice(i, Math.min(i + 2, lines.length)).join(' | ')}`);
        }
      }
      if (fileSymbols.length > 0) symbolMap[relFile] = fileSymbols;
    }
    const symbolLines = Object.entries(symbolMap).map(([f, syms]) => `${f}: ${syms.join(', ')}`).join('\n');
    preSlingerReport = `=== SYMBOLS BY FILE ===\n${symbolLines}\n\n=== SIGNATURES ===\n${sigLines.join('\n')}`;
    const totalSymbols = Object.values(symbolMap).flat().length;
    onUpdate?.({ text: `✅ Pre-Slinger: ${srcFiles.length} files, ${totalSymbols} symbols` });
  } catch (e: any) {
    onUpdate?.({ text: `⚠️ Pre-Slinger scan failed: ${e.message}` });
  }

  // --- 3. PLAN: Frontier-planned or Aristomenis ---
  let taskNodes: import('./types.js').HelotTask[];

  if (frontierTasks && frontierTasks.length > 0) {
    setPhase('Architect');
    onUpdate?.({ text: `📋 **Frontier-Planned Mode** — ${frontierTasks.length} tasks (Aristomenis bypassed)` });

    taskNodes = frontierTasks.map(ft => ({
      id: ft.id, description: ft.description, status: 'pending' as const,
      file: ft.file, targetSymbol: ft.symbol, dependsOn: ft.dependsOn ?? [], changes: ft.changes,
    }));

    if (Object.keys(symbolMap).length > 0) {
      const allValidSymbols = new Set(Object.values(symbolMap).flat());
      for (const task of taskNodes) {
        if (task.targetSymbol && !allValidSymbols.has(task.targetSymbol)) {
          onUpdate?.({ text: `⚠️ Symbol "${task.targetSymbol}" (Task ${task.id}) not in codebase — clearing for full-file mode.` });
          task.targetSymbol = undefined;
        }
      }
    }

    const syntheticChecklist = taskNodes
      .map(t => `- [ ] ${t.id}. ${t.description} (Target: ${t.file}, Symbol: ${t.targetSymbol ?? 'N/A'}, Action: EDIT) [DEPENDS: ${t.dependsOn?.join(', ') || 'none'}]`)
      .join('\n');
    writeFileSync(progressFile, syntheticChecklist);
    onUpdate?.({ text: `📋 **Task List:**\n${syntheticChecklist}` });
    await writeTrace({ phase: 'aristomenis', status: 'bypassed_frontier_planned' });
    governor.setPhase('builder');

  } else {
    const aristomenisSystem = `${globalContext}
You are Aristomenis, the Architect. DESIGN the technical implementation checklist with SPARTAN SIMPLICITY.

TASK FORMAT — CRITICAL: every task MUST start with "- [ ]":
- [ ] 1. Create greeting utility (Target: src/core/greeting.ts, Action: CREATE) [DEPENDS: none]
- [ ] 2. Wire greeting into scout (Target: src/core/scout.ts, Symbol: getSymbolSlice, Action: EDIT) [DEPENDS: 1] [CHANGES: add \`import { greet } from './greeting.js'\` at top; call greet() before return inside getSymbolSlice]

SYMBOL RULE: Symbol must be an EXISTING function or class from the VALID SYMBOLS list. Do not invent names.
CREATE RULE: One task per new file. Builder writes the complete file in one shot.
CHANGES RULE: For every EDIT task, add [CHANGES: ...] describing exactly what to add, remove, or modify — specific lines, imports, or logic. For CREATE tasks, omit [CHANGES].
FORBIDDEN: tasks like "open file", "locate pattern", "verify", "run tests" — every task must write a file.

RESPOND ONLY WITH THE CHECKLIST. DO NOT USE PLACEHOLDERS.`;

    setPhase('Architect');
    onUpdate?.({ text: `[Aristomenis] Designing implementation strategy...` });

    const cappedSlingerReport = preSlingerReport.slice(0, SLINGER_CAP);
    let checklist = await runSubagentFn('Aristomenis', 'Aristomenis', aristomenisSystem,
      `Project Map: ${manifestRaw}\n\nVALID SYMBOLS (use ONLY these for Symbol: field):\n${cappedSlingerReport}\n\nFrontier Plan: ${cappedPlan}`,
      onUpdate, {}, 'INSTRUCT_GENERAL', modelName);

    if (checklist.includes('NEED MORE DATA:')) {
      const query = checklist.split('NEED MORE DATA:')[1].trim();
      onUpdate?.({ text: `🏹 Aristomenis requested data. Deploying Slinger...` });
      const slingerReport = await slingerAgent.execute(query, undefined, onUpdate);
      checklist = await runSubagentFn('Aristomenis', 'Aristomenis', aristomenisSystem,
        `RE-PLANNING with Slinger Report:\n${slingerReport}\n\nProject Map: ${manifestRaw}\n\nFrontier Plan: ${cappedPlan}`,
        onUpdate, {}, 'INSTRUCT_GENERAL', modelName);
    }

    checklist = stripThinking(checklist);
    if (!checklist.includes('- [ ]')) {
      const rawPlanFile = join(governor.config.stateDir, 'raw-plan-failure.md');
      writeFileSync(rawPlanFile, checklist);
      await writeTrace({ phase: 'aristomenis', status: 'failed_malformed' });
      return `[ERROR] Aristomenis produced a malformed checklist.\n\nOptions:\n- [RETRY] Try again\n- [ABORT] Stop here\n\nRaw output saved to ${rawPlanFile}`;
    }

    onUpdate?.({ text: `📋 **Spartan Checklist Generated:**\n${checklist}` });
    writeFileSync(progressFile, checklist);

    if (governor.isPlanOnly()) {
      await writeTrace({ phase: 'aristomenis', status: 'plan_only' });
      governor.setPhase('finished');
      return `[PLAN ONLY] ✅ Checklist drafted. Call again without [PLAN ONLY] to execute.\n\n${checklist}`;
    }
    await writeTrace({ phase: 'aristomenis', status: 'complete' });
    governor.setPhase('builder');

    taskNodes = taskRunner.parseChecklist(checklist);

    if (taskNodes.length === 0) {
      const rawPlanFile = join(governor.config.stateDir, 'raw-plan-failure.md');
      writeFileSync(rawPlanFile, checklist);
      await writeTrace({ phase: 'aristomenis', status: 'failed_empty_parse' });
      return `[ERROR] Aristomenis checklist parsed to zero tasks.\n\nOptions:\n- [RETRY] Try again\n- [ABORT] Stop here\n\nRaw output saved to ${rawPlanFile}`;
    }

    if (Object.keys(symbolMap).length > 0) {
      const allValidSymbols = new Set(Object.values(symbolMap).flat());
      for (const task of taskNodes) {
        if (task.targetSymbol && !allValidSymbols.has(task.targetSymbol)) {
          onUpdate?.({ text: `⚠️ Plan validation: symbol "${task.targetSymbol}" (Task ${task.id}) not a real symbol — clearing.` });
          task.targetSymbol = undefined;
        }
      }
    }
  }

  writeFileSync(reviewFile, `# Aristomenis Review Report\nPlan: ${taskSummary}\n\n`);

  const halt = await runTaskLoop(taskRunner, taskNodes, runId, modelName, globalContext, cappedPlan, psiloiMetrics, reviewFile, onUpdate, writeTrace);
  governor.config.projectRoot = originalProjectRoot;
  if (halt) return halt;

  const passed = taskNodes.filter(t => t.status === 'completed').length;
  const failed = taskNodes.filter(t => t.status === 'failed').length;
  writeEventFn({ type: 'run_end', passed, failed });
  onUpdate?.({ text: `✅ Execution complete! ${passed}/${taskNodes.length} tasks passed.` });
  governor.setPhase('finished');

  const branchLine = worktreeBranch
    ? `\nBranch: \`${worktreeBranch}\` — merge when ready, or discard: git branch -D ${worktreeBranch}`
    : '';

  const failedTasks = taskNodes.filter(t => t.status === 'failed');
  if (failed > 0) {
    const details = failedTasks.map(t => `Task ${t.id} (${t.description.slice(0, 60)})`).join(', ');
    return `⚠️ ${passed}/${taskNodes.length} tasks passed. Failed: ${details}. Run ID: ${runId}${branchLine}\nSee .helot-mcp-connector/runs/${runId}/ for details.`;
  }
  return `✅ ${passed}/${taskNodes.length} tasks passed. Run ID: ${runId}${branchLine}`;
}
