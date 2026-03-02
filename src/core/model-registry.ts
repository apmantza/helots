import { SamplingProfile } from '../config.js';

export interface ModelFeatureConfig {
    idPattern: string; // Used to partially match the model ID from the server
    profiles: Record<string, SamplingProfile>;
}

// -------------------------------------------------------------
// 1. Qwen 3.5 27B (Dense)
// Designed for Qwen 3.5 27B dense alignments
// max_tokens clamped tightly for Builder/Peltast to prevent runaway reasoning loops.
// -------------------------------------------------------------
const QWEN_27B_PROFILES: Record<string, SamplingProfile> = {
    // Architect (General tasks)
    THINKING_GENERAL: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: true, max_tokens: 32768 },
    // Builder (Precise coding tasks)
    THINKING_CODE: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: true, max_tokens: 8192 },
    // Peltast (Reasoning tasks)
    THINKING_REASONING: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: true, max_tokens: 4096 },

    // Non-thinking modes
    INSTRUCT_GENERAL: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 16384, extra_body: { chat_template_kwargs: { enable_thinking: false } } },
    INSTRUCT_REASONING: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 16384, extra_body: { chat_template_kwargs: { enable_thinking: false } } }
};

// -------------------------------------------------------------
// 2. Qwen 3.5 35B (MoE)
// Designed for Qwen 3.5 35B-MoE alignments and officially recommended parameters.
// max_tokens clamped tightly for Builder/Peltast to prevent runaway reasoning loops.
// -------------------------------------------------------------
const QWEN_35B_MOE_PROFILES: Record<string, SamplingProfile> = {
    // Architect (General tasks): Needs larger token cap for full progress.md generation
    THINKING_GENERAL: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: true, max_tokens: 32768 },
    // Builder (Precise coding tasks): Tight token cap (8192) to cut off infinite loops
    THINKING_CODE: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: true, max_tokens: 8192 },
    // Peltast (Reasoning tasks): Very tight token cap (4096) — decision should be quick
    THINKING_REASONING: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: true, max_tokens: 4096 },

    // Non-thinking modes
    INSTRUCT_GENERAL: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 16384, extra_body: { chat_template_kwargs: { enable_thinking: false } } },
    INSTRUCT_REASONING: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 16384, extra_body: { chat_template_kwargs: { enable_thinking: false } } }
};

// -------------------------------------------------------------
// 2. Llama 3 / 3.1
// Lower temperature generally preferred for code inference
// -------------------------------------------------------------
const LLAMA3_PROFILES: Record<string, SamplingProfile> = {
    THINKING_GENERAL: { temperature: 0.8, top_p: 0.9, top_k: 40, min_p: 0.05, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
    THINKING_CODE: { temperature: 0.2, top_p: 0.9, top_k: 40, min_p: 0.05, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
    INSTRUCT_GENERAL: { temperature: 0.6, top_p: 0.9, top_k: 40, min_p: 0.05, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
    INSTRUCT_REASONING: { temperature: 0.8, top_p: 0.9, top_k: 40, min_p: 0.05, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 }
};

// -------------------------------------------------------------
// 3. DeepSeek Coder V2 / DeepSeek-V3
// Strict reasoning parameters; relies heavily on built-in reasoning steps if enabled
// -------------------------------------------------------------
const DEEPSEEK_PROFILES: Record<string, SamplingProfile> = {
    THINKING_GENERAL: { temperature: 0.6, top_p: 0.95, top_k: 50, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: true, max_tokens: 8192 },
    THINKING_CODE: { temperature: 0.0, top_p: 0.95, top_k: 50, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: true, max_tokens: 8192 },
    INSTRUCT_GENERAL: { temperature: 0.6, top_p: 0.95, top_k: 50, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
    INSTRUCT_REASONING: { temperature: 0.6, top_p: 0.95, top_k: 50, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 }
};

export const MODEL_REGISTRY: ModelFeatureConfig[] = [
    { idPattern: '35b', profiles: QWEN_35B_MOE_PROFILES }, // Target specific 35B explicitly
    { idPattern: 'moe', profiles: QWEN_35B_MOE_PROFILES }, // Target MoE architectures explicitly
    { idPattern: 'qwen3.5-35b', profiles: QWEN_35B_MOE_PROFILES },
    { idPattern: 'qwen35-moe', profiles: QWEN_35B_MOE_PROFILES },
    { idPattern: 'qwen', profiles: QWEN_27B_PROFILES }, // Generic Qwen defaults to Dense 27B
    { idPattern: 'llama', profiles: LLAMA3_PROFILES },
    { idPattern: 'deepseek', profiles: DEEPSEEK_PROFILES },
    { idPattern: 'codestral', profiles: LLAMA3_PROFILES } // Fallback to Llama params
];

export const DEFAULT_PROFILES = QWEN_27B_PROFILES;

export function getProfilesForModel(modelId: string): Record<string, SamplingProfile> {
    const lowerId = modelId.toLowerCase();
    for (const config of MODEL_REGISTRY) {
        if (lowerId.includes(config.idPattern)) {
            return config.profiles;
        }
    }
    return DEFAULT_PROFILES;
}
