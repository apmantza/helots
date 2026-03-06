/**
 * task-runner.ts — Single task execution: Builder → Peltast retry loop.
 *
 * Contains: parseChecklist, runOneTask, replanTaskWithAristomenis.
 * Task loop orchestration is in task-loop.ts.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, copyFileSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { execSync }  from 'child_process';
import { stripThinking }      from './text-utils.js';
import { pickName }           from './persona-utils.js';
import { LspManager }         from './lsp-client.js';
import { SkillInjector }      from './skill-injector.js';
import { detectLang, codeFenceFor, getSymbolBounds, applySurgicalPatches } from './symbol-utils.js';
import { buildBuilderPrompt } from './builder-prompt.js';
import { runVerification }    from './verification.js';
import { Aristomenis }        from './governor.js';
import type { ToolSet }       from './tool-resolver.js';
import type { HelotTask }     from './types.js';
import type { RunSubagentFn, WriteEventFn } from './types.js';

export class TaskRunner {
  public tools: ToolSet = { python: 'python', ruff: null, pytest: null };
  public serverMaxTokens: number = 0;
  private lspManager: LspManager | null = null;
  private skillInjector: SkillInjector | null = null;

  constructor(
    public  governor:      Aristomenis,
    public  runSubagentFn: RunSubagentFn,
    public  writeEventFn:  WriteEventFn,
    private setPhase:      (p: string) => void,
    private setTaskTitle:  (t: string) => void,
    private getModelProps: () => Promise<{ modelName: string; maxTokens: number }>,
  ) {}

  dispose(): void {
    this.lspManager?.dispose();
    this.lspManager = null;
  }

  setCurrentTaskTitle(title: string): void { this.setTaskTitle(title); }

  parseChecklist(checklist: string): HelotTask[] {
    return checklist.split('\n')
      .filter(l => l.includes('- [ ]'))
      .map(line => {
        const idMatch      = line.match(/^\- \[ \]\s*(\d+)\./);
        const fileMatch    = line.match(/\(Target:\s*([^,\]\)]+)/);
        const symbolMatch  = line.match(/Symbol:\s*([^,\]\)]+)/);
        const actionMatch  = line.match(/Action:\s*(CREATE|EDIT)/i);
        const dependsMatch = line.match(/\[DEPENDS:\s*([^\]]+)\]/);
        const isCreate     = actionMatch?.[1]?.toUpperCase() === 'CREATE';

        let filePath = fileMatch ? fileMatch[1].trim().replace(/`/g, '') : undefined;
        if (!filePath) {
          const descFallback = line.match(/\bsrc\/[\w/.-]+\.(?:py|ts|tsx|js|jsx|mjs|cjs)\b/);
          if (descFallback) filePath = descFallback[0];
        }

        return {
          id:            idMatch ? idMatch[1] : Math.random().toString(36).substr(2, 5),
          description:   line.split('(')[0].replace(/^- \[ \]\s*\d+\.\s*/, '').trim(),
          status:        'pending' as const,
          file:          filePath,
          targetSymbol:  (!isCreate && symbolMatch) ? symbolMatch[1].trim().replace(/`/g, '') : undefined,
          dependsOn:     dependsMatch ? dependsMatch[1].split(',').map(d => d.trim()).filter(d => d !== 'none') : [],
          skipLintCodes: (() => { const m = line.match(/SkipLintCodes:\s*([^\]\n]+)/); return m ? m[1].trim().split(/\s*,\s*/).filter(Boolean) : []; })(),
        };
      });
  }

  async runOneTask(
    task:               HelotTask,
    runId:              string,
    modelName:          string,
    globalContext:      string,
    implementationPlan: string,
    psiloiMetrics:      { builder: any; peltast: any },
    reviewFile:         string,
    onUpdate:           ((data: any) => void) | undefined,
    allTasks:           HelotTask[] = [],
    writeTrace:         (data: any) => void = () => {},
  ): Promise<{ passed: boolean; escalation?: string }> {

    const taskContext = task.changes || implementationPlan;
    let contextContent = '';
    let isSurgical = false;
    const lang = detectLang(task.file || '');

    if (task.file) {
      const abs = resolve(task.file);
      if (existsSync(abs) && !statSync(abs).isDirectory()) {
        contextContent = readFileSync(abs, 'utf-8');
        if (task.targetSymbol && lang !== 'unknown') {
          const bounds = getSymbolBounds(contextContent, task.targetSymbol, lang);
          if (bounds) {
            isSurgical = true;
            onUpdate?.({ text: `🔬 Surgical mode: targeting \`${task.targetSymbol}\` in ${lang} (${bounds.slice.split('\n').length} lines)` });
          } else {
            onUpdate?.({ text: `⚠️ Symbol "${task.targetSymbol}" not found in ${task.file} — falling back to full-file mode.` });
            task.targetSymbol = undefined;
          }
        }
        if (!isSurgical && contextContent.length > 40000)
          onUpdate?.({ text: `⚠️ Builder: "${task.file}" is ${Math.round(contextContent.length / 1000)}k chars — large file.` });
      } else if (!existsSync(resolve(task.file))) {
        // CREATE task — no existing content
      } else {
        onUpdate?.({ text: `⚠️ Scout: Target ${task.file} is missing or invalid.` });
      }
    }

    const backupBaseDir = join(process.cwd(), '.helots', 'backups', runId, task.id);
    mkdirSync(backupBaseDir, { recursive: true });

    // Inject upstream file content from dependsOn tasks
    let upstreamContext = '';
    if (task.dependsOn && task.dependsOn.length > 0 && allTasks.length > 0) {
      const numUpstream = task.dependsOn.length;
      const UPSTREAM_CAP = this.serverMaxTokens > 0 ? Math.floor((this.serverMaxTokens - 10000) * 4 / numUpstream) : 3000;
      const sections: string[] = [];
      for (const depId of task.dependsOn) {
        const depTask = allTasks.find(t => t.id === depId);
        if (depTask?.file) {
          const depAbs = resolve(depTask.file);
          if (existsSync(depAbs)) {
            try {
              const raw = readFileSync(depAbs, 'utf-8');
              const content = raw.length > UPSTREAM_CAP ? raw.slice(0, UPSTREAM_CAP) + `\n...[truncated]` : raw;
              sections.push(`=== Task ${depId} → ${depTask.file} ===\n${content}`);
            } catch { /* non-fatal */ }
          }
        }
      }
      if (sections.length > 0) {
        upstreamContext = sections.join('\n\n');
        onUpdate?.({ text: `🔗 Builder: injecting ${sections.length} upstream file(s) as context` });
      }
    }

    let taskPassed = false;
    let lastPeltastFeedback = '';
    let replannedByAristomenis = false;
    let lastBuilderOut = '';

    for (let tryCount = 1; tryCount <= 3; tryCount++) {
      const retryContext = lastPeltastFeedback
        ? `\nPREVIOUS ATTEMPT FAILED — Peltast feedback:\n${lastPeltastFeedback}\nFix the issues above.\n` : '';
      const targetHeader = task.file ? `### [${task.file}]` : `### [output.ts]`;
      const fence = codeFenceFor(lang, task.file || '');
      const isCreateTask = task.file ? !existsSync(resolve(task.file)) : false;

      const { maxTokens: serverCtx } = await this.getModelProps();
      let builderMaxTokensOverride: number | undefined;
      if (!isSurgical && serverCtx > 0) {
        if (isCreateTask) {
          builderMaxTokensOverride = Math.min(Math.floor(serverCtx * 0.65), 24576);
          onUpdate?.({ text: `📐 Builder max_tokens → ${builderMaxTokensOverride} (CREATE, server ctx: ${serverCtx})` });
        } else if (contextContent) {
          const dynamicBudget = Math.min(Math.max(Math.ceil(contextContent.split('\n').length * 15), 8192), serverCtx - 4096);
          if (dynamicBudget > 8192) {
            builderMaxTokensOverride = dynamicBudget;
            onUpdate?.({ text: `📐 Builder max_tokens → ${dynamicBudget} (file: ${contextContent.split('\n').length} lines)` });
          }
        }
      }

      if (!this.skillInjector) this.skillInjector = new SkillInjector(process.cwd());
      const skillContext = this.skillInjector.match(task.file ?? '', task.description, lang);

      const builderSystem = buildBuilderPrompt({
        globalContext, description: task.description, file: task.file, targetSymbol: task.targetSymbol,
        lang, isSurgical, fence, contextContent, taskContext, upstreamContext, retryContext,
        skillContext: skillContext ?? null, builderMaxTokensOverride, targetHeader,
      });

      const builder = pickName(runId, `Builder-${task.id}-${tryCount}`);
      this.setPhase(`Builder (Task ${task.id})`);
      const builderProfile = (isSurgical || !isCreateTask) ? 'INSTRUCT_CODE' : 'THINKING_CODE';

      writeTrace({ phase: 'builder', status: 'start', taskId: task.id, tryNum: tryCount });
      const builderRaw = await this.runSubagentFn(
        'Builder', builder.name, builderSystem,
        `Mission ID: ${runId}\nTask: ${task.description}`,
        onUpdate, psiloiMetrics.builder, builderProfile, modelName, undefined, builderMaxTokensOverride,
      );
      const builderOut = stripThinking(builderRaw);
      lastBuilderOut = builderOut.slice(0, 3000);
      writeTrace({ phase: 'builder', status: 'complete', taskId: task.id, tryNum: tryCount });

      // --- Parse Builder output ---
      const filesToProcess: Array<{ filePath: string; fullPath: string; content: string }> = [];

      if (isSurgical && task.file) {
        const abs = resolve(task.file);
        const original = existsSync(abs) ? readFileSync(abs, 'utf-8') : '';
        const patched = applySurgicalPatches(original, builderOut, lang);
        if (patched) {
          filesToProcess.push({ filePath: task.file, fullPath: abs, content: patched });
        } else {
          onUpdate?.({ text: `⚠️ Builder (try ${tryCount}) produced no ### FUNCTION: blocks. Retrying...` });
          lastPeltastFeedback = `Surgical mode requires output as:\n### FUNCTION: ${task.targetSymbol}\n\`\`\`${fence}\n(complete function implementation)\n\`\`\`\nDo NOT output the full file.`;
          continue;
        }
      } else {
        const fileBlockStart = builderOut.indexOf('### [');
        const cleanOut = fileBlockStart >= 0 ? builderOut.slice(fileBlockStart) : builderOut;
        const fileRegex = /###\s*\[([^\]]+)\]\s*\n\s*```[a-z]*\n([\s\S]*?)\n```/gi;
        let match;
        while ((match = fileRegex.exec(cleanOut)) !== null)
          filesToProcess.push({ filePath: match[1].trim(), fullPath: resolve(match[1].trim()), content: match[2] });

        const hasPlaceholder = filesToProcess.some(f =>
          f.content.trim().length < 20 || f.content.includes('(complete file content)') || f.content.includes('write the COMPLETE file')
        );
        if (hasPlaceholder) {
          onUpdate?.({ text: `⚠️ Builder (try ${tryCount}) wrote placeholder text. Retrying...` });
          lastPeltastFeedback = `You wrote a placeholder instead of actual code. Write the REAL implementation.`;
          filesToProcess.length = 0; continue;
        }
        if (filesToProcess.length === 0 && task.file) {
          const fallback = cleanOut.match(/```(?:python|typescript|javascript|js|ts)?\n([\s\S]+?)\n```\s*(?:#[^\n]*)?\s*$/i);
          if (fallback && fallback[1].trim().length > 20) {
            onUpdate?.({ text: `⚠️ Builder (try ${tryCount}) skipped ### header — rescued code fence for ${task.file}` });
            filesToProcess.push({ filePath: task.file, fullPath: resolve(task.file), content: fallback[1] });
          }
        }
        if (filesToProcess.length === 0) {
          onUpdate?.({ text: `⚠️ Builder (try ${tryCount}) produced no parseable file blocks. Retrying...` });
          lastPeltastFeedback = `Your response must start with:\n### [${task.file ?? 'path/to/file'}]\n\`\`\`${fence}\n...code...\n\`\`\``;
          this.governor.addStrike(`task-${task.id}`);
          if (this.governor.checkStrikes(`task-${task.id}`).blocked) {
            const escalation = `⚠️ **ESCALATION** — Task ${task.id} failed to produce parseable output after ${tryCount} attempts.\n\n**Task:** ${task.description}\n\nOptions: [CONTINUE] [RETRY] [ABORT]`;
            onUpdate?.({ text: escalation });
            return { passed: false, escalation };
          }
          continue;
        }
      }

      // --- LSP pre-flight ---
      if (filesToProcess.length > 0 && (lang === 'typescript' || lang === 'python' || lang === 'rust')) {
        if (!this.lspManager) this.lspManager = new LspManager(process.cwd());
        const lspErrors: string[] = [];
        for (const { filePath, content } of filesToProcess) {
          const diags = await this.lspManager.diagnose(filePath, content);
          if (diags) {
            const errors = diags.filter(d => d.severity === 'error');
            if (errors.length > 0) {
              lspErrors.push(`Type errors in ${filePath}:`);
              errors.slice(0, 8).forEach(e => lspErrors.push(`  Line ${e.line + 1}:${e.col + 1} — ${e.message}${e.code ? ` [${e.code}]` : ''}`));
            }
          }
        }
        if (lspErrors.length > 0) {
          onUpdate?.({ text: `⚠️ LSP: type errors detected — retrying Builder without disk write` });
          lastPeltastFeedback = `Fix these type errors before resubmitting:\n${lspErrors.join('\n')}`;
          continue;
        }
        onUpdate?.({ text: `✓ LSP: type-check passed` });
      }

      // --- File size guard ---
      const oversized = filesToProcess.filter(f => f.content.split('\n').length > 500);
      if (oversized.length > 0) {
        const details = oversized.map(f => `  ${f.filePath}: ${f.content.split('\n').length} lines`).join('\n');
        onUpdate?.({ text: `⚠️ File size: output exceeds 500 lines — retrying Builder` });
        lastPeltastFeedback = `Output is too long. Split into multiple focused files:\n${details}\nEach file must be ≤500 lines.`;
        continue;
      }

      // --- Backup + write ---
      for (const { filePath, fullPath } of filesToProcess) {
        if (existsSync(fullPath)) copyFileSync(fullPath, join(backupBaseDir, filePath.replace(/[/\\]/g, '__') + '.bak'));
      }
      for (const { fullPath, content } of filesToProcess) {
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content);
      }
      this.governor.recordSourceEdit();

      // --- Verification ---
      const { groundTruth, hasSyntaxError, hasContentLoss, hasNewLintErrors, hasSymbolMissing, hasTestFailure } =
        runVerification({ filesToProcess, task, isSurgical, backupBaseDir, tools: this.tools, cwd: process.cwd() });

      // --- Peltast verdict ---
      const syntaxChecked = groundTruth.some(g => g.startsWith('Syntax'));
      const lintChecked   = groundTruth.some(g => g.startsWith('Lint (ruff)'));
      const testChecked   = groundTruth.some(g => g.startsWith('Tests (pytest)'));
      const symbolChecked = !!task.targetSymbol;
      const hasAnySignal  = syntaxChecked || lintChecked || testChecked || symbolChecked;
      const allGreen      = (!syntaxChecked || groundTruth.some(g => /Syntax.*✅/.test(g)))
                         && (!lintChecked   || !hasNewLintErrors)
                         && (!testChecked   || !hasTestFailure)
                         && (!symbolChecked || groundTruth.some(g => g.includes('Symbol check') && g.includes('✅ FOUND')));

      type Tier = 'PASS' | 'FAIL' | 'LLM';
      let tier: Tier;
      let verdictReason: string;

      if (hasSyntaxError || hasContentLoss || hasNewLintErrors || hasSymbolMissing || hasTestFailure) {
        tier = 'FAIL';
        verdictReason = hasSyntaxError ? 'syntax error' : hasContentLoss ? 'content loss' :
          hasNewLintErrors ? 'new lint errors' : hasTestFailure ? 'pytest failed' : 'symbol missing';
      } else if (hasAnySignal && allGreen) {
        tier = 'PASS'; verdictReason = 'auto-pass: all checks green';
      } else {
        tier = 'LLM'; verdictReason = '';
      }

      let peltastOut: string;
      if (tier === 'LLM') {
        const peltastSystem = `${globalContext}
You are the Peltast. The code has already passed compile and lint checks. Confirm the file implements the described task.

TASK: ${task.description}

FILE:
${filesToProcess.map(f => `${f.filePath}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n')}

VERDICT RULES: PASS if implemented even partially. FAIL only if clearly not implemented (empty body, wrong function, stub/TODO, completely missing logic). Do NOT fail for style issues.

RESPOND WITH EXACTLY 2 LINES:
VERDICT: PASS
or
VERDICT: FAIL — <reason in 10 words or fewer>`;

        const peltast = pickName(runId, `Peltast-${task.id}-${tryCount}`);
        this.setPhase(`Peltast (Task ${task.id})`);
        peltastOut = await this.runSubagentFn('Peltast', peltast.name, peltastSystem, `Verify task completion: ${task.description}`, onUpdate, psiloiMetrics.peltast, 'PELTAST', modelName);
        tier = peltastOut.includes('VERDICT: PASS') ? 'PASS' : 'FAIL';
        verdictReason = peltastOut.replace(/VERDICT:\s*(PASS|FAIL)\s*[—\-]?\s*/i, '').trim().slice(0, 120);
      } else {
        peltastOut = tier === 'PASS' ? `VERDICT: PASS (${verdictReason})` : `VERDICT: FAIL — ${verdictReason}`;
        onUpdate?.({ text: `⚡ Auto-${tier} — Task ${task.id} (deterministic)` });
      }

      appendFileSync(reviewFile, `\n## Task: ${task.description} (Try ${tryCount})\n**Ground Truth:**\n${groundTruth.join('\n')}\n\n**Peltast:**\n${peltastOut}\n`);

      if (tier === 'PASS') {
        taskPassed = true; task.status = 'completed';
        this.governor.recordVerification({ passed: true, message: `Task ${task.id} verified` });
        onUpdate?.({ text: `✅ PASS — Task ${task.id}: ${task.description.slice(0, 70)}` });
        this.writeEventFn({ type: 'verdict', taskId: task.id, result: 'PASS', tryNum: tryCount });
        writeTrace({ phase: 'peltast', status: 'pass', taskId: task.id, tryNum: tryCount });
        break;
      } else {
        onUpdate?.({ text: `❌ FAIL — Task ${task.id} (try ${tryCount}/3): ${verdictReason.slice(0, 120)}` });
        this.writeEventFn({ type: 'verdict', taskId: task.id, result: 'FAIL', tryNum: tryCount, reason: verdictReason });
        writeTrace({ phase: 'peltast', status: 'fail', taskId: task.id, tryNum: tryCount, reason: verdictReason.slice(0, 100) });
        for (const { filePath, fullPath } of filesToProcess) {
          const bak = join(backupBaseDir, filePath.replace(/[/\\]/g, '__') + '.bak');
          if (existsSync(bak)) copyFileSync(bak, fullPath);
        }
        lastPeltastFeedback = peltastOut;
        this.governor.addStrike(`task-${task.id}`);
        if (this.governor.checkStrikes(`task-${task.id}`).blocked) {
          if (!replannedByAristomenis) {
            onUpdate?.({ text: `🏛️ Aristomenis intervening — redesigning task ${task.id}...` });
            const replan = await this.replanTaskWithAristomenis(task, lastBuilderOut, lastPeltastFeedback, globalContext, modelName, onUpdate);
            if (replan) {
              task.description = replan.description; task.changes = replan.changes;
              this.governor.resetStrikes(`task-${task.id}`);
              replannedByAristomenis = true;
              lastPeltastFeedback = `[Aristomenis redesigned]\nNew spec: ${replan.description}\n\nChanges:\n${replan.changes}`;
              tryCount = 0; continue;
            }
          }
          const escalation = `⚠️ **ESCALATION REQUIRED** — Task ${task.id} failed after ${tryCount} attempts.\n\n**Task:** ${task.description}\n**Ground Truth:**\n${groundTruth.join('\n')}\n**Peltast:** ${lastPeltastFeedback.slice(0, 400)}\n\nOptions: [CONTINUE] [RETRY] [ABORT]`;
          onUpdate?.({ text: escalation });
          return { passed: false, escalation };
        }
      }
    }

    if (!taskPassed) { task.status = 'failed'; return { passed: false }; }

    const commitCheck = this.governor.canCommit();
    if (commitCheck.allowed) {
      try { execSync(`git add . && git commit -m "[Aristomenis] Task ${task.id}: ${task.description}"`, { cwd: process.cwd(), stdio: 'ignore' }); onUpdate?.({ text: `✅ Task ${task.id} committed.` }); }
      catch { }
    } else {
      onUpdate?.({ text: `⚠️ Skipping commit: ${commitCheck.reason}` });
    }
    return { passed: true };
  }

  async replanTaskWithAristomenis(
    task: HelotTask, lastBuilderOut: string, peltastVerdict: string,
    globalContext: string, modelName: string, onUpdate: ((data: any) => void) | undefined,
  ): Promise<{ description: string; changes: string } | null> {
    const system = `${globalContext}
You are Aristomenis. A Builder failed quality review. Rewrite the task spec to be more explicit.

RULES:
- Do NOT change what the task accomplishes — only make it more precise.
- Show the EXACT old code lines → new code lines.
- Keep the same file and function target.

Output EXACTLY this format:
REVISED_DESCRIPTION: <one-line imperative task description>
REVISED_CHANGES:
<explicit before→after diff>
END`;

    const user = `Original task: ${task.description}\nFile: ${task.file ?? '(unknown)'}\nSymbol: ${task.targetSymbol ?? '(full-file)'}\nOriginal changes:\n${(task.changes ?? '(none)').slice(0, 1000)}\n\nBuilder's failed output:\n\`\`\`\n${lastBuilderOut}\n\`\`\`\n\nPeltast verdict:\n${peltastVerdict.slice(0, 400)}`;

    try {
      const raw = await this.runSubagentFn('Aristomenis', 'Aristomenis', system, user, onUpdate, {}, 'THINKING_GENERAL', modelName);
      const out = stripThinking(raw);
      const descMatch    = out.match(/REVISED_DESCRIPTION:\s*(.+)/);
      const changesMatch = out.match(/REVISED_CHANGES:\n([\s\S]+?)\nEND/);
      if (!descMatch || !changesMatch) { onUpdate?.({ text: `⚠️ Aristomenis replan failed to parse — falling through to frontier.` }); return null; }
      const description = descMatch[1].trim();
      const changes = changesMatch[1].trim();
      onUpdate?.({ text: `🏛️ Aristomenis replan: "${description.slice(0, 80)}"` });
      return { description, changes };
    } catch { return null; }
  }
}
