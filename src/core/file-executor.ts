import { appendFileSync, readdirSync, statSync, mkdirSync, rmdirSync, renameSync, copyFileSync, readFileSync } from 'fs';
import * as path from 'path';
import { join } from 'path';

export function listFilesRecursive(dir: string, exclude = ['node_modules', '.git', '__pycache__']): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (exclude.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...listFilesRecursive(full, exclude));
      else results.push(full);
    }
  } catch {}
  return results;
}

export function deriveProtectedFiles(): Set<string> {
  const protect = new Set<string>(['.gitignore', 'README.md', 'CLAUDE.md']);

  const addBase = (v: string) => {
    const base = path.basename(v);
    protect.add(base);
    protect.add(base.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts'));
  };

  // Node / TypeScript
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    protect.add('package.json'); protect.add('package-lock.json'); protect.add('yarn.lock'); protect.add('pnpm-lock.yaml');
    for (const f of ['main', 'types', 'typings', 'module']) if (pkg[f]) addBase(pkg[f]);
    if (pkg.bin) (typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin) as string[]).forEach(addBase);
    if (Array.isArray(pkg.files)) pkg.files.forEach((f: string) => addBase(f));
    if (pkg.scripts) for (const cmd of Object.values(pkg.scripts) as string[])
      for (const word of cmd.split(/\s+/))
        if (/\.(ts|js|mjs|cjs|json|sh|py)$/.test(word) && !word.startsWith('-')) addBase(word);
  } catch {}
  try {
    const tsc = JSON.parse(readFileSync('tsconfig.json', 'utf-8'));
    protect.add('tsconfig.json');
    if (Array.isArray(tsc.files)) tsc.files.forEach((f: string) => addBase(f));
    if (Array.isArray(tsc.include)) tsc.include.forEach((p: string) => { if (!p.includes('/') && !p.includes('*')) protect.add(p); });
  } catch {}

  // Python
  for (const f of ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'Pipfile.lock', 'poetry.lock']) {
    try { readFileSync(f); protect.add(f); } catch {}
  }

  // Rust
  try { readFileSync('Cargo.toml'); protect.add('Cargo.toml'); protect.add('Cargo.lock'); } catch {}

  // Go
  try { readFileSync('go.mod'); protect.add('go.mod'); protect.add('go.sum'); } catch {}

  // Java / Kotlin / Gradle / Maven
  for (const f of ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradlew', 'mvnw']) {
    try { readFileSync(f); protect.add(f); } catch {}
  }

  // Generic build/make
  for (const f of ['Makefile', 'CMakeLists.txt', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml']) {
    try { readFileSync(f); protect.add(f); } catch {}
  }

  // Source-code scan: protect root files referenced as quoted string literals in src/**
  try {
    const rootFiles = readdirSync('.').filter(f => { try { return statSync(f).isFile(); } catch { return false; } });
    const srcFiles = listFilesRecursive('src').filter(f => f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.mjs'));
    for (const rootFile of rootFiles) {
      const base = path.basename(rootFile);
      if (protect.has(base)) continue;
      const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const quotedRef = new RegExp(`['"\`]${escaped}['"\`]`);
      for (const src of srcFiles) {
        try { if (quotedRef.test(readFileSync(src, 'utf-8'))) { protect.add(base); break; } } catch {}
      }
    }
  } catch {}

  return protect;
}

export function expandPruneRules(
  rules: Array<{ glob: string; dest: string }>,
  protectedSet: Set<string>,
): Array<{ src: string; dst: string }> {
  const moves: Array<{ src: string; dst: string }> = [];
  for (const rule of rules) {
    const g = rule.glob.replace(/\\/g, '/');
    const recursive = g.endsWith('/**');
    const dirGlob   = g.endsWith('/*') || recursive;
    const dir       = dirGlob ? g.replace(/\/\*\*?$/, '') : path.dirname(g);
    const extMatch  = !dirGlob ? path.basename(g) : null;

    try {
      const files = dirGlob
        ? listFilesRecursive(dir)
        : readdirSync('.').filter(f => {
            if (!extMatch) return false;
            const re = new RegExp('^' + extMatch.replace('.', '\\.').replace('*', '.*') + '$');
            return re.test(f) && statSync(f).isFile();
          }).map(f => path.join('.', f));

      for (const src of files) {
        const base = path.basename(src);
        if (protectedSet.has(base) || base.startsWith('.')) continue;
        moves.push({ src, dst: join(rule.dest, base) });
      }
    } catch {}
  }
  return moves;
}

export async function executeScript(
  script:          string,
  auditLog:        string,
  dryRun:          boolean = false,
  scriptFile?:     string,
  protectedFiles?: string[],
  remapRules?:     Array<{ pattern: string; dir: string }>,
  pruneRules?:     Array<{ glob: string; dest: string }>,
): Promise<string> {
  const content = scriptFile ? readFileSync(scriptFile, 'utf-8') : script;

  const stripShellIdioms = (l: string) => l
    .replace(/\s*2>\/dev\/null/g, '')
    .replace(/\s*\|\|\s*true\b/g, '')
    .replace(/\s*&&\s*true\b/g, '')
    .trim();
  const lines = content.split('\n').map(l => stripShellIdioms(l.trim())).filter(l => l && !l.startsWith('#'));

  const ALLOWED  = new Set(['mv', 'mkdir', 'cp', 'rmdir']);
  const BLOCKED  = [/\.\./, /[;&|`$]/, /\s-rf\b/, /\brm\b/, /\bdel\b/];
  const ts = () => new Date().toISOString();

  const protectedSet: Set<string> = (protectedFiles?.includes('auto'))
    ? deriveProtectedFiles()
    : new Set(protectedFiles ?? []);

  try { mkdirSync(path.dirname(auditLog), { recursive: true }); } catch {}

  const results: string[] = [];
  const log = (entry: string) => {
    results.push(entry);
    try { appendFileSync(auditLog, entry + '\n', 'utf-8'); } catch {}
  };

  if (pruneRules?.length) {
    const pruneOps = expandPruneRules(pruneRules, protectedSet);
    for (const { src, dst } of pruneOps) {
      if (dryRun) { log(`[${ts()}] DRY-RUN (prune): mv ${src} → ${dst}`); continue; }
      try {
        mkdirSync(path.dirname(dst), { recursive: true });
        renameSync(src, dst);
        log(`[${ts()}] OK (prune): mv ${src} → ${dst}`);
      } catch (err: any) {
        log(`[${ts()}] ERROR (prune): mv ${src} → ${dst} — ${err.message}`);
      }
    }
  }

  for (const line of lines) {
    const parts = line.split(/\s+/);
    const cmd   = parts[0];

    if (!ALLOWED.has(cmd)) { log(`[${ts()}] BLOCKED: "${line}" — command not in allowlist`); continue; }
    if (BLOCKED.some(p => p.test(line))) { log(`[${ts()}] BLOCKED: "${line}" — unsafe pattern detected`); continue; }

    if ((cmd === 'mv' || cmd === 'cp') && parts[1] && remapRules?.length) {
      const srcBase = path.basename(parts[1]);
      for (const rule of remapRules) {
        if (new RegExp(rule.pattern, 'i').test(srcBase)) {
          const newDst = join(rule.dir, srcBase);
          log(`[${ts()}] REMAP: ${parts[1]} → ${newDst} (matched rule: ${rule.pattern})`);
          parts[2] = newDst;
          break;
        }
      }
    }

    if ((cmd === 'mv' || cmd === 'cp') && parts[1]) {
      const srcBase = path.basename(parts[1]);
      if (srcBase.startsWith('.')) { log(`[${ts()}] PROTECTED: "${line}" — dotfile`); continue; }
      if (protectedSet.has(srcBase) || protectedSet.has(parts[1])) {
        log(`[${ts()}] PROTECTED: "${line}" — referenced by package.json/tsconfig.json`); continue;
      }
    }

    if (dryRun) {
      if (cmd === 'mv' || cmd === 'cp') {
        let dst = parts[2] ?? '';
        if (dst.endsWith('/') || dst.endsWith('\\')) dst = join(dst, path.basename(parts[1]));
        log(`[${ts()}] DRY-RUN: ${cmd} ${parts[1]} → ${dst}`);
      } else {
        log(`[${ts()}] DRY-RUN: ${line}`);
      }
      continue;
    }

    try {
      if (cmd === 'mkdir') {
        mkdirSync(parts[parts.length - 1], { recursive: true });
        log(`[${ts()}] OK: mkdir ${parts[parts.length - 1]}`);
      } else if (cmd === 'mv') {
        let dst = parts[2];
        try { if (statSync(dst).isDirectory()) dst = join(dst, path.basename(parts[1])); } catch {}
        if (dst.endsWith('/') || dst.endsWith('\\')) dst = join(dst, path.basename(parts[1]));
        renameSync(parts[1], dst);
        log(`[${ts()}] OK: mv ${parts[1]} → ${dst}`);
      } else if (cmd === 'cp') {
        let dst = parts[2];
        try { if (statSync(dst).isDirectory()) dst = join(dst, path.basename(parts[1])); } catch {}
        if (dst.endsWith('/') || dst.endsWith('\\')) dst = join(dst, path.basename(parts[1]));
        copyFileSync(parts[1], dst);
        log(`[${ts()}] OK: cp ${parts[1]} → ${dst}`);
      } else if (cmd === 'rmdir') {
        const dir = parts[1];
        const entries = readdirSync(dir);
        if (entries.length > 0) {
          log(`[${ts()}] BLOCKED: rmdir ${dir} — directory not empty (${entries.length} items)`);
        } else {
          rmdirSync(dir);
          log(`[${ts()}] OK: rmdir ${dir}`);
        }
      }
    } catch (err: any) {
      log(`[${ts()}] ERROR: ${line} — ${err.message}`);
    }
  }

  const tag = dryRun ? ' (dry-run)' : '';
  return `✅ helot_execute: ${results.length} operations${tag} → audit: ${auditLog}\n\n${results.join('\n')}`;
}
