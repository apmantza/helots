import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, appendFileSync } from 'fs';
import { HelotConfig, TaskRole, SamplingProfile } from '../config.js';
import { getProfilesForModel } from './model-registry.js';

const _dir = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(_dir, '../../logs');
try { mkdirSync(LOGS_DIR, { recursive: true }); } catch {}

function appendReasoningLog(entry: string): void {
    try { appendFileSync(join(LOGS_DIR, 'reasoning.log'), entry, 'utf8'); } catch {}
}

/**
 * LlamaClient - Hardened SSE streaming client
 * Implements Model Swapping & Dynamic Sampling
 * Manual line-buffering with finally block cleanup
 * 3-try retry logic for ECONNRESET
 */
export class LlamaClient {
    private config: HelotConfig;
    private baseUrl: string;
    private apiKey: string;
    private currentModel: string;
    private serverAvailableModels: string[] = [];
    private serverContextSize: number = 4096; // Default
    private modelsInitialized = false;

    constructor(config: HelotConfig) {
        this.config = config;
        this.baseUrl = config.llamaUrl;
        this.apiKey = config.apiKey;
        this.currentModel = config.moeModel; // assume MoE loaded initially
    }

    public async getProps(): Promise<{ modelName: string; maxTokens: number }> {
        await this.initializeModels();
        return {
            modelName: this.serverAvailableModels[0] || this.currentModel,
            maxTokens: this.serverContextSize
        };
    }

