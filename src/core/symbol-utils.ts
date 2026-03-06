/**
 * symbol-utils.ts — Language detection and symbol boundary extraction.
 *
 * Pure functions — no class dependencies, no side effects.
 * Used by the Builder for surgical mode (splice individual functions)
 * and by the engine for language dispatch.
 */

// ── Language kind ─────────────────────────────────────────────────────────────

export type LangKind = 'python' | 'typescript' | 'rust' | 'unknown';

export function detectLang(filePath: string): LangKind {
  if (filePath.endsWith('.py')) return 'python';
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) return 'typescript';
  if (filePath.endsWith('.rs')) return 'rust';
  return 'unknown';
}

export function codeFenceFor(lang: LangKind, filePath: string): string {
  if (lang === 'python') return 'python';
  if (lang === 'typescript') {
    if (/\.(js|jsx|mjs|cjs)$/.test(filePath)) return 'javascript';
    return 'typescript';
  }
  return '';
}

// ── Symbol boundary detection ─────────────────────────────────────────────────

export function getPythonSymbolBounds(
  content: string,
  symbolName: string,
): { start: number; end: number; slice: string } | null {
  const lines = content.split('\n');
  let defLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if ((/^(?:async\s+)?def\s+/.test(l) && l.includes(`def ${symbolName}(`)) ||
        (/^class\s+/.test(l) && (l.includes(`class ${symbolName}(`) || l.includes(`class ${symbolName}:`)))) {
      defLine = i;
      break;
    }
  }
  if (defLine === -1) return null;

  // Walk back to include any preceding decorators
  let startLine = defLine;
  while (startLine > 0 && /^@/.test(lines[startLine - 1].trimEnd())) startLine--;

  // Scan forward — stop at next top-level decorator, def, or class
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
export function getTsSymbolBounds(
  content: string,
  symbolName: string,
): { start: number; end: number; slice: string } | null {
  const lines = content.split('\n');
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s/.test(l)) continue; // skip indented (methods inside classes)
    if (new RegExp(`\\bfunction\\s+${symbolName}\\s*[(<]`).test(l) ||
        new RegExp(`\\bclass\\s+${symbolName}\\b`).test(l) ||
        new RegExp(`\\bconst\\s+${symbolName}\\s*=`).test(l) ||
        new RegExp(`\\blet\\s+${symbolName}\\s*=`).test(l)) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) return null;

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

export function getSymbolBounds(
  content: string,
  symbolName: string,
  lang: LangKind,
): { start: number; end: number; slice: string } | null {
  if (lang === 'python') return getPythonSymbolBounds(content, symbolName);
  if (lang === 'typescript') return getTsSymbolBounds(content, symbolName);
  return null;
}

// ── Surgical patching ─────────────────────────────────────────────────────────

/**
 * Apply surgical patches from Builder's ### FUNCTION: name blocks into original file content.
 * Language-agnostic: dispatches to correct bounds finder.
 */
export function applySurgicalPatches(
  original: string,
  builderOut: string,
  lang: LangKind,
): string | null {
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
