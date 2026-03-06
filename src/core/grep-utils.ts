import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import * as path from 'path';

/**
 * Node.js-native grep — runs without a shell.
 * Avoids PowerShell quoting failures on Windows.
 * Supports: -r/-R (recursive), -n (line numbers), -l (files only),
 *           -i (case insensitive), -E (extended regex), --include=*.ext
 */
export function nodeGrepCommand(command: string, cwd: string): string {
  // Strip leading "grep" and parse flags
  const afterGrep = command.replace(/^grep\s*/, '');
  const flagsMatch = afterGrep.match(/^((?:-[a-zA-Z]+\s+)*)/);
  const flagsStr   = flagsMatch ? flagsMatch[1] : '';
  const flags      = flagsStr.replace(/[\s-]/g, '');
  let   rest       = afterGrep.slice(flagsStr.length).trim();

  // Extract pattern (single-quoted, double-quoted, or bare word)
  let pattern = '';
  const sq = rest.match(/^'((?:[^'\\]|\\.)*)'\s*(.*)/s);
  const dq = rest.match(/^"((?:[^"\\]|\\.)*)"\s*(.*)/s);
  if (sq) { pattern = sq[1]; rest = sq[2]; }
  else if (dq) { pattern = dq[1]; rest = dq[2]; }
  else { const parts = rest.split(/\s+/); pattern = parts[0]; rest = parts.slice(1).join(' '); }

  // Extract all --include patterns (handles '*.ts', "*.ts", *.ts, CLAUDE.md)
  const includeExts: string[] = [];
  for (const m of rest.matchAll(/--include[=\s]['"]?(\*?[^\s'"]+)['"]?/g)) {
    const raw = m[1].replace(/^\*/, ''); // strip leading glob → '.ts', 'CLAUDE.md'
    if (raw) includeExts.push(raw);
  }
  rest = rest.replace(/--include[=\s]['"]?\*?[^\s'"]+['"]?/g, '').trim();

  // Strip surrounding quotes from each path token (single or double)
  const searchPaths = (rest ? rest.split(/\s+/).filter(Boolean) : ['.']).map(p => p.replace(/^['"]|['"]$/g, ''));
  const recursive       = /[rR]/.test(flags);
  const lineNums        = flags.includes('n');
  const filesOnly       = flags.includes('l');
  const caseInsensitive = flags.includes('i');

  // Normalize BRE/GNU alternation \| → | so models using grep BRE syntax work correctly
  const normalizedPattern = pattern.replace(/\\\|/g, '|');
  let regex: RegExp;
  try { regex = new RegExp(normalizedPattern, caseInsensitive ? 'i' : ''); }
  catch { return `(node-grep: invalid regex — ${pattern})`; }

  const results: string[] = [];

  const processFile = (filePath: string) => {
    try {
      const lines = readFileSync(filePath, 'utf-8').split('\n');
      let hit = false;
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          hit = true;
          if (!filesOnly) results.push(lineNums ? `${filePath}:${i + 1}:${lines[i]}` : `${filePath}:${lines[i]}`);
        }
      }
      if (filesOnly && hit) results.push(filePath);
    } catch { /* unreadable file */ }
  };

  const walkDir = (dirPath: string) => {
    try {
      for (const entry of readdirSync(dirPath)) {
        if (entry === 'node_modules' || entry === 'venv' || entry === 'env' || entry === '__pycache__' || entry.startsWith('.')) continue;
        const full = join(dirPath, entry);
        try {
          const st = statSync(full);
          if (st.isDirectory() && recursive) walkDir(full);
          else if (st.isFile() && (!includeExts.length || includeExts.some(ext => full.endsWith(ext)))) processFile(full);
        } catch { /* skip inaccessible */ }
      }
    } catch { /* skip unreadable dir */ }
  };

  for (const p of searchPaths) {
    // Windows drive paths (C:\...) are absolute even if path.isAbsolute misidentifies
    const isAbsPath = path.isAbsolute(p) || /^[A-Za-z]:[/\\]/.test(p);
    const abs = isAbsPath ? p : join(cwd, p);
    try {
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (recursive) walkDir(abs);
        else {
          for (const e of readdirSync(abs)) {
            try { const f = join(abs, e); if (statSync(f).isFile() && (!includeExts.length || includeExts.some(ext => f.endsWith(ext)))) processFile(f); } catch { }
          }
        }
      } else if (st.isFile()) processFile(abs);
    } catch { /* path doesn't exist */ }
  }

  if (results.length === 0) {
    const paths = searchPaths.join(', ');
    const hint = pattern !== normalizedPattern
      ? ` [NOTE: \\| was normalized to | for JS regex — pattern used: /${normalizedPattern}/]`
      : '';
    return `(no matches — searched: ${paths} for /${normalizedPattern}/${caseInsensitive ? 'i' : ''}${hint})`;
  }
  const MAX_LINES = 300;
  return results.length > MAX_LINES
    ? results.slice(0, MAX_LINES).join('\n') + `\n...[node-grep truncated: ${results.length} total matches, showing ${MAX_LINES}]`
    : results.join('\n');
}

/**
 * Count lines in a file (equivalent to wc -l).
 */
export function nodeLineCount(arg: string, cwd: string): string {
  try {
    // Strip -l / -L flags, then unquote
    const cleaned = arg.replace(/^-[lL]\s+/, '').replace(/^['"](.*)['"]$/, '$1').trim();
    const abs = path.isAbsolute(cleaned) || /^[A-Za-z]:[/\\]/.test(cleaned)
      ? cleaned
      : join(cwd, cleaned);
    if (!existsSync(abs)) return `wc: ${cleaned}: No such file`;
    const lines = readFileSync(abs, 'utf-8').split('\n');
    return `${lines.length} ${abs}`;
  } catch (e: any) {
    return `wc error: ${e.message}`;
  }
}