    private async probeUrl(url: string): Promise<{ models: string[]; contextSize: number } | null> {
        try {
            const response = await fetch(`${url}/v1/models`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` },
                signal: AbortSignal.timeout(3000),
            });
            if (!response.ok) return null;
            const json = await response.json();
            const models = (json.data || []).map((m: any) => m.id) as string[];

            let contextSize = 4096;
            try {
                const propsRes = await fetch(`${url}/props`, {
                    headers: { 'Authorization': `Bearer ${this.apiKey}` },
                    signal: AbortSignal.timeout(2000),
                });
                if (propsRes.ok) {
                    const props = await propsRes.json();
                    contextSize = props.default_generation_settings?.n_ctx || props.cntxt || props.n_ctx || 4096;
                } else {
                    const modelMeta = json.data?.find((m: any) => m.id === this.currentModel);
                    contextSize = modelMeta?.meta?.n_ctx || modelMeta?.cntxt || 4096;
                }
            } catch { /* use default */ }

            return { models, contextSize };
        } catch {
            return null;
        }
    }

    private async initializeModels(): Promise<void> {
        if (this.modelsInitialized) return;

        // Build probe list: primary URL + any configured fallbacks + default :8080
        const candidates = [
            this.baseUrl,
            ...(this.config.llamaUrlFallbacks ?? []),
            'http://127.0.0.1:8080',
        ].filter((u, i, arr) => arr.indexOf(u) === i); // deduplicate

        for (const url of candidates) {
            const result = await this.probeUrl(url);
            if (result) {
                if (url !== this.baseUrl) {
                    console.error(`[LlamaClient] Primary URL unreachable — using fallback: ${url}`);
                    this.baseUrl = url;
                }
                this.serverAvailableModels = result.models;
                this.serverContextSize = result.contextSize;
                console.error(`[LlamaClient] Connected to ${url} — models: ${result.models.join(', ')} — ctx: ${result.contextSize}`);
                break;
            } else {
                console.error(`[LlamaClient] No response from ${url}, trying next...`);
            }
        }

        if (this.serverAvailableModels.length === 0) {
            console.warn(`[LlamaClient] All URLs unreachable. Falling back to config model names.`);
            this.serverAvailableModels = [this.config.moeModel];
        }
        this.modelsInitialized = true;
    }

    private getTargetModel(role: TaskRole): string {
        const desired = (role === 'Aristomenis' || role === 'Governor') ? this.config.denseModel : this.config.moeModel;

        if (this.serverAvailableModels.includes(desired)) {
            return desired;
        }

        const fuzzy = this.serverAvailableModels.find(m => m.toLowerCase().includes(desired.toLowerCase()));
        if (fuzzy) return fuzzy;

        return this.serverAvailableModels[0] || desired;
    }

    /**
     * Stream completion with retry logic, model swapping, and dynamic sampling
     */
    async streamCompletion(
        messages: { role: string; content: string }[],
        role: TaskRole,
        profileKey: string,
        maxTokensOverride: number | undefined,
        onChunk: (chunk: string, metrics: { genTps: number; promptEvalTps: number; isFirstToken: boolean; promptTokens: number; genTokens: number; maxTokens: number }) => void,
        onEnd: () => void
    ): Promise<void> {
        await this.initializeModels();
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            try {
                await this.attemptStream(messages, role, profileKey, maxTokensOverride, onChunk, onEnd);
                return;
            } catch (error) {
                attempts++;
                if (error instanceof Error && error.message.includes('ECONNRESET') && attempts < maxAttempts) {
                    console.error(`LlamaClient: ECONNRESET detected, retry ${attempts}/${maxAttempts}`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
                    continue;
                }
                throw error;
            }
        }
    }

    private async attemptStream(
        messages: { role: string; content: string }[],
        role: TaskRole,
        profileKey: string,
        maxTokensOverride: number | undefined,
        onChunk: (chunk: string, metrics: { genTps: number; promptEvalTps: number; isFirstToken: boolean; promptTokens: number; genTokens: number; maxTokens: number }) => void,
        onEnd: () => void
    ): Promise<void> {
        const targetModel = this.getTargetModel(role);
        if (this.currentModel !== targetModel) {
            console.error(`[MODEL SWAP] Swapping from ${this.currentModel} to ${targetModel} for role ${role}...`);
            // Note: Inference server (like llama.cpp) will attempt to swap if a diff model is requested,
            // or we accept manual reload if not supported.
            this.currentModel = targetModel;
        }

        const profiles = getProfilesForModel(targetModel);
        let profile = profiles[profileKey] || profiles['THINKING_GENERAL'];

        // Dynamic max_tokens override: allow caller to request more output budget than the profile default.
        // Only applied when the override exceeds the profile default (never reduces it).
        if (maxTokensOverride !== undefined && maxTokensOverride > (profile.max_tokens ?? 0)) {
            profile = { ...profile, max_tokens: maxTokensOverride };
        }

        // If thinkingEnabled is explicitly false, strip all thinking-related params.
        // Preserves all model-specific tuning (temp, top_p, etc.) — only removes thinking directives.
        const thinkingEnabled = this.config.thinkingEnabled ?? true;
        if (!thinkingEnabled && profile.enableThinking) {
            const { extra_body, ...rest } = profile;
            // Strip budget_tokens / enable_thinking from chat_template_kwargs if present
            const cleanedExtra = extra_body
                ? Object.fromEntries(
                    Object.entries(extra_body).map(([k, v]) => {
                        if (k === 'chat_template_kwargs' && v && typeof v === 'object') {
                            const { enable_thinking, budget_tokens, ...restKwargs } = v as any;
                            return [k, restKwargs];
                        }
                        return [k, v];
                    })
                )
                : undefined;
            profile = { ...rest, enableThinking: false, ...(cleanedExtra ? { extra_body: cleanedExtra } : {}) };
        }

        const requestBody = {
            model: targetModel,
            messages: messages,
            stream: true,
            temperature: profile.temperature,
            top_p: profile.top_p,
            top_k: profile.top_k,
            min_p: profile.min_p,
            presence_penalty: profile.presence_penalty,
            repetition_penalty: profile.repetition_penalty,
            max_tokens: profile.max_tokens,
            // Spread extra_body directly so llama.cpp sees top-level fields like chat_template_kwargs
            ...(profile.extra_body ?? {})
        };

        const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HTTP error: ${response.status} - ${errText}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No reader available');

        const startTime = performance.now();
        let firstTokenTime = 0;
        let tokenCount = 0;
        let reasoningContent = '';
        const promptEstimate = messages.reduce((acc, m) => acc + (m.content.length / 4), 0);

        try {
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.trim().startsWith('data: ')) {
                        const data = line.trim().slice(6);
                        if (data === '[DONE]') {
                            onEnd();
                            return;
                        }
                        try {
                            const parsed = JSON.parse(data);
                            const delta = parsed.choices?.[0]?.delta;
                            if (delta) {
                                const reasoning = delta.reasoning_content || '';
                                if (reasoning) reasoningContent += reasoning;
                                const content = delta.content || '';
                                if (content) {
                                    if (firstTokenTime === 0) firstTokenTime = performance.now();
                                    tokenCount++;

                                    const now = performance.now();
                                    const genTps = tokenCount / ((now - firstTokenTime) / 1000);
                                    const promptEvalTps = promptEstimate / ((firstTokenTime - startTime) / 1000);

                                    onChunk(content, {
                                        genTps: isFinite(genTps) ? genTps : 0,
                                        promptEvalTps: isFinite(promptEvalTps) ? promptEvalTps : 0,
                                        isFirstToken: tokenCount === 1,
                                        promptTokens: Math.round(promptEstimate),
                                        genTokens: tokenCount,
                                        maxTokens: this.serverContextSize
                                    });
                                }
                            }
                        } catch {
                            // Ignore parse errors
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
            if (reasoningContent) {
                const ts = new Date().toISOString();
                const params = [
                    `temperature=${requestBody.temperature}`,
                    `top_p=${requestBody.top_p}`,
                    `top_k=${requestBody.top_k}`,
                    `min_p=${requestBody.min_p}`,
                    `max_tokens=${requestBody.max_tokens}`,
                    `presence_penalty=${requestBody.presence_penalty}`,
                    `repetition_penalty=${requestBody.repetition_penalty}`,
                ].join(' ');
                const promptDump = messages.map(m => `[${m.role}]: ${m.content}`).join('\n---\n');
                const entry = [
                    `\n=== ${ts} | ${role} | ${targetModel} | ${profileKey} ===`,
                    `PARAMS: ${params}`,
                    `MESSAGES:\n${promptDump}`,
                    `REASONING (${reasoningContent.length} chars):\n${reasoningContent}`,
                    `RESPONSE: ${tokenCount === 0 ? '(empty)' : `${tokenCount} tokens`}`,
                    `===\n`,
                ].join('\n');
                appendReasoningLog(entry);
                console.error(`[reasoning] logged ${reasoningContent.length} chars to logs/reasoning.log`);
            }
        }
    }
}
