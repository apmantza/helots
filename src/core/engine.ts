/**
 * engine.ts — HelotEngine: thin coordinator for all helot agents.
 *
 * Instantiates agents, owns runSubagent + writeEvent, delegates
 * public methods to the appropriate agent or orchestrator.
 */

import { appendFileSync, readdirSync, statSync, mkdirSync, rmdirSync, renameSync, copyFileSync, readFileSync } from 'fs';
import * as path from 'path';
import { join } from 'path';
import { LlamaClient }       from './llama-client.js';
import { HelotConfig, TaskRole } from '../config.js';
import { Aristomenis }       from './governor.js';
import { SlingerAgent }      from './slinger-agent.js';
import { HopliteAgent }      from './hoplite-agent.js';
import { VisionAgent }       from './vision-agent.js';
import { TaskRunner }        from './task-runner.js';
import { executeHelots as _executeHelots } from './helots-orchestrator.js';
import type { HelotTask, HelotState, HelotContext, RunSubagentFn, WriteEventFn } from './types.js';
import type { FrontierTask } from './types.js';

// Re-export types for consumers who import from engine
export type { HelotTask, HelotState, HelotContext };

export class HelotEngine {
  private governor:           Aristomenis;
  private client:             LlamaClient;
  private slingerAgent:       SlingerAgent;
  private hopliteAgent:       HopliteAgent;
  private visionAgent:        VisionAgent;
  private taskRunner:         TaskRunner;
  private currentPhase:       string = 'Setup';
  private currentTaskTitle:   string = '';
  private sessionTotalTokens: number = 0;

