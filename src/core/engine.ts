import { LlamaClient } from './llama-client.js';
import { HelotConfig, TaskRole } from '../config.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, copyFileSync, statSync } from 'fs';
import { join, resolve, dirname, relative, basename } from 'path';
import * as path from 'path';
import { getAllFiles } from './file-utils.js';
import { execSync, spawnSync } from 'child_process';
import { stripThinking } from './text-utils.js';
import { nodeGrepCommand } from './grep-utils.js';
import { Governor } from './governor.js';
import { Scout } from './scout.js';
import { Builder } from './builder-orchestrator.js';
import { Peltast } from './peltast-orchestrator.js';
import { pickName, getGlobalContext } from './persona-utils.js';
import { HelotTask, HelotState, HelotContext } from './types.js';

// Re-export types for consumers who import from engine
export type { HelotTask, HelotState, HelotContext };

/** Language kind for surgical mode dispatch */
type LangKind = 'python' | 'typescript' | 'unknown';

/** Detect language from file extension */
function detectLang(filePath: string): LangKind {
  if (filePath.endsWith('.py')) return 'python';
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) return 'typescript';
  return 'unknown';
}

/** Code fence name for Builder prompts */
function codeFenceFor(lang: LangKind, filePath: string): string {
  if (lang === 'python') return 'python';
  if (lang === 'typescript') {
    if (/\.(js|jsx|mjs|cjs)$/.test(filePath)) return 'javascript';
    return 'typescript';
  }
  return '';
}

function getPythonSymbolBounds(content: string, symbolName: string): { start: number; end: number; slice: string } | null {
  const lines = content.split('\n');
  let defLine = -1;

  // Find the def/class line
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if ((/^(?:async\s+)?def\s+/.test(l) && l.includes(`def ${symbolName}(`)) ||
        (/^class\s+/.test(l) && (l.includes(`class ${symbolName}(`) || l.includes(`class ${symbolName}:`)))) {
      defLine = i;
      break;
    }
  }
  if (defLine === -1) return null;

  // Walk back to include any preceding decorators (@st.cache_data, @property, etc.)
  let startLine = defLine;
  while (startLine > 0 && /^@/.test(lines[startLine - 1].trimEnd())) startLine--;

  // Scan forward from the def line — stop at the next top-level @decorator, def, or class
  let endLine = lines.length;
  for (let i = defLine + 1; i < lines.length; i++) {
    if (/^@/.test(lines[i]) || /^(?:async\s+)?def\s+/.test(lines[i]) || /^class\s+/.test(lines[i])) {
      endLine = i;
      break;
    }
  }

  while (endLine > startLine + 1 && lines[endLine - 1].trim() === '') endLine--;
  const charStart = lines.slice(0, startLine).join('\n').length + (startLine > 0 ? 1 : 0);
  const charEnd   = lines.slice(0, endLine).join('\n').length   + (endLine   > 0 ? 1 : 0);
  return { start: charStart, end: charEnd, slice: lines.slice(startLine, endLine).join('\n') };
}

/**
 * TypeScript/JavaScript symbol boundary detection (brace-counting).
 * Matches top-level function/class/const declarations.
 */
function getTsSymbolBounds(content: string, symbolName: string): { start: number; end: number; slice: string } | null {
  const lines = content.split('\n');
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // Skip indented lines (methods inside classes); only match top-level declarations
    if (/^\s/.test(l)) continue;
    if (new RegExp(`\\bfunction\\s+${symbolName}\\s*[(<]`).test(l) ||
        new RegExp(`\\bclass\\s+${symbolName}\\b`).test(l) ||
        new RegExp(`\\bconst\\s+${symbolName}\\s*=`).test(l) ||
        new RegExp(`\\blet\\s+${symbolName}\\s*=`).test(l)) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) return null;
  // Brace-count to find closing }
  let depth = 0;
  let foundOpen = false;
  let endLine = -1;
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; foundOpen = true; }
      else if (ch === '}') {
        depth--;
        if (foundOpen && depth === 0) { endLine = i + 1; break; }
      }
    }
    if (endLine !== -1) break;
  }
  if (endLine === -1) return null;
  while (endLine > startLine + 1 && lines[endLine - 1].trim() === '') endLine--;
  const charStart = lines.slice(0, startLine).join('\n').length + (startLine > 0 ? 1 : 0);
  const charEnd   = lines.slice(0, endLine).join('\n').length   + (endLine   > 0 ? 1 : 0);
  return { start: charStart, end: charEnd, slice: lines.slice(startLine, endLine).join('\n') };
}

/** Dispatch symbol bounds detection by language */
function getSymbolBounds(content: string, symbolName: string, lang: LangKind): { start: number; end: number; slice: string } | null {
  if (lang === 'python') return getPythonSymbolBounds(content, symbolName);
  if (lang === 'typescript') return getTsSymbolBounds(content, symbolName);
  return null;
}

/**
 * Apply surgical patches from Builder's ### FUNCTION: name blocks into original file content.
 * Language-agnostic: dispatches to correct bounds finder.
 */
function applySurgicalPatches(original: string, builderOut: string, lang: LangKind): string | null {
  const patchRegex = /###\s*FUNCTION:\s*(\w+)\s*\n```[a-z]*\n([\s\S]*?)\n```/gi;
  let patched = original;
  let anyApplied = false;
  let match;
  while ((match = patchRegex.exec(builderOut)) !== null) {
    const funcName = match[1].trim();
    const newCode  = match[2].trim();
    const bounds = getSymbolBounds(patched, funcName, lang);
    if (bounds) {
      patched = patched.slice(0, bounds.start) + newCode + '\n' + patched.slice(bounds.end);
      anyApplied = true;
    }
  }
  return anyApplied ? patched : null;
}

/**
 * HELLOT ENGINE - Orchestration Layer
 * Maintains the Triad orchestration loop (Scout, Builder, Peltast)
 * Features Surgical Slicing, Sequential Dependencies, and Technical Backups
 */
interface ToolSet {
  python: string;           // always set — falls back to 'python' if not resolvable
  ruff:   string | null;    // null = not available, lint checking skipped
  pytest: string | null;    // null = not available, test execution skipped
}

export class HelotEngine {
  private governor: Governor;
  private scout: Scout;
  private builder: Builder;
  private peltast: Peltast;
  private client: LlamaClient;
  private sessionTotalTokens: number = 0;
  private serverMaxTokens: number = 0;
  private currentPhase: string = "Setup";
  private currentTaskTitle: string = "";
  private tools: ToolSet = { python: 'python', ruff: null, pytest: null };

  constructor(config: HelotConfig) {
    this.governor = new Governor(config);
    this.scout = new Scout(config);
    this.builder = new Builder(config);
    this.peltast = new Peltast(config);
    this.client = new LlamaClient(config);
  }

