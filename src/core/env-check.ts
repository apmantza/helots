/**
 * env-check.ts — Pre-flight environment check for helot_run.
 *
 * Reads .helot-tools.json, checks tool availability on PATH,
 * and returns a structured report included in every run response.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface ToolConfig {
  format?:         string[];   // e.g. ["prettier --write {{file}}"]
  lint_fix?:       string[];   // e.g. ["eslint --fix {{file}}"]
  typecheck_fast?: string[];   // e.g. ["tsc --noEmit --pretty false"]
  typecheck_slow?: string[];   // e.g. ["mypy src/"]
  test_suite?:     string[];   // e.g. ["jest --passWithNoTests"] — overrides auto-detect
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

/**
 * Detect the project stack and write a .helot-tools.json on first use.
 * Only fires when the file is absent. Only includes tools found on PATH.
 * Returns the generated config, or null if nothing was detected.
 */
export function bootstrapToolConfig(projectRoot: string): ToolConfig | null {
  const configPath = join(projectRoot, '.helot-tools.json');
  if (existsSync(configPath)) return null;

  const config: ToolConfig = {};

  // TypeScript / JavaScript
  const hasTsConfig   = existsSync(join(projectRoot, 'tsconfig.json'));
  const hasPackageJson = existsSync(join(projectRoot, 'package.json'));
  if (hasPackageJson) {
    if (checkBin('prettier')) config.format        = ['prettier --write {{file}}'];
    if (checkBin('eslint'))   config.lint_fix       = ['eslint --fix {{file}}'];
    if (hasTsConfig && checkBin('tsc')) config.typecheck_fast = ['tsc --noEmit --pretty false'];
  }

  // Python
  const isPython = existsSync(join(projectRoot, 'pyproject.toml'))
                || existsSync(join(projectRoot, 'requirements.txt'))
                || existsSync(join(projectRoot, 'setup.py'));
  if (isPython) {
    const formatter = checkBin('black') ? 'black {{file}}' : checkBin('ruff') ? 'ruff format {{file}}' : null;
    if (formatter) config.format = [...(config.format ?? []), formatter];
    if (checkBin('ruff'))    config.lint_fix       = [...(config.lint_fix ?? []), 'ruff check --fix {{file}}'];
    if (checkBin('pyright')) config.typecheck_fast = [...(config.typecheck_fast ?? []), 'pyright'];
    if (checkBin('mypy'))    config.typecheck_slow = ['mypy src/'];
  }

  // Rust
  if (existsSync(join(projectRoot, 'Cargo.toml'))) {
    if (checkBin('rustfmt')) config.format         = ['rustfmt {{file}}'];
    config.typecheck_fast = ['cargo check'];
    config.typecheck_slow = ['cargo clippy -- -D warnings'];
  }

  // Go
  if (existsSync(join(projectRoot, 'go.mod'))) {
    config.format         = ['gofmt -w {{file}}'];
    config.typecheck_fast = ['go vet ./...'];
    if (checkBin('staticcheck')) config.typecheck_slow = ['staticcheck ./...'];
  }

  if (Object.keys(config).length === 0) return null;

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  } catch {
    return null;
  }

  // Append a one-time note to project CLAUDE.md so Claude knows to review the config
  const claudeMdPath = join(projectRoot, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    try {
      const note = '\n## Helots\n`.helot-tools.json` auto-created from project detection — review and adjust format/lint/typecheck tools as needed.\n';
      const existing = readFileSync(claudeMdPath, 'utf-8');
      if (!existing.includes('.helot-tools.json')) {
        writeFileSync(claudeMdPath, existing + note);
      }
    } catch { /* non-fatal */ }
  }

  return config;
}

export function runEnvCheck(projectRoot: string): EnvReport {
  let toolConfig = loadToolConfig(projectRoot);
  let bootstrapped = false;

  if (Object.keys(toolConfig).length === 0) {
    const generated = bootstrapToolConfig(projectRoot);
    if (generated) { toolConfig = generated; bootstrapped = true; }
  }
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

  if (bootstrapped) {
    warnings.push('.helot-tools.json created from project detection — review and adjust as needed');
  } else if (allTools.length === 0) {
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
