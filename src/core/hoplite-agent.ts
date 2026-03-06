/**
 * hoplite-agent.ts — Lightweight read+write agent (Hoplite).
 *
 * No Peltast review — for markdown, config, and doc updates
 * where lint checks are irrelevant.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
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

    const userPrompt = exists
      ? `File: ${file}\n\nCurrent content:\n\`\`\`\n${originalContent}\n\`\`\`\n\nInstruction: ${instruction}`
      : `File: ${file} (new file)\n\nInstruction: ${instruction}`;

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
    const headerIdx = stripped.indexOf('### [');
    const parseFrom = headerIdx >= 0 ? stripped.slice(headerIdx) : stripped;
    const match = parseFrom.match(/###\s*\[[^\]]*\]\s*\n```[a-z]*\n([\s\S]*)\n```\s*$/i);
    if (!match) {
      return `❌ Hoplite: could not parse output for ${file}. Raw:\n${stripped.slice(0, 500)}`;
    }

    const newContent = match[1];

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
    this.writeEventFn({ type: 'hoplite_done', file, linesBefore, linesAfter });

    return `✅ ${file} written (${linesBefore} → ${linesAfter} lines)`;
  }
}
