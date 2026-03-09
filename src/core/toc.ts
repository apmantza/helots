/**
 * toc.ts — AST-lite Table of Contents generator for source files.
 * Extracts symbols with line numbers; no LLM, pure regex/stdlib.
 * Used by slinger as a fast alternative to READLINES for navigation,
 * and as a fallback when LSP_SYMBOLS is unavailable.
 *
 * Inspired by https://github.com/mfranzon/toc (Python original).
 * Supports: TypeScript, JavaScript, Python, Go, Rust.
 */

import { readFileSync, existsSync } from 'fs';
import * as path from 'path';

export interface TocSymbol {
  kind: 'class' | 'function' | 'method' | 'interface' | 'type' | 'const';
  name: string;
  line: number;
  signature: string;
  doc?: string;
  children: TocSymbol[];
}

const SUPPORTED_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs']);

/**
 * Generate a compact TOC string for a source file.
 * @param filePath - relative or absolute path to the file
 * @param projectRoot - optional project root for relative path resolution
 */
export function generateToc(filePath: string, projectRoot?: string): string {
  const stripped = filePath.replace(/^['"]|['"]$/g, '');
  const cwd = projectRoot ?? process.cwd();
  const candidates = [
    path.resolve(cwd, stripped),
    path.resolve(process.cwd(), stripped),
    path.resolve(stripped),
  ];
  const absPath = candidates.find(p => existsSync(p));
  if (!absPath) return `# TOC: ${path.basename(stripped)}: file not found\n`;

  const ext = path.extname(absPath).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) {
    const lineCount = readFileSync(absPath, 'utf-8').split('\n').length;
    return `# TOC: ${path.basename(absPath)}: unsupported extension (${ext}), ${lineCount} lines\n`;
  }

  const content = readFileSync(absPath, 'utf-8');
  const lines = content.split('\n');
  const basename = path.basename(absPath);
  let language: string;
  let symbols: TocSymbol[];
  let imports: string[];

  if (ext === '.ts' || ext === '.tsx') {
    language = 'typescript';
    ({ symbols, imports } = parseTS(lines));
  } else if (ext === '.js' || ext === '.jsx') {
    language = 'javascript';
    ({ symbols, imports } = parseTS(lines));
  } else if (ext === '.py') {
    language = 'python';
    ({ symbols, imports } = parsePy(lines));
  } else if (ext === '.go') {
    language = 'go';
    ({ symbols, imports } = parseGeneric(lines, 'go'));
  } else {
    language = 'rust';
    ({ symbols, imports } = parseGeneric(lines, 'rust'));
  }

  return formatToc(basename, language, imports, symbols, lines.length);
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatToc(
  basename: string,
  language: string,
  imports: string[],
  symbols: TocSymbol[],
  totalLines: number,
): string {
  const out: string[] = [`# TOC: ${basename} (${language}, ${totalLines} lines)`, ''];

  if (imports.length > 0) {
    out.push(`## Imports (${imports.length})`);
    for (const imp of imports.slice(0, 12)) out.push(`  ${imp}`);
    if (imports.length > 12) out.push(`  ... (${imports.length - 12} more)`);
    out.push('');
  }

  if (symbols.length > 0) {
    out.push(`## Symbols (${symbols.length})`);
    for (const sym of symbols) out.push(formatSymbol(sym, 0));
  } else {
    out.push('## Symbols: none detected');
  }

  return out.join('\n') + '\n';
}

function formatSymbol(sym: TocSymbol, depth: number): string {
  const indent = '  '.repeat(depth);
  const icon = sym.kind === 'class' ? 'class'
    : sym.kind === 'interface' ? 'iface'
    : sym.kind === 'type' ? 'type'
    : 'fn';
  const doc = sym.doc ? ` — ${sym.doc.slice(0, 60)}` : '';
  const rows: string[] = [`${indent}[${icon}] ${sym.name} (L${sym.line})${doc}`];
  for (const child of sym.children) rows.push(formatSymbol(child, depth + 1));
  return rows.join('\n');
}

// ─── TypeScript / JavaScript parser ──────────────────────────────────────────

const SKIP_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'switch', 'catch', 'return', 'const',
  'let', 'var', 'new', 'throw', 'case', 'default', 'break', 'continue',
  'typeof', 'instanceof', 'await', 'yield', 'try', 'finally', 'do',
]);

