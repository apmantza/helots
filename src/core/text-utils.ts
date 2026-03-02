/**
 * FIX 7: Strip LLM thinking-chain preamble from model responses.
 * Removes <think>...</think> blocks and any content before the first checklist line.
 * Essential for reasoning models (Qwen3, DeepSeek-R1) that emit thinking steps.
 */
export function stripThinking(raw: string): string {
    // Strip <think>...</think> XML tags (with or without newlines)
    let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // Strip "Thinking Process:" sections that end before the first checklist item
    const checklistStart = cleaned.indexOf('- [ ]');
    if (checklistStart > 0) {
        cleaned = cleaned.slice(checklistStart);
    }
    return cleaned.trim();
}
