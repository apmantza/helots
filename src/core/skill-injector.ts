/**
 * skill-injector.ts — Domain skill injection for the Builder.
 *
 * Loads skill-rules.json from the project root (per-project) and matches
 * task metadata (file path, description, language) against declared triggers.
 * Matched skill content is injected into the Builder prompt as a
 * DOMAIN PATTERNS block, giving the local model project-specific conventions
 * without changing the model or increasing retry count.
 *
 * skill-rules.json lives in the target project root — each project owns its
 * own domain knowledge. helots-pi ships no default rules.
 *
 * Schema (skill-rules.json):
 * {
 *   "skills": {
 *     "skill-name": {
 *       "description": "human label",
 *       "triggers": {
 *         "languages":           ["typescript"],        // optional lang filter
 *         "pathPatterns":        ["**\/navigation\/**"], // glob patterns on task.file
 *         "keywords":            ["navigate", "route"], // substrings in task.description
 *         "descriptionPatterns": ["add.*screen"]        // regex on task.description
 *       },
 *       "content": "Actionable patterns the Builder must follow.\nMultiple lines OK."
 *     }
 *   }
 * }
 *
 * A skill matches if ANY trigger fires (OR logic across trigger types).
 * language filter is the exception — it acts as a gate (AND with the rest).
 * Multiple skills can match; their content is concatenated.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

interface SkillTriggers {
  languages?:           string[];   // e.g. ['typescript', 'python']
  pathPatterns?:        string[];   // glob patterns matched against task.file
  keywords?:            string[];   // substring match on task.description (case-insensitive)
  descriptionPatterns?: string[];   // regex match on task.description (case-insensitive)
}

interface SkillDef {
  description?: string;
  triggers:     SkillTriggers;
  content:      string;
}

interface SkillRules {
  skills: Record<string, SkillDef>;
}

// ── Glob matching ─────────────────────────────────────────────────────────────

/**
 * Minimal glob matcher supporting * and ** — no external deps.
 * Converts glob to regex, matches against forward-slash normalised path.
 */
function matchGlob(filePath: string, pattern: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*\//g, '<<<DS>>>')
    .replace(/\*\*/g,   '<<<D>>>')
    .replace(/\*/g,     '[^/]*')
    .replace(/<<<DS>>>/g, '(.*\\/)?')
    .replace(/<<<D>>>/g,  '.*');
  try {
    return new RegExp(`^${regex}$`, 'i').test(norm);
  } catch {
    return false;
  }
}

// ── SkillInjector ─────────────────────────────────────────────────────────────

export class SkillInjector {
  private rules: SkillRules | null | false = null; // false = confirmed absent

  constructor(private readonly cwd: string) {}

  /**
   * Match task metadata against skill rules and return concatenated content
   * for all matching skills, or null if nothing matches (or no rules file).
   */
  match(filePath: string, description: string, lang: string): string | null {
    const rules = this.loadRules();
    if (!rules) return null;

    const matched: string[] = [];

    for (const [, skill] of Object.entries(rules.skills)) {
      if (this.skillMatches(skill, filePath, description, lang)) {
        matched.push(skill.content.trim());
      }
    }

    return matched.length > 0 ? matched.join('\n\n') : null;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private loadRules(): SkillRules | null {
    if (this.rules === false) return null;
    if (this.rules !== null) return this.rules;

    const candidate = join(this.cwd, 'skill-rules.json');
    if (!existsSync(candidate)) {
      this.rules = false;
      return null;
    }
    try {
      this.rules = JSON.parse(readFileSync(candidate, 'utf-8')) as SkillRules;
      return this.rules;
    } catch {
      this.rules = false;
      return null;
    }
  }

  private skillMatches(
    skill:       SkillDef,
    filePath:    string,
    description: string,
    lang:        string,
  ): boolean {
    const { triggers } = skill;

    // Language gate — if specified, lang must be in the list
    if (triggers.languages && !triggers.languages.includes(lang)) return false;

    const descLower = description.toLowerCase();

    // Path patterns
    if (triggers.pathPatterns) {
      for (const pattern of triggers.pathPatterns) {
        if (filePath && matchGlob(filePath, pattern)) return true;
      }
    }

    // Keywords (substring, case-insensitive)
    if (triggers.keywords) {
      for (const kw of triggers.keywords) {
        if (descLower.includes(kw.toLowerCase())) return true;
      }
    }

    // Description patterns (regex, case-insensitive)
    if (triggers.descriptionPatterns) {
      for (const pattern of triggers.descriptionPatterns) {
        try {
          if (new RegExp(pattern, 'i').test(description)) return true;
        } catch { /* invalid regex — skip */ }
      }
    }

    return false;
  }
}
