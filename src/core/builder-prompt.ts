/**
 * builder-prompt.ts — Construct the Builder system prompt.
 *
 * Pure function — takes all parameters, returns the prompt string.
 * Surgical mode and full-file mode are handled here.
 */

import { LangKind } from './symbol-utils.js';

export interface BuilderPromptParams {
  globalContext:           string;
  description:             string;
  file:                    string | undefined;
  targetSymbol:            string | undefined;
  lang:                    LangKind;
  isSurgical:              boolean;
  fence:                   string;
  contextContent:          string;
  taskContext:             string;
  upstreamContext:         string;
  retryContext:            string;
  skillContext:            string | null;
  builderMaxTokensOverride: number | undefined;
  targetHeader:            string;
  checkpointSummary?:      string; // injected when continuing a prior CHECKPOINT session
}

export function buildBuilderPrompt(p: BuilderPromptParams): string {
  const checkpointCtx = p.checkpointSummary
    ? `\nPREVIOUS SESSION CHECKPOINT — continue from here, do NOT redo completed work:\n${p.checkpointSummary}\n`
    : '';

  const checkpointProtocol = `
CHECKPOINT PROTOCOL: If this task is too large to complete fully in one response, output:
### CHECKPOINT
<precise chronological summary: what you implemented, up to what line, and exactly what remains>
Then output whatever file blocks you did complete. The next session will continue from your summary.`;

  if (p.isSurgical) {
    return `${p.globalContext}
You are the Builder. IMPLEMENT the following task with LACONIC SIMPLICITY: ${p.description}
File: ${p.file} (${p.lang})
Primary target: \`${p.targetSymbol}\`
${checkpointCtx}
SURGICAL OUTPUT FORMAT — CRITICAL:
For EACH function you modify, output it as a named block:
### FUNCTION: function_name
\`\`\`${p.fence}
(complete function implementation)
\`\`\`

RULES:
- Output ONLY the functions that change. Do NOT output imports, the full file, or unchanged functions.
- Never use "..." placeholders — write complete, working code.
- You MUST output a block for every function the task requires changing (may be more than one).
- The file is ${p.contextContent.split('\n').length} lines. DO NOT output the full file — output ONLY named ### FUNCTION: blocks.
${p.skillContext ? `\nDOMAIN PATTERNS (follow these conventions):\n${p.skillContext}\n` : ''}${checkpointProtocol}
${p.retryContext}
IMPLEMENTATION CONTEXT (signatures and patterns to use):
${p.taskContext.slice(0, 2000)}

FULL FILE (read-only — understand context; output ONLY the changed functions below, NOT the full file):
\`\`\`${p.fence}
${p.contextContent}
\`\`\`${p.upstreamContext ? `\n\nUPSTREAM DEPENDENCIES (read-only — use for correct imports/interfaces):\n${p.upstreamContext}` : ''}`;
  }

  // FULL-FILE MODE
  const symbolInstruction = p.targetSymbol
    ? `TARGET: Modify \`${p.targetSymbol}\` and any other functions explicitly named in the task. Keep everything else exactly as-is.`
    : `TARGET: Implement the task. Keep all existing content unless explicitly required to remove it.`;

  return `${p.globalContext}
You are the Builder. IMPLEMENT the following task with LACONIC SIMPLICITY: ${p.description}
${p.file ? `Target File: ${p.file}` : ''}
${checkpointCtx}
SPARTAN BUILDER GUIDELINES:
1. LACONISM: Use the minimum code required.
2. ${symbolInstruction}
3. COMPLETENESS: Output the COMPLETE file — never truncate, never use "..." placeholders.
4. Your response MUST start immediately with the file header — no preamble, no explanation.
5. Output budget: ~${p.builderMaxTokensOverride ?? 8192} tokens — write the COMPLETE file. No stubs, no ellipsis, no "// TODO". Every function must be fully implemented.
${p.skillContext ? `\nDOMAIN PATTERNS (follow these conventions):\n${p.skillContext}\n` : ''}${checkpointProtocol}
${p.retryContext}
IMPLEMENTATION CONTEXT (signatures and patterns to use):
${p.taskContext.slice(0, 2000)}

${p.contextContent ? `CURRENT FILE CONTENT:\n${p.contextContent}` : ''}
${p.upstreamContext ? `\nUPSTREAM DEPENDENCIES (read-only — use for correct imports/interfaces):\n${p.upstreamContext}` : ''}
Your response must begin with EXACTLY this header on the first line:
${p.targetHeader}
\`\`\`${p.fence}
Then write the COMPLETE file content. Close with a single \`\`\` on its own line.
Do NOT echo these instructions. Do NOT write placeholder text like "(complete file content)".
\`\`\``;
}
