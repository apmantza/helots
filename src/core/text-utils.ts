/**
 * Strip thinking blocks and any content before the first checklist line.
 * Essential for reasoning models (Qwen3, DeepSeek-R1) that emit thinking steps.
 */
export function stripThinking(raw: string): string {
    if (!raw) return raw;
    
    // First, try to find the checklist anywhere in the response
    const checklistIndex = raw.indexOf('- [ ]');
    
    if (checklistIndex >= 0) {
        // Found checklist, return everything from there
        return raw.slice(checklistIndex).trim();
    }
    
    // No checklist found - try stripping thinking blocks anyway
    let cleaned = raw;
    
    // Strip <think>...</think> XML tags (with or without newlines)
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
    
    // Strip <think> blocks that might be without closing tag
    cleaned = cleaned.replace(/<think>[\s\S]*?(?===|\n\n|\Z)/gi, '');
    
    // Strip "Thinking Process:" sections
    cleaned = cleaned.replace(/Thinking Process:[\s\S]*?(?=###|\n\n|\Z)/gi, '');
    
    // Try again to find checklist after stripping
    const retryIndex = cleaned.indexOf('- [ ]');
    if (retryIndex >= 0) {
        return cleaned.slice(retryIndex).trim();
    }
    
    // Return whatever we have after stripping (will fail validation downstream)
    return cleaned.trim();
}
