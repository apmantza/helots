/**
 * slinger-agent.ts — Code reconnaissance agent (Slinger).
 *
 * Executes read-only shell commands to answer research questions.
 * Supports targetFiles preloading and a 8-turn command loop.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join }      from 'path';
import * as path     from 'path';
import { spawnSync } from 'child_process';
import { execSync }  from 'child_process';
import { nodeGrepCommand } from './grep-utils.js';
import { pickName }        from './persona-utils.js';
import { Aristomenis }     from './governor.js';
import type { RunSubagentFn, WriteEventFn } from './types.js';

export class SlingerAgent {
  constructor(
    private governor:      Aristomenis,
    private runSubagentFn: RunSubagentFn,
    private writeEventFn:  WriteEventFn,
    private setPhase:      (p: string) => void,
    private getModelProps: () => Promise<{ modelName: string; maxTokens: number }>,
  ) {}

  async execute(
    researchTask: string,
    targetFiles:  string[] | undefined,
    onUpdate?:    (data: any) => void,
  ): Promise<string> {
    const { modelName, maxTokens } = await this.getModelProps();
    const slingerPersona = pickName(Date.now().toString(), 'Slinger');
    const isWindows = process.platform === 'win32';

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

    const stripShellWrapper = (cmd: string): string =>
      cmd
        .replace(/^powershell(?:\.exe)?\s+(?:-\w+\s+)*-Command\s+"?/i, '')
        .replace(/"$/, '')
        .replace(/^(?:bash|sh)\s+-c\s+"?/i, '')
        .replace(/"$/, '')
        .trim();

    const SAFE_PATTERNS = [
      /^(ls|cat|find|rg|grep|head|tail|wc|dir)\b/i,
      /^git\s+(status|diff|log|show|branch|shortlog|stash\s+list)\b/i,
      /^(ruff|python|python3)\b/i,
      /^Get-(ChildItem|Content|Item)\b/i,
      /^Select-(String|Object)\b/i,
      /^Measure-Object\b/i,
      /^Where-Object\b/i,
    ];
    const isSafeCommand = (cmd: string) =>
      SAFE_PATTERNS.some(p => p.test(stripShellWrapper(cmd).trim()));

    onUpdate?.({ text: `🏹 Slinger ${slingerPersona.name} deployed.` });
    this.writeEventFn({ type: 'slinger_start', task: researchTask.slice(0, 120), name: slingerPersona.name });

    let history = '';
    let preloadedContent = '';

    const RESERVED_TOKENS = 10000;
    const CHARS_PER_TOKEN = 4;
    const numFiles = targetFiles?.length || 1;
    const availableChars = Math.max(2000 * numFiles, (maxTokens - RESERVED_TOKENS) * CHARS_PER_TOKEN);
    const FILE_CAP = Math.floor(availableChars / numFiles);
    onUpdate?.({ text: `📐 Context: ${maxTokens} tokens → FILE_CAP: ${FILE_CAP} chars × ${numFiles} file(s)` });

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

    const writeSlingerLog = (report: string): string => {
      this.writeEventFn({ type: 'slinger_done', task: researchTask.slice(0, 120), name: slingerPersona.name });
      try {
        const logsDir = join(this.governor.config.stateDir, 'slinger-logs');
        mkdirSync(logsDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        writeFileSync(join(logsDir, `slinger-${ts}.md`), `# Slinger Report\n**Task:** ${researchTask}\n\n${report}`);
      } catch { /* non-fatal */ }
      return report;
    };

    this.setPhase('Slinger');

    for (let turn = 1; turn <= 8; turn++) {
      const turnsLeft = 8 - turn;
      const isFinalTurn = turnsLeft === 0;
      const summaryNudge = isFinalTurn
        ? `\nFINAL TURN — DO NOT output a ### COMMAND block. You MUST output ### SUMMARY, ### LOCATIONS, and ### EVIDENCE right now using only the information already in History.\n`
        : turnsLeft === 1
          ? `\nWARNING: 1 turn remaining after this. Plan to summarize on the next turn.\n`
          : '';
      const haltTokens = isFinalTurn ? undefined : ['### END_COMMAND'];
      const preloadSection = preloadedContent
        ? `\n\n## PRE-LOADED FILE CONTENT (authoritative — answer from this before issuing any commands):\n${preloadedContent}`
        : '';

      const result = await this.runSubagentFn(
        'Slinger', slingerPersona.name, slingerSystem,
        `Research: ${researchTask}${preloadSection}\n\nCommand History:\n${history}${summaryNudge}`,
        onUpdate, {}, 'SLINGER', modelName, haltTokens,
      );

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
          history += `\n[Turn ${turn}] BLOCKED: "${command.slice(0, 80)}" is not in the safe allowlist.\n`;
          continue;
        }
        try {
          let output: string;
          if (isWindows && /^grep\b/i.test(command)) {
            output = nodeGrepCommand(command, process.cwd()).slice(0, 6000);
          } else if (isWindows) {
            const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
              cwd: process.cwd(), encoding: 'utf-8', maxBuffer: 1024 * 1024 * 5,
            });
            output = ((r.stdout || '') + (r.stderr || '')).slice(0, 6000);
            if (r.error) throw r.error;
          } else {
            output = execSync(command, { cwd: process.cwd(), shell: '/bin/bash', stdio: 'pipe', maxBuffer: 1024 * 1024 * 5 }).toString().slice(0, 6000);
          }
          history += `\n[Turn ${turn}] Command: ${command}\nOutput:\n${output}\n`;
        } catch (e: any) {
          history += `\n[Turn ${turn}] Command Failed: ${e.message}\n`;
        }
      } else if (result.includes('### SUMMARY')) {
        return writeSlingerLog(result);
      } else if (isFinalTurn) {
        return writeSlingerLog(`### SUMMARY\n${result}\n\n### EVIDENCE\n${history}`);
      } else {
        history += `\n[Turn ${turn}] (No command issued)\n`;
      }
    }
    return writeSlingerLog(`### SUMMARY\nSlinger exhausted turns without a final summary.\n\n### EVIDENCE\n${history}`);
  }
}