  constructor(config: HelotConfig) {
    this.governor = new Aristomenis(config);
    this.client   = new LlamaClient(config);

    const runSubagentFn: RunSubagentFn = this.runSubagent.bind(this);
    const writeEventFn:  WriteEventFn  = this.writeEvent.bind(this);
    const setPhase     = (p: string) => { this.currentPhase = p; };
    const setTaskTitle = (t: string) => { this.currentTaskTitle = t; };
    const getModelProps = () => this.client.getProps();

    this.taskRunner   = new TaskRunner(this.governor, runSubagentFn, writeEventFn, setPhase, setTaskTitle, getModelProps);
    this.slingerAgent = new SlingerAgent(this.governor, runSubagentFn, writeEventFn, setPhase, getModelProps);
    this.hopliteAgent = new HopliteAgent(this.governor, runSubagentFn, writeEventFn, setPhase, getModelProps);
    this.visionAgent  = new VisionAgent(this.governor, this.slingerAgent, this.taskRunner, runSubagentFn, writeEventFn, setPhase, getModelProps);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async executeHelots(
    taskSummary:        string,
    implementationPlan: string,
    onUpdate?:          (data: any) => void,
    frontierTasks?:     FrontierTask[],
  ): Promise<string> {
    this.sessionTotalTokens = 0;
    return _executeHelots(taskSummary, implementationPlan, frontierTasks, {
      governor:      this.governor,
      slingerAgent:  this.slingerAgent,
      taskRunner:    this.taskRunner,
      runSubagentFn: this.runSubagent.bind(this),
      writeEventFn:  this.writeEvent.bind(this),
      setPhase:      (p: string) => { this.currentPhase = p; },
      getModelProps: () => this.client.getProps(),
    }, onUpdate);
  }

  async executeSlinger(
    researchTask: string,
    targetFiles?: string[],
    onUpdate?:    (data: any) => void,
  ): Promise<string> {
    return this.slingerAgent.execute(researchTask, targetFiles, onUpdate);
  }

  async executeHoplite(
    file:        string,
    instruction: string,
    onUpdate?:   (data: any) => void,
  ): Promise<string> {
    return this.hopliteAgent.execute(file, instruction, onUpdate);
  }

  async executeScribe(
    researchTask:    string,
    outputFile:      string,
    onUpdate?:       (data: any) => void,
    batchDir?:       string,
    maxFilesPerBatch: number = 8,
  ): Promise<string> {
    // Phase 1: initial research → write base doc
    onUpdate?.({ text: `🔍 Scribe | researching...` });
    const research = await this.slingerAgent.execute(researchTask, undefined, onUpdate);
    onUpdate?.({ text: `✍️ Scribe | writing ${outputFile}...` });
    // Cap research passed to hoplite to avoid OOM — ~6k chars ≈ 1500 tokens
    const researchCapped = research.length > 6000 ? research.slice(0, 6000) + '\n\n[...truncated for context budget]' : research;
    await this.hopliteAgent.execute(outputFile,
      `Based on this research, write a clean well-formatted markdown document:\n\n${researchCapped}`,
      onUpdate);

    if (!batchDir) return `✅ Scribe done → ${outputFile}`;

    // Phase 2: dynamic batching based on actual server context size
    const { maxTokens } = await this.client.getProps();
    // Reserve 60% for system prompt + task description + slinger response
    const tokenBudget = Math.floor(maxTokens * 0.4);
    onUpdate?.({ text: `📚 Scribe | ctx=${maxTokens} → token budget per batch: ~${tokenBudget}` });

    const files = this.listFilesRecursive(batchDir);
    const batches: string[][] = [];
    let current: string[] = [];
    let currentTokens = 0;

    for (const file of files) {
      const estimatedTokens = Math.ceil(this.estimateFileTokens(file));
      if (current.length > 0 && (currentTokens + estimatedTokens > tokenBudget || current.length >= maxFilesPerBatch)) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(file);
      currentTokens += estimatedTokens;
    }
    if (current.length > 0) batches.push(current);

    onUpdate?.({ text: `📚 Scribe | ${files.length} files → ${batches.length} dynamic batches` });

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchTokens = batch.reduce((sum, f) => sum + this.estimateFileTokens(f), 0);
      onUpdate?.({ text: `📖 Scribe | batch ${i + 1}/${batches.length} (${batch.length} files, ~${batchTokens} tokens): ${batch.map(f => path.basename(f)).join(', ')}` });

      const summaries = await this.slingerAgent.execute(
        `Read each file and write a one-paragraph summary of what it does.\nFormat as: ### <filename>\n<summary>\n\nFiles:\n${batch.join('\n')}`,
        batch,
        onUpdate,
      );

      const section = i === 0
        ? '\n\n## Source File Summaries\n\n' + summaries
        : '\n\n' + summaries;
      appendFileSync(outputFile, section, 'utf-8');
      onUpdate?.({ text: `✅ Scribe | batch ${i + 1}/${batches.length} appended` });
    }

    return `✅ Scribe done → ${outputFile} (${files.length} files in ${batches.length} batches)`;
  }

  private estimateFileTokens(filePath: string): number {
    try { return Math.ceil(statSync(filePath).size / 4); } catch { return 1000; }
  }

