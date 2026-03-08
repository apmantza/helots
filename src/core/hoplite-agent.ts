/**
 * hoplite-agent.ts — Lightweight read+write agent (Hoplite).
 *
 * No Peltast review — for markdown, config, and doc updates
 * where lint checks are irrelevant.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs';
import { join, resolve, dirname, basename } from 'path';
import { pickName }    from './persona-utils.js';
import { stripThinking } from './text-utils.js';
import { Aristomenis }   from './governor.js';
import type { RunSubagentFn, WriteEventFn } from './types.js';

export class HopliteAgent {
  constructor(
    private governor:      Aristomenis,
    private runSubagentFn: RunSubagentFn,
    private writeEventFn:  WriteEventFn,
    private setPhase:      (p: string) => void,
    private getModelProps: () => Promise<{ modelName: string; maxTokens: number }>,
  ) {}

  private readLocalFiles(instruction: string): string {
    const pathRegex = /((?:\.[\w\-]+\/|[\w\-]+\/)[\w\-./]+\.(?:txt|md|json|jsonl|log|ts|js|sh|yaml|toml))\b/g;
    const paths = [...new Set(instruction.match(pathRegex) ?? [])];
    if (!paths.length) return '';

    const sections: string[] = [];
    for (const p of paths) {
      const abs = resolve(p);
      if (!existsSync(abs)) continue;
      try {
        const size = statSync(abs).size;
        let content: string;
        if (size > 20_000) {
          // tail: last 100 lines
          const lines = readFileSync(abs, 'utf-8').split('\n');
          content = lines.slice(-100).join('\n');
        } else {
          content = readFileSync(abs, 'utf-8');
        }
        sections.push(`--- File: ${p} ---\n${content.slice(0, 4000)}`);
      } catch { /* skip unreadable */ }
    }
    return sections.join('\n\n');
  }

  private async fetchUrls(instruction: string): Promise<string> {
    const urlRegex = /https?:\/\/[^\s"')>]+/g;
    const urls = instruction.match(urlRegex);
    if (!urls?.length) return '';

    const fetched: string[] = [];
    for (const url of urls) {
      // Convert GitHub blob URLs to raw content
      const raw = url
        .replace('github.com', 'raw.githubusercontent.com')
        .replace('/blob/', '/');
      try {
        const res = await fetch(raw, { headers: { 'User-Agent': 'helots-hoplite/1.0' } });
        if (res.ok) {
          const text = await res.text();
          fetched.push(`--- Fetched: ${url} ---\n${text.slice(0, 8000)}`);
        }
      } catch { /* skip unfetchable URLs */ }
    }
    return fetched.join('\n\n');
  }

  async execute(
    file:       string,
    instruction: string,
    onUpdate?:  (data: any) => void,
  ): Promise<string> {
    const { modelName, maxTokens } = await this.getModelProps();
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

    const localContent  = this.readLocalFiles(instruction);
    const fetchedContent = await this.fetchUrls(instruction);
    const fetchedSection = [
      localContent  ? `\n\nLocal files:\n${localContent}`   : '',
      fetchedContent ? `\n\nFetched content:\n${fetchedContent}` : '',
    ].join('');

    const userPrompt = exists
      ? `File: ${file}\n\nCurrent content:\n\`\`\`\n${originalContent}\n\`\`\`\n\nInstruction: ${instruction}${fetchedSection}`
      : `File: ${file} (new file)\n\nInstruction: ${instruction}${fetchedSection}`;

    onUpdate?.({ text: `✏️ Hoplite editing ${file}...` });
    this.writeEventFn({ type: 'hoplite_start', file, instruction: instruction.slice(0, 120) });

    let maxTokensOverride: number | undefined;
    if (originalContent) {
      const fileLines = originalContent.split('\n').length;
      const estimated = Math.ceil(fileLines * 15);
      const safeMax = maxTokens - 4096;
      const budget = Math.min(Math.max(estimated, 4096), safeMax);
      if (budget > 4096) maxTokensOverride = budget;
    }

    this.setPhase('Hoplite');
    const hoplitePersona = pickName(Date.now().toString(), 'Hoplite');
    const raw = await this.runSubagentFn(
      'Hoplite', hoplitePersona.name, systemPrompt, userPrompt,
      onUpdate, { in: 0, out: 0, tps: 0 }, 'INSTRUCT_CODE', modelName,
      undefined, maxTokensOverride,
    );

    const stripped = stripThinking(raw);
    // Accept both ### [filename] and ### filename (LLM sometimes omits brackets)
    const headerIdx = Math.max(stripped.indexOf('### ['), stripped.indexOf('### '));
    const parseFrom = headerIdx >= 0 ? stripped.slice(headerIdx) : stripped;
    const strictMatch = parseFrom.match(/###\s*(?:\[[^\]]*\]|[^\n]+)\s*\n```[a-z]*\n([\s\S]*)\n```\s*$/i);
    let newContent: string;
    if (strictMatch) {
      newContent = strictMatch[1];
    } else {
      // Fallback: model omitted the outer closing fence — common when file content itself
      // contains triple backticks (model stops at the inner closing fence instead).
      const fenceLineIdx = parseFrom.indexOf('\n```');
      if (fenceLineIdx < 0) {
        return `❌ Hoplite: could not parse output for ${file}. Raw:\n${stripped.slice(0, 500)}`;
      }
      const afterFenceLine = parseFrom.slice(fenceLineIdx + 1); // skip leading \n
      const contentStart = afterFenceLine.indexOf('\n') + 1;    // skip the ``` line itself
      newContent = afterFenceLine.slice(contentStart).replace(/\n```\s*$/, '');
    }

    if (exists) {
      try {
        const backupDir = join(this.governor.config.stateDir, 'hoplite-backups');
        mkdirSync(backupDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        writeFileSync(join(backupDir, `${basename(file)}.${ts}.bak`), originalContent);
      } catch { /* non-fatal */ }
    }

    mkdirSync(dirname(abs), { recursive: true });
    const tmp = abs + '.helot.tmp';
    writeFileSync(tmp, newContent, 'utf-8');
    renameSync(tmp, abs);

    const linesBefore = originalContent ? originalContent.split('\n').length : 0;
    const linesAfter = newContent.split('\n').length;
    onUpdate?.({ text: `✅ Hoplite: ${file} written (${linesBefore} → ${linesAfter} lines)` });
    this.writeEventFn({ type: 'hoplite_done', file, linesBefore, linesAfter });

    return `✅ ${file} written (${linesBefore} → ${linesAfter} lines)`;
  }
}