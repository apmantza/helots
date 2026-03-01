import { HelotConfig, TaskRole, SAMPLING_PROFILES, SamplingProfile } from '../config.js';

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

    constructor(config: HelotConfig) {
        this.config = config;
        this.baseUrl = config.llamaUrl;
        this.apiKey = config.apiKey;
        this.currentModel = config.moeModel; // assume MoE loaded initially
    }

    private getTargetModel(role: TaskRole): string {
        // Dense for strategic planning, MoE for execution/rapid tasks
        if (role === 'Aristomenis' || role === 'Governor') {
            return this.config.denseModel;
        }
        return this.config.moeModel;
    }

    /**
     * Stream completion with retry logic, model swapping, and dynamic sampling
     */
    async streamCompletion(
        prompt: string,
        role: TaskRole,
        profileKey: keyof typeof SAMPLING_PROFILES,
        onChunk: (chunk: string) => void,
        onEnd: () => void
    ): Promise<void> {
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            try {
                await this.attemptStream(prompt, role, profileKey, onChunk, onEnd);
                return;
            } catch (error) {
                attempts++;
                if (error instanceof Error && error.message.includes('ECONNRESET') && attempts < maxAttempts) {
                    console.log(`LlamaClient: ECONNRESET detected, retry ${attempts}/${maxAttempts}`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
                    continue;
                }
                throw error;
            }
        }
    }

    private async attemptStream(
        prompt: string,
        role: TaskRole,
        profileKey: keyof typeof SAMPLING_PROFILES,
        onChunk: (chunk: string) => void,
        onEnd: () => void
    ): Promise<void> {
        const targetModel = this.getTargetModel(role);
        if (this.currentModel !== targetModel) {
            console.log(`[MODEL SWAP] Swapping from ${this.currentModel} to ${targetModel} for role ${role}...`);
            // Note: Inference server (like llama.cpp) will attempt to swap if a diff model is requested,
            // or we accept manual reload if not supported.
            this.currentModel = targetModel;
        }

        const profile = SAMPLING_PROFILES[profileKey];

        const requestBody = {
            model: targetModel,
            messages: [{ role: 'user', content: prompt }],
            stream: true,
            temperature: profile.temperature,
            top_p: profile.top_p,
            top_k: profile.top_k,
            min_p: profile.min_p,
            presence_penalty: profile.presence_penalty,
            repetition_penalty: profile.repetition_penalty,
            max_tokens: profile.max_tokens,
            // Pass enable_thinking via extra_body or chat_template_kwargs depending on backend
            chat_template_kwargs: { enable_thinking: profile.enableThinking },
            extra_body: { enable_thinking: profile.enableThinking }
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
                                const content = delta.content || delta.reasoning_content || '';
                                if (content) onChunk(content);
                            }
                        } catch {
                            // Ignore parse errors
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
    }
}