  private listFilesRecursive(dir: string, exclude = ['node_modules', '.git', '__pycache__']): string[] {
    const results: string[] = [];
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (exclude.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...this.listFilesRecursive(full, exclude));
        else results.push(full);
      }
    } catch {}
    return results;
  }

  async executeVision(
    userIntent:         string,
    additionalContext?: string,
    onUpdate?:          (data: any) => void,
  ): Promise<string> {
    return this.visionAgent.executeVision(userIntent, additionalContext, onUpdate);
  }

  async executeApprovedTasks(
    approvalResponse: string,
    modifications?:   string,
    onUpdate?:        (data: any) => void,
  ): Promise<string> {
    return this.visionAgent.executeApprovedTasks(approvalResponse, modifications, onUpdate);
  }

  getStatus(): { phase: string; taskTitle: string; sessionTokens: number } {
    return {
      phase:         this.governor.getPhase(),
      taskTitle:     this.currentTaskTitle,
      sessionTokens: this.sessionTotalTokens,
    };
  }

  private deriveProtectedFiles(): Set<string> {
    const protect = new Set<string>(['.gitignore', 'README.md', 'CLAUDE.md']);

    const addBase = (v: string) => {
      const base = path.basename(v);
      protect.add(base);
      // Protect TypeScript source counterpart of compiled JS entry points
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

    // Source-code scan: protect any root-level file whose basename appears as a
    // string literal in src/**/*.ts (catches hardcoded path references like
    // `path.join(root, 'watch.mjs')` that config manifests don't enumerate).
    try {
      const rootFiles = readdirSync('.').filter(f => {
        try { return statSync(f).isFile(); } catch { return false; }
      });
      const srcFiles = this.listFilesRecursive('src').filter(f => f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.mjs'));
      for (const rootFile of rootFiles) {
        const base = path.basename(rootFile);
        if (protect.has(base)) continue; // already protected
        for (const src of srcFiles) {
          try {
            if (readFileSync(src, 'utf-8').includes(base)) { protect.add(base); break; }
          } catch {}
        }
      }
    } catch {}

    return protect;
  }

  private expandPruneRules(
    rules: Array<{ glob: string; dest: string }>,
    protectedSet: Set<string>,
  ): Array<{ src: string; dst: string }> {
    const moves: Array<{ src: string; dst: string }> = [];
    for (const rule of rules) {
      const g = rule.glob.replace(/\\/g, '/');
      const recursive = g.endsWith('/**');
      const dirGlob   = g.endsWith('/*') || recursive;
      const dir       = dirGlob ? g.replace(/\/\*\*?$/, '') : path.dirname(g);
      const extMatch  = !dirGlob ? path.basename(g) : null; // e.g. "*.log"

      try {
        const files = dirGlob
          ? this.listFilesRecursive(dir)
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

  async executeScript(
    script:          string,
    auditLog:        string,
    dryRun:          boolean = false,
    scriptFile?:     string,
    protectedFiles?: string[],
    remapRules?:     Array<{ pattern: string; dir: string }>,
    pruneRules?:     Array<{ glob: string; dest: string }>,
  ): Promise<string> {
    const content = scriptFile ? readFileSync(scriptFile, 'utf-8') : script;
    const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

    const ALLOWED  = new Set(['mv', 'mkdir', 'cp', 'rmdir']);
    const BLOCKED  = [/\.\./, /[;&|`$]/, /\s-rf\b/, /\brm\b/, /\bdel\b/];
    const ts = () => new Date().toISOString();

    // Build protected set — "auto" triggers config-derived protection
    const protectedSet: Set<string> = (protectedFiles?.includes('auto'))
      ? this.deriveProtectedFiles()
      : new Set(protectedFiles ?? []);

    try { mkdirSync(path.dirname(auditLog), { recursive: true }); } catch {}

    const results: string[] = [];
    const log = (entry: string) => {
      results.push(entry);
      try { appendFileSync(auditLog, entry + '\n', 'utf-8'); } catch {}
    };

    // Expand pruneRules into synthetic mv lines
    if (pruneRules?.length) {
      const pruneOps = this.expandPruneRules(pruneRules, protectedSet);
      for (const { src, dst } of pruneOps) {
        if (dryRun) {
          log(`[${ts()}] DRY-RUN (prune): mv ${src} → ${dst}`); continue;
        }
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

      if (!ALLOWED.has(cmd)) {
        log(`[${ts()}] BLOCKED: "${line}" — command not in allowlist`); continue;
      }
      if (BLOCKED.some(p => p.test(line))) {
        log(`[${ts()}] BLOCKED: "${line}" — unsafe pattern detected`); continue;
      }

      // For mv/cp: apply remap rules before protection check
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

      // For mv/cp: check source against protected set and dotfile rule
      if ((cmd === 'mv' || cmd === 'cp') && parts[1]) {
        const srcBase = path.basename(parts[1]);
        if (srcBase.startsWith('.')) {
          log(`[${ts()}] PROTECTED: "${line}" — dotfile`); continue;
        }
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

  // ── Internal: shared LLM call + event writer ───────────────────────────────

  private writeEvent(event: Record<string, any>): void {
    try {
      const eventsFile = join(this.governor.config.stateDir, 'events.jsonl');
      appendFileSync(eventsFile, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
    } catch (e: any) { process.stderr.write(`[writeEvent] failed: ${e?.message}\n`); }
  }

  private async runSubagent(
    role: string, name: string, systemPrompt: string, userPrompt: string,
    onUpdate: any, _metrics: any, profile: string, model: string,
    haltOn?: string[], maxTokensOverride?: number,
  ): Promise<string> {
    let fullResponse = '';
    const baseTokensPrior = this.sessionTotalTokens;
    let streamAborted = false;
    let lastCompleteLine = '';
    let repeatCount = 0;
    let finalMetrics = { genTps: 0, promptTokens: 0, genTokens: 0, maxTokens: 0 };

    const streamLogPath = join(this.governor.config.stateDir, 'stream.log');
    const debugLogPath = join(this.governor.config.stateDir, 'debug.log');
    try { appendFileSync(debugLogPath, `[runSubagent] ${new Date().toISOString()} | ${name} | stateDir=${this.governor.config.stateDir} | cwd=${process.cwd()}\n`); } catch (e: any) { process.stderr.write(`[runSubagent] debug.log write failed: ${e?.message}\n`); }
    this.writeEvent({ type: 'phase_change', phase: this.currentPhase, name });
    try { appendFileSync(streamLogPath, `\n\n--- ${this.currentPhase} | ${name} ---\n`); } catch (e: any) { appendFileSync(debugLogPath, `[runSubagent] stream.log write failed: ${e?.message}\n`); }

    try {
      await this.client.streamCompletion(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        role as TaskRole, profile, maxTokensOverride,
        (chunk, m) => {
          if (streamAborted) return;
          fullResponse += chunk;

          if (chunk.includes('\n')) {
            try { appendFileSync(streamLogPath, chunk); } catch { }
          }

          if (haltOn && haltOn.some(stop => fullResponse.includes(stop))) {
            streamAborted = true; return;
          }

          if (chunk.includes('\n')) {
            const completedLine = chunk.split('\n').filter(l => l.trim().length > 15).pop()?.trim() || '';
            if (completedLine) {
              if (completedLine === lastCompleteLine) {
                if (++repeatCount > 8) { streamAborted = true; return; }
              } else { repeatCount = 0; lastCompleteLine = completedLine; }
            }
          }

          this.sessionTotalTokens = baseTokensPrior + (m.promptTokens + m.genTokens);
          finalMetrics = m;
        },
        () => {},
      );
    } catch (err: any) {
      onUpdate?.({ text: `⚠️ ${this.currentPhase} | ${name} | server error: ${err?.message ?? err}` });
    }

    if (!fullResponse && finalMetrics.genTokens === 0) {
      onUpdate?.({ text: `❌ ${this.currentPhase} | ${name} | empty response — server may be down` });
      throw new Error(`${name}: server returned empty response (0 tokens). Is the LLM server running?`);
    }

    const pressure    = finalMetrics.maxTokens ? Math.round((finalMetrics.promptTokens / finalMetrics.maxTokens) * 100) : 0;
    const pressureTag = pressure > 70 ? ` ⚠️ ctx:${pressure}%` : '';
    onUpdate?.({ text: `✅ ${this.currentPhase} | ${name} | ${finalMetrics.genTps.toFixed(1)}t/s | ${finalMetrics.genTokens} gen + ${finalMetrics.promptTokens} prompt tokens${pressureTag}` });
    this.writeEvent({ type: 'subagent_done', phase: this.currentPhase, role, name, tps: finalMetrics.genTps, genTokens: finalMetrics.genTokens, promptTokens: finalMetrics.promptTokens, ctxPct: pressure });

    return fullResponse;
  }
}
