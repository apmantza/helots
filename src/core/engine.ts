/**
 * engine.ts — HelotEngine: thin coordinator for all helot agents.
 *
 * Instantiates agents, owns runSubagent + writeEvent, delegates
 * public methods to the appropriate agent or orchestrator.
 */

import { appendFileSync, readdirSync } from 'fs';
import * as path from 'path';
import { join } from 'path';
import { LlamaClient }       from './llama-client.js';
import { HelotConfig, TaskRole } from '../config.js';
import { Aristomenis }       from './governor.js';
import { SlingerAgent }      from './slinger-agent.js';
import { HopliteAgent }      from './hoplite-agent.js';
import { VisionAgent }       from './vision-agent.js';
import { TaskRunner }        from './task-runner.js';
import { executeHelots as _executeHelots } from './helots-orchestrator.js';
import type { HelotTask, HelotState, HelotContext, RunSubagentFn, WriteEventFn } from './types.js';
import type { FrontierTask } from './types.js';

// Re-export types for consumers who import from engine
export type { HelotTask, HelotState, HelotContext };

export class HelotEngine {
  private governor:           Aristomenis;
  private client:             LlamaClient;
  private slingerAgent:       SlingerAgent;
  private hopliteAgent:       HopliteAgent;
  private visionAgent:        VisionAgent;
  private taskRunner:         TaskRunner;
  private currentPhase:       string = 'Setup';
  private currentTaskTitle:   string = '';
  private sessionTotalTokens: number = 0;

