/**
 * env-check.ts — Pre-flight environment check for helot_run.
 *
 * Reads .helot-tools.json, checks tool availability on PATH,
 * and returns a structured report included in every run response.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface ToolConfig {
  format?:         string[];   // e.g. ["prettier --write {{file}}"]
  lint_fix?:       string[];   // e.g. ["eslint --fix {{file}}"]
  typecheck_fast?: string[];   // e.g. ["tsc --noEmit --pretty false"]
  typecheck_slow?: string[];   // e.g. ["mypy src/"]
}

export interface EnvReport {
  available:  string[];
  missing:    string[];
  warnings:   string[];
  toolConfig: ToolConfig;
}

export function loadToolConfig(projectRoot: string): ToolConfig {
  const configPath = join(projectRoot, '.helot-tools.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

function checkBin(bin: string): boolean {
  try {
    execSync(`${bin} --version`, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function gitWorktreeSupported(): boolean {
  try {
    const out = execSync('git --version', { encoding: 'utf-8', timeout: 5000 });
    const m = out.match(/(\d+)\.(\d+)/);
    if (!m) return false;
    return parseInt(m[1]) > 2 || (parseInt(m[1]) === 2 && parseInt(m[2]) >= 5);
  } catch {
    return false;
  }
}

export function runEnvCheck(projectRoot: string): EnvReport {
  const toolConfig = loadToolConfig(projectRoot);
  const available: string[] = [];
  const missing:   string[] = [];
  const warnings:  string[] = [];

  if (gitWorktreeSupported()) {
    available.push('git-worktrees');
  } else {
    missing.push('git >= 2.5 (worktrees disabled)');
  }

  const allTools = [
    ...(toolConfig.format         ?? []),
    ...(toolConfig.lint_fix       ?? []),
    ...(toolConfig.typecheck_fast ?? []),
    ...(toolConfig.typecheck_slow ?? []),
  ];

  const seen = new Set<string>();
  for (const tool of allTools) {
    const bin = tool.split(' ')[0];
    if (seen.has(bin)) continue;
    seen.add(bin);
    (checkBin(bin) ? available : missing).push(bin);
  }

  if (allTools.length === 0) {
    warnings.push('no .helot-tools.json — format/lint/typecheck steps skipped (create one to enable)');
  }

  return { available, missing, warnings, toolConfig };
}

export function formatEnvReport(report: EnvReport): string {
  const lines = ['### Environment'];
  if (report.available.length > 0) lines.push(`✅ ${report.available.join(', ')}`);
  for (const m of report.missing)  lines.push(`⚠️  ${m} — step skipped`);
  for (const w of report.warnings) lines.push(`ℹ️  ${w}`);
  return lines.join('\n');
}
