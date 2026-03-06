/**
 * workflow-engine.ts — Off-frontier workflow executor.
 *
 * Accepts a sequence of helot tool steps and runs them locally,
 * chaining outputs via the filesystem. Returns only a final summary.
 */

import { execSync } from 'child_process';
import type { HelotEngine } from './engine.js';

export interface WorkflowStep {
  id:               string;
  tool:             'slinger' | 'execute' | 'hoplite' | 'shell';
  dependsOn?:       string[];
  // slinger
  researchTask?:    string;
  outputFile?:      string;
  batchDir?:        string;
  maxFilesPerBatch?: number;
  // execute
  scriptFile?:      string;
  script?:          string;
  auditLog?:        string;
  protectedFiles?:  string[];
  remapRules?:      Array<{ pattern: string; dir: string }>;
  pruneRules?:      Array<{ glob: string; dest: string }>;
  // hoplite
  file?:            string;
  instruction?:     string;
  // shell
  command?:         string;
}

export async function executeWorkflow(
  workflowName: string,
  steps:        WorkflowStep[],
  engine:       HelotEngine,
  onUpdate?:    (data: any) => void,
): Promise<string> {
  const results: Record<string, string> = {};
  const errors:  Array<{ stepId: string; error: string }> = [];

  onUpdate?.({ text: `⚙️ Workflow "${workflowName}" — ${steps.length} steps` });

  const ordered = topoSort(steps);

  for (const step of ordered) {
    // Skip if a dependency failed
    const blockedBy = (step.dependsOn ?? []).find(dep => errors.some(e => e.stepId === dep));
    if (blockedBy) {
      const msg = `Skipped — dependency "${blockedBy}" failed`;
      results[step.id] = msg;
      onUpdate?.({ text: `⏭️ [${step.id}] ${msg}` });
      continue;
    }

    onUpdate?.({ text: `▶️ [${step.id}] ${step.tool}...` });
    try {
      let result: string;

      if (step.tool === 'slinger') {
        if (!step.researchTask) throw new Error('slinger step requires researchTask');
        if (step.outputFile) {
          result = await engine.executeScribe(
            step.researchTask, step.outputFile, onUpdate,
            step.batchDir, step.maxFilesPerBatch,
          );
        } else {
          result = await engine.executeSlinger(step.researchTask, undefined, onUpdate);
        }

      } else if (step.tool === 'execute') {
        const script   = step.script ?? '';
        const auditLog = step.auditLog ?? `.helot-mcp-connector/workflow-${workflowName}.log`;
        result = await engine.executeScript(
          script, auditLog, false, step.scriptFile,
          step.protectedFiles, step.remapRules, step.pruneRules,
        );

      } else if (step.tool === 'hoplite') {
        if (!step.file || !step.instruction) throw new Error('hoplite step requires file + instruction');
        result = await engine.executeHoplite(step.file, step.instruction, onUpdate);

      } else if (step.tool === 'shell') {
        if (!step.command) throw new Error('shell step requires command');
        const stdout = String(execSync(step.command, { shell: true } as any));
        result = stdout.trim() || '(no output)';

      } else {
        throw new Error(`Unknown tool: ${(step as any).tool}`);
      }

      results[step.id] = result;
      onUpdate?.({ text: `✅ [${step.id}] done` });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      errors.push({ stepId: step.id, error: msg });
      results[step.id] = `ERROR: ${msg}`;
      onUpdate?.({ text: `❌ [${step.id}] failed: ${msg.slice(0, 100)}` });
    }
  }

  const passed = steps.length - errors.length;
  const lines = [
    `✅ Workflow "${workflowName}": ${passed}/${steps.length} steps passed`,
    ...errors.map(e => `  ❌ ${e.stepId}: ${e.error.slice(0, 120)}`),
    '',
    ...ordered.map(s => `  [${s.id}] ${(results[s.id] ?? '(no result)').slice(0, 120)}`),
  ];
  return lines.join('\n');
}

function topoSort(steps: WorkflowStep[]): WorkflowStep[] {
  const map     = new Map(steps.map(s => [s.id, s]));
  const visited = new Set<string>();
  const order:  WorkflowStep[] = [];

  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const step = map.get(id);
    if (!step) return;
    for (const dep of step.dependsOn ?? []) visit(dep);
    order.push(step);
  };

  for (const step of steps) visit(step.id);
  return order;
}
