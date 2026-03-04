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
    // Architect / Planner (general reasoning, needs thinking for plan quality)
    // HF recommended: temp=1.0, top_p=0.95, top_k=20, presence_penalty=1.5
    THINKING_GENERAL: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0, enableThinking: true, max_tokens: 32768 },
    // Builder — full-file / CREATE tasks (thinking helps plan file structure)
    // HF recommended: temp=0.6, top_p=0.95, top_k=20, presence_penalty=0.0 (precise coding)
    // budget_tokens caps llama.cpp thinking tokens — they don't count toward max_tokens and are otherwise uncapped.
    THINKING_CODE: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: true, max_tokens: 8192, extra_body: { chat_template_kwargs: { enable_thinking: true, budget_tokens: 4096 } } },
    // Builder — surgical tasks (mechanical replacements; thinking is wasteful, non-thinking is faster + cleaner)
    INSTRUCT_CODE: { temperature: 0.4, top_p: 0.9, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192, extra_body: { chat_template_kwargs: { enable_thinking: false } } },
    // Peltast — rule-based verdict (near-deterministic; outputs 1-2 lines max)
    PELTAST: { temperature: 0.1, top_p: 0.9, top_k: 10, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 512, extra_body: { chat_template_kwargs: { enable_thinking: false } } },

    // Legacy / kept for compatibility
    THINKING_REASONING: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0, enableThinking: true, max_tokens: 4096 },
    // HF recommended non-thinking/general: temp=0.7, top_p=0.8, top_k=20, presence_penalty=1.5
    INSTRUCT_GENERAL: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0, enableThinking: false, max_tokens: 16384, extra_body: { chat_template_kwargs: { enable_thinking: false } } },
    // HF recommended non-thinking/reasoning: temp=1.0, top_p=1.0, top_k=40, presence_penalty=2.0
    INSTRUCT_REASONING: { temperature: 1.0, top_p: 1.0, top_k: 40, min_p: 0.0, presence_penalty: 2.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 16384, extra_body: { chat_template_kwargs: { enable_thinking: false } } },
    // Slinger: low-temp factual search, non-thinking (presence_penalty=0.0 — accuracy over diversity)
    SLINGER: { temperature: 0.4, top_p: 0.9, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192, extra_body: { chat_template_kwargs: { enable_thinking: false } } }
};

// -------------------------------------------------------------
// 2. Qwen 3.5 35B (MoE)
// Designed for Qwen 3.5 35B-MoE alignments and officially recommended parameters.
// max_tokens clamped tightly for Builder/Peltast to prevent runaway reasoning loops.
// -------------------------------------------------------------
const QWEN_35B_MOE_PROFILES: Record<string, SamplingProfile> = {
    // Architect / Planner
    // HF recommended: temp=1.0, top_p=0.95, top_k=20, presence_penalty=1.5
    THINKING_GENERAL: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0, enableThinking: true, max_tokens: 32768 },
    // Builder — full-file / CREATE tasks
    // HF recommended: temp=0.6, top_p=0.95, top_k=20, presence_penalty=0.0 (precise coding)
    // budget_tokens caps llama.cpp thinking tokens — they don't count toward max_tokens and are otherwise uncapped.
    THINKING_CODE: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: true, max_tokens: 8192, extra_body: { chat_template_kwargs: { enable_thinking: true, budget_tokens: 4096 } } },
    // Builder — surgical tasks (non-thinking, faster)
    INSTRUCT_CODE: { temperature: 0.4, top_p: 0.9, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192, extra_body: { chat_template_kwargs: { enable_thinking: false } } },
    // Peltast — near-deterministic rule-follower, tight token cap
    PELTAST: { temperature: 0.1, top_p: 0.9, top_k: 10, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 512, extra_body: { chat_template_kwargs: { enable_thinking: false } } },

    // Legacy
    THINKING_REASONING: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0, enableThinking: true, max_tokens: 4096 },
    // HF recommended non-thinking/general: temp=0.7, top_p=0.8, top_k=20, presence_penalty=1.5
    INSTRUCT_GENERAL: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0, enableThinking: false, max_tokens: 16384, extra_body: { chat_template_kwargs: { enable_thinking: false } } },
    // HF recommended non-thinking/reasoning: temp=1.0, top_p=1.0, top_k=40, presence_penalty=2.0
    INSTRUCT_REASONING: { temperature: 1.0, top_p: 1.0, top_k: 40, min_p: 0.0, presence_penalty: 2.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 16384, extra_body: { chat_template_kwargs: { enable_thinking: false } } },
    SLINGER: { temperature: 0.4, top_p: 0.9, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192, extra_body: { chat_template_kwargs: { enable_thinking: false } } }
};

