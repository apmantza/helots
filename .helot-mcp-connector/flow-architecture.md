# Helot MCP Connector Flow Architecture

## Summary

Based on the code analysis, here is the architecture summary:

### 1. Flow Map

- **helot_run**
  - **Path**: MCP Entry → `engine.executeHelots()` → `_executeHelots()` (helots-orchestrator.ts)
  - **Function**: Orchestrates TaskRunner with SlingerAgent subagents.
  - **Returns**: Final task execution summary text.
  - **Local State**: All intermediate agent states, logs, and file operations stay on-disk.

- **helot_slinger**
  - **Path**: MCP Entry → `engine.executeSlinger()` → `SlingerAgent.execute()`
  - **Function**: Runs research tasks on target files.
  - **Returns**: Research findings text.
  - **Local State**: Full codebase analysis stays on-disk.

- **helot_hoplite**
  - **Path**: MCP Entry → `engine.executeHoplite()` → `HopliteAgent.execute()`
  - **Function**: Executes file-specific instructions.
  - **Returns**: Execution result text.
  - **Local State**: File modifications stay on-disk.

- **helot_execute**
  - **Path**: MCP Entry → `engine.executeScript()` → `_executeScript()` (file-executor.ts)
  - **Function**: Runs shell scripts with audit logging.
  - **Returns**: Script output text.
  - **Local State**: All script operations and audit logs stay on-disk.

- **helot_workflow**
  - **Path**: MCP Entry → `executeWorkflow()` (workflow-engine.ts)
  - **Function**: Executes sequential steps using engine methods.
  - **Returns**: Step-by-step execution summary.
  - **Local State**: Intermediate step results stay on-disk.

### 2. Token Pressure Points

- **Large payloads to frontier**: All tools return full text summaries of their operations.
  - `helot_run` returns complete task execution logs.
  - `helot_slinger` returns full research findings.
- **Fully off-frontier**: File modifications, audit logs, intermediate agent states, and batch processing results stay entirely local.
- **Hybrid flows**: `helot_scribe` (via `executeScribe`) returns only final output file path, but intermediate research is truncated to ~6k chars before being sent to Hoplite.

### 3. Skills Gap

Currently `/maintain` uses `helot_workflow` (single call), but `/cleanup`, `/docs`, and `/prune` call individual tools directly. To wire them to `helot_workflow`:

- Define workflow steps for cleanup (e.g., `[identify, backup, delete, verify]`)
- Define workflow steps for docs (e.g., `[research, generate, validate]`)
- Define workflow steps for prune (e.g., `[scan, categorize, execute, audit]`)
- Each would need a `WorkflowStep[]` definition in the MCP server

### 4. Session Token Usage

Cannot determine from code alone - requires reading `.helot-mcp-connector/events.jsonl` file which wasn't accessible in current analysis.

### 5. Architecture Gaps

- All tools return full text summaries to frontier that could be eliminated or summarized.
- `helot_run` returns complete execution logs when only final status might be needed.
- `helot_slinger` returns full research when only key findings might suffice.
- No streaming/progressive return mechanism - all results batched at end.
- Intermediate states could be compressed or summarized before sending to frontier.

## Locations

- `src/adapters/mcp-server.ts:100-180` (MCP tool definitions and return paths)
- `src/core/engine.ts:55-192` (Engine method implementations)
- `src/core/helots-orchestrator.ts:19` (Import and delegation)
- `src/core/workflow-engine.ts` (Workflow execution)
- `src/core/slinger-agent.ts` (Slinger agent implementation)

## Evidence

```typescript
// MCP Server - helot_run returns full result text
if (name === "helot_run") {
    const result = await engine.executeHelots(taskSummary, '', (data) => {
        console.error(`[Helot Update] ${data.text}`);
    }, frontierTasks);
    return {
        content: [{ type: "text", text: result }], // Full text returned to frontier
    };
}

// MCP Server - helot_slinger returns full research
if (name === "helot_slinger") {
    const result = await engine.executeSlinger(researchTask, targetFiles, (data: { text: string }) => {
        console.error(`[Slinger Update] ${data.text}`);
    });
    return { content: [{ type: "text", text: result }] }; // Full research returned
}

// Engine delegates to orchestrator
async executeHelots(
    taskSummary:        string,
    implementationPlan: string,
    onUpdate?:          (data: any) => void,
    frontierTasks?:     FrontierTask[],
): Promise<string> {
    return _executeHelots(taskSummary, implementationPlan, frontierTasks, {
        governor:      this.governor,
        slingerAgent:  this.slingerAgent,
        taskRunner:    this.taskRunner,
        runSubagentFn: this.runSubagent.bind(this),
        writeEventFn:  this.writeEvent.bind(this),
        setPhase:      (p: string) => { this.currentPhase = p; },
        getModelProps: () => this.client.getProps(),
    }, onUpdate);
}

// Scribe truncates research to avoid OOM
const researchCapped = research.length > 6000 ? research.slice(0, 6000) + '\n\n[...truncated for context budget]' : research;
await this.hopliteAgent.execute(outputFile,
  `Based on this research, write a clean well-formatted markdown document:\n\n${researchCapped}`,
  onUpdate);
```