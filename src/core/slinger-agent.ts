/**
 * slinger-agent.ts — Code reconnaissance agent (Slinger).
 *
 * Executes read-only shell commands to answer research questions.
 * Supports targetFiles preloading and a 8-turn command loop.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
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
CRITICAL: ### COMMAND and ### SUMMARY are MUTUALLY EXCLUSIVE. Never output both in the same response. Either issue a command OR summarize — never both.
CRITICAL: Never answer from memory or training data. Every claim in ### SUMMARY must come from actual command output in History.

FORMAT (strict — one command per turn):
### COMMAND
<single command — must be ONE line, no line breaks>
### END_COMMAND

When you have sufficient evidence FROM COMMAND HISTORY, output your findings instead of a command:
### SUMMARY
<what was found — every claim must reference actual command output. Never say "X is not found" unless you ran a command that confirmed absence.>
### LOCATIONS
<file:line for each key finding>
### EVIDENCE
<relevant code snippets — MUST be copied verbatim from the file: exact whitespace, exact indentation, no paraphrasing, no reformatting. Paste the raw lines as they appear on disk. Every claim in SUMMARY must have supporting EVIDENCE here.>

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
  ? `  Get-ChildItem -Recurse -Name | Where-Object { $_ -notmatch '\\\\node_modules\\\\|\\\\\.git\\\\|\\\\__pycache__\\\\|\\\\\.helot-mcp-connector\\\\' }
  Get-ChildItem -Recurse -Filter *.ts -Name | Where-Object { $_ -notmatch '\\\\node_modules\\\\|\\\\\.git\\\\|\\\\\.helot-mcp-connector\\\\' }`
  : `  find src/ -name "*.ts" -not -path "*/node_modules/*" -not -path "*/.git/*"
  find . -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/__pycache__/*" -not -path "*/.helot-mcp-connector/*"
  ls -la src/core/`}

READ FILES (when you need to see full context):
${isWindows
  ? `  Get-Content src/core/engine.ts | Select-Object -First 80
  Get-Content src/core/engine.ts | Measure-Object -Line`
  : `  head -80 src/core/engine.ts
  wc -l src/core/engine.ts`}

READ EXACT LINES (verbatim line-range extraction — use when you need precise code for editing):
  READLINES src/core/engine.ts 55-80        returns lines 55–80 exactly as they appear on disk
  READLINES src/adapters/mcp-server.ts 1-40
  Note: ONE file per command. Issue separate READLINES commands for each file across multiple turns.
  Note: Do NOT quote the path — no single or double quotes. Write: READLINES src/core/engine.ts 55-80
  Note: Output is raw file content — no synthesis, no paraphrasing.

FETCH (external URLs — GitHub READMEs, docs, API references):
  WEBFETCH https://raw.githubusercontent.com/owner/repo/main/README.md
  WEBFETCH https://docs.example.com/api-reference
  Note: GitHub blob URLs are auto-converted to raw. Output truncated to 8000 chars.

STRATEGY:
${targetFiles && targetFiles.length > 0
  ? `⚠️  PRE-LOADED FILES ARE IN YOUR PROMPT — follow this order strictly:
STEP 1: Your user message contains a "## PRE-LOADED FILE CONTENT" section with ${targetFiles.length} file(s) under "=== FILE: path ===" headers. READ ALL OF THEM NOW before doing anything else.
STEP 2: Answer as many questions as possible directly from that content.
STEP 3: Only issue a ### COMMAND for information genuinely absent from the pre-loaded files.
STEP 4: Output ### SUMMARY once you have covered all pre-loaded files.
DO NOT issue Get-Content or cat for any file already in the PRE-LOADED section.`
  : `1. If the task names a specific file (e.g. "check foo.ts"), grep THAT file first — do not search other files first.
2. grep first — it gives file:line:content instantly, no file listing needed
3. Only use file listing if you genuinely do not know where to look
4. Only read a full file if grep cannot answer the question
5. After 2-3 successful commands, you likely have enough — output ### SUMMARY`}
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
      /^READLINES\s+/i,
    ];
    const isSafeCommand = (cmd: string) =>
      SAFE_PATTERNS.some(p => p.test(stripShellWrapper(cmd).trim()));

    this.writeEventFn({ type: 'slinger_start', task: researchTask.slice(0, 120), name: slingerPersona.name });

    let history = '';
    let preloadedContent = '';

    // Reserve 55% for system prompt + command loop history + generation budget.
    // Hard cap per file at 20000 chars (~5000 tokens) to prevent single-file OOM.
    const RESERVED_TOKENS = Math.floor(maxTokens * 0.55);
    const CHARS_PER_TOKEN = 4;
    const numFiles = targetFiles?.length || 1;
    const availableChars = Math.max(2000 * numFiles, (maxTokens - RESERVED_TOKENS) * CHARS_PER_TOKEN);
    const FILE_CAP = Math.min(Math.floor(availableChars / numFiles), 20000);

    if (targetFiles && targetFiles.length > 0) {
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

    const dedupeReport = (report: string): string => {
      const seen = new Set<string>();
      const lines = report.split('\n');
      const out: string[] = [];
      for (const line of lines) {
        const t = line.trim();
        // Always keep: empty lines, section headers, code fence markers, file separators
        if (!t || t.startsWith('###') || t.startsWith('```') || t.startsWith('===') || t.startsWith('---')) {
          out.push(line); continue;
        }
        if (!seen.has(t)) { seen.add(t); out.push(line); }
      }
      return out.join('\n');
    };

    const writeSlingerLog = (report: string, turns?: number): string => {
      this.writeEventFn({ type: 'slinger_done', task: researchTask.slice(0, 120), name: slingerPersona.name });
      onUpdate?.({ text: `🏹 ${slingerPersona.name}: ${turns ?? '?'} turn(s) — ${researchTask.slice(0, 60)}` });
      try {
        const logsDir = join(this.governor.config.stateDir, 'slinger-logs');
        mkdirSync(logsDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        // Write full report to log, return deduped version to frontier
        writeFileSync(join(logsDir, `slinger-${ts}.md`), `# Slinger Report\n**Task:** ${researchTask}\n\n${report}`);
      } catch { /* non-fatal */ }
      return dedupeReport(report);
    };

    this.setPhase('Slinger');

    for (let turn = 1; turn <= 8; turn++) {
      const turnsLeft = 8 - turn;
      const isFinalTurn = turnsLeft === 0;
      const noCommandsYet = history.trim() === '' && !preloadedContent;
      const summaryNudge = isFinalTurn
        ? `\nFINAL TURN — DO NOT output a ### COMMAND block. You MUST output ### SUMMARY, ### LOCATIONS, and ### EVIDENCE right now using only the information already in History.\n`
        : turnsLeft === 1
          ? `\nWARNING: 1 turn remaining after this. Plan to summarize on the next turn.\n`
          : noCommandsYet
            ? `\nCRITICAL: You have NO command results yet. Do NOT output ### SUMMARY — you must issue a ### COMMAND first to search the actual codebase. Your training knowledge is NOT a substitute for real search results.\n`
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

        // READLINES handler — verbatim line-range extraction, bypasses shell
        if (/^READLINES\s+/i.test(command)) {
          const parts = command.replace(/^READLINES\s+/i, '').trim().split(/\s+/);
          const filePart = parts[0].replace(/^['"]|['"]$/g, ''); // strip accidental shell quotes
          const rangePart = parts[1] ?? '';
          const rangeMatch = rangePart.match(/^(\d+)-(\d+)$/);
          try {
            // Try projectRoot-relative, then cwd-relative, then absolute
            const candidates = [
              path.resolve(this.governor.config.projectRoot ?? process.cwd(), filePart),
              path.resolve(process.cwd(), filePart),
              path.resolve(filePart),
            ];
            const absPath = candidates.find(p => existsSync(p)) ?? candidates[0];
            const lines = readFileSync(absPath, 'utf-8').split('\n');
            let start = 1, end = lines.length;
            if (rangeMatch) {
              start = Math.max(1, parseInt(rangeMatch[1], 10));
              end   = Math.min(lines.length, parseInt(rangeMatch[2], 10));
            }
            const slice = lines.slice(start - 1, end).join('\n');
            history += `\n[Turn ${turn}] READLINES ${filePart} ${start}-${end}:\n${slice}\n`;
          } catch (e: any) {
            // Auto-fallback: grep the file for exports/functions so the model has real signal
            try {
              const fallback = nodeGrepCommand(
                `grep -n "export\\|^function\\|^class\\|^const\\|^async" "${filePart}"`,
                this.governor.config.projectRoot ?? process.cwd(),
              ).slice(0, 3000);
              history += `\n[Turn ${turn}] READLINES failed (${e.message}) — auto-fallback symbol grep of ${filePart}:\n${fallback || '(no matches — file may not exist at that path, try a directory search)'}\n`;
            } catch {
              history += `\n[Turn ${turn}] READLINES failed: ${e.message} — DO NOT infer "not found". Issue a grep command to verify.\n`;
            }
          }
          continue;
        }

        // WEBFETCH handler — bypasses shell entirely
        if (/^WEBFETCH\s+/i.test(command)) {
          const rawUrl = command.replace(/^WEBFETCH\s+/i, '').trim();
          const url = rawUrl
            .replace('github.com', 'raw.githubusercontent.com')
            .replace('/blob/', '/');
          try {
            const res = await fetch(url, { headers: { 'User-Agent': 'helots-slinger/1.0' } });
            const text = (await res.text()).slice(0, 8000);
            history += `\n[Turn ${turn}] WEBFETCH: ${rawUrl}\nStatus: ${res.status}\nContent:\n${text}\n`;
          } catch (e: any) {
            history += `\n[Turn ${turn}] WEBFETCH failed: ${rawUrl} — ${e.message}\n`;
          }
          continue;
        }

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
        // Reject summary on turn 1 with no commands and no preloaded files —
        // model skipped the search and hallucinated from training weights.
        if (noCommandsYet) {
          history += `\n[Turn ${turn}] REJECTED PREMATURE SUMMARY — no commands were run. Issue a ### COMMAND to search the codebase first.\n`;
        } else {
          return writeSlingerLog(result, turn);
        }
      } else if (isFinalTurn) {
        return writeSlingerLog(`### SUMMARY\n${result}\n\n### EVIDENCE\n${history}`, turn);
      } else {
        history += `\n[Turn ${turn}] (No command issued)\n`;
      }
    }
    return writeSlingerLog(`### SUMMARY\nSlinger exhausted turns without a final summary.\n\n### EVIDENCE\n${history}`, 8);
  }
}
