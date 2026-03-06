# 🏛️ Helots: The "Gorgo & Psiloi" Architecture

Welcome to **Helots**—a local LLM orchestration framework designed to bridge the gap between expensive cloud reasoning APIs (The Architect) and free, high-throughput local execution GPUs (The Swarm).

## The Core Philosophy: "Cloud Brain, Local Muscle"

Current agentic workflows suffer from a glaring dichotomy:

1. **API Maximalism**: Using Claude 3.7 or GPT-4o for every file read, edit, and bash command. This leads to massive token bloat, rapid context drift, and astronomical costs on large codebases.
2. **Local Purism**: Relying exclusively on local models (like `llama.cpp`) for complex software architecture. While free, even the best local open-weight models struggle with zero-shot, multi-file software design.

**Helots introduces the Hybrid Delegation Pattern**:
The elite Cloud Model acts strictly as **"Gorgo of Sparta" (The Architect)**. It interacts with the user, designs the software architecture, and writes granular implementation checklists. It is explicitly forbidden from writing code.
Instead, it delegates all physical labor to the **"Psiloi Swarm" (The Local LLM)**, a highly optimized, parallelized MoE model running locally via `llama.cpp` that rapidly builds and validates the code for free.

---

## 🏗️ Architecture Components

The framework is packaged as an extremely portable extension (`mcp.ts`/`pi.ts`) containing the orchestrator engine.

### The Psiloi Swarm Pipeline

The Swarm executes a rigorous **Scout → Builder → Peltast** pipeline to ensure high-quality code generation:

* **Scout (Strategic Local - Dense Model)**: Powered by a high-precision Dense model (e.g., Qwen 27B), the Scout parses the Architect's plan, identifies relevant files, and creates a local `progress.md` tracked state.
* **Builder (Tactical Execution - MoE Model)**: Powered by a high-TPS Mixture-of-Experts model (e.g., Qwen 35B-A3B), the Builder picks up tasks from the checklist sequentially and rapidly modifies the codebase.
* **Peltast (Quality Assurance - MoE Model)**: The Peltast reviews the Builder's work. If flawed, it rejects the code and feeds the error back to the Builder for an automatic retry loop (up to 3 times).

### MCP Tools

The framework exposes the following specialized tools to the Orchestrator:

* **`helot_run`**: The primary execution engine that manages the multi-agent loop (Scout, Builder, Peltast).
* **`helot_slinger`**: A research subroutine. When the Architect needs to understand local codebase context (e.g., "How does authentication work here?"), it dispatches the Slinger. The local LLM reads the files and returns a highly dense, summarized report, keeping the Architect's context window lean and cheap.
* **`helot_hoplite`**: Handles defensive operations and secure execution contexts.
* **`helot_execute`**: Direct command execution interface for the Swarm.
* **`helot_workflow`**: Manages complex, multi-step orchestration flows and state persistence.

---

## 📂 Project Structure

The project is organized to separate orchestration logic from execution agents:

```text
helots/
├── src/
│   ├── orchestrator/       # Core logic for Gorgo interaction and delegation
│   ├── agents/
│   │   ├── scout/          # Dense model agent for planning
│   │   ├── builder/        # MoE model agent for coding
│   │   └── peltast/        # MoE model agent for QA
│   ├── tools/
│   │   ├── helot_run.ts
│   │   ├── helot_slinger.ts
│   │   ├── helot_hoplite.ts
│   │   ├── helot_execute.ts
│   │   └── helot_workflow.ts
│   └── utils/
├── .helots/
│   └── config.json         # Per-project LLM tuning
└── USAGE.md
```

---

## ⚙️ Configuration (.helots/config.json)

The Swarm dynamically loads configuration parameters from `.helots/config.json` in your project root, allowing per-project tuning of the LLM endpoints and models.

```json
{
  "llmUrl": "http://127.0.0.1:8080",
  "denseModel": "Qwen/Qwen3.5-27B",
  "moeModel": "Qwen/Qwen3.5-35B-A3B",
  "autoCompact": true
}
```

* **Model Router Logic**: The framework automatically routes the `Scout` to the slower, higher-precision `denseModel`, while the `Builder` and `Peltast` are routed to the extremely fast `moeModel`.
* **Dynamic Sampling**: Different internal agents utilize hardcoded sampling profiles (e.g., `THINKING_CODE` for precise generation, `INSTRUCT_REASONING` for logical verification).

## 🚀 Getting Started

To launch Helots with Antigravity, Claude, or other MCP-compatible clients, please refer to the [USAGE.md](USAGE.md) documentation.