/**
 * tool-resolver.ts — Detect Python toolchain (python, ruff, pytest) in the project.
 *
 * Resolves tools from .venv / venv / env / VIRTUAL_ENV, auto-installs
 * missing tools via pip if a venv is present.
 */

import { existsSync } from 'fs';
import { join }       from 'path';
import { spawnSync }  from 'child_process';

export interface ToolSet {
  python: string;        // always set — falls back to 'python' if not resolvable
  ruff:   string | null; // null = not available, lint checking skipped
  pytest: string | null; // null = not available, test execution skipped
}

export function resolveTools(
  projectRoot: string,
  onUpdate: ((data: any) => void) | undefined,
): ToolSet {
  const isWindows = process.platform === 'win32';
  const ext       = isWindows ? '.exe' : '';

  const venvCandidates = ['.venv', 'venv', 'env'];
  const envVarVenv     = process.env['VIRTUAL_ENV'];
  const venvRoot       = envVarVenv && existsSync(envVarVenv)
    ? envVarVenv
    : venvCandidates.map(d => join(projectRoot, d)).find(d => existsSync(d));
  const hasVenv    = !!venvRoot;
  const scriptsDir = venvRoot ? join(venvRoot, isWindows ? 'Scripts' : 'bin') : '';

  const venvPython = venvRoot ? join(scriptsDir, `python${ext}`) : '';
  const python     = hasVenv && existsSync(venvPython) ? venvPython : 'python';
  const pythonOk   = spawnSync(python, ['--version'], { encoding: 'utf-8', timeout: 5000 }).status === 0;
  if (!pythonOk) onUpdate?.({ text: '⚠️ python not found — syntax checking disabled.' });

  const resolveTool = (name: string): string | null => {
    const venvBin = hasVenv ? join(scriptsDir, `${name}${ext}`) : '';

    if (hasVenv && existsSync(venvBin)) {
      if (spawnSync(venvBin, ['--version'], { encoding: 'utf-8', timeout: 5000 }).status === 0)
        return venvBin;
    }

    if (spawnSync(name, ['--version'], { encoding: 'utf-8', timeout: 5000 }).status === 0)
      return name;

    if (hasVenv && pythonOk) {
      onUpdate?.({ text: `⚙️ ${name} not found — installing into .venv...` });
      const pip = spawnSync(python, ['-m', 'pip', 'install', name, '--quiet'],
        { encoding: 'utf-8', timeout: 60000, cwd: projectRoot });
      if (pip.status === 0) {
        onUpdate?.({ text: `✅ ${name} installed in .venv` });
        return existsSync(venvBin) ? venvBin : name;
      }
      onUpdate?.({ text: `⚠️ Failed to install ${name} in .venv — ${name} checking disabled.` });
    } else {
      onUpdate?.({ text: `⚠️ ${name} not found — ${name} checking disabled. Run: pip install ${name}` });
    }
    return null;
  };

  return {
    python: pythonOk ? python : 'python',
    ruff:   resolveTool('ruff'),
    pytest: resolveTool('pytest'),
  };
}
