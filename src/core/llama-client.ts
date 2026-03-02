import { HelotConfig, TaskRole, SamplingProfile } from '../config.js';
import { getProfilesForModel } from './model-registry.js';

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
    private modelsInitialized = false;

    constructor(config: HelotConfig) {
        this.config = config;
        this.baseUrl = config.llamaUrl;
        this.apiKey = config.apiKey;
        this.currentModel = config.moeModel; // assume MoE loaded initially
    }

    private async initializeModels(): Promise<void> {
        if (this.modelsInitialized) return;
        try {
            const response = await fetch(`${this.baseUrl}/v1/models`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` }
            });
            if (response.ok) {
                const json = await response.json();
                this.serverAvailableModels = (json.data || []).map((m: any) => m.id);
                console.log(`[LlamaClient] Detected active server models: \n  - ${this.serverAvailableModels.join('\n  - ')}`);
            }
        } catch (error) {
            console.warn(`[LlamaClient] Failed to auto-detect models from server. Falling back to config.json models.`);
        }

        if (this.serverAvailableModels.length === 0) {
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
        prompt: string,
        role: TaskRole,
        profileKey: string,
        onChunk: (chunk: string) => void,
        onEnd: () => void
    ): Promise<void> {
        await this.initializeModels();
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
        profileKey: string,
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

        const profiles = getProfilesForModel(targetModel);
        const profile = profiles[profileKey] || profiles['THINKING_GENERAL'];

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