// -------------------------------------------------------------
// 2. Llama 3 / 3.1
// Lower temperature generally preferred for code inference
// -------------------------------------------------------------
const LLAMA3_PROFILES: Record<string, SamplingProfile> = {
    THINKING_GENERAL: { temperature: 0.8, top_p: 0.9, top_k: 40, min_p: 0.05, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
    THINKING_CODE: { temperature: 0.2, top_p: 0.9, top_k: 40, min_p: 0.05, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
    INSTRUCT_GENERAL: { temperature: 0.6, top_p: 0.9, top_k: 40, min_p: 0.05, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
    INSTRUCT_REASONING: { temperature: 0.8, top_p: 0.9, top_k: 40, min_p: 0.05, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
    SLINGER: { temperature: 0.4, top_p: 0.9, top_k: 40, min_p: 0.05, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 }
};

// -------------------------------------------------------------
// 3. DeepSeek Coder V2 / DeepSeek-V3
// Strict reasoning parameters; relies heavily on built-in reasoning steps if enabled
// -------------------------------------------------------------
const DEEPSEEK_PROFILES: Record<string, SamplingProfile> = {
    THINKING_GENERAL: { temperature: 0.6, top_p: 0.95, top_k: 50, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: true, max_tokens: 8192 },
    THINKING_CODE: { temperature: 0.0, top_p: 0.95, top_k: 50, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: true, max_tokens: 8192 },
    INSTRUCT_GENERAL: { temperature: 0.6, top_p: 0.95, top_k: 50, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
    INSTRUCT_REASONING: { temperature: 0.6, top_p: 0.95, top_k: 50, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
    SLINGER: { temperature: 0.4, top_p: 0.9, top_k: 50, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 }
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

// Safe fallback for unknown models: conservative non-thinking params.
// Unknown models should NOT inherit Qwen3 thinking parameters (budget_tokens, enable_thinking).
const SAFE_FALLBACK_PROFILES: Record<string, SamplingProfile> = {
    THINKING_GENERAL:   { temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0.0, presence_penalty: 0.5, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
    THINKING_CODE:      { temperature: 0.2, top_p: 0.9, top_k: 40, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
    THINKING_REASONING: { temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0.0, presence_penalty: 0.5, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
    INSTRUCT_GENERAL:   { temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0.0, presence_penalty: 0.5, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
    INSTRUCT_CODE:      { temperature: 0.2, top_p: 0.9, top_k: 40, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
    INSTRUCT_REASONING: { temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0.0, presence_penalty: 0.5, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
    PELTAST:            { temperature: 0.1, top_p: 0.9, top_k: 10, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 512 },
    SLINGER:            { temperature: 0.3, top_p: 0.9, top_k: 40, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
};

export const DEFAULT_PROFILES = SAFE_FALLBACK_PROFILES;

export function getProfilesForModel(modelId: string): Record<string, SamplingProfile> {
    const lowerId = modelId.toLowerCase();
    for (const config of MODEL_REGISTRY) {
        if (lowerId.includes(config.idPattern)) {
            return config.profiles;
        }
    }
    return DEFAULT_PROFILES;
}
