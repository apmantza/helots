import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import * as fs from "node:fs/promises";

declare var process: any;
declare var require: any;

// --- CONFIGURATION ---
// Default config
let CONFIG = {
  llmUrl: process.env.HELOT_LLM_URL || "http://127.0.0.1:8080",
  denseModel: process.env.HELOT_DENSE_MODEL || "Qwen/Qwen3.5-27B",
  moeModel: process.env.HELOT_MOE_MODEL || "Qwen/Qwen3.5-35B-A3B",
  autoCompact: true
};

// Attempt to load user overrides from workspace
const loadUserConfig = async () => {
  try {
    const configPath = path.join(process.cwd(), ".helots", "config.json");
    const overrideRaw = await fs.readFile(configPath, "utf-8");
    const overrides = JSON.parse(overrideRaw);
    CONFIG = { ...CONFIG, ...overrides };
  } catch {
    // Silent fail if config doesn't exist or is invalid
  }
};

// --- MODEL REGISTRY & SAMPLING PROFILES ---

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

interface ModelFeatureConfig {
  idPattern: string;
  profiles: Record<string, SamplingProfile>;
}

const QWEN_PROFILES: Record<string, SamplingProfile> = {
  THINKING_GENERAL: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0, enableThinking: true, max_tokens: 32768 },
  THINKING_CODE: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: true, max_tokens: 81920 },
  INSTRUCT_GENERAL: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0.0, presence_penalty: 1.5, repetition_penalty: 1.0, enableThinking: false, max_tokens: 32768 },
  INSTRUCT_REASONING: { temperature: 1.0, top_p: 1.0, top_k: 40, min_p: 0.0, presence_penalty: 2.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 81920 }
};

