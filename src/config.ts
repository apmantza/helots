export interface HelotConfig {
    projectRoot: string;
    stateDir: string;
    llamaUrl: string;
    llamaUrlFallbacks?: string[];   // Additional URLs to probe if primary is unreachable
    apiKey: string;
    denseModel: string;
    moeModel: string;
    thinkingEnabled?: boolean;      // Default true. Set false for non-thinking models — strips all thinking params from every profile.
}

export type TaskRole = 'Aristomenis' | 'Governor' | 'Psiloi' | 'Slinger' | 'Gatherer';

export interface SamplingProfile {
    temperature: number;
    top_p: number;
    top_k: number;
    min_p: number;
    presence_penalty: number;
    repetition_penalty: number;
    enableThinking: boolean;
    max_tokens?: number;
    extra_body?: any;
}

// Note: SAMPLING_PROFILES has been moved to src/core/model-registry.ts to support dynamic model inference overrides
