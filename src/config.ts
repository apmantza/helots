export interface HelotConfig {
    projectRoot: string;
    stateDir: string;
    llamaUrl: string;
    apiKey: string;
    denseModel: string;
    moeModel: string;
}

export type TaskRole = 'Aristomenis' | 'Psiloi' | 'Slinger' | 'Governor';

export interface SamplingProfile {
    temperature: number;
    top_p: number;
    top_k: number;
    min_p: number;
    presence_penalty: number;
    repetition_penalty: number;
    enableThinking: boolean;
    max_tokens?: number;
}

export const SAMPLING_PROFILES: Record<string, SamplingProfile> = {
    THINKING_GENERAL: {
        temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0, enableThinking: true, max_tokens: 32768
    },
    THINKING_CODE: {
        temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: true, max_tokens: 81920
    },
    INSTRUCT_GENERAL: {
        temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0, enableThinking: false, max_tokens: 32768
    },
    INSTRUCT_REASONING: {
        temperature: 1.0, top_p: 1.0, top_k: 40, min_p: 0.0, presence_penalty: 2.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 81920
    }
};
