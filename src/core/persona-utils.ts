import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Persona naming utility
 */
export function pickName(runId: string, role: string): { name: string; avatar: string } {
    const names = ["Aristomenis", "Brasidas", "Gylippus", "Leonidas", "Lysander", "Pausanias", "Teleutias", "Agesilaus", "Archidamus", "Agis"];
    const avatars = ["🛡️", "🏹", "⚔️", "🏛️", "🏟️", "🔱", "🐚", "🏺", "📜", "📐"];
    const hash = (runId + role).split("").reduce((a, b) => { a = ((a << 5) - a) + b.charCodeAt(0); return a & a; }, 0);
    const idx = Math.abs(hash) % names.length;
    return { name: names[idx], avatar: avatars[idx] };
}

/**
 * Get global behavioral context for LLM prompts
 */
export async function getGlobalContext(): Promise<string> {
    return `LACONIC SPARTAN DIRECTIVE:
1. SPARTAN SIMPLICITY: Your code must be direct, minimal, and performant. 
2. NO CEREMONY: Skip boilerplate, deep nesting, and excessive abstraction. 
3. SURGICAL PRECISION: Edit only what is requested.
4. ONE FILE, ONE SYMBOL: Prefer single-file changes and single-symbol focus.`;
}
