/**
 * tool-runner.ts — Executes configured format/lint/typecheck tools from .helot-tools.json.
 *
 * Called by task-runner after Builder writes files and before Peltast.
 * All functions are synchronous wrappers over execSync.
 */

import { execSync, spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { ToolConfig } from './env-check.js';

export interface ProcessedFile {
  filePath: string;
  fullPath: string;
  content:  string;
}

/**
 * Run format + lint_fix tools on each written file. Mutates f.content to reflect
 * the on-disk state after formatting so Peltast sees the final result.
 */
export function runFormatLint(
  toolConfig:      ToolConfig,
  filesToProcess:  ProcessedFile[],
  projectRoot:     string,
  onUpdate:        ((data: any) => void) | undefined,
): void {
  const tools = [...(toolConfig.format ?? []), ...(toolConfig.lint_fix ?? [])];
  for (const tool of tools) {
    for (const f of filesToProcess) {
      const cmd = tool.replace(/\{\{file\}\}/g, `"${f.fullPath}"`);
      try {
        execSync(cmd, { cwd: projectRoot, stdio: 'pipe', timeout: 15000 });
      } catch (e: any) {
        const msg = ((e.stderr ?? e.stdout ?? '') + '').toString().slice(0, 200);
        onUpdate?.({ text: `⚠️ ${tool.split(' ')[0]}: ${msg || 'non-zero exit (non-fatal)'}` });
      }
    }
  }
  // Re-read so Peltast sees the formatted content, not the pre-format version
  for (const f of filesToProcess) {
    try { f.content = readFileSync(f.fullPath, 'utf-8'); } catch { }
  }
}

/**
 * Run typecheck_fast commands. Returns an error string on first failure, null if all pass.
 * Skipped if toolConfig has no typecheck_fast entries.
 */
export function runTypecheckFast(
  toolConfig:  ToolConfig,
  projectRoot: string,
  onUpdate:    ((data: any) => void) | undefined,
): string | null {
  const cmds = toolConfig.typecheck_fast ?? [];
  if (cmds.length === 0) return null;

  const errors: string[] = [];
  for (const cmd of cmds) {
    try {
      execSync(cmd, { cwd: projectRoot, stdio: 'pipe', timeout: 30000 });
    } catch (e: any) {
      errors.push(((e.stdout ?? '') + (e.stderr ?? '')).toString().slice(0, 600));
    }
  }
  if (errors.length > 0) return errors.join('\n');
  onUpdate?.({ text: `✓ typecheck_fast: passed` });
  return null;
}

/**
 * Run typecheck_slow commands. Returns an error string on first failure, null if all pass.
 * Skipped if toolConfig has no typecheck_slow entries.
 */
export function runTypecheckSlow(
  toolConfig:  ToolConfig,
  projectRoot: string,
  onUpdate:    ((data: any) => void) | undefined,
): string | null {
  const cmds = toolConfig.typecheck_slow ?? [];
  if (cmds.length === 0) return null;

  for (const cmd of cmds) {
    try {
      execSync(cmd, { cwd: projectRoot, stdio: 'pipe', timeout: 60000 });
    } catch (e: any) {
      const out = ((e.stdout ?? '') + (e.stderr ?? '')).toString().slice(0, 800);
      return out;
    }
  }
  onUpdate?.({ text: `✓ typecheck_slow: passed` });
  return null;
}

/**
 * Run the full test suite at end-of-run.
 * Priority: test_suite from toolConfig → jest (local) → vitest (local) → pytest.
 * Returns an error string on failure, null if all pass or no runner found.
 */
export function runTestSuite(
  toolConfig:  ToolConfig,
  projectRoot: string,
  pytest:      string | null,
  onUpdate:    ((data: any) => void) | undefined,
): string | null {
  // User-configured command takes priority
  if (toolConfig.test_suite?.length) {
    for (const cmd of toolConfig.test_suite) {
      try {
        execSync(cmd, { cwd: projectRoot, stdio: 'pipe', timeout: 120000 });
      } catch (e: any) {
        return ((e.stdout ?? '') + (e.stderr ?? '')).toString().slice(0, 1000);
      }
    }
    onUpdate?.({ text: `✓ test_suite: passed` });
    return null;
  }

  const npx      = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const jestBin  = join(projectRoot, 'node_modules', '.bin', 'jest');
  const vitestBin = join(projectRoot, 'node_modules', '.bin', 'vitest');

  if (existsSync(jestBin)) {
    onUpdate?.({ text: `🧪 End-of-run: jest` });
    const r = spawnSync(npx, ['jest', '--passWithNoTests'], { encoding: 'utf-8', timeout: 120000, cwd: projectRoot });
    if (r.status !== 0) return ((r.stdout ?? '') + (r.stderr ?? '')).slice(0, 1000);
    onUpdate?.({ text: `✓ jest: all tests passed` });
    return null;
  }

  if (existsSync(vitestBin)) {
    onUpdate?.({ text: `🧪 End-of-run: vitest` });
    const r = spawnSync(npx, ['vitest', 'run'], { encoding: 'utf-8', timeout: 120000, cwd: projectRoot });
    if (r.status !== 0) return ((r.stdout ?? '') + (r.stderr ?? '')).slice(0, 1000);
    onUpdate?.({ text: `✓ vitest: all tests passed` });
    return null;
  }

  if (pytest) {
    onUpdate?.({ text: `🧪 End-of-run: pytest` });
    const r = spawnSync(pytest, ['--tb=short', '-q', '--no-header'], { encoding: 'utf-8', timeout: 120000, cwd: projectRoot });
    if (r.status !== 0) return ((r.stdout ?? '') + (r.stderr ?? '')).slice(0, 1000);
    onUpdate?.({ text: `✓ pytest: all tests passed` });
    return null;
  }

  return null; // no test runner found
}
