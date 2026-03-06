/**
 * verification.ts — Ground-truth verification after Builder writes.
 *
 * Runs diff analysis, symbol presence, syntax (py_compile / tsc),
 * lint (ruff), and tests (pytest) against the written files.
 * Returns a structured result for the Peltast tier selector.
 */

import { existsSync, readFileSync, copyFileSync } from 'fs';
import { join }      from 'path';
import * as path     from 'path';
import { spawnSync } from 'child_process';
import { detectLang } from './symbol-utils.js';
import { ToolSet }    from './tool-resolver.js';
import { HelotTask }  from './types.js';

export interface VerificationInput {
  filesToProcess: Array<{ filePath: string; fullPath: string; content: string }>;
  task:           HelotTask;
  isSurgical:     boolean;
  backupBaseDir:  string;
  tools:          ToolSet;
  cwd:            string;
}

export interface VerificationResult {
  groundTruth:       string[];
  hasSyntaxError:    boolean;
  hasContentLoss:    boolean;
  hasNewLintErrors:  boolean;
  hasSymbolMissing:  boolean;
  hasTestFailure:    boolean;
}

export function runVerification(input: VerificationInput): VerificationResult {
  const { filesToProcess, task, isSurgical, backupBaseDir, tools, cwd } = input;
  const groundTruth: string[] = [];

  // --- Diff + content-loss detection ---
  for (const { filePath, fullPath, content } of filesToProcess) {
    const bak = join(backupBaseDir, filePath.replace(/[/\\]/g, '__') + '.bak');
    if (existsSync(bak)) {
      const before = readFileSync(bak, 'utf-8').split('\n');
      const after  = content.split('\n');
      const delta  = after.length - before.length;
      groundTruth.push(`${filePath}: ${delta >= 0 ? '+' : ''}${delta} lines (${before.length} → ${after.length})`);

      if (!isSurgical && before.length > 20 && after.length / before.length < 0.7) {
        const bakLang = detectLang(fullPath);
        let bakIsValid = true;
        if (bakLang === 'python') {
          const bakCheck = spawnSync(tools.python, ['-m', 'py_compile', bak], { encoding: 'utf-8', timeout: 10000 });
          bakIsValid = bakCheck.status === 0;
        }
        if (bakIsValid) {
          groundTruth.push(`⚠️ CONTENT LOSS: file shrank ${Math.round((1 - after.length / before.length) * 100)}% — Builder likely deleted functions it should have kept`);
        } else {
          groundTruth.push(`ℹ️ File shrank ${Math.round((1 - after.length / before.length) * 100)}% but backup had syntax errors (corrupt baseline) — content-loss flag suppressed`);
        }
      }
    } else {
      groundTruth.push(`${filePath}: NEW FILE (${content.split('\n').length} lines)`);
    }
  }

  // --- Symbol presence ---
  if (task.targetSymbol) {
    for (const { filePath, content } of filesToProcess) {
      const found = content.includes(task.targetSymbol);
      groundTruth.push(`Symbol check — "${task.targetSymbol}" in ${filePath}: ${found ? '✅ FOUND' : '❌ MISSING'}`);
    }
  }

  // --- Syntax + lint + tests ---
  for (const { filePath, fullPath } of filesToProcess) {
    const fileLang = detectLang(fullPath);
    const bak      = join(backupBaseDir, filePath.replace(/[/\\]/g, '__') + '.bak');
    try {
      if (fileLang === 'python') {
        const r = spawnSync(tools.python, ['-m', 'py_compile', fullPath], { encoding: 'utf-8', timeout: 10000 });
        groundTruth.push(`Syntax (py_compile): ${r.status === 0 ? '✅ OK' : `❌ ERROR — ${(r.stderr || '').slice(0, 200)}`}`);

        if (tools.ruff) {
          const ruffCheck = spawnSync(tools.ruff, ['check', '--select=E9,F', '--output-format=concise', fullPath], { encoding: 'utf-8', timeout: 10000 });
          const newErrors = (ruffCheck.stdout || '').trim().split('\n').filter(l => l && /:\d+:\d+:\s*[EF]\d+/.test(l));
          if (newErrors.length > 0 && existsSync(bak)) {
            const ruffBak  = spawnSync(tools.ruff, ['check', '--select=E9,F', '--output-format=concise', bak], { encoding: 'utf-8', timeout: 10000 });
            const normErr  = (l: string) => { const m = l.match(/:\d+:\d+:\s*(.+)/); return m ? m[1].trim() : l; };
            const bakErrors = new Set((ruffBak.stdout || '').trim().split('\n').filter(Boolean).map(normErr));
            const skipCodes = (task.skipLintCodes ?? []) as string[];
            const introduced = newErrors.filter(l => {
              if (skipCodes.length > 0) {
                const codeMatch = l.match(/:\s*([EWF]\d+)/);
                if (codeMatch && skipCodes.includes(codeMatch[1])) return false;
              }
              return !bakErrors.has(normErr(l));
            });
            if (introduced.length > 0) {
              groundTruth.push(`Lint (ruff): ❌ ${introduced.length} NEW error(s) — ${introduced.slice(0, 3).join(' | ')}`);
            } else {
              groundTruth.push(`Lint (ruff): ✅ no new errors (${newErrors.length} pre-existing)`);
            }
          } else if (newErrors.length === 0) {
            groundTruth.push(`Lint (ruff): ✅ clean`);
          }
        }

        if (tools.pytest) {
          const base = path.basename(fullPath, '.py');
          const testCandidates = [
            join(cwd, 'tests',                   `test_${base}.py`),
            join(cwd, 'test',                    `test_${base}.py`),
            join(path.dirname(fullPath),          `test_${base}.py`),
            join(path.dirname(fullPath), 'tests', `test_${base}.py`),
          ];
          const testFile = testCandidates.find(p => existsSync(p));
          if (testFile) {
            const res = spawnSync(tools.pytest, ['--tb=short', '-q', '--no-header', testFile],
              { encoding: 'utf-8', timeout: 30000, cwd });
            if (res.status === 0) {
              groundTruth.push(`Tests (pytest): ✅ passed`);
            } else {
              const out = (res.stdout || '').trim().split('\n').slice(0, 8).join(' | ');
              groundTruth.push(`Tests (pytest): ❌ FAILED — ${out.slice(0, 300)}`);
            }
          }
        }

      } else if (fileLang === 'typescript') {
        const tsconfigPath = join(cwd, 'tsconfig.json');
        if (existsSync(tsconfigPath)) {
          const r = spawnSync('npx', ['tsc', '--noEmit', '--skipLibCheck'],
            { encoding: 'utf-8', timeout: 30000, cwd });
          groundTruth.push(`Syntax (tsc): ${r.status === 0 ? '✅ OK' : `❌ ERRORS — ${(r.stdout || '').split('\n').slice(0, 5).join(' | ')}`}`);
        }

        // TS lint: biome check (preferred) or eslint
        const localBiome   = join(cwd, 'node_modules', '.bin', 'biome');
        const localEslint  = join(cwd, 'node_modules', '.bin', 'eslint');
        const hasBiomeJson = existsSync(join(cwd, 'biome.json'));
        const linter       = hasBiomeJson && existsSync(localBiome) ? [localBiome, 'check', fullPath]
                           : existsSync(localEslint)                 ? [localEslint, '--max-warnings=0', fullPath]
                           : null;
        if (linter) {
          const lintNew = spawnSync(linter[0], linter.slice(1), { encoding: 'utf-8', timeout: 20000, cwd });
          const newErrors = (lintNew.stdout + lintNew.stderr).trim().split('\n').filter(l => l.trim() && lintNew.status !== 0);
          if (newErrors.length > 0 && existsSync(bak)) {
            const lintBak = spawnSync(linter[0], [linter[1], bak], { encoding: 'utf-8', timeout: 20000, cwd });
            const bakLines = new Set((lintBak.stdout + lintBak.stderr).trim().split('\n').map(l => l.replace(/:\d+:\d+/, ':?:?').trim()));
            const introduced = newErrors.filter(l => !bakLines.has(l.replace(/:\d+:\d+/, ':?:?').trim()));
            if (introduced.length > 0) {
              groundTruth.push(`Lint (ts): ❌ ${introduced.length} NEW error(s) — ${introduced.slice(0, 3).join(' | ')}`);
            } else {
              groundTruth.push(`Lint (ts): ✅ no new errors`);
            }
          } else if (lintNew.status === 0) {
            groundTruth.push(`Lint (ts): ✅ clean`);
          }
        }
      }
    } catch { /* checks are best-effort */ }
  }

  return {
    groundTruth,
    hasSyntaxError:   groundTruth.some(g => /Syntax.*(❌|ERROR)/.test(g)),
    hasContentLoss:   groundTruth.some(g => g.includes('⚠️ CONTENT LOSS')),
    hasNewLintErrors: groundTruth.some(g => g.includes('Lint (ruff): ❌') || g.includes('Lint (ts): ❌')),
    hasSymbolMissing: groundTruth.some(g => g.includes('Symbol check') && g.includes('❌ MISSING')),
    hasTestFailure:   groundTruth.some(g => g.includes('Tests (pytest): ❌')),
  };
}