  constructor(config: HelotConfig) {
    this.governor = new Aristomenis(config);
    this.client   = new LlamaClient(config);

    const runSubagentFn: RunSubagentFn = this.runSubagent.bind(this);
    const writeEventFn:  WriteEventFn  = this.writeEvent.bind(this);
    const setPhase     = (p: string) => { this.currentPhase = p; };
    const setTaskTitle = (t: string) => { this.currentTaskTitle = t; };
    const getModelProps = () => this.client.getProps();

    this.taskRunner   = new TaskRunner(this.governor, runSubagentFn, writeEventFn, setPhase, setTaskTitle, getModelProps);
    this.slingerAgent = new SlingerAgent(this.governor, runSubagentFn, writeEventFn, setPhase, getModelProps);
    this.hopliteAgent = new HopliteAgent(this.governor, runSubagentFn, writeEventFn, setPhase, getModelProps);
    this.visionAgent  = new VisionAgent(this.governor, this.slingerAgent, this.taskRunner, runSubagentFn, writeEventFn, setPhase, getModelProps);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async executeHelots(
    taskSummary:        string,
    implementationPlan: string,
    onUpdate?:          (data: any) => void,
    frontierTasks?:     FrontierTask[],
  ): Promise<string> {
    this.sessionTotalTokens = 0;
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

  async executeSlinger(
    researchTask: string,
    targetFiles?: string[],
    onUpdate?:    (data: any) => void,
  ): Promise<string> {
    return this.slingerAgent.execute(researchTask, targetFiles, onUpdate);
  }

  async executeHoplite(
    file:        string,
    instruction: string,
    onUpdate?:   (data: any) => void,
  ): Promise<string> {
    return this.hopliteAgent.execute(file, instruction, onUpdate);
  }

  async executeScribe(
    researchTask: string,
    outputFile:   string,
    onUpdate?:    (data: any) => void,
    batchDir?:    string,
    batchSize:    number = 4,
  ): Promise<string> {
    // Phase 1: initial research → write base doc
    onUpdate?.({ text: `🔍 Scribe | researching...` });
    const research = await this.slingerAgent.execute(researchTask, undefined, onUpdate);
    onUpdate?.({ text: `✍️ Scribe | writing ${outputFile}...` });
    await this.hopliteAgent.execute(outputFile,
      `Based on this research, write a clean well-formatted markdown document:\n\n${research}`,
      onUpdate);

    if (!batchDir) return `✅ Scribe done → ${outputFile}`;

    // Phase 2: batch-summarize files in batchDir
    const files = this.listFilesRecursive(batchDir);
    const batches: string[][] = [];
    for (let i = 0; i < files.length; i += batchSize) batches.push(files.slice(i, i + batchSize));

    onUpdate?.({ text: `📚 Scribe | ${files.length} files → ${batches.length} batches` });

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      onUpdate?.({ text: `📖 Scribe | batch ${i + 1}/${batches.length}: ${batch.map(f => path.basename(f)).join(', ')}` });

      const summaries = await this.slingerAgent.execute(
        `Read each file and write a one-paragraph summary of what it does.\nFormat as: ### <filename>\n<summary>\n\nFiles:\n${batch.join('\n')}`,
        batch,
        onUpdate,
      );

      const appendInstruction = i === 0
        ? `Append a new "## Source File Summaries" section to the document with these entries:\n\n${summaries}`
        : `Append these entries to the "## Source File Summaries" section:\n\n${summaries}`;

      await this.hopliteAgent.execute(outputFile, appendInstruction, onUpdate);
    }

    return `✅ Scribe done → ${outputFile} (${files.length} files in ${batches.length} batches)`;
  }

  private listFilesRecursive(dir: string, exclude = ['node_modules', '.git', '__pycache__']): string[] {
    const results: string[] = [];
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (exclude.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...this.listFilesRecursive(full, exclude));
        else results.push(full);
      }
    } catch {}
    return results;
  }

  async executeVision(
    userIntent:         string,
    additionalContext?: string,
    onUpdate?:          (data: any) => void,
  ): Promise<string> {
    return this.visionAgent.executeVision(userIntent, additionalContext, onUpdate);
  }

  async executeApprovedTasks(
    approvalResponse: string,
    modifications?:   string,
    onUpdate?:        (data: any) => void,
  ): Promise<string> {
    return this.visionAgent.executeApprovedTasks(approvalResponse, modifications, onUpdate);
  }

  getStatus(): { phase: string; taskTitle: string; sessionTokens: number } {
    return {
      phase:         this.governor.getPhase(),
      taskTitle:     this.currentTaskTitle,
      sessionTokens: this.sessionTotalTokens,
    };
  }

  // ── Internal: shared LLM call + event writer ───────────────────────────────

  private writeEvent(event: Record<string, any>): void {
    try {
      const eventsFile = join(this.governor.config.stateDir, 'events.jsonl');
      appendFileSync(eventsFile, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
    } catch { }
  }

  private async runSubagent(
    role: string, name: string, systemPrompt: string, userPrompt: string,
    onUpdate: any, _metrics: any, profile: string, model: string,
    haltOn?: string[], maxTokensOverride?: number,
  ): Promise<string> {
    let fullResponse = '';
    const baseTokensPrior = this.sessionTotalTokens;
    let streamAborted = false;
    let lastCompleteLine = '';
    let repeatCount = 0;
    let finalMetrics = { genTps: 0, promptTokens: 0, genTokens: 0, maxTokens: 0 };

    const streamLogPath = join(this.governor.config.stateDir, 'stream.log');
    this.writeEvent({ type: 'phase_change', phase: this.currentPhase, name });
    try { appendFileSync(streamLogPath, `\n\n--- ${this.currentPhase} | ${name} ---\n`); } catch { }

    try {
      await this.client.streamCompletion(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        role as TaskRole, profile, maxTokensOverride,
        (chunk, m) => {
          if (streamAborted) return;
          fullResponse += chunk;

          if (chunk.includes('\n')) {
            try { appendFileSync(streamLogPath, chunk); } catch { }
          }

          if (haltOn && haltOn.some(stop => fullResponse.includes(stop))) {
            streamAborted = true; return;
          }

          if (chunk.includes('\n')) {
            const completedLine = chunk.split('\n').filter(l => l.trim().length > 15).pop()?.trim() || '';
            if (completedLine) {
              if (completedLine === lastCompleteLine) {
                if (++repeatCount > 8) { streamAborted = true; return; }
              } else { repeatCount = 0; lastCompleteLine = completedLine; }
            }
          }

          this.sessionTotalTokens = baseTokensPrior + (m.promptTokens + m.genTokens);
          finalMetrics = m;
        },
        () => {},
      );
    } catch (err: any) {
      onUpdate?.({ text: `⚠️ ${this.currentPhase} | ${name} | server error: ${err?.message ?? err}` });
    }

    if (!fullResponse && finalMetrics.genTokens === 0) {
      onUpdate?.({ text: `❌ ${this.currentPhase} | ${name} | empty response — server may be down` });
      throw new Error(`${name}: server returned empty response (0 tokens). Is the LLM server running?`);
    }

    const pressure    = finalMetrics.maxTokens ? Math.round((finalMetrics.promptTokens / finalMetrics.maxTokens) * 100) : 0;
    const pressureTag = pressure > 70 ? ` ⚠️ ctx:${pressure}%` : '';
    onUpdate?.({ text: `✅ ${this.currentPhase} | ${name} | ${finalMetrics.genTps.toFixed(1)}t/s | ${finalMetrics.genTokens} gen + ${finalMetrics.promptTokens} prompt tokens${pressureTag}` });
    this.writeEvent({ type: 'subagent_done', phase: this.currentPhase, role, name, tps: finalMetrics.genTps, genTokens: finalMetrics.genTokens, promptTokens: finalMetrics.promptTokens, ctxPct: pressure });

    return fullResponse;
  }
}
