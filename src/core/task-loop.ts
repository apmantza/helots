/**
 * task-loop.ts — Sequential task loop orchestration.
 *
 * Iterates a parsed checklist, handling dependencies, blocked tasks,
 * LSP disposal, and escalation. Calls TaskRunner.runOneTask per task.
 */

import type { HelotTask } from './types.js';
import type { TaskRunner } from './task-runner.js';

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

    if (result.escalation) {
      runner.dispose();
      return `[ESCALATION] ${result.escalation}`;
    }
    if (!result.passed) {
      runner.dispose();
      return `Pipeline halted at Task ${task.id}: ${task.description}`;
    }
  }

  runner.dispose();
  return null;
}
