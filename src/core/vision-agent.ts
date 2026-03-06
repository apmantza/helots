/**
 * vision-agent.ts — Vision workflow: Slinger → Plan → Aristomenis → Approval → Execute.
 *
 * Fully autonomous flow with frontier approval gate.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, relative } from 'path';
import { getAllFiles }    from './file-utils.js';
import { stripThinking } from './text-utils.js';
import { pickName, getGlobalContext } from './persona-utils.js';
import { Aristomenis }   from './governor.js';
import { runTaskLoop }      from './task-loop.js';
import type { SlingerAgent } from './slinger-agent.js';
import type { TaskRunner }   from './task-runner.js';
import type { RunSubagentFn, WriteEventFn } from './types.js';

export class VisionAgent {
  constructor(
    private governor:      Aristomenis,
    private slingerAgent:  SlingerAgent,
    private taskRunner:    TaskRunner,
    private runSubagentFn: RunSubagentFn,
    private writeEventFn:  WriteEventFn,
    private setPhase:      (p: string) => void,
    private getModelProps: () => Promise<{ modelName: string; maxTokens: number }>,
  ) {}

  async executeVision(
    userIntent:        string,
    additionalContext: string | undefined,
    onUpdate?:         (data: any) => void,
  ): Promise<string> {
    const runId = this.governor.getRunId();
    const { modelName } = await this.getModelProps();
    const globalContext = await getGlobalContext();

    const runDir = join(this.governor.config.stateDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const visionFile = join(runDir, 'vision.md');
    const planFile   = join(runDir, 'plan.md');
    const tasksFile  = join(runDir, 'tasks.md');

    // Step 1: Slinger exploration
    this.governor.setPhase('scout');
    onUpdate?.({ text: `🎯 **VISION WORKFLOW**\n\n1️⃣ Slinger exploring codebase...` });

    const slingerResult = await this.slingerAgent.execute(
      `Explore the codebase to understand its structure for: "${userIntent}"\n${additionalContext ? `Context: ${additionalContext}` : ''}\nProvide: file structure overview, key relevant modules, existing patterns to follow.`,
      undefined, onUpdate,
    );

    writeFileSync(visionFile, `# Vision: ${userIntent}\n\n## Slinger Exploration\n${slingerResult}\n\n## Additional Context\n${additionalContext || 'None'}\n`);
    onUpdate?.({ text: `✅ Slinger exploration complete.` });

    // Step 2: High-level plan
    onUpdate?.({ text: `2️⃣ Creating high-level plan...` });

    const plannerSystem = `${globalContext}
You are a Technical Planner. Based on the user's vision and Slinger exploration, create a HIGH-LEVEL plan.

OUTPUT FORMAT:
## Vision
[Brief restatement]

## Approach
[How to achieve this — architectural decisions]

## Files to Modify
[List of files that likely need changes]

## Potential Challenges
[Any risks or considerations]

Respond ONLY with the plan. No code yet.`;

    const planResult = await this.runSubagentFn(
      'Planner', pickName(runId, 'Planner').name,
      plannerSystem, `User Intent: ${userIntent}\n\nSlinger Exploration:\n${slingerResult}`,
      onUpdate, {}, 'THINKING_GENERAL', modelName,
    );

    const planContent = stripThinking(planResult);
    writeFileSync(planFile, planContent);

    // Step 3: Aristomenis detailed tasks
    onUpdate?.({ text: `3️⃣ Aristomenis creating detailed tasks...` });

    const { maxTokens: visionMaxTokens } = await this.getModelProps();
    const fileList = getAllFiles(process.cwd(), this.governor.config.stateDir);
    const manifest = { files: fileList.map(f => ({ path: relative(process.cwd(), f), size: existsSync(f) ? readFileSync(f).length : 0 })) };
    const VISION_MANIFEST_CAP = Math.min(48000, Math.max(16000, Math.floor((visionMaxTokens * 4) * 0.25)));
    const manifestRaw = JSON.stringify(manifest, null, 2).slice(0, VISION_MANIFEST_CAP);
    writeFileSync(join(this.governor.config.stateDir, 'context.json'), manifestRaw);

    const aristomenisSystem = `${globalContext}
You are Aristomenis, the Architect. Translate the high-level plan into SPECIFIC, EXECUTABLE tasks.

SPARTAN TASK FORMAT:
- [ ] 1. Task description (Target: src/path/file.ts, Symbol: functionName, Action: CREATE|EDIT) [DEPENDS: none]

IMPORTANT:
- Each task must have exact file paths from the Project Map
- Use Symbol: to specify the exact function/variable to modify
- Mark dependencies correctly with [DEPENDS: N]`;

    let tasks = await this.runSubagentFn(
      'Aristomenis', pickName(runId, 'Aristomenis').name,
      aristomenisSystem,
      `## High-Level Plan\n${planContent}\n\n## Project Map\n${manifestRaw.slice(0, 10000)}\n\nCreate detailed tasks.`,
      onUpdate, {}, 'THINKING_GENERAL', modelName,
    );

    tasks = stripThinking(tasks);
    if (!tasks.includes('- [ ]')) {
      writeFileSync(join(this.governor.config.stateDir, 'raw-tasks-failure.md'), tasks);
      return `[ERROR] Aristomenis failed to create tasks. Raw: ${tasks.slice(0, 500)}`;
    }

    writeFileSync(tasksFile, tasks);
    this.governor.setPhase('aristomenis');

    const approvalPrompt = `══════════════════════════════════════════════
🎯 **VISION WORKFLOW — APPROVAL REQUIRED**
══════════════════════════════════════════════

## User Intent
${userIntent}

## High-Level Plan
${planContent}

## Detailed Tasks (Aristomenis)
${tasks}

══════════════════════════════════════════════

Options:
- [APPROVE] Proceed with these tasks
- [MODIFY] Provide changes (detail below)
- [ABORT] Stop here

Reply with APPROVE, MODIFY (with details), or ABORT.`;

    onUpdate?.({ text: approvalPrompt });
    return `[📋 APPROVAL REQUIRED]\n\n${approvalPrompt}`;
  }

  async executeApprovedTasks(
    approvalResponse: string,
    modifications?:   string,
    onUpdate?:        (data: any) => void,
  ): Promise<string> {
    const runId = this.governor.getRunId();
    const { modelName } = await this.getModelProps();
    const globalContext = await getGlobalContext();
    const psiloiMetrics = { scout: { in: 0, out: 0, tps: 0 }, builder: { in: 0, out: 0, tps: 0 }, peltast: { in: 0, out: 0, tps: 0 } };

    const runDir    = join(this.governor.config.stateDir, 'runs', runId);
    const tasksFile = join(runDir, 'tasks.md');
    const reviewFile = join(runDir, 'review.md');

    let tasks = readFileSync(tasksFile, 'utf-8');

    if (approvalResponse === 'MODIFY' && modifications) {
      onUpdate?.({ text: `🔄 Applying modifications. Re-running Aristomenis...` });

      const aristomenisSystem = `${globalContext}
You are Aristomenis. The user has provided MODIFICATIONS to the tasks. Apply them and regenerate the task list:
${modifications}`;

      tasks = await this.runSubagentFn(
        'Aristomenis', pickName(runId, 'Aristomenis').name,
        aristomenisSystem, `Original tasks:\n${tasks}\n\nUser modifications:\n${modifications}`,
        onUpdate, {}, 'THINKING_GENERAL', modelName,
      );

      tasks = stripThinking(tasks);
      if (!tasks.includes('- [ ]')) return `[ERROR] Aristomenis failed to apply modifications.`;
      writeFileSync(tasksFile, tasks);
    }

    onUpdate?.({ text: `4️⃣ **APPROVED — Starting Task Execution**\n` });
    this.governor.setPhase('builder');
    writeFileSync(reviewFile, `# Execution Review\nApproval: ${approvalResponse}\n\n`);

    const taskNodes = this.taskRunner.parseChecklist(tasks);
    const halt = await runTaskLoop(
      this.taskRunner, taskNodes, runId, modelName, globalContext, tasks, psiloiMetrics, reviewFile, onUpdate,
    );
    if (halt) return halt;

    this.governor.setPhase('finished');
    onUpdate?.({ text: `✅ All tasks completed!` });
    return this.governor.generateSweepReport();
  }
}