function parseTS(lines: string[]): { symbols: TocSymbol[]; imports: string[] } {
  const symbols: TocSymbol[] = [];
  const imports: string[] = [];

  // Class stack: tracks open class scopes by brace depth at point of opening
  const classStack: Array<{ sym: TocSymbol; openDepth: number }> = [];
  let braceDepth = 0;
  let pendingDoc: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = raw.trim();

    // Count braces to track scope, then pop classes that are now closed
    for (const ch of raw) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') {
        braceDepth--;
        while (classStack.length > 0 && braceDepth < classStack[classStack.length - 1].openDepth) {
          classStack.pop();
        }
      }
    }

    // Single-line doc comment immediately above a symbol
    if (/^\/\//.test(stripped)) {
      pendingDoc = stripped.replace(/^\/\/+\s*/, '').trim() || undefined;
      continue;
    }
    if (/^\/\*\*/.test(stripped)) {
      pendingDoc = stripped.replace(/^\/\*\*?\s*/, '').replace(/\s*\*\/$/, '').trim() || undefined;
      continue;
    }
    // Consume pending doc
    const doc = pendingDoc;
    pendingDoc = undefined;

    // Imports
    if (/^import\s/.test(stripped)) {
      imports.push(stripped.replace(/\s+/g, ' ').slice(0, 100));
      continue;
    }

    const lineNum = i + 1;

    // Interface
    const ifaceM = /^(?:export\s+)?interface\s+(\w+)/.exec(stripped);
    if (ifaceM) {
      symbols.push({ kind: 'interface', name: ifaceM[1], line: lineNum, signature: stripped.slice(0, 100), doc, children: [] });
      continue;
    }

    // Type alias
    const typeM = /^(?:export\s+)?type\s+(\w+)\s*[=<]/.exec(stripped);
    if (typeM) {
      symbols.push({ kind: 'type', name: typeM[1], line: lineNum, signature: stripped.slice(0, 100), doc, children: [] });
      continue;
    }

    // Class declaration
    const classM = /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/.exec(stripped);
    if (classM) {
      const sym: TocSymbol = { kind: 'class', name: classM[1], line: lineNum, signature: stripped.slice(0, 100), doc, children: [] };
      symbols.push(sym);
      // openDepth = braceDepth after counting this line's braces; class body opens +1 from here
      classStack.push({ sym, openDepth: braceDepth });
      continue;
    }

    // Function declaration
    const fnM = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*[\(<]/.exec(stripped);
    if (fnM) {
      const sym: TocSymbol = { kind: 'function', name: fnM[1], line: lineNum, signature: stripped.slice(0, 100), doc, children: [] };
      if (classStack.length > 0) {
        classStack[classStack.length - 1].sym.children.push({ ...sym, kind: 'method' });
      } else {
        symbols.push(sym);
      }
      continue;
    }

    // Arrow / const assigned function (top-level only to avoid noise)
    if (classStack.length === 0) {
      const arrowM = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\(|\bfunction\b)/.exec(stripped);
      if (arrowM) {
        symbols.push({ kind: 'function', name: arrowM[1], line: lineNum, signature: stripped.slice(0, 100), doc, children: [] });
        continue;
      }
    }

    // Class methods — indented, inside an open class scope
    if (classStack.length > 0 && braceDepth > classStack[classStack.length - 1].openDepth) {
      // Match: [access modifier]* methodName( or methodName<
      const methM = /^(?:(?:public|private|protected|static|async|override|readonly|abstract|get|set)\s+)*(\w+)\s*[\(<]/.exec(stripped);
      if (methM && !SKIP_KEYWORDS.has(methM[1]) && methM[1] !== 'constructor') {
        const parent = classStack[classStack.length - 1].sym;
        if (!parent.children.some(c => c.name === methM[1] && c.line === lineNum)) {
          parent.children.push({ kind: 'method', name: methM[1], line: lineNum, signature: stripped.slice(0, 100), doc, children: [] });
        }
      }
      // Also catch constructor
      if (/^constructor\s*\(/.test(stripped)) {
        const parent = classStack[classStack.length - 1].sym;
        parent.children.push({ kind: 'method', name: 'constructor', line: lineNum, signature: stripped.slice(0, 100), doc, children: [] });
      }
    }
  }

  return { symbols, imports };
}

// ─── Python parser ────────────────────────────────────────────────────────────

function parsePy(lines: string[]): { symbols: TocSymbol[]; imports: string[] } {
  const symbols: TocSymbol[] = [];
  const imports: string[] = [];
  // Simple: track last top-level class for method grouping
  let currentClass: TocSymbol | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = raw.trim();
    const indent = raw.length - raw.trimStart().length;

    if (/^(?:import|from)\s/.test(stripped)) {
      imports.push(stripped.slice(0, 100));
      continue;
    }

    const classM = /^class\s+(\w+)/.exec(stripped);
    if (classM && indent === 0) {
      const sym: TocSymbol = { kind: 'class', name: classM[1], line: i + 1, signature: stripped.slice(0, 100), children: [] };
      symbols.push(sym);
      currentClass = sym;
      continue;
    }

    const fnM = /^(?:async\s+)?def\s+(\w+)\s*\(/.exec(stripped);
    if (fnM) {
      const isMethod = indent > 0 && currentClass !== null;
      const sym: TocSymbol = { kind: isMethod ? 'method' : 'function', name: fnM[1], line: i + 1, signature: stripped.slice(0, 100), children: [] };
      if (isMethod) {
        currentClass!.children.push(sym);
      } else {
        if (indent === 0) currentClass = null; // top-level fn resets class context
        symbols.push(sym);
      }
    }
  }

  return { symbols, imports };
}

// ─── Generic parser (Go, Rust) ────────────────────────────────────────────────

function parseGeneric(lines: string[], lang: 'go' | 'rust'): { symbols: TocSymbol[]; imports: string[] } {
  const symbols: TocSymbol[] = [];
  const imports: string[] = [];

  const patterns: Array<[TocSymbol['kind'], RegExp]> = lang === 'go'
    ? [
        ['function', /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/],
        ['type',     /^type\s+(\w+)\s+(?:struct|interface)/],
      ]
    : [
        ['function', /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*[\(<]/],
        ['type',     /^(?:pub\s+)?struct\s+(\w+)/],
        ['type',     /^(?:pub\s+)?enum\s+(\w+)/],
        ['type',     /^(?:pub\s+)?trait\s+(\w+)/],
      ];

  const importRe = lang === 'go' ? /^import\s/ : /^use\s/;

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (importRe.test(stripped)) { imports.push(stripped.slice(0, 100)); continue; }
    for (const [kind, pat] of patterns) {
      const m = pat.exec(stripped);
      if (m) { symbols.push({ kind, name: m[1], line: i + 1, signature: stripped.slice(0, 100), children: [] }); break; }
    }
  }

  return { symbols, imports };
}