  // ============================================================
  // SHARED: Parse checklist markdown into typed task nodes
  // ============================================================
  private parseChecklist(checklist: string): HelotTask[] {
    return checklist.split("\n")
      .filter(l => l.includes("- [ ]"))
      .map(line => {
        const idMatch = line.match(/^\- \[ \]\s*(\d+)\./);
        const fileMatch = line.match(/\(Target:\s*([^,\]\)]+)/);
        const symbolMatch = line.match(/Symbol:\s*([^,\]\)]+)/);
        const actionMatch = line.match(/Action:\s*(CREATE|EDIT)/i);
        const dependsMatch = line.match(/\[DEPENDS:\s*([^\]]+)\]/);
        const isCreate = actionMatch?.[1]?.toUpperCase() === 'CREATE';

        // Fallback: if no (Target: ...) metadata, try to extract a source file path from description text.
        // Handles Aristomenis format violations like "- [ ] 3. Edit src/foo/bar.py to add X"
        let filePath = fileMatch ? fileMatch[1].trim().replace(/`/g, '') : undefined;
        if (!filePath) {
          const descFallback = line.match(/\bsrc\/[\w/.-]+\.(?:py|ts|tsx|js|jsx|mjs|cjs)\b/);
          if (descFallback) filePath = descFallback[0];
        }

        return {
          id: idMatch ? idMatch[1] : Math.random().toString(36).substr(2, 5),
          description: line.split("(")[0].replace(/^- \[ \]\s*\d+\.\s*/, "").trim(),
          status: 'pending' as const,
          file: filePath,
          targetSymbol: (!isCreate && symbolMatch) ? symbolMatch[1].trim().replace(/`/g, '') : undefined,
          dependsOn: dependsMatch ? dependsMatch[1].split(",").map(d => d.trim()).filter(d => d !== "none") : [],
          skipLintCodes: (() => { const m = line.match(/SkipLintCodes:\s*([^\]\n]+)/); return m ? m[1].trim().split(/\s*,\s*/).filter(Boolean) : []; })()
        };
      });
  }

  // ============================================================
  // SHARED: Single task execution — Builder → Peltast retry loop
  // Returns { passed, escalation? }
  // ============================================================
  private async runOneTask(
    task: HelotTask,
    runId: string,
    modelName: string,
    globalContext: string,
    implementationPlan: string,
    psiloiMetrics: { builder: any; peltast: any },
    reviewFile: string,
    onUpdate: ((data: any) => void) | undefined,
    allTasks: HelotTask[] = [],
    writeTrace: (data: any) => void = () => {}
  ): Promise<{ passed: boolean; escalation?: string }> {

    // Per-task changes from frontier take priority over the shared implementation plan
    const taskContext = task.changes || implementationPlan;

    // --- Determine mode: SURGICAL (known lang + symbol) or FULL-FILE ---
    // Surgical mode: Builder outputs only named function blocks, Engine splices them in.
    // Full-file mode: Builder outputs the complete file (for CREATE tasks or unknown lang).
    let contextContent = "";
    let isSurgical = false;
    let surgicalSlice = "";   // the current function body shown to Builder as context
    let lang: LangKind = 'unknown';

    if (task.file) {
      const abs = resolve(task.file);
      lang = detectLang(abs);
      if (existsSync(abs) && !statSync(abs).isDirectory()) {
        const originalContent = readFileSync(abs, "utf-8");
        contextContent = originalContent;

        if (task.targetSymbol && lang !== 'unknown') {
          const bounds = getSymbolBounds(originalContent, task.targetSymbol, lang);
          if (bounds) {
            isSurgical = true;
            surgicalSlice = bounds.slice;
            onUpdate?.({ text: `🔬 Surgical mode: targeting \`${task.targetSymbol}\` in ${lang} (${bounds.slice.split('\n').length} lines)` });
          } else {
            onUpdate?.({ text: `⚠️ Symbol "${task.targetSymbol}" not found in ${task.file} — falling back to full-file mode.` });
            task.targetSymbol = undefined;
          }
        }

        if (!isSurgical && contextContent.length > 40000) {
          onUpdate?.({ text: `⚠️ Builder: "${task.file}" is ${Math.round(contextContent.length/1000)}k chars — large file.` });
        }
      } else if (!existsSync(resolve(task.file))) {
        // CREATE task — no existing content
      } else {
        onUpdate?.({ text: `⚠️ Scout: Target ${task.file} is missing or invalid.` });
      }
    }

    const backupBaseDir = join(process.cwd(), '.helots', 'backups', runId, task.id);
    mkdirSync(backupBaseDir, { recursive: true });

    // Cross-file context: preload files from upstream dependsOn tasks so the builder
    // knows the exact interfaces/types it must implement against.
    let upstreamContext = "";
    if (task.dependsOn && task.dependsOn.length > 0 && allTasks.length > 0) {
      const numUpstream = task.dependsOn.length;
      const UPSTREAM_CAP = this.serverMaxTokens > 0
        ? Math.floor((this.serverMaxTokens - 10000) * 4 / numUpstream)
        : 3000; // fallback if serverMaxTokens not yet set
      const sections: string[] = [];
      for (const depId of task.dependsOn) {
        const depTask = allTasks.find(t => t.id === depId);
        if (depTask?.file) {
          const depAbs = resolve(depTask.file);
          if (existsSync(depAbs)) {
            try {
              const raw = readFileSync(depAbs, 'utf-8');
              const content = raw.length > UPSTREAM_CAP ? raw.slice(0, UPSTREAM_CAP) + `\n...[truncated at ${UPSTREAM_CAP} chars]` : raw;
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
    let lastPeltastFeedback = "";
    let replannedByAristomenis = false;
    let lastBuilderOut = "";

    for (let tryCount = 1; tryCount <= 3; tryCount++) {
      const retryContext = lastPeltastFeedback
        ? `\nPREVIOUS ATTEMPT FAILED — Peltast feedback:\n${lastPeltastFeedback}\nFix the issues above.\n`
        : "";

      const targetHeader = task.file ? `### [${task.file}]` : `### [output.ts]`;
      const fence = codeFenceFor(lang, task.file || '');

      let builderSystem: string;
      if (isSurgical) {
        // SURGICAL MODE: Builder sees the full file (for complete context across all functions),
        // but outputs only ### FUNCTION: blocks for the functions it changes.
        // This lets it correctly refactor multiple related functions without guessing.
        builderSystem = `${globalContext}
You are the Builder. IMPLEMENT the following task with LACONIC SIMPLICITY: ${task.description}
File: ${task.file} (${lang})
Primary target: \`${task.targetSymbol}\`

SURGICAL OUTPUT FORMAT — CRITICAL:
For EACH function you modify, output it as a named block:
### FUNCTION: function_name
\`\`\`${fence}
(complete function implementation)
\`\`\`

RULES:
- Output ONLY the functions that change. Do NOT output imports, the full file, or unchanged functions.
- Never use "..." placeholders — write complete, working code.
- You MUST output a block for every function the task requires changing (may be more than one).
${retryContext}
IMPLEMENTATION CONTEXT (signatures and patterns to use):
${taskContext.slice(0, 2000)}

FULL FILE (read to understand all functions; output only changed ones):
\`\`\`${fence}
${contextContent}
\`\`\`${upstreamContext ? `\n\nUPSTREAM DEPENDENCIES (read-only — use for correct imports/interfaces):\n${upstreamContext}` : ''}`;
      } else {
        // FULL-FILE MODE: for CREATE tasks or unknown-language files
        const symbolInstruction = task.targetSymbol
          ? `TARGET: Modify \`${task.targetSymbol}\` and any other functions explicitly named in the task. Keep everything else exactly as-is.`
          : `TARGET: Implement the task. Keep all existing content unless explicitly required to remove it.`;
        builderSystem = `${globalContext}
You are the Builder. IMPLEMENT the following task with LACONIC SIMPLICITY: ${task.description}
${task.file ? `Target File: ${task.file}` : ""}

SPARTAN BUILDER GUIDELINES:
1. LACONISM: Use the minimum code required.
2. ${symbolInstruction}
3. COMPLETENESS: Output the COMPLETE file — never truncate, never use "..." placeholders.
4. Your response MUST start immediately with the file header — no preamble, no explanation.
${retryContext}
IMPLEMENTATION CONTEXT (signatures and patterns to use):
${taskContext.slice(0, 2000)}

${contextContent ? `CURRENT FILE CONTENT:\n${contextContent}` : ""}
${upstreamContext ? `\nUPSTREAM DEPENDENCIES (read-only — use for correct imports/interfaces):\n${upstreamContext}` : ""}
Your response must begin with EXACTLY this header on the first line:
${targetHeader}
\`\`\`${fence}
Then write the COMPLETE file content. Close with a single \`\`\` on its own line.
Do NOT echo these instructions. Do NOT write placeholder text like "(complete file content)".
\`\`\``;
      }

      const builder = pickName(runId, `Builder-${task.id}-${tryCount}`);
      this.currentPhase = `Builder (Task ${task.id})`;
      // Profile selection:
      // - Surgical EDIT → INSTRUCT_CODE (mechanical symbol replacement, thinking wastes tokens)
      // - Full-file EDIT (file exists) → INSTRUCT_CODE (model must reproduce the whole file; thinking
      //   causes the model to burn token budget planning, then EOS without writing code)
      // - Full-file CREATE (file absent) → THINKING_CODE (new file benefits from structural planning)
      const isCreateTask = task.file ? !existsSync(resolve(task.file)) : false;
      const builderProfile = (isSurgical || !isCreateTask) ? "INSTRUCT_CODE" : "THINKING_CODE";

      // Dynamic max_tokens for full-file mode: scale budget with file size to prevent mid-file truncation.
      // Default profile max_tokens (8192) only covers ~640 lines; large files need more.
      // Only applies to full-file mode (surgical outputs only a function body, well within 8192).
      let builderMaxTokensOverride: number | undefined;
      if (!isSurgical && contextContent && this.serverMaxTokens > 0) {
        const fileLines = contextContent.split('\n').length;
        const estimatedOutputTokens = Math.ceil(fileLines * 15); // ~15 tokens/line is conservative
        const safeMax = this.serverMaxTokens - 4096; // leave ~4K tokens headroom for prompt
        const dynamicBudget = Math.min(Math.max(estimatedOutputTokens, 8192), safeMax);
        if (dynamicBudget > 8192) {
          builderMaxTokensOverride = dynamicBudget;
          onUpdate?.({ text: `📐 Builder max_tokens → ${dynamicBudget} (file: ${fileLines} lines, server ctx: ${this.serverMaxTokens})` });
        }
      }

      writeTrace({ phase: 'builder', status: 'start', taskId: task.id, tryNum: tryCount });
      const builderRaw = await this.runSubagent(
        "Builder", builder.name, builderSystem,
        `Mission ID: ${runId}\nTask: ${task.description}`,
        onUpdate, psiloiMetrics.builder, builderProfile, modelName, undefined, builderMaxTokensOverride
      );
      // Strip <think> blocks so chain-of-thought doesn't leak into file parsing
      const builderOut = stripThinking(builderRaw);
      lastBuilderOut = builderOut.slice(0, 3000); // context for potential replan
      writeTrace({ phase: 'builder', status: 'complete', taskId: task.id, tryNum: tryCount });

      // --- Parse output files ---
      const filesToProcess: Array<{ filePath: string; fullPath: string; content: string }> = [];
      let match;

      if (isSurgical && task.file) {
        // SURGICAL MODE: parse ### FUNCTION: name blocks and splice into original file
        const abs = resolve(task.file);
        const original = existsSync(abs) ? readFileSync(abs, "utf-8") : "";
        const patched = applySurgicalPatches(original, builderOut, lang);
        if (patched) {
          filesToProcess.push({ filePath: task.file, fullPath: abs, content: patched });
        } else {
          onUpdate?.({ text: `⚠️ Builder (try ${tryCount}) produced no ### FUNCTION: blocks in surgical mode. Retrying...` });
          lastPeltastFeedback = `Surgical mode requires output as:\n### FUNCTION: ${task.targetSymbol}\n\`\`\`${fence}\n(complete function implementation)\n\`\`\`\nDo NOT output the full file.`;
          continue;
        }
      } else {
        // FULL-FILE MODE: strip reasoning prefix, then parse ### [file] blocks
        // Reasoning emitted as regular tokens (not in <think> tags) can appear
        // before the first ### [ block — slice it off before parsing.
        const fileBlockStart = builderOut.indexOf('### [');
        const cleanBuilderOut = fileBlockStart >= 0 ? builderOut.slice(fileBlockStart) : builderOut;
        const fileRegex = /###\s*\[([^\]]+)\]\s*\n\s*```[a-z]*\n([\s\S]*?)\n```/gi;
        while ((match = fileRegex.exec(cleanBuilderOut)) !== null) {
          filesToProcess.push({ filePath: match[1].trim(), fullPath: resolve(match[1].trim()), content: match[2] });
        }
        // Reject placeholder or near-empty content (model echoed instruction text)
        const hasPlaceholder = filesToProcess.some(f =>
          f.content.trim().length < 20 ||
          f.content.includes('(complete file content)') ||
          f.content.includes('write the COMPLETE file')
        );
        if (hasPlaceholder) {
          onUpdate?.({ text: `⚠️ Builder (try ${tryCount}) wrote placeholder text instead of real content. Retrying...` });
          lastPeltastFeedback = `You wrote a placeholder like "(complete file content)" instead of actual code. Write the REAL implementation of the file.`;
          filesToProcess.length = 0;
          continue;
        }
        if (filesToProcess.length === 0 && task.file) {
          // Fallback: Builder wrote code but forgot the ### [file] header.
          // Extract the last code fence in the output and map it to task.file.
          const fallbackMatch = cleanBuilderOut.match(/```(?:python|typescript|javascript|js|ts)?\n([\s\S]+?)\n```\s*(?:#[^\n]*)?\s*$/i);
          if (fallbackMatch && fallbackMatch[1].trim().length > 20) {
            onUpdate?.({ text: `⚠️ Builder (try ${tryCount}) skipped ### header — rescued code fence for ${task.file}` });
            filesToProcess.push({ filePath: task.file, fullPath: resolve(task.file), content: fallbackMatch[1] });
          }
        }
        if (filesToProcess.length === 0) {
          onUpdate?.({ text: `⚠️ Builder (try ${tryCount}) produced no parseable file blocks. Retrying...` });
          lastPeltastFeedback = `Your response must start with:\n### [${task.file ?? 'path/to/file'}]\n\`\`\`${fence}\n...code...\n\`\`\`\nDo NOT use any other format. Do NOT add explanations before this header.`;
          this.governor.addStrike(`task-${task.id}`);
          const strikeCheck = this.governor.checkStrikes(`task-${task.id}`);
          if (strikeCheck.blocked) {
            const escalation = `⚠️ **ESCALATION REQUIRED** — Task ${task.id} failed to produce parseable output after ${tryCount} attempts.\n\n**Task:** ${task.description}\n\nBuilder kept ignoring the ### [file] header format.\n\nOptions:\n- [CONTINUE] Skip and proceed\n- [RETRY] Retry with fresh context\n- [ABORT] Stop execution\n\nReply with CONTINUE, RETRY, or ABORT.`;
            onUpdate?.({ text: escalation });
            return { passed: false, escalation };
          }
          continue;
        }
      }

      // --- Backup originals ---
      for (const { filePath, fullPath } of filesToProcess) {
        if (existsSync(fullPath)) {
          const bak = join(backupBaseDir, filePath.replace(/[/\\]/g, '__') + '.bak');
          copyFileSync(fullPath, bak);
        }
      }

      // --- Write new files ---
      for (const { fullPath, content } of filesToProcess) {
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content);
      }
      this.governor.recordSourceEdit();

      // --- Ground truth: diff + symbol presence (no tsc available) ---
      const groundTruth: string[] = [];

      for (const { filePath, fullPath, content } of filesToProcess) {
        const bak = join(backupBaseDir, filePath.replace(/[/\\]/g, '__') + '.bak');
        if (existsSync(bak)) {
          const before = readFileSync(bak, 'utf-8').split('\n');
          const after = content.split('\n');
          const delta = after.length - before.length;
          groundTruth.push(`${filePath}: ${delta >= 0 ? '+' : ''}${delta} lines (${before.length} → ${after.length})`);
          // Flag drastic content loss — but only when the backup itself was valid.
          // If a previous attempt wrote corrupt content, the backup is corrupt too;
          // comparing against it produces spurious CONTENT LOSS flags.
          // Skip for surgical tasks (isSurgical=true): the function body shrinks legitimately
          // during refactoring. Symbol presence + syntax OK is sufficient evidence.
          if (!isSurgical && before.length > 20 && after.length / before.length < 0.7) {
            const bakLang = detectLang(fullPath);
            let bakIsValid = true;
            if (bakLang === 'python') {
              const bakCheck = spawnSync(this.tools.python, ['-m', 'py_compile', bak], { encoding: 'utf-8', timeout: 10000 });
              bakIsValid = bakCheck.status === 0;
            }
            if (bakIsValid) {
              groundTruth.push(`⚠️ CONTENT LOSS: file shrank ${Math.round((1 - after.length/before.length)*100)}% — Builder likely deleted functions it should have kept`);
            } else {
              groundTruth.push(`ℹ️ File shrank ${Math.round((1 - after.length/before.length)*100)}% but backup had syntax errors (corrupt baseline) — content-loss flag suppressed`);
            }
          }
        } else {
          groundTruth.push(`${filePath}: NEW FILE (${content.split('\n').length} lines)`);
        }
      }

      if (task.targetSymbol) {
        for (const { filePath, content } of filesToProcess) {
          const found = content.includes(task.targetSymbol);
          groundTruth.push(`Symbol check — "${task.targetSymbol}" in ${filePath}: ${found ? '✅ FOUND' : '❌ MISSING'}`);
        }
      }

      // --- Syntax + lint checks (language-appropriate, best-effort) ---
      for (const { filePath, fullPath } of filesToProcess) {
        const fileLang = detectLang(fullPath);
        const bak = join(backupBaseDir, filePath.replace(/[/\\]/g, '__') + '.bak');
        try {
          if (fileLang === 'python') {
            // 1. Syntax check
            const r = spawnSync(this.tools.python, ['-m', 'py_compile', fullPath], { encoding: 'utf-8', timeout: 10000 });
            groundTruth.push(`Syntax (py_compile): ${r.status === 0 ? '✅ OK' : `❌ ERROR — ${(r.stderr || '').slice(0, 200)}`}`);

            // 2. Lint check via ruff (errors only: E9=runtime errors, F=pyflakes undefined/unused)
            //    Only report NEW errors introduced by the Builder — diff against backup lint output.
            if (this.tools.ruff) {
              const ruffCheck = spawnSync(this.tools.ruff, ['check', '--select=E9,F', '--output-format=concise', fullPath], { encoding: 'utf-8', timeout: 10000 });
              // Filter to actual ruff diagnostic lines only (path:line:col: CODE msg).
              // Strips summary lines like "All checks passed!" that ruff emits when clean.
              const newErrors = (ruffCheck.stdout || '').trim().split('\n').filter(l => l && /:\d+:\d+:\s*[EF]\d+/.test(l));
              if (newErrors.length > 0 && existsSync(bak)) {
                const ruffBak = spawnSync(this.tools.ruff, ['check', '--select=E9,F', '--output-format=concise', bak], { encoding: 'utf-8', timeout: 10000 });
                // Normalize: strip path + line:col prefix so pre-existing errors that merely
                // shifted line numbers after a refactor are not falsely flagged as "new".
                // Format: "path:line:col: CODE message" → keep "CODE message" only.
                // Uses :\d+:\d+: scan (not ^path:) so Windows drive-letter paths (C:\...) work too.
                const normErr = (l: string) => { const m = l.match(/:\d+:\d+:\s*(.+)/); return m ? m[1].trim() : l; };
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

            // 3. Test execution via pytest — find matching test file, run it if found
            if (this.tools.pytest) {
              const basename = path.basename(fullPath, '.py');
              const testCandidates = [
                join(process.cwd(), 'tests',     `test_${basename}.py`),
                join(process.cwd(), 'test',      `test_${basename}.py`),
                join(path.dirname(fullPath),      `test_${basename}.py`),
                join(path.dirname(fullPath), 'tests', `test_${basename}.py`),
              ];
              const testFile = testCandidates.find(p => existsSync(p));
              if (testFile) {
                const pytestResult = spawnSync(
                  this.tools.pytest, ['--tb=short', '-q', '--no-header', testFile],
                  { encoding: 'utf-8', timeout: 30000, cwd: process.cwd() }
                );
                if (pytestResult.status === 0) {
                  groundTruth.push(`Tests (pytest): ✅ passed`);
                } else {
                  const output = (pytestResult.stdout || '').trim().split('\n').slice(0, 8).join(' | ');
                  groundTruth.push(`Tests (pytest): ❌ FAILED — ${output.slice(0, 300)}`);
                }
              }
            }
          } else if (fileLang === 'typescript') {
            // tsc --noEmit only works if tsconfig is present; skip silently if not
            const tsconfigPath = join(process.cwd(), 'tsconfig.json');
            if (existsSync(tsconfigPath)) {
              const r = spawnSync('npx', ['tsc', '--noEmit', '--skipLibCheck'], { encoding: 'utf-8', timeout: 30000, cwd: process.cwd() });
              groundTruth.push(`Syntax (tsc): ${r.status === 0 ? '✅ OK' : `❌ ERRORS — ${(r.stdout || '').split('\n').slice(0, 5).join(' | ')}`}`);
            }
          }
        } catch { /* checks are best-effort; don't block on failure */ }
      }

      // --- Peltast: deterministic layer first, LLM only for semantic gap ---
      const hasSyntaxError   = groundTruth.some(g => /Syntax.*(❌|ERROR)/.test(g));
      const hasContentLoss   = groundTruth.some(g => g.includes('⚠️ CONTENT LOSS'));
      const hasNewLintErrors = groundTruth.some(g => g.includes('Lint (ruff): ❌'));
      const hasSymbolMissing = groundTruth.some(g => g.includes('Symbol check') && g.includes('❌ MISSING'));
      const hasTestFailure   = groundTruth.some(g => g.includes('Tests (pytest): ❌'));

      const syntaxChecked = groundTruth.some(g => g.startsWith('Syntax'));
      const lintChecked   = groundTruth.some(g => g.startsWith('Lint (ruff)'));
      const testChecked   = groundTruth.some(g => g.startsWith('Tests (pytest)'));
      const symbolChecked = !!task.targetSymbol;
      const hasAnySignal  = syntaxChecked || lintChecked || testChecked || symbolChecked;

      const syntaxOk = !syntaxChecked || groundTruth.some(g => /Syntax.*✅/.test(g));
      const lintOk   = !lintChecked   || !hasNewLintErrors;
      const testOk   = !testChecked   || !hasTestFailure;
      const symbolOk = !symbolChecked || groundTruth.some(g => g.includes('Symbol check') && g.includes('✅ FOUND'));

      // Determine verdict tier
      type Tier = 'PASS' | 'FAIL' | 'LLM';
      let tier: Tier;
      let verdictReason: string;

      if (hasSyntaxError || hasContentLoss || hasNewLintErrors || hasSymbolMissing || hasTestFailure) {
        tier = 'FAIL';
        verdictReason = hasSyntaxError   ? 'syntax error'
          : hasContentLoss   ? 'content loss — too many lines deleted'
          : hasNewLintErrors ? 'new lint/import errors introduced'
          : hasTestFailure   ? 'pytest tests failed'
          : 'required symbol missing from output';
      } else if (hasAnySignal && syntaxOk && lintOk && testOk && symbolOk) {
        tier = 'PASS';
        verdictReason = 'auto-pass: all checks green';
      } else {
        // No strong quality signal (CREATE task, unknown language, no symbol) — ask LLM
        tier = 'LLM';
        verdictReason = '';
      }

      let peltastOut: string;

      if (tier === 'LLM') {
        // LLM peltast: semantic sanity check only — triggered when deterministic checks have no signal.
        // Prompt is explicitly lenient: technically correct = PASS.
        const peltastSystem = `${globalContext}
You are the Peltast. The code has already passed compile and lint checks. Your only job is to confirm the file implements the described task.

TASK: ${task.description}

FILE:
${filesToProcess.map(f => `${f.filePath}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")}

VERDICT RULES (read carefully):
- If the file implements the task — even partially, even imperfectly — output VERDICT: PASS
- Only output VERDICT: FAIL if the task is clearly NOT implemented: empty body, wrong function entirely, stub with only "pass" or "TODO", or completely missing logic
- Do NOT fail for: style issues, missing docstrings, imperfect error handling, suboptimal code, or "could be written better"
- Technically correct = PASS

RESPOND WITH EXACTLY 2 LINES — no preamble, no explanation, nothing else:
VERDICT: PASS
or
VERDICT: FAIL — <reason in 10 words or fewer>`;

        const peltast = pickName(runId, `Peltast-${task.id}-${tryCount}`);
        this.currentPhase = `Peltast (Task ${task.id})`;
        peltastOut = await this.runSubagent(
          "Peltast", peltast.name, peltastSystem,
          `Verify task completion: ${task.description}`,
          onUpdate, psiloiMetrics.peltast, "PELTAST", modelName
        );
        tier = peltastOut.includes("VERDICT: PASS") ? 'PASS' : 'FAIL';
        verdictReason = peltastOut.replace(/VERDICT:\s*(PASS|FAIL)\s*[—\-]?\s*/i, '').trim().slice(0, 120);
      } else {
        // Deterministic verdict — no LLM call needed
        peltastOut = tier === 'PASS'
          ? `VERDICT: PASS (${verdictReason})`
          : `VERDICT: FAIL — ${verdictReason}`;
        onUpdate?.({ text: `⚡ Auto-${tier} — Task ${task.id} (deterministic)` });
      }

      appendFileSync(reviewFile, `\n## Task: ${task.description} (Try ${tryCount})\n**Ground Truth:**\n${groundTruth.join('\n')}\n\n**Peltast:**\n${peltastOut}\n`);

      if (tier === 'PASS') {
        taskPassed = true;
        task.status = 'completed';
        this.governor.recordVerification({ passed: true, message: `Task ${task.id} verified` });
        onUpdate?.({ text: `✅ PASS — Task ${task.id}: ${task.description.slice(0, 70)}` });
        this.writeEvent({ type: 'verdict', taskId: task.id, result: 'PASS', tryNum: tryCount });
        writeTrace({ phase: 'peltast', status: 'pass', taskId: task.id, tryNum: tryCount });
        break;
      } else {
        onUpdate?.({ text: `❌ FAIL — Task ${task.id} (try ${tryCount}/3): ${verdictReason.slice(0, 120)}` });
        this.writeEvent({ type: 'verdict', taskId: task.id, result: 'FAIL', tryNum: tryCount, reason: verdictReason });
        writeTrace({ phase: 'peltast', status: 'fail', taskId: task.id, tryNum: tryCount, reason: verdictReason.slice(0, 100) });
        // Restore backup
        for (const { filePath, fullPath } of filesToProcess) {
          const bak = join(backupBaseDir, filePath.replace(/[/\\]/g, '__') + '.bak');
          if (existsSync(bak)) copyFileSync(bak, fullPath);
        }
        lastPeltastFeedback = peltastOut;
        this.governor.addStrike(`task-${task.id}`);

        const strikeCheck = this.governor.checkStrikes(`task-${task.id}`);
        if (strikeCheck.blocked) {
          if (!replannedByAristomenis) {
            onUpdate?.({ text: `🏛️ Aristomenis intervening — redesigning task ${task.id} before frontier escalation...` });
            const replan = await this.replanTaskWithAristomenis(
              task, lastBuilderOut, lastPeltastFeedback, globalContext, modelName, onUpdate
            );
            if (replan) {
              task.description = replan.description;
              task.changes = replan.changes;
              this.governor.resetStrikes(`task-${task.id}`);
              replannedByAristomenis = true;
              lastPeltastFeedback = `[Aristomenis redesigned this task]\nNew spec: ${replan.description}\n\nChanges:\n${replan.changes}`;
              tryCount = 0; // for-loop increments to 1 on continue
              continue;
            }
            // Aristomenis produced nothing useful — fall through to frontier
          }
          const escalation = `⚠️ **ESCALATION REQUIRED** — Task ${task.id} failed after ${tryCount} attempts (Aristomenis replan attempted).

**Task:** ${task.description}
**Ground Truth:**
${groundTruth.join('\n')}
**Peltast Feedback:** ${lastPeltastFeedback.slice(0, 400)}

Options:
- [CONTINUE] Override and proceed to next task
- [RETRY] Retry with fresh context
- [ABORT] Stop execution

Reply with CONTINUE, RETRY, or ABORT.`;
          onUpdate?.({ text: escalation });
          return { passed: false, escalation };
        }
      }
    }

    if (!taskPassed) {
      task.status = 'failed';
      return { passed: false };
    }

    // --- Commit if the verification gate allows it ---
    const commitCheck = this.governor.canCommit();
    if (commitCheck.allowed) {
      try {
        execSync(`git add . && git commit -m "[Aristomenis] Task ${task.id}: ${task.description}"`, { cwd: process.cwd(), stdio: 'ignore' });
        onUpdate?.({ text: `✅ Task ${task.id} committed.` });
      } catch { }
    } else {
      onUpdate?.({ text: `⚠️ Skipping commit: ${commitCheck.reason}` });
    }

    return { passed: true };
  }

  // ============================================================
  // ARISTOMENIS MID-TIER: Replan a failed task before frontier
  // ============================================================
  private async replanTaskWithAristomenis(
    task: HelotTask,
    lastBuilderOut: string,
    peltastVerdict: string,
    globalContext: string,
    modelName: string,
    onUpdate: ((data: any) => void) | undefined
  ): Promise<{ description: string; changes: string } | null> {

    const system = `${globalContext}
You are Aristomenis, a software architect.

A Builder subagent failed quality review. Your sole job is to rewrite the task specification
to be more explicit and unambiguous so the next Builder attempt succeeds.

RULES:
- Do NOT change what the task accomplishes — only make it more precise.
- Show the EXACT old code lines → new code lines. Include function signatures.
- If the original spec was too vague, add concrete diff instructions.
- Keep the same file and function target (do not rename or move).

Output EXACTLY this format (no other text):
REVISED_DESCRIPTION: <one-line imperative task description>
REVISED_CHANGES:
<explicit before→after diff, as specific as possible>
END`;

    const user = `Original task: ${task.description}
File: ${task.file ?? '(unknown)'}
Symbol: ${task.targetSymbol ?? '(full-file)'}
Original changes spec:
${(task.changes ?? '(none)').slice(0, 1000)}

Builder's failed output (last attempt):
\`\`\`
${lastBuilderOut}
\`\`\`

Peltast verdict:
${peltastVerdict.slice(0, 400)}

Rewrite the task spec to fix the failure above.`;

    try {
      const raw = await this.runSubagent(
        'Aristomenis', 'Aristomenis', system, user,
        onUpdate, {}, 'THINKING_GENERAL', modelName
      );
      const out = stripThinking(raw);
      const descMatch = out.match(/REVISED_DESCRIPTION:\s*(.+)/);
      const changesMatch = out.match(/REVISED_CHANGES:\n([\s\S]+?)\nEND/);
      if (!descMatch || !changesMatch) {
        onUpdate?.({ text: `⚠️ Aristomenis replan produced no parseable output — falling through to frontier.` });
        return null;
      }
      const description = descMatch[1].trim();
      const changes = changesMatch[1].trim();
      onUpdate?.({ text: `🏛️ Aristomenis replan: "${description.slice(0, 80)}"` });
      return { description, changes };
    } catch {
      return null;
    }
  }

  // ============================================================
  // SHARED: Run the sequential task loop over a parsed checklist
  // ============================================================
  private async runTaskLoop(
    taskNodes: HelotTask[],
    runId: string,
    modelName: string,
    globalContext: string,
    implementationPlan: string,
    psiloiMetrics: { builder: any; peltast: any },
    reviewFile: string,
    onUpdate: ((data: any) => void) | undefined,
    writeTrace: (data: any) => void = () => {}
  ): Promise<string | null> {
    // Sync initial task list to governor state
    this.governor.state.tasks = taskNodes;
    this.governor.saveState();

    // Emit full task list so watch UI can render it upfront
    this.writeEvent({ type: 'task_list', tasks: taskNodes.map(t => ({ id: t.id, desc: t.description, file: t.file, status: 'pending' })) });

    for (let i = 0; i < taskNodes.length; i++) {
      const task = taskNodes[i];

      const blockers = (task.dependsOn || []).filter(depId => {
        const dep = taskNodes.find(t => t.id === depId);
        return dep && dep.status !== 'completed';
      });

      if (blockers.length > 0) {
        onUpdate?.({ text: `🚫 Task ${task.id} BLOCKED by: ${blockers.join(', ')}` });
        this.writeEvent({ type: 'task_status', taskId: task.id, status: 'blocked' });
        task.status = 'blocked';
        this.governor.state.tasks[i] = task;
        this.governor.saveState();
        continue;
      }

      this.currentTaskTitle = task.description;
      this.writeEvent({ type: 'task_status', taskId: task.id, status: 'running' });
      onUpdate?.({ text: `🛠️ Task ${task.id}/${taskNodes.length}: ${task.description}` });

      const result = await this.runOneTask(task, runId, modelName, globalContext, implementationPlan, psiloiMetrics, reviewFile, onUpdate, taskNodes, writeTrace);

      // Persist task status after each run
      this.governor.state.tasks[i] = task;
      this.governor.saveState();

      if (result.escalation) {
        return `[ESCALATION] ${result.escalation}`;
      }
      if (!result.passed) {
        return `Pipeline halted at Task ${task.id}: ${task.description}`;
      }
    }

    return null; // null = success, all tasks passed
  }

  /**
   * ARISTOMENIS ORCHESTRATION (Execute Run)
   * Classic flow: Frontier provides the implementation plan, local LLM executes it.
   */
  async executeHelots(
    taskSummary: string,
    implementationPlan: string,
    onUpdate?: (data: any) => void,
    frontierTasks?: import('./types.js').FrontierTask[]
  ): Promise<string> {
    const runId = this.governor.getRunId();
    const { modelName, maxTokens } = await this.client.getProps();
    this.serverMaxTokens = maxTokens;
    const psiloiMetrics = { scout: { in: 0, out: 0, tps: 0 }, builder: { in: 0, out: 0, tps: 0 }, peltast: { in: 0, out: 0, tps: 0 } };

    // Resolve python/ruff/pytest — detect .venv, auto-install missing tools
    this.tools = this.resolveTools(onUpdate);

    // All input caps scale proportionally with live model context.
    // Reserve 15% of context for system prompts, globalContext, and output budget.
    const CHARS_PER_TOKEN = 4;
    const RESERVED_FRACTION = 0.15;
    const availableChars = Math.floor(maxTokens * (1 - RESERVED_FRACTION) * CHARS_PER_TOKEN);
    const MANIFEST_CAP = Math.floor(availableChars * 0.35);    // 35% → file map
    const PLAN_CAP     = Math.floor(availableChars * 0.30);    // 30% → implementation plan
    const SLINGER_CAP  = Math.floor(availableChars * 0.20);    // 20% → slinger symbol report
    // Remaining 15% is output budget (covered by RESERVED_FRACTION above)
    onUpdate?.({ text: `📐 Context budget (${maxTokens} tokens): manifest=${Math.round(MANIFEST_CAP/1000)}k  plan=${Math.round(PLAN_CAP/1000)}k  slinger=${Math.round(SLINGER_CAP/1000)}k chars` });

    const cappedPlan = implementationPlan.length > PLAN_CAP
      ? implementationPlan.slice(0, PLAN_CAP) + `\n...[TRUNCATED — plan exceeded ${PLAN_CAP} chars. Pass a shorter plan or increase model context.]`
      : implementationPlan;
    if (implementationPlan.length > PLAN_CAP) {
      onUpdate?.({ text: `⚠️ Aristomenis: implementationPlan truncated to ${PLAN_CAP} chars (model context: ${maxTokens} tokens).` });
    }

    const isPlanOnly = implementationPlan.includes("[PLAN ONLY]") || implementationPlan.includes("[PLAN ONLY:]");
    this.governor.setPlanOnly(isPlanOnly);
    if (isPlanOnly) {
      onUpdate?.({ text: `📋 **PLAN ONLY MODE** — Will generate checklist without executing.` });
    }

    const runDir = join(this.governor.config.stateDir, 'runs', runId);
    const contextFile = join(runDir, "context.json");
    const progressFile = join(runDir, "progress.md");
    const reviewFile = join(runDir, "review.md");
    const traceFile = join(runDir, "trace.jsonl");

    const writeTrace = (data: any) => {
      try { appendFileSync(traceFile, JSON.stringify({ ts: new Date().toISOString(), ...data }) + "\n"); } catch { }
    };

    const globalContext = await getGlobalContext();
    mkdirSync(this.governor.config.stateDir, { recursive: true }); // for stream.log / events.jsonl
    mkdirSync(runDir, { recursive: true });
    this.sessionTotalTokens = 0;

    // Fresh run — clear stream.log and events.jsonl for clean watch UI
    try { writeFileSync(join(this.governor.config.stateDir, 'stream.log'), ''); } catch { }
    try { writeFileSync(join(this.governor.config.stateDir, 'events.jsonl'), ''); } catch { }
    this.writeEvent({ type: 'run_start', runId, model: modelName, projectRoot: process.cwd() });

    // --- 1. SCOUT PHASE ---
    const scoutPersona = pickName(runId, "Scout");
    this.currentPhase = "Scout";
    this.governor.setPhase('scout');
    onUpdate?.({ text: `### 🛡️ ${scoutPersona.name} is scouting\n**Mapping Workspace Territory**\n---\nScanning workspace...` });

    const IGNORE_DIRS = ['node_modules', 'venv', '.venv', '__pycache__', '.git', 'dist', 'build', '.helot', '.helots'];
    const fileList = getAllFiles(process.cwd(), this.governor.config.stateDir)
      .filter(f => !IGNORE_DIRS.some(d => f.replace(/\\/g, '/').includes(`/${d}/`)));
    const manifest = { files: fileList.map(f => ({ path: relative(process.cwd(), f), size: existsSync(f) ? readFileSync(f).length : 0 })) };
    const manifestRaw = JSON.stringify(manifest, null, 2).slice(0, MANIFEST_CAP);
    writeFileSync(contextFile, manifestRaw);
    await writeTrace({ phase: "scout", status: "complete", fileCount: fileList.length });

    // --- 2. PRE-SLINGER PHASE (Symbol Mapping — pure in-process walk, no shell) ---
    this.governor.setPhase('aristomenis');
    onUpdate?.({ text: `🏹 Pre-Slinger: scanning source symbols...` });
    let preSlingerReport = "";
    const symbolMap: Record<string, string[]> = {};
    try {
      const srcDir = join(process.cwd(), 'src');
      const SOURCE_EXTS = /\.(py|ts|tsx|js|jsx|mjs|cjs)$/;
      const srcFiles = existsSync(srcDir)
        ? getAllFiles(srcDir, this.governor.config.stateDir).filter(f => SOURCE_EXTS.test(f))
        : [];
      const sigLines: string[] = [];
      for (const absFile of srcFiles) {
        const relFile = relative(process.cwd(), absFile).replace(/\\/g, '/');
        const fileLang = detectLang(absFile);
        const lines = readFileSync(absFile, 'utf-8').split('\n');
        const fileSymbols: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          let m: RegExpMatchArray | null = null;
          if (fileLang === 'python') {
            m = line.match(/^(?:async\s+)?(?:def|class)\s+(\w+)/);
          } else if (fileLang === 'typescript') {
            // Only top-level (non-indented) declarations
            if (/^\s/.test(line)) continue;
            m = line.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/) ||
                line.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/) ||
                line.match(/^(?:export\s+)?const\s+(\w+)\s*=/);
          }
          if (m) {
            fileSymbols.push(m[1]);
            const snippet = lines.slice(i, Math.min(i + 2, lines.length)).join(' | ');
            sigLines.push(`${relFile}:${i + 1}: ${snippet}`);
          }
        }
        if (fileSymbols.length > 0) symbolMap[relFile] = fileSymbols;
      }
      const symbolLines = Object.entries(symbolMap)
        .map(([f, syms]) => `${f}: ${syms.join(', ')}`)
        .join('\n');
      preSlingerReport = `=== SYMBOLS BY FILE ===\n${symbolLines}\n\n=== SIGNATURES ===\n${sigLines.join('\n')}`;
      const totalSymbols = Object.values(symbolMap).flat().length;
      onUpdate?.({ text: `✅ Pre-Slinger: ${srcFiles.length} files, ${totalSymbols} symbols` });
    } catch (e: any) {
      onUpdate?.({ text: `⚠️ Pre-Slinger scan failed: ${e.message}` });
    }

    // --- 3. PLAN PHASE — Frontier-planned (structured tasks) OR Aristomenis ---
    let taskNodes: HelotTask[];

    if (frontierTasks && frontierTasks.length > 0) {
      // ── FRONTIER-PLANNED PATH: skip Aristomenis entirely ──────────────────
      this.currentPhase = "Architect";
      onUpdate?.({ text: `📋 **Frontier-Planned Mode** — ${frontierTasks.length} tasks (Aristomenis bypassed)` });

      taskNodes = frontierTasks.map(ft => ({
        id: ft.id,
        description: ft.description,
        status: 'pending' as const,
        file: ft.file,
        targetSymbol: ft.symbol,
        dependsOn: ft.dependsOn ?? [],
        changes: ft.changes,
      }));

      // Symbol validation — clear hallucinated symbols to fall back to full-file mode
      if (Object.keys(symbolMap).length > 0) {
        const allValidSymbols = new Set(Object.values(symbolMap).flat());
        for (const task of taskNodes) {
          if (task.targetSymbol && !allValidSymbols.has(task.targetSymbol)) {
            onUpdate?.({ text: `⚠️ Symbol "${task.targetSymbol}" (Task ${task.id}) not in codebase — clearing for full-file mode.` });
            task.targetSymbol = undefined;
          }
        }
      }

      const syntheticChecklist = taskNodes
        .map(t => `- [ ] ${t.id}. ${t.description} (Target: ${t.file}, Symbol: ${t.targetSymbol ?? 'N/A'}, Action: EDIT) [DEPENDS: ${t.dependsOn?.join(', ') || 'none'}]`)
        .join('\n');
      writeFileSync(progressFile, syntheticChecklist);
      onUpdate?.({ text: `📋 **Task List:**\n${syntheticChecklist}` });
      await writeTrace({ phase: "aristomenis", status: "bypassed_frontier_planned" });
      this.governor.setPhase('builder');

    } else {
      // ── ARISTOMENIS PATH (original) ────────────────────────────────────────
      const aristomenisSystem = `${globalContext}
You are Aristomenis, the Architect. DESIGN the technical implementation checklist with SPARTAN SIMPLICITY.
Based on the Project Map, the Slinger Symbol Report, and the Frontier Plan, create a granular checklist in \`progress.md\`.

SPARTAN CODE PRINCIPLES:
1. MODULARITY: If a Target File exceeds 400 lines, split logic into sub-modules.
2. SURGICAL PRECISION: Each task targets ONE file and ONE symbol. If a refactor requires changing N functions, create N separate tasks — one per symbol — linked with DEPENDS. Never bundle multiple symbols into one task.
3. DEPENDENCY AWARENESS: Mark which tasks depend on others using [DEPENDS: N].

TASK FORMAT — CRITICAL: every task MUST start with "- [ ]" (hyphen space bracket space bracket):
- [ ] 1. Create greeting utility (Target: src/core/greeting.ts, Action: CREATE) [DEPENDS: none]
- [ ] 2. Update scout to use greeting (Target: src/core/scout.ts, Symbol: getSymbolSlice, Action: EDIT) [DEPENDS: 1]

SYMBOL RULE — CRITICAL: Symbol must be an EXISTING function or class name from the VALID SYMBOLS list in your user message. Choose from that list ONLY — do not invent or guess names. If you need to create a new symbol, use Action: CREATE (no Symbol field needed).

FORBIDDEN TASK TYPES — NEVER generate tasks like these (they are not executable by the Builder):
- "Open <file>" / "Read <file>" / "Save <file>" — the Builder reads/writes automatically
- "Locate <pattern>" / "Find all instances of..." / "Search for..." — not a code change
- "Verify <file>" / "Confirm <file>" / "Check that..." / "Run tests" — not a code write
- "Ensure <X>" / "Make sure <X>" — vague, not a concrete file edit
Every task MUST result in a file being written (Action: CREATE) or a function/class being modified (Action: EDIT).
If the Frontier Plan contains procedural steps (open, locate, verify, save), IGNORE them and instead generate the equivalent code-write task.

RESPOND ONLY WITH THE CHECKLIST. DO NOT USE PLACEHOLDERS.`;

      this.currentPhase = "Architect";
      onUpdate?.({ text: `[Aristomenis] Designing implementation strategy...` });

      const cappedSlingerReport = preSlingerReport.slice(0, SLINGER_CAP);
      let checklist = await this.runSubagent('Aristomenis', 'Aristomenis', aristomenisSystem, `Project Map: ${manifestRaw}\n\nVALID SYMBOLS (use ONLY these names for any Symbol: field — no other names are allowed):\n${cappedSlingerReport}\n\nFrontier Plan: ${cappedPlan}`, onUpdate, {}, 'INSTRUCT_GENERAL', modelName);

      if (checklist.includes("NEED MORE DATA:")) {
        const query = checklist.split("NEED MORE DATA:")[1].trim();
        onUpdate?.({ text: `🏹 Aristomenis requested data. Deploying Slinger...` });
        const slingerReport = await this.executeSlinger(query, undefined, onUpdate);
        checklist = await this.runSubagent('Aristomenis', 'Aristomenis', aristomenisSystem, `RE-PLANNING with Slinger Report:\n${slingerReport}\n\nProject Map: ${manifestRaw}\n\nFrontier Plan: ${cappedPlan}`, onUpdate, {}, 'INSTRUCT_GENERAL', modelName);
      }

      checklist = stripThinking(checklist);
      if (!checklist.includes("- [ ]")) {
        const rawPlanFile = join(this.governor.config.stateDir, "raw-plan-failure.md");
        writeFileSync(rawPlanFile, checklist);
        await writeTrace({ phase: "aristomenis", status: "failed_malformed" });
        return `[ERROR] Aristomenis produced a malformed checklist.\n\nOptions:\n- [RETRY] Try again\n- [ABORT] Stop here\n\nRaw output saved to ${rawPlanFile}`;
      }

      onUpdate?.({ text: `📋 **Spartan Checklist Generated:**\n${checklist}` });
      writeFileSync(progressFile, checklist);

      if (this.governor.isPlanOnly()) {
        await writeTrace({ phase: "aristomenis", status: "plan_only" });
        this.governor.setPhase('finished');
        return `[PLAN ONLY] ✅ Checklist drafted. Call again without [PLAN ONLY] to execute.\n\n${checklist}`;
      }
      await writeTrace({ phase: "aristomenis", status: "complete" });
      this.governor.setPhase('builder');

      taskNodes = this.parseChecklist(checklist);

      if (Object.keys(symbolMap).length > 0) {
        const allValidSymbols = new Set(Object.values(symbolMap).flat());
        for (const task of taskNodes) {
          if (task.targetSymbol && !allValidSymbols.has(task.targetSymbol)) {
            onUpdate?.({ text: `⚠️ Plan validation: symbol "${task.targetSymbol}" (Task ${task.id}) is not a real symbol — clearing for full-file edit mode.` });
            task.targetSymbol = undefined;
          }
        }
      }
    }

    writeFileSync(reviewFile, `# Aristomenis Review Report\nPlan: ${taskSummary}\n\n`);

    const halt = await this.runTaskLoop(taskNodes, runId, modelName, globalContext, cappedPlan, psiloiMetrics, reviewFile, onUpdate, writeTrace);
    if (halt) return halt;

    const passed = taskNodes.filter(t => t.status === 'completed').length;
    const failed = taskNodes.filter(t => t.status === 'failed').length;
    this.writeEvent({ type: 'run_end', passed, failed });
    onUpdate?.({ text: `✅ Execution complete! ${passed}/${taskNodes.length} tasks passed.` });
    this.governor.setPhase('finished');
    return this.governor.generateSweepReport();
  }

  async executeSlinger(researchTask: string, targetFiles: string[] | undefined, onUpdate?: (data: any) => void): Promise<string> {
    const runId = this.governor.getRunId();
    const { modelName, maxTokens } = await this.client.getProps();
    const slingerPersona = pickName(runId, "Slinger");
    const isWindows = process.platform === 'win32';

    // Derive the target project root from targetFiles (may differ from process.cwd())
    let targetProjectRoot: string | undefined;
    if (targetFiles && targetFiles.length > 0) {
      const first = targetFiles[0].replace(/\\/g, '/');
      const srcIdx = first.indexOf('/src/');
      targetProjectRoot = srcIdx >= 0 ? targetFiles[0].slice(0, srcIdx) : undefined;
    }

    const slingerSystem = `You are the Slinger — a code reconnaissance agent. Execute read-only shell commands to answer the research question.

CRITICAL: Do NOT write any reasoning, explanation, or preamble before ### COMMAND. Your FIRST output must be ### COMMAND.

FORMAT (strict — one command per turn):
### COMMAND
<single command — must be ONE line, no line breaks>
### END_COMMAND

When you have sufficient evidence, output your findings instead of a command:
### SUMMARY
<what was found>
### LOCATIONS
<file:line for each key finding>
### EVIDENCE
<relevant code snippets>

SEARCH TOOLKIT (grep is the primary tool — use it first):
  IMPORTANT: Always use SINGLE QUOTES around patterns and paths. Double quotes cause PowerShell parse errors.
  grep -rn '^pattern' src/                           search all source files
  grep -rn '^pattern' src/ --include=*.ts            search TypeScript only (no quotes on --include value)
  grep -E -rn 'pattern1|pattern2' src/               multiple patterns (use -E and | not \\|)
  grep -n '^pattern' src/core/engine.ts              search a specific file
  grep -rl '^pattern' src/                           list files containing pattern (no line content)
  grep -rn '^export' src/core/engine.ts              find all exports in a file

FILE LISTING (when you need to discover files):
${isWindows
  ? `  Get-ChildItem -Recurse -Name                    list all files
  Get-ChildItem -Recurse -Filter *.ts -Name        list by extension (no quotes)`
  : `  find src/ -name "*.ts" -not -path "*/node_modules/*"
  ls -la src/core/`}

READ FILES (when you need to see full context):
${isWindows
  ? `  Get-Content src/core/engine.ts | Select-Object -First 80
  Get-Content src/core/engine.ts | Measure-Object -Line`
  : `  head -80 src/core/engine.ts
  wc -l src/core/engine.ts`}

STRATEGY:
${targetFiles && targetFiles.length > 0
  ? `⚠️  PRE-LOADED FILES ARE IN YOUR PROMPT — follow this order strictly:
STEP 1: Your user message contains a "## PRE-LOADED FILE CONTENT" section with ${targetFiles.length} file(s) under "=== FILE: path ===" headers. READ ALL OF THEM NOW before doing anything else.
STEP 2: Answer as many questions as possible directly from that content.
STEP 3: Only issue a ### COMMAND for information genuinely absent from the pre-loaded files.
STEP 4: Output ### SUMMARY once you have covered all pre-loaded files.
DO NOT issue Get-Content or cat for any file already in the PRE-LOADED section.`
  : `1. grep first — it gives file:line:content instantly, no file listing needed
2. Only use file listing if you genuinely do not know where to look
3. Only read a full file if grep cannot answer the question
4. After 2-3 successful commands, you likely have enough — output ### SUMMARY`}
For any grep/search commands use absolute paths: grep -rn 'pattern' '${targetProjectRoot || process.cwd()}'`;

    // Allowlist: check the raw expression the model outputs (before our shell wrapper is added).
    // Strip any accidental powershell.exe/bash prefix the model may have included.
    const stripShellWrapper = (cmd: string): string => {
      return cmd
        .replace(/^powershell(?:\.exe)?\s+(?:-\w+\s+)*-Command\s+"?/i, '')
        .replace(/"$/, '')
        .replace(/^(?:bash|sh)\s+-c\s+"?/i, '')
        .replace(/"$/, '')
        .trim();
    };
    const SAFE_PATTERNS = [
      /^(ls|cat|find|rg|grep|head|tail|wc|dir)\b/i,
      /^git\s+(status|diff|log|show|branch|shortlog|stash\s+list)\b/i,  // read-only git
      /^(ruff|python|python3)\b/i,                                       // linting + syntax checks
      /^Get-(ChildItem|Content|Item)\b/i,
      /^Select-(String|Object)\b/i,
      /^Measure-Object\b/i,
      /^Where-Object\b/i,
    ];
    const isSafeCommand = (cmd: string) => SAFE_PATTERNS.some(p => p.test(stripShellWrapper(cmd).trim()));

    onUpdate?.({ text: `🏹 Slinger ${slingerPersona.name} deployed.` });
    this.writeEvent({ type: 'slinger_start', task: researchTask.slice(0, 120), name: slingerPersona.name });
    let history = "";
    let preloadedContent = "";

    // Dynamic FILE_CAP: scale with live model context, split evenly across files.
    // Reserve ~10k tokens for system prompt + task + history + output budget.
    // 4 chars ≈ 1 token. Floor at 2k/file, ceiling at 20k/file.
    const RESERVED_TOKENS = 10000;
    const CHARS_PER_TOKEN = 4;
    const numFiles = targetFiles?.length || 1;
    const availableChars = Math.max(2000 * numFiles, (maxTokens - RESERVED_TOKENS) * CHARS_PER_TOKEN);
    const FILE_CAP = Math.floor(availableChars / numFiles);
    onUpdate?.({ text: `📐 Context: ${maxTokens} tokens → FILE_CAP: ${FILE_CAP} chars × ${numFiles} file(s)` });

    // Preload targetFiles into their own section (separate from command history)
    if (targetFiles && targetFiles.length > 0) {
      onUpdate?.({ text: `📖 Slinger preloading ${targetFiles.length} file(s)...` });
      for (const f of targetFiles) {
        try {
          const content = readFileSync(path.resolve(f), 'utf-8');
          const truncated = content.length > FILE_CAP;
          preloadedContent += `\n=== FILE: ${f} ===\n${content.slice(0, FILE_CAP)}${truncated ? `\n...[TRUNCATED at ${FILE_CAP} chars — grep for deeper search]` : ''}\n`;
        } catch (e: any) {
          preloadedContent += `\n=== FILE: ${f} ===\n(Error reading: ${e.message})\n`;
        }
      }
    }


    // Write per-run slinger log and return the report unchanged
    const writeSlingerLog = (report: string): string => {
      this.writeEvent({ type: 'slinger_done', task: researchTask.slice(0, 120), name: slingerPersona.name });
      try {
        const logsDir = join(this.governor.config.stateDir, 'slinger-logs');
        mkdirSync(logsDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        writeFileSync(join(logsDir, `slinger-${ts}.md`), `# Slinger Report\n**Task:** ${researchTask}\n\n${report}`);
      } catch { /* non-fatal */ }
      return report;
    };

    for (let turn = 1; turn <= 8; turn++) {
      const turnsLeft = 8 - turn;
      const isFinalTurn = turnsLeft === 0;
      const summaryNudge = isFinalTurn
        ? `\nFINAL TURN — DO NOT output a ### COMMAND block. You MUST output ### SUMMARY, ### LOCATIONS, and ### EVIDENCE right now using only the information already in History.\n`
        : turnsLeft === 1
          ? `\nWARNING: 1 turn remaining after this. Plan to summarize on the next turn.\n`
          : '';
      // On the final turn don't halt on END_COMMAND — let the summary stream fully
      const haltTokens = isFinalTurn ? undefined : ["### END_COMMAND"];
      const preloadSection = preloadedContent
        ? `\n\n## PRE-LOADED FILE CONTENT (authoritative — answer from this before issuing any commands):\n${preloadedContent}`
        : '';
      const result = await this.runSubagent("Slinger", slingerPersona.name, slingerSystem, `Research: ${researchTask}${preloadSection}\n\nCommand History:\n${history}${summaryNudge}`, onUpdate, {}, "SLINGER", modelName, haltTokens);

      // Robust command extraction: works whether model re-emits "### COMMAND" header or omits it
      const endIdx = result.indexOf('### END_COMMAND');
      let cmdText: string | null = null;
      if (endIdx >= 0) {
        let raw = result.slice(0, endIdx);
        const headerIdx = raw.lastIndexOf('### COMMAND');
        if (headerIdx >= 0) raw = raw.slice(headerIdx + '### COMMAND'.length);
        cmdText = raw.replace(/\r?\n/g, ' ').trim();
      }
      const cmdMatch = cmdText !== null ? [null, cmdText] : null;

      if (cmdMatch) {
        const command = stripShellWrapper(cmdMatch[1] as string);
        if (!isSafeCommand(command)) {
          history += `\n[Turn ${turn}] BLOCKED: "${command.slice(0, 80)}" is not in the safe allowlist. Use only read-only commands: grep, find, head, wc, cat, Get-ChildItem, Get-Content, Measure-Object.\n`;
          continue;
        }
        try {
          let output: string;
          if (isWindows && /^grep\b/i.test(command)) {
            // Route all grep through Node.js — PowerShell chokes on quotes in complex patterns
            output = nodeGrepCommand(command, process.cwd()).slice(0, 6000);
          } else if (isWindows) {
            // Use spawnSync with explicit args to bypass cmd.exe — avoids | being interpreted as a pipe
            const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
              cwd: process.cwd(),
              encoding: 'utf-8',
              maxBuffer: 1024 * 1024 * 5,
            });
            output = ((result.stdout || '') + (result.stderr || '')).slice(0, 6000);
            if (result.error) throw result.error;
          } else {
            output = execSync(command, { cwd: process.cwd(), shell: '/bin/bash', stdio: 'pipe', maxBuffer: 1024 * 1024 * 5 }).toString().slice(0, 6000);
          }
          history += `\n[Turn ${turn}] Command: ${command}\nOutput:\n${output}\n`;
        } catch (e: any) {
          history += `\n[Turn ${turn}] Command Failed: ${e.message}\n`;
        }
      } else if (result.includes("### SUMMARY")) {
        return writeSlingerLog(result);
      } else if (isFinalTurn) {
        // Final turn: model gave prose without ### SUMMARY format — accept it as-is
        return writeSlingerLog(`### SUMMARY\n${result}\n\n### EVIDENCE\n${history}`);
      } else {
        // Non-final turn: model gave prose without a command — record and continue
        history += `\n[Turn ${turn}] (No command issued)\n`;
      }
    }
    return writeSlingerLog(`### SUMMARY\nSlinger exhausted turns without a final summary.\n\n### EVIDENCE\n${history}`);
  }

  /**
   * VISION WORKFLOW
   * Fully autonomous flow: Slinger → Plan → Aristomenis → Frontier approval → Execute
   */
  async executeVision(
    userIntent: string,
    additionalContext: string | undefined,
    onUpdate?: (data: any) => void
  ): Promise<string> {
    const runId = this.governor.getRunId();
    const { modelName } = await this.client.getProps();
    const globalContext = await getGlobalContext();

    const runDir = join(this.governor.config.stateDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const visionFile = join(runDir, "vision.md");
    const planFile = join(runDir, "plan.md");
    const tasksFile = join(runDir, "tasks.md");

    // Step 1: Slinger exploration
    this.governor.setPhase('scout');
    onUpdate?.({ text: `🎯 **VISION WORKFLOW**\n\n1️⃣ Slinger exploring codebase...` });

    const slingerResult = await this.executeSlinger(
      `Explore the codebase to understand its structure for: "${userIntent}"\n${additionalContext ? `Context: ${additionalContext}` : ''}\nProvide: file structure overview, key relevant modules, existing patterns to follow.`,
      undefined, onUpdate
    );

    writeFileSync(visionFile, `# Vision: ${userIntent}\n\n## Slinger Exploration\n${slingerResult}\n\n## Additional Context\n${additionalContext || 'None'}\n`);
    onUpdate?.({ text: `✅ Slinger exploration complete.` });

    // Step 2: High-level plan
    onUpdate?.({ text: `2️⃣ Creating high-level plan...` });

    const plannerSystem = `${globalContext}
You are a Technical Planner. Based on the user's vision and Slinger exploration, create a HIGH-LEVEL plan.

OUTPUT FORMAT:
## Vision
[Brief restatement]

## Approach
[How to achieve this — architectural decisions]

## Files to Modify
[List of files that likely need changes]

## Potential Challenges
[Any risks or considerations]

Respond ONLY with the plan. No code yet.`;

    const planResult = await this.runSubagent("Planner", pickName(runId, "Planner").name, plannerSystem, `User Intent: ${userIntent}\n\nSlinger Exploration:\n${slingerResult}`, onUpdate, {}, "THINKING_GENERAL", modelName);

    const planContent = stripThinking(planResult);
    writeFileSync(planFile, planContent);

    // Step 3: Aristomenis detailed tasks
    onUpdate?.({ text: `3️⃣ Aristomenis creating detailed tasks...` });

    const fileList = getAllFiles(process.cwd(), this.governor.config.stateDir);
    const manifest = { files: fileList.map(f => ({ path: relative(process.cwd(), f), size: existsSync(f) ? readFileSync(f).length : 0 })) };
    const { modelName: visionModelName, maxTokens: visionMaxTokens } = await this.client.getProps();
    const VISION_MANIFEST_CAP = Math.min(48000, Math.max(16000, Math.floor((visionMaxTokens * 4) * 0.25)));
    const manifestRaw = JSON.stringify(manifest, null, 2).slice(0, VISION_MANIFEST_CAP);
    writeFileSync(join(this.governor.config.stateDir, "context.json"), manifestRaw);

    const aristomenisSystem = `${globalContext}
You are Aristomenis, the Architect. Translate the high-level plan into SPECIFIC, EXECUTABLE tasks.

SPARTAN TASK FORMAT:
- [ ] 1. Task description (Target: src/path/file.ts, Symbol: functionName, Action: CREATE|EDIT) [DEPENDS: none]

IMPORTANT:
- Each task must have exact file paths from the Project Map
- Use Symbol: to specify the exact function/variable to modify
- Mark dependencies correctly with [DEPENDS: N]`;

    let tasks = await this.runSubagent("Aristomenis", pickName(runId, "Aristomenis").name, aristomenisSystem, `## High-Level Plan\n${planContent}\n\n## Project Map\n${manifestRaw.slice(0, 10000)}\n\nCreate detailed tasks.`, onUpdate, {}, "THINKING_GENERAL", modelName);

    tasks = stripThinking(tasks);
    if (!tasks.includes("- [ ]")) {
      writeFileSync(join(this.governor.config.stateDir, "raw-tasks-failure.md"), tasks);
      return `[ERROR] Aristomenis failed to create tasks. Raw: ${tasks.slice(0, 500)}`;
    }

    writeFileSync(tasksFile, tasks);
    this.governor.setPhase('aristomenis');

    // Step 4: Frontier approval gate
    const approvalPrompt = `══════════════════════════════════════════════
🎯 **VISION WORKFLOW — APPROVAL REQUIRED**
══════════════════════════════════════════════

## User Intent
${userIntent}

## High-Level Plan
${planContent}

## Detailed Tasks (Aristomenis)
${tasks}

══════════════════════════════════════════════

Options:
- [APPROVE] Proceed with these tasks
- [MODIFY] Provide changes (detail below)
- [ABORT] Stop here

Reply with APPROVE, MODIFY (with details), or ABORT.`;

    onUpdate?.({ text: approvalPrompt });
    return `[📋 APPROVAL REQUIRED]\n\n${approvalPrompt}`;
  }

  /**
   * Execute approved tasks — called after Frontier approves the task list
   */
  async executeApprovedTasks(
    approvalResponse: string,
    modifications?: string,
    onUpdate?: (data: any) => void
  ): Promise<string> {
    const runId = this.governor.getRunId();
    const { modelName } = await this.client.getProps();
    const globalContext = await getGlobalContext();
    const psiloiMetrics = { scout: { in: 0, out: 0, tps: 0 }, builder: { in: 0, out: 0, tps: 0 }, peltast: { in: 0, out: 0, tps: 0 } };

    const runDir = join(this.governor.config.stateDir, 'runs', runId);
    const tasksFile = join(runDir, "tasks.md");
    const reviewFile = join(runDir, "review.md");

    let tasks = readFileSync(tasksFile, 'utf-8');

    if (approvalResponse === "MODIFY" && modifications) {
      onUpdate?.({ text: `🔄 Applying modifications. Re-running Aristomenis...` });

      const aristomenisSystem = `${globalContext}
You are Aristomenis. The user has provided MODIFICATIONS to the tasks. Apply them and regenerate the task list:
${modifications}`;

      tasks = await this.runSubagent("Aristomenis", pickName(runId, "Aristomenis").name, aristomenisSystem, `Original tasks:\n${tasks}\n\nUser modifications:\n${modifications}`, onUpdate, {}, "THINKING_GENERAL", modelName);

      tasks = stripThinking(tasks);
      if (!tasks.includes("- [ ]")) {
        return `[ERROR] Aristomenis failed to apply modifications.`;
      }
      writeFileSync(tasksFile, tasks);
    }

    onUpdate?.({ text: `4️⃣ **APPROVED — Starting Task Execution**\n` });
    this.governor.setPhase('builder');

    writeFileSync(reviewFile, `# Execution Review\nApproval: ${approvalResponse}\n\n`);

    const taskNodes = this.parseChecklist(tasks);
    const halt = await this.runTaskLoop(taskNodes, runId, modelName, globalContext, tasks, psiloiMetrics, reviewFile, onUpdate, writeTrace);
    if (halt) return halt;

    this.governor.setPhase('finished');
    onUpdate?.({ text: `✅ All tasks completed!` });
    return this.governor.generateSweepReport();
  }

  /** Write a structured event to events.jsonl for the watch UI */
  // ============================================================
  // TOOL RESOLVER: detect venv, check/install python tools
  // ============================================================
  private resolveTools(onUpdate: ((data: any) => void) | undefined): ToolSet {
    const projectRoot = process.cwd();
    const isWindows = process.platform === 'win32';
    const ext       = isWindows ? '.exe' : '';

    // Detect venv: check common names and VIRTUAL_ENV env var
    const venvCandidates = ['.venv', 'venv', 'env'];
    const envVarVenv     = process.env['VIRTUAL_ENV'];
    const venvRoot       = envVarVenv && existsSync(envVarVenv)
        ? envVarVenv
        : venvCandidates.map(d => join(projectRoot, d)).find(d => existsSync(d));
    const hasVenv    = !!venvRoot;
    const scriptsDir = venvRoot ? join(venvRoot, isWindows ? 'Scripts' : 'bin') : '';

    // Resolve python — prefer venv if present
    const venvPython = venvRoot ? join(scriptsDir, `python${ext}`) : '';
    const python     = hasVenv && existsSync(venvPython) ? venvPython : 'python';
    const pythonOk   = spawnSync(python, ['--version'], { encoding: 'utf-8', timeout: 5000 }).status === 0;
    if (!pythonOk) onUpdate?.({ text: '⚠️ python not found — syntax checking disabled.' });

    // Helper: find tool in venv or globally, auto-install in venv if missing
    const resolveTool = (name: string): string | null => {
      const venvBin = hasVenv ? join(scriptsDir, `${name}${ext}`) : '';

      if (hasVenv && existsSync(venvBin)) {
        if (spawnSync(venvBin, ['--version'], { encoding: 'utf-8', timeout: 5000 }).status === 0)
          return venvBin;
      }

      if (spawnSync(name, ['--version'], { encoding: 'utf-8', timeout: 5000 }).status === 0)
        return name;

      // Not found — auto-install into .venv if possible
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

    return { python: pythonOk ? python : 'python', ruff: resolveTool('ruff'), pytest: resolveTool('pytest') };
  }

  private writeEvent(event: Record<string, any>): void {
    try {
      const eventsFile = join(this.governor.config.stateDir, 'events.jsonl');
      appendFileSync(eventsFile, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
    } catch { }
  }

  private async runSubagent(role: string, name: string, systemPrompt: string, userPrompt: string, onUpdate: any, metrics: any, profile: string, model: string, haltOn?: string[], maxTokensOverride?: number): Promise<string> {
    let fullResponse = "";
    const baseTokensPrior = this.sessionTotalTokens;
    let streamAborted = false;
    let lastCompleteLine = "";
    let repeatCount = 0;
    let finalMetrics = { genTps: 0, promptTokens: 0, genTokens: 0, maxTokens: 0 };

    // Write phase event + stream marker for watch UI
    const streamLogPath = join(this.governor.config.stateDir, 'stream.log');
    this.writeEvent({ type: 'phase_change', phase: this.currentPhase, name });
    try { appendFileSync(streamLogPath, `\n\n--- ${this.currentPhase} | ${name} ---\n`); } catch { }

    try {
      await this.client.streamCompletion([{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], role as TaskRole, profile, maxTokensOverride, (chunk, m) => {
        if (streamAborted) return;
        fullResponse += chunk;

        // Write token stream to file for watch UI (best-effort, only on line boundaries to reduce I/O)
        if (chunk.includes('\n')) {
          try { appendFileSync(streamLogPath, chunk); } catch { }
        }

        if (haltOn && haltOn.some(stop => fullResponse.includes(stop))) {
          streamAborted = true;
          return;
        }

        if (chunk.includes('\n')) {
          const completedLine = chunk.split('\n').filter(l => l.trim().length > 15).pop()?.trim() || "";
          if (completedLine) {
            if (completedLine === lastCompleteLine) {
              if (++repeatCount > 8) { streamAborted = true; return; }
            } else { repeatCount = 0; lastCompleteLine = completedLine; }
          }
        }

        this.sessionTotalTokens = baseTokensPrior + (m.promptTokens + m.genTokens);
        finalMetrics = m;
      }, () => { });
    } catch (err: any) {
      onUpdate?.({ text: `⚠️ ${this.currentPhase} | ${name} | server error: ${err?.message ?? err}` });
    }

    // Detect silent server failure (connection dropped with no tokens)
    if (!fullResponse && finalMetrics.genTokens === 0) {
      onUpdate?.({ text: `❌ ${this.currentPhase} | ${name} | empty response — server may be down` });
      throw new Error(`${name}: server returned empty response (0 tokens). Is the LLM server running?`);
    }

    // Single summary line per subagent — no per-chunk noise
    const pressure = finalMetrics.maxTokens ? Math.round((finalMetrics.promptTokens / finalMetrics.maxTokens) * 100) : 0;
    const pressureTag = pressure > 70 ? ` ⚠️ ctx:${pressure}%` : "";
    onUpdate?.({ text: `✅ ${this.currentPhase} | ${name} | ${finalMetrics.genTps.toFixed(1)}t/s | ${finalMetrics.genTokens} gen + ${finalMetrics.promptTokens} prompt tokens${pressureTag}` });
    this.writeEvent({ type: 'subagent_done', phase: this.currentPhase, name, tps: finalMetrics.genTps, genTokens: finalMetrics.genTokens, promptTokens: finalMetrics.promptTokens, ctxPct: pressure });

    return fullResponse;
  }

  // ============================================================
  // HOPLITE: Lightweight read+write agent — no peltast review
  // For markdown, config, and doc updates where lint is irrelevant.
  // ============================================================
  async executeHoplite(file: string, instruction: string, onUpdate?: (data: any) => void): Promise<string> {
    const { modelName, maxTokens } = await this.client.getProps();
    const abs = resolve(file);
    const exists = existsSync(abs);
    const originalContent = exists ? readFileSync(abs, 'utf-8') : '';

    const systemPrompt = `You are a precise file editor. Apply the instruction to the file and output the complete updated file.

Output format — exactly one fenced block:
### [${file}]
\`\`\`
<complete file content>
\`\`\`

Rules:
- Output the COMPLETE file, not just the changed sections
- Do not add commentary outside the fenced block
- Preserve all content not mentioned in the instruction
- Identify target sections by their exact ## heading, not by content pattern matching
- If the instruction names a specific section (e.g. "Option 7"), only modify content under that heading
- When multiple similar patterns exist (e.g. several **Status:** lines), use the section heading to disambiguate`;

    const userPrompt = exists
      ? `File: ${file}\n\nCurrent content:\n\`\`\`\n${originalContent}\n\`\`\`\n\nInstruction: ${instruction}`
      : `File: ${file} (new file)\n\nInstruction: ${instruction}`;

    onUpdate?.({ text: `✏️ Hoplite editing ${file}...` });
    this.writeEvent({ type: 'hoplite_start', file, instruction: instruction.slice(0, 120) });

    // Dynamic max_tokens: scale with file size to avoid truncation
    let maxTokensOverride: number | undefined;
    if (originalContent) {
      const fileLines = originalContent.split('\n').length;
      const estimated = Math.ceil(fileLines * 15);
      const safeMax = maxTokens - 4096;
      const budget = Math.min(Math.max(estimated, 4096), safeMax);
      if (budget > 4096) maxTokensOverride = budget;
    }

    const raw = await this.runSubagent(
      'Builder', 'Hoplite', systemPrompt, userPrompt,
      onUpdate, { in: 0, out: 0, tps: 0 }, 'INSTRUCT_CODE', modelName, undefined, maxTokensOverride
    );

    const stripped = stripThinking(raw);
    const headerIdx = stripped.indexOf('### [');
    const parseFrom = headerIdx >= 0 ? stripped.slice(headerIdx) : stripped;
    // Greedy match + end-anchor: captures everything up to the LAST closing fence.
    // Non-greedy would stop at the first ``` inside the file content (e.g. code examples in markdown).
    const match = parseFrom.match(/###\s*\[[^\]]*\]\s*\n```[a-z]*\n([\s\S]*)\n```\s*$/i);
    if (!match) {
      return `❌ Hoplite: could not parse output for ${file}. Raw:\n${stripped.slice(0, 500)}`;
    }

    const newContent = match[1];

    // Backup original before overwriting
    if (exists) {
      try {
        const backupDir = join(this.governor.config.stateDir, 'hoplite-backups');
        mkdirSync(backupDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        writeFileSync(join(backupDir, `${basename(file)}.${ts}.bak`), originalContent);
      } catch { /* non-fatal */ }
    }

    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, newContent, 'utf-8');

    const linesBefore = originalContent ? originalContent.split('\n').length : 0;
    const linesAfter = newContent.split('\n').length;
    onUpdate?.({ text: `✅ Hoplite: ${file} written (${linesBefore} → ${linesAfter} lines)` });
    this.writeEvent({ type: 'hoplite_done', file, linesBefore, linesAfter });

    return `✅ ${file} written (${linesBefore} → ${linesAfter} lines)`;
  }
}
