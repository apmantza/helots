/**
 * run-reporter.ts — Formats the final helot_run result into a structured markdown report.
 * Replaces the plain string returns in helots-orchestrator with actionable output.
 */

import type { HelotTask } from './types.js';
import type { EnvReport } from './env-check.js';

export interface RunReportData {
  taskSummary:    string;
  runId:          string;
  taskNodes:      HelotTask[];
  envReport:      EnvReport;
  worktreeBranch: string | undefined;
}

export function formatRunReport(data: RunReportData): string {
  const { taskSummary, runId, taskNodes, envReport, worktreeBranch } = data;
  const passed = taskNodes.filter(t => t.status === 'completed').length;
  const failed = taskNodes.filter(t => t.status === 'failed').length;
  const lines: string[] = [];

  lines.push(`## Run Report — ${taskSummary}`);
  if (worktreeBranch) {
    lines.push(`Branch: \`${worktreeBranch}\``);
  }
  lines.push(`Run ID: \`${runId}\``);
  lines.push('');

  // Environment summary (compact)
  const envParts: string[] = [];
  if (envReport.available.length > 0) envParts.push(`✅ ${envReport.available.join(', ')}`);
  if (envReport.missing.length > 0)   envParts.push(`⚠️ missing: ${envReport.missing.join(', ')}`);
  if (envReport.warnings.length > 0)  envParts.push(`ℹ️ ${envReport.warnings[0]}`);
  if (envParts.length > 0) lines.push(`**Env:** ${envParts.join('  ')}`);
  lines.push('');

  // Per-task results
  lines.push('### Results');
  for (const task of taskNodes) {
    const icon = task.status === 'completed' ? '✅' : task.status === 'failed' ? '❌' : '⏳';
    const fileRef = task.file ? ` \`${task.file}\`` : '';
    lines.push(`${icon} **${task.id}** — ${task.description.slice(0, 80)}${fileRef}`);
  }
  lines.push('');
  lines.push(`**${passed}/${taskNodes.length} tasks passed.**`);

  // Suggested actions
  lines.push('');
  lines.push('### Actions');
  if (worktreeBranch) {
    lines.push(`- Review: \`git diff main..${worktreeBranch}\``);
    if (failed === 0) {
      lines.push(`- Merge:  \`git merge ${worktreeBranch}\``);
    } else {
      lines.push(`- Re-run failed tasks or merge passing subset`);
    }
    lines.push(`- Discard: \`git branch -D ${worktreeBranch}\``);
  }
  if (failed > 0) {
    const failedIds = taskNodes.filter(t => t.status === 'failed').map(t => t.id).join(', ');
    lines.push(`- Failed task details: \`.helot-mcp-connector/runs/${runId}/\``);
    lines.push(`- Failed: ${failedIds}`);
  }

  return lines.join('\n');
}
