# Helots: Agent Architecture & Portability

This project is designed with a **Modular Triad Architecture** to ensure full portability across multiple LLM execution environments.

### 🏹 Maintainer's Mandate: Mandatory Synchronization
>
> [!IMPORTANT]
> ANY ARCHITECTURAL CHANGES must be synchronized to the Pi extension directory:
> `C:\Users\R3LiC\.pi\agent\extensions\`
>
> This includes:
>
> 1. Updating the `src/` core files in that directory.
> 2. Verifying the `helots.ts` bridge is still correctly pointing to the updated core.

## 🏛️ Project Goal

Maintain a strictly decoupled core logic to ensure the system remains usable as:

1. **Pi Extension**: Via the root `index.ts` bridge.
2. **MCP Server**: Via `src/adapters/mcp-server.ts` for Antigravity and Claude.

## 📐 Architecture Overview

- **Core (`src/core/`)**: Houses the `HelotEngine`, `LlamaClient`, and `ModelRegistry`. All orchestration logic (Aristomenis, Slinger, Builder, Peltast) MUST live here.
- **Adapters (`src/adapters/`)**: Environment-specific entry points.
- **Config (`src/config.ts`)**: Shared interfaces and environmental defaults.

## 🏗️ Portability Rules

- **No Glue Code in Core**: Orchestration logic should never depend on Pi-specific or MCP-specific APIs. Use abstractions and callbacks (`onUpdate`).
- **Dual-Entry Support**: Any new feature must be exposed to both the Pi `registerTool` and MCP `setRequestHandler` interfaces.
- **Git Safety**: Always verify `.git` presence before executing automated commits or rollbacks.

## 🏹 Running as MCP

```bash
npm run mcp
```

Exposes `helot_slinger` and `helot_run` to the local MCP transport.