const LLAMA3_PROFILES: Record<string, SamplingProfile> = {
  THINKING_GENERAL: { temperature: 0.8, top_p: 0.9, top_k: 40, min_p: 0.05, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
  THINKING_CODE: { temperature: 0.2, top_p: 0.9, top_k: 40, min_p: 0.05, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
  INSTRUCT_GENERAL: { temperature: 0.6, top_p: 0.9, top_k: 40, min_p: 0.05, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
  INSTRUCT_REASONING: { temperature: 0.8, top_p: 0.9, top_k: 40, min_p: 0.05, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 }
};

const DEEPSEEK_PROFILES: Record<string, SamplingProfile> = {
  THINKING_GENERAL: { temperature: 0.6, top_p: 0.95, top_k: 50, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: true, max_tokens: 8192 },
  THINKING_CODE: { temperature: 0.0, top_p: 0.95, top_k: 50, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: true, max_tokens: 8192 },
  INSTRUCT_GENERAL: { temperature: 0.6, top_p: 0.95, top_k: 50, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 },
  INSTRUCT_REASONING: { temperature: 0.6, top_p: 0.95, top_k: 50, min_p: 0.0, presence_penalty: 0.0, repetition_penalty: 1.0, enableThinking: false, max_tokens: 8192 }
};

const MODEL_REGISTRY: ModelFeatureConfig[] = [
  { idPattern: 'qwen', profiles: QWEN_PROFILES },
  { idPattern: 'llama', profiles: LLAMA3_PROFILES },
  { idPattern: 'deepseek', profiles: DEEPSEEK_PROFILES },
  { idPattern: 'codestral', profiles: LLAMA3_PROFILES } // Fallback to Llama params
];

function getProfilesForModel(modelId: string): Record<string, SamplingProfile> {
  const lowerId = modelId.toLowerCase();
  for (const config of MODEL_REGISTRY) {
    if (lowerId.includes(config.idPattern)) {
      return config.profiles;
    }
  }
  return QWEN_PROFILES;
}

// Authentic ancient Greek names for Helot persona assignment
const GREEK_NAMES = [
  "Achilles", "Adrastos", "Agathon", "Agis", "Aias", "Aischylos", "Alkibiades",
  "Alkidas", "Alkmeon", "Amyntas", "Anaxandros", "Anaxippos", "Archidamos",
  "Ariston", "Aristophanes", "Aristomenes", "Brasidas", "Damaratos", "Deinokrates",
  "Demaratos", "Dexippos", "Dion", "Diodoros", "Diokles", "Dionysios", "Dorieus",
  "Eudamidas", "Eukleidas", "Eurybiades", "Eurykrates", "Gorgidas", "Gylippos",
  "Hekataios", "Hermokrates", "Hiketas", "Hippokrates", "Ikkos", "Isokrates",
  "Kallikrates", "Kallimachos", "Kleanthes", "Kleisthenes", "Kleombrotos",
  "Kleomenes", "Kratinos", "Kratippos", "Labotas", "Lakonikos", "Leotychidas",
  "Leonidas", "Lykos", "Lysander", "Lysias", "Menandros", "Menelaos",
  "Nikias", "Nikolaos", "Nikomachos", "Pantites", "Pausanias", "Pelopidas",
  "Perdikkas", "Philopoimen", "Phormion", "Polydoros", "Sperthias", "Terpandros",
  "Theron", "Thrasybulos", "Thrasymachos", "Timoleon", "Tyrtaios", "Xanthippos"
];

const GREEK_CITIES = [
  "Sparta", "Athens", "Corinth", "Argos", "Thebes", "Olympia", "Delphi",
  "Megara", "Elis", "Tegea", "Mantinea", "Epidaurus", "Sikyon", "Phlius",
  "Plataea", "Thespiae", "Orchomenos", "Tanagra", "Akragas", "Syracuse",
  "Gela", "Selinous", "Himera", "Naxos", "Kroton", "Sybaris", "Taras",
  "Miletos", "Ephesos", "Halikarnassos", "Smyrna", "Pergamon", "Sardis",
  "Knidos", "Kolophon", "Samos", "Chios", "Lesbos", "Abdera", "Amphipolis"
];

export default function (pi: ExtensionAPI) {
  // Prevent infinite recursive subagent spawning
  if (process.env.HELOT_SUBAGENT === "true") return;

  // Load user overrides for models/url
  loadUserConfig().catch(() => { });

  // Attempt to resolve optional context augmentations natively
  let readMapExt = "";
  try { readMapExt = require.resolve("pi-read-map/src/index.ts"); } catch { }

  // Helper to extract global rules from Context Repo (.pi/system)
  const getGlobalContext = async (): Promise<string> => {
    const systemDir = path.join(process.cwd(), ".pi", "system");
    try {
      const files = await fs.readdir(systemDir);
      let context = "GLOBAL SYSTEM RULES:\n";
      for (const f of files) {
        if (f.endsWith(".md")) {
          const content = await fs.readFile(path.join(systemDir, f), "utf-8");
          context += `\n--- ${f} ---\n${content}\n`;
        }
      }
      return context;
    } catch {
      return ""; // No context repo found
    }
  };

  // Assign a name + city to a helot, deterministically derived from runId + role
  const pickName = (runId: string, role: string): { name: string; city: string } => {
    let hash = 0;
    const seed = runId + role;
    for (let i = 0; i < seed.length; i++) { hash = (hash * 31 + seed.charCodeAt(i)) >>> 0; }
    const name = GREEK_NAMES[hash % GREEK_NAMES.length];
    const city = GREEK_CITIES[(hash * 7 + 13) % GREEK_CITIES.length];
    return { name, city };
  };

  // --- LLM CLIENT (MODULARITY) ---
  class LlamaClient {
    private baseUrl: string;

    constructor(baseUrl: string) {
      this.baseUrl = baseUrl;
    }

    async getProps(): Promise<{ modelName: string; maxTokens: number }> {
      try {
        const res = await (globalThis as any).fetch(`${this.baseUrl}/props`);
        if (!res.ok) return { modelName: "unknown", maxTokens: 8192 };
        const props: any = await res.json();
        const modelName: string = props.model_alias || props.default_generation_settings?.model || "unknown";
        const ctxSize: number = props.default_generation_settings?.n_ctx || 32768;
        return { modelName, maxTokens: Math.min(16384, Math.floor(ctxSize * 0.25)) };
      } catch {
        return { modelName: "unknown", maxTokens: 8192 };
      }
    }

    async chatComplete(params: {
      messages: { role: string; content: string }[];
      model: string;
      profile: any;
      onToken?: (token: string) => void;
    }): Promise<{ content: string; usage?: any; timings?: any }> {
      const res = await (globalThis as any).fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: params.model,
          messages: params.messages,
          temperature: params.profile.temperature,
          top_p: params.profile.top_p,
          top_k: params.profile.top_k,
          min_p: params.profile.min_p,
          presence_penalty: params.profile.presence_penalty,
          repetition_penalty: params.profile.repetition_penalty,
          max_tokens: params.profile.max_tokens,
          stream: true,
          stream_options: { include_usage: true },
          chat_template_kwargs: { enable_thinking: params.profile.enableThinking },
          extra_body: { enable_thinking: params.profile.enableThinking }
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`LLM API error ${res.status}: ${errText.slice(0, 300)}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("Could not get stream reader");

      let fullContent = "";
      const decoder = new TextDecoder();
      let lastUsage = null;
      let lastTimings = null;
      let lineBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine || !trimmedLine.startsWith("data: ")) continue;
          const dataStr = trimmedLine.slice(6).trim();
          if (dataStr === "[DONE]") return { content: fullContent, usage: lastUsage, timings: lastTimings };

          try {
            const data = JSON.parse(dataStr);
            const delta = data.choices?.[0]?.delta;
            if (delta) {
              const text = delta.content || delta.reasoning_content || delta.thought || "";
              if (text) {
                fullContent += text;
                params.onToken?.(text);
              }
            }
            if (data.usage) lastUsage = data.usage;
            if (data.timings) lastTimings = data.timings;
          } catch { }
        }
      }

      return {
        content: fullContent,
        usage: lastUsage,
        timings: lastTimings
      };
    }
  }

  const client = new LlamaClient(CONFIG.llmUrl);

  interface SubagentMetrics {
    in: number;
    out: number;
    tps: number;
  }

  // --- SUBAGENT ORCHESTRATION ---
  const runSubagent = async (
    role: string,
    helotName: string,
    systemPrompt: string,
    task: string,
    onUpdate: (data: any) => void,
    metrics: SubagentMetrics,
    profileKey: string = "THINKING_GENERAL",
    detectedModelName?: string
  ): Promise<string> => {
    // Router Logic: Aristomenis gets Dense, others get MoE
    const targetModel = (role === "Aristomenis" || role === "Governor") ? CONFIG.denseModel : CONFIG.moeModel;

    // Check available models from client if not passed directly (mostly for fallback, executeHelots passes it)
    const activeModelName = detectedModelName || (await client.getProps()).modelName;

    // Fall back to the active model if the desired model isn't running
    const actualModelToUse = activeModelName; // Simplification: we use what the server actually has loaded

    const profiles = getProfilesForModel(actualModelToUse);
    const profile = profiles[profileKey] || profiles["THINKING_GENERAL"];

    onUpdate?.({ content: [{ type: "text", text: `⚔️ Helot ${helotName} (${role}) running on ${actualModelToUse} [${profileKey}]...` }] });

    const response = await client.chatComplete({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: task }
      ],
      model: actualModelToUse,
      profile,
      onToken: (t) => {
        if (!t) return;
        const spin = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][Math.floor(Date.now() / 100) % 10];
        onUpdate?.({
          content: [{
            type: "text",
            text: `${spin} Helot ${helotName} (${role}) generating...`
          }]
        });
      }
    });

    const { content, usage, timings } = response;

    // Update token metrics
    if (usage) {
      metrics.in += usage.prompt_tokens || 0;
      metrics.out += usage.completion_tokens || 0;
      if (timings?.predicted_per_second) metrics.tps = timings.predicted_per_second;

      onUpdate?.({
        content: [{
          type: "text",
          text: `[${helotName}/${role}] In: ${metrics.in} | Out: ${metrics.out}${metrics.tps ? ` | ${metrics.tps.toFixed(1)} tps` : ""}`
        }]
      });
    }

    // Parse file write/edit operations from the model's text response.
    // Both <write> and <edit> perform a full-file overwrite — use either tag.
    const writeRegex = /<write\s+file="([^"]+)">([\/\s\S]*?)<\/write>/g;
    const editRegex = /<edit\s+file="([^"]+)">([\/\s\S]*?)<\/edit>/g;
    let match;

    while ((match = writeRegex.exec(content)) !== null) {
      const filePath = path.resolve(process.cwd(), match[1]);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, match[2].trim(), "utf-8");
      onUpdate?.({ content: [{ type: "text", text: `[${role}] 💾 Wrote: ${match[1]}` }] });
    }

    while ((match = editRegex.exec(content)) !== null) {
      const filePath = path.resolve(process.cwd(), match[1]);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, match[2], "utf-8");
      onUpdate?.({ content: [{ type: "text", text: `[${role}] 🛠️ Edited: ${match[1]}` }] });
    }

    return content;
  };

  const executeHelots = async (taskSummary: string, implementationPlan: string, onUpdate: any) => {
    const runId = Math.random().toString(36).substring(7);

    // Support custom state directory via HELOT_STATE_DIR, fallback to .helot-state in CWD
    const baseStateDir = process.env.HELOT_STATE_DIR || path.join(process.cwd(), ".helot-state");
    const stateDir = path.join(baseStateDir, `run-${runId}`);

    await fs.mkdir(stateDir, { recursive: true });

    const contextFile = path.join(stateDir, "context.md");
    const progressFile = path.join(stateDir, "progress.md");
    const reviewFile = path.join(stateDir, "review.md");
    const traceJsonl = path.join(stateDir, "trace.jsonl");

    const writeTrace = async (entry: any) => {
      await fs.appendFile(traceJsonl, JSON.stringify({ timestamp: Date.now(), ...entry }) + "\n");
    };

    onUpdate?.({ content: [{ type: "text", text: `🛡️ Helots Initialized (Run ID: ${runId})` }] });

    // Auto-detect server model and context size
    const { modelName, maxTokens } = await client.getProps();
    onUpdate?.({ content: [{ type: "text", text: `🤖 Detected Loaded Model: ${modelName} | Max output: ${maxTokens} tokens` }] });

    // Portability: Auto-patch .gitignore if it exists
    try {
      const gitignorePath = path.join(process.cwd(), ".gitignore");
      let gitignore = await fs.readFile(gitignorePath, "utf-8");
      if (!gitignore.includes(".helot-state")) {
        await fs.writeFile(gitignorePath, gitignore + "\n# Helots subagent state\n.helot-state/\n");
        onUpdate?.({ content: [{ type: "text", text: "📦 Added .helot-state to .gitignore" }] });
      }
    } catch { /* No .gitignore, ignore */ }

    // Natively inject context repo
    const globalContext = await getGlobalContext();

    // Aggregated Metrics
    const psiloiMetrics = {
      scout: { in: 0, out: 0, tps: 0 },
      builder: { in: 0, out: 0, tps: 0 },
      peltast: { in: 0, out: 0, tps: 0 }
    };

    // --- 1. SCOUT PHASE ---
    const scoutSystem = `${globalContext}
You are the Scout. Your ONLY job is to be the Strategic Reader for the Architect's plan.
The Architect has provided a high-level plan. You must scout the codebase and output two XML blocks:

1. <write file="${contextFile}">: A list of all relevant file paths needed to execute the plan, one per line.
2. <write file="${progressFile}">: A granular, step-by-step technical checklist for the Builders.

RESPOND ONLY WITH XML. NO explanations, NO prose, NO thinking.`;

    const scout = pickName(runId, "Scout");
    onUpdate?.({ content: [{ type: "text", text: `[Scout] ${scout.name} of ${scout.city} summoned...` }] });
    await runSubagent("Scout", scout.name, scoutSystem, `Plan: ${implementationPlan}`, onUpdate, psiloiMetrics.scout, "INSTRUCT_GENERAL", modelName);

    await writeTrace({ phase: "scout", status: "complete" });

    // --- 2. BUILDER LOOP ---
    let progressContent;
    try {
      progressContent = await fs.readFile(progressFile, "utf-8");
    } catch {
      return `❌ Scout failed to create ${progressFile}. Pipeline aborted.`;
    }

    const tasks = progressContent.split("\n").filter((l: string) => l.trim().startsWith("- [ ]"));

    const builderSystem = `${globalContext}
You are the Builder subagent in the Helots pipeline.
Execute ONLY the single assigned task.
Output ALL file changes using XML tags (full file content, no diffs):

<write file="relative/path/to/file.ts">
full file content here
</write>

You may output multiple <write> blocks if needed. After all writes, output: DONE`;

    for (const [index, checklistTask] of tasks.entries()) {
      // Print the Live Visual Checklist
      let currentChecklist = `\n📋 **Live Checklist (${index}/${tasks.length} Done)**\n`;
      tasks.forEach((t: string, i: number) => {
        const isDone = i < index ? "[x]" : (i === index ? "[▶]" : "[ ]");
        const cleanTask = t.replace("- [ ]", "").replace("- [x]", "").trim();
        currentChecklist += `  ${isDone} ${cleanTask}\n`;
      });
      onUpdate?.({ content: [{ type: "text", text: currentChecklist }] });

      let tryCount = 0;
      const maxTries = 3;
      let lastPeltastFeedback = "";
      let taskPassed = false;

      while (tryCount < maxTries) {
        tryCount++;
        let contextContent = "";
        try { contextContent = await fs.readFile(contextFile, "utf-8"); } catch { }

        const builderPrompt = `FILES CONTEXT: ${contextContent}
YOUR TASK: ${checklistTask}
PROGRESS SO FAR: ${await fs.readFile(progressFile, "utf-8")}
${lastPeltastFeedback ? `\nPREVIOUS ATTEMPT FAILED. Peltast Feedback:\n${lastPeltastFeedback}\n\nPlease fix the issues above.` : ""}`;

        const builder = pickName(runId, `Builder-${index}-${tryCount}`);
        onUpdate?.({ content: [{ type: "text", text: `[Builder] ${builder.name} of ${builder.city} assigned Task ${index + 1}/${tasks.length} (Try ${tryCount}/${maxTries})...` }] });
        const builderOut = await runSubagent("Builder", builder.name, builderSystem, builderPrompt, onUpdate, psiloiMetrics.builder, "THINKING_CODE", modelName);
        await writeTrace({ phase: "builder", taskIndex: index, try: tryCount, outputLength: builderOut.length });

        // --- 3. PELTAST PHASE ---
        const peltastSystem = `${globalContext}
You are the Peltast. Check if the Builder completed: ${checklistTask}.
If correct, output VERDICT: PASS. If incorrect, output VERDICT: FAIL and explain why.`;

        const peltast = pickName(runId, `Peltast-${index}-${tryCount}`);
        onUpdate?.({ content: [{ type: "text", text: `[Peltast] ${peltast.name} of ${peltast.city} verifying Task ${index + 1} (Try ${tryCount}/${maxTries})...` }] });
        const peltastOut = await runSubagent("Peltast", peltast.name, peltastSystem,
          `Builder output:\n${builderOut}\n\nVerify this completed the task: ${checklistTask}`,
          onUpdate, psiloiMetrics.peltast, "INSTRUCT_REASONING", modelName);

        await fs.appendFile(reviewFile, `\n## Task: ${checklistTask} (Try ${tryCount})\n${peltastOut}\n`);
        await writeTrace({ phase: "peltast", taskIndex: index, try: tryCount, result: peltastOut.includes("PASS") ? "pass" : "fail" });

        if (peltastOut.includes("VERDICT: PASS")) {
          taskPassed = true;
          break;
        } else {
          lastPeltastFeedback = peltastOut;
          onUpdate?.({ content: [{ type: "text", text: `⚠️ Peltast ${peltast.name} rejected task. Retrying...` }] });
        }
      }

      if (!taskPassed) {
        onUpdate?.({ content: [{ type: "text", text: `❌ Task ${index + 1} failed after ${maxTries} attempts. Halting pipeline.` }] });
        return `Pipeline halted at Task ${index + 1} due to Peltast rejection. Check ${reviewFile}.`;
      }

      // Mark task as done
      progressContent = progressContent.replace(checklistTask, checklistTask.replace("- [ ]", "- [x]"));
      await fs.writeFile(progressFile, progressContent);
    }

    onUpdate?.({ content: [{ type: "text", text: `✅ Execution complete! All items checked off.` }] });

    const totalOut = psiloiMetrics.scout.out + psiloiMetrics.builder.out + psiloiMetrics.peltast.out || 1;
    const scoutPct = Math.round((psiloiMetrics.scout.out / totalOut) * 20);
    const builderPct = Math.round((psiloiMetrics.builder.out / totalOut) * 20);
    const peltastPct = Math.max(0, 20 - scoutPct - builderPct);

    const bar = "🟦".repeat(scoutPct) + "🟩".repeat(builderPct) + "🟪".repeat(peltastPct);

    return `Aristomenis Plan Executed Successfully by the Psiloi!

🏛️ **Neodamodeis Ratification Speech** 🏛️
"The Psiloi have proven their valor. By decree of Aristomenis, you are hereby granted the honor of Neodamodeis. Sparta recognizes your tactical prowess and precision."

📊 **Workload Distribution (Tokens Generated)**
${bar}
  🟦 Scout:   ${psiloiMetrics.scout.out}
  🟩 Builder: ${psiloiMetrics.builder.out}
  🟪 Peltast: ${psiloiMetrics.peltast.out}`;
  };

  const executeSlinger = async (researchTask: string, targetFiles: string[] | undefined, onUpdate: any) => {
    const runId = Math.random().toString(36).substring(7);
    const { modelName, maxTokens } = await client.getProps();
    const slingerMetrics = { in: 0, out: 0, tps: 0 };
    const slingerPersona = pickName(runId, "Slinger");

    let fileContext = "";
    if (targetFiles && targetFiles.length > 0) {
      onUpdate?.({ content: [{ type: "text", text: `📖 Slinger reading ${targetFiles.length} files...` }] });
      for (const f of targetFiles) {
        try {
          const content = await fs.readFile(path.resolve(f), "utf-8");
          fileContext += `\n--- FILE: ${f} ---\n${content}\n`;
        } catch (e: any) {
          fileContext += `\n--- FILE: ${f} ---\n(Error reading file: ${e.message})\n`;
        }
      }
    }

    const slingerSystem = `${await getGlobalContext()}
You are the Slinger, a specialized reconnaissance subagent.
Your goal is to perform deep reading and research on the codebase to answer the Architect's specific questions.
Analyze the provided context and provide a concise, technical, and accurate summary or answer.
Avoid fluff. Focus on architectural patterns, logic flow, and specific implementation details.

${fileContext ? `FILE CONTENT TO ANALYZE:\n${fileContext}` : ""}`;

    onUpdate?.({ content: [{ type: "text", text: `🏹 Slinger ${slingerPersona.name} of ${slingerPersona.city} deployed (Run ID: ${runId})` }] });
    onUpdate?.({ content: [{ type: "text", text: `🤖 Detected Loaded Model: ${modelName} | Max output: ${maxTokens} tokens` }] });

    const result = await runSubagent("Slinger", slingerPersona.name, slingerSystem, researchTask, onUpdate, slingerMetrics, "THINKING_GENERAL", modelName);

    return `🏹 **Slinger Research Report** (by ${slingerPersona.name} of ${slingerPersona.city})

${result}

---
📊 **Slinger Metrics**
  In: ${slingerMetrics.in} | Out: ${slingerMetrics.out} | Speed: ${slingerMetrics.tps.toFixed(1)} tps`;
  };

  pi.registerTool({
    name: "helot_slinger",
    label: "helot: slinger",
    description: "Delegates deep codebase research or analysis to the local Slinger subagent. Use this to 'read' large sections of code or understand complex logic without consuming the Architect's context window.",
    parameters: Type.Object({
      researchTask: Type.String({ description: "The specific research objective or question about the codebase." }),
      targetFiles: Type.Optional(Type.Array(Type.String(), { description: "Optional list of absolute file paths to analyze." }))
    }),
    async execute(_id: string, p: any, _s: any, onUpdate: (data: any) => void, _ctx: any) {
      try {
        const result = await executeSlinger(p.researchTask, p.targetFiles, onUpdate);
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (err: any) {
        return { content: [{ type: "text", text: `❌ Slinger failed: ${err.message}` }], details: { error: err.message } };
      }
    }
  });

  pi.registerTool({
    name: "helot_run",
    label: "helot: run",
    description: "Delegates the Architect implementation plan to the Psiloi subagent swarm (Scout → Builder → Peltast). Use this exclusively to edit files.",
    parameters: Type.Object({
      taskSummary: Type.String({ description: "High-level summary of the architectural changes." }),
      implementationPlan: Type.String({ description: "Extremely detailed, step-by-step technical plan for the subagents." })
    }),
    async execute(_id: string, p: any, _s: any, onUpdate: (data: any) => void, _ctx: any) {
      try {
        const result = await executeHelots(p.taskSummary, p.implementationPlan, onUpdate);
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (err: any) {
        return { content: [{ type: "text", text: `❌ Helots crashed: ${err.message}` }], details: { error: err.message } };
      }
    }
  });
}
