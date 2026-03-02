export interface HelotConfig {
    projectRoot: string;
    stateDir: string;
    llamaUrl: string;
    apiKey: string;
    denseModel: string;
    moeModel: string;
}

export type TaskRole = 'Aristomenis' | 'Psiloi' | 'Slinger' | 'Governor' | 'Gatherer';

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

// Note: SAMPLING_PROFILES has been moved to src/core/model-registry.ts to support dynamic model inference overrides
