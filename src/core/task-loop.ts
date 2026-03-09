/**
 * task-loop.ts — Sequential task loop orchestration.
 *
 * Iterates a parsed checklist, handling dependencies, blocked tasks,
 * LSP disposal, and escalation. Calls TaskRunner.runOneTask per task.
 */

import type { HelotTask } from './types.js';
import type { TaskRunner } from './task-runner.js';
import { runTestSuite } from './tool-runner.js';

export async function runTaskLoop(
  runner:             TaskRunner,
  taskNodes:          HelotTask[],
  runId:              string,
  modelName:          string,
  globalContext:      string,
  implementationPlan: string,
  psiloiMetrics:      { builder: any; peltast: any },
  reviewFile:         string,
  onUpdate:           ((data: any) => void) | undefined,
  writeTrace:         (data: any) => void = () => {},
): Promise<string | null> {

  runner.governor.state.tasks = taskNodes;
  runner.governor.saveState();

  runner.writeEventFn({
    type: 'task_list',
    tasks: taskNodes.map(t => ({ id: t.id, desc: t.description, file: t.file, status: 'pending' })),
  });

  for (let i = 0; i < taskNodes.length; i++) {
    const task = taskNodes[i];

    const blockers = (task.dependsOn || []).filter(depId => {
      const dep = taskNodes.find(t => t.id === depId);
      return dep && dep.status !== 'completed';
    });

    if (blockers.length > 0) {
      onUpdate?.({ text: `🚫 Task ${task.id} BLOCKED by: ${blockers.join(', ')}` });
      runner.writeEventFn({ type: 'task_status', taskId: task.id, status: 'blocked' });
      task.status = 'blocked';
      runner.governor.state.tasks[i] = task;
      runner.governor.saveState();
      continue;
    }

    runner.setCurrentTaskTitle(task.description);
    runner.writeEventFn({ type: 'task_status', taskId: task.id, status: 'running' });
    onUpdate?.({ text: `🛠️ Task ${task.id}/${taskNodes.length}: ${task.description}` });

    const result = await runner.runOneTask(
      task, runId, modelName, globalContext, implementationPlan,
      psiloiMetrics, reviewFile, onUpdate, taskNodes, writeTrace,
    );

    runner.governor.state.tasks[i] = task;
    runner.governor.saveState();

    if (result.checkpoint) {
      // Builder signalled CHECKPOINT — partial progress made, queue a continuation task
      task.status = 'checkpoint';
      runner.governor.state.tasks[i] = task;
      runner.governor.saveState();
      onUpdate?.({ text: `🔖 Task ${task.id} checkpointed — splicing continuation` });
      runner.writeEventFn({ type: 'task_status', taskId: task.id, status: 'checkpoint' });
      const continuation: HelotTask = {
        id: `${task.id}-cont`,
        description: task.description,
        status: 'pending',
        file: task.file,
        targetSymbol: task.targetSymbol,
        dependsOn: [],  // continuation runs immediately after; original is already applied
        changes: task.changes,
        skipLintCodes: task.skipLintCodes,
        checkpointSummary: result.checkpoint,
      };
      taskNodes.splice(i + 1, 0, continuation);
      runner.governor.state.tasks = taskNodes;
      runner.governor.saveState();
      continue;
    }

    if (!result.passed) {
      task.status = 'failed';
      runner.governor.state.tasks[i] = task;
      runner.governor.saveState();
      onUpdate?.({ text: `❌ Task ${task.id} failed — continuing with independent tasks` });
      runner.writeEventFn({ type: 'task_status', taskId: task.id, status: 'failed' });
      // Don't halt — the blocker check at loop top will skip any tasks that depend on this one
      continue;
    }
  }

  // --- End-of-run test suite ---
  if (runner.toolConfig) {
    const suiteErr = runTestSuite(runner.toolConfig, runner.governor.config.projectRoot, runner.tools.pytest ?? null, onUpdate);
    if (suiteErr) {
      onUpdate?.({ text: `⚠️ End-of-run tests FAILED:\n${suiteErr.slice(0, 400)}` });
      runner.writeEventFn({ type: 'test_suite', result: 'FAIL', output: suiteErr.slice(0, 400) });
    }
  }

  runner.dispose();
  return null;
}
