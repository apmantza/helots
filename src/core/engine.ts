import { LlamaClient } from './llama-client.js';
import { HelotConfig } from '../config.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * HELLOT PSILOI ARCHITECTURAL ANCHOR
 * Core Pattern: The Triad (Scout, Builder, Peltast)
 * Non-Negotiable: executeRun and runSubagent orchestration logic
 */

interface HelotTask {
  id: string;
  description: string;
  status: 'pending' | 'completed' | 'failed';
  file?: string;
  lineRange?: [number, number];
}

interface HelotState {
  runId: string;
  tasks: HelotTask[];
  currentTaskIndex: number;
  lastCheckpoint: string;
}

interface HelotContext {
  implementationPlan: string;
  fileMapping: Record<string, string>;
  progress: HelotState;
}

/**
 * GOVERNOR (formerly Ephor)
 * Performs final SWEEP REPORT to ensure strategic alignment
 */
class Governor {
  public state: HelotState;
  public config: HelotConfig;

  constructor(config: HelotConfig) {
    this.config = config;
    this.state = this.loadState();
  }

  private loadState(): HelotState {
    const statePath = join(this.config.stateDir, 'helot-state.json');
    if (existsSync(statePath)) {
      return JSON.parse(readFileSync(statePath, 'utf-8'));
    }
    return {
      runId: this.generateRunId(),
      tasks: [],
      currentTaskIndex: 0,
      lastCheckpoint: '',
    };
  }

  private generateRunId(): string {
    return `run-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  saveState(): void {
    const statePath = join(this.config.stateDir, 'helot-state.json');
    mkdirSync(this.config.stateDir, { recursive: true });
    writeFileSync(statePath, JSON.stringify(this.state, null, 2));
  }

  /**
   * SWEEP REPORT - Final strategic alignment verification
   */
  generateSweepReport(): string {
    const completed = this.state.tasks.filter(t => t.status === 'completed').length;
    const total = this.state.tasks.length;
    const failed = this.state.tasks.filter(t => t.status === 'failed').length;

    return `
=== GOVERNOR'S SWEEP REPORT ===
Run ID: ${this.state.runId}
Total Tasks: ${total}
Completed: ${completed}
Failed: ${failed}
Current Task Index: ${this.state.currentTaskIndex}
Last Checkpoint: ${this.state.lastCheckpoint}
Status: ${failed > 0 ? 'RECOVERY REQUIRED' : completed === total ? 'MISSION ACCOMPLISHED' : 'IN PROGRESS'}
================================
`;
  }

  getRunId(): string {
    return this.state.runId;
  }
}

/**
 * SCOUT - Technical Reconnaissance & File Mapping
 * Maps Gorgo's plan to file structure, generates context for Builder
 */
class Scout {
  private config: HelotConfig;

  constructor(config: HelotConfig) {
    this.config = config;
  }

  /**
   * Perform Technical Reconnaissance & File Mapping
   * Returns file structure and context for Builder
   */
  async performReconnaissance(implementationPlan: string): Promise<Record<string, string>> {
    const fileMapping: Record<string, string> = {};

    // Parse implementation plan for file references
    const fileRegex = /(?:file|target|path)\s*[:=]\s*["']?([^\s"'`]+)["']?/gi;
    let match;
    while ((match = fileRegex.exec(implementationPlan)) !== null) {
      const filePath = match[1];
      if (existsSync(filePath)) {
        fileMapping[filePath] = readFileSync(filePath, 'utf-8');
      }
    }

    return fileMapping;
  }

  /**
   * Generate context.md for Builder based on reconnaissance
   */
  generateContext(fileMapping: Record<string, string>): string {
    let context = '## FILE MAPPING CONTEXT\n\n';
    for (const [filePath, content] of Object.entries(fileMapping)) {
      context += `### ${filePath}\n\n\`\`\`\n${content.substring(0, 500)}${content.length > 500 ? '...' : ''}\n\`\`\`\n\n`;
    }
    return context;
  }
}

/**
 * BUILDER - Implementation Agent
 * Performs actual file writes/edits based on Scout's context
 */
class Builder {
  private config: HelotConfig;

  constructor(config: HelotConfig) {
    this.config = config;
  }

  /**
   * Execute file modifications based on implementation plan
   */
  async executeImplementation(
    implementationPlan: string,
    fileMapping: Record<string, string>
  ): Promise<string[]> {
    const modifications: string[] = [];

    // Parse implementation plan for modification directives
    const modifyRegex = /(?:modify|edit|update|create)\s*["']?([^\s"'`]+)["']?\s*[:=]\s*["']?([\s\S]*?)["']?/gi;
    let match;
    while ((match = modifyRegex.exec(implementationPlan)) !== null) {
      const filePath = match[1];
      const content = match[2];

      if (filePath && content) {
        const fullPath = join(this.config.projectRoot, filePath);
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, content);
        modifications.push(`Modified: ${filePath}`);
      }
    }

    return modifications;
  }
}

/**
 * PELTAST - Verification Agent
 * Validates Builder's work and triggers retries on failure
 */
class Peltast {
  private config: HelotConfig;

  constructor(config: HelotConfig) {
    this.config = config;
  }

  /**
   * Verify Builder's modifications
   */
  async verifyModifications(modifications: string[]): Promise<boolean> {
    for (const mod of modifications) {
      const [_, filePath] = mod.split(': ');
      if (!existsSync(filePath)) {
        console.error(`Verification failed: ${filePath} does not exist`);
        return false;
      }
    }
    return true;
  }

  /**
   * Trigger retry on verification failure
   */
  async triggerRetry(taskId: string): Promise<void> {
    console.log(`Peltast: Retrying task ${taskId}`);
    // Retry logic would be implemented here
  }
}

/**
 * HELLOT ENGINE - Orchestration Layer
 * Maintains the Triad orchestration loop (Scout, Builder, Envoy)
 */
export class HelotEngine {
  private governor: Governor;
  private scout: Scout;
  private builder: Builder;
  private peltast: Peltast;
  private client: LlamaClient;

  constructor(config: HelotConfig) {
    this.governor = new Governor(config);
    this.scout = new Scout(config);
    this.builder = new Builder(config);
    this.peltast = new Peltast(config);
    this.client = new LlamaClient(config);
  }

  /**
   * Execute Run - Main orchestration loop
   * Takes Gorgo's implementationPlan and executes through the Triad
   */
  async executeRun(
    implementationPlan: string,
    resumeId?: string
  ): Promise<string> {
    // Handle resume functionality
    if (resumeId) {
      this.governor.state = JSON.parse(
        readFileSync(join(this.governor.config.stateDir, 'helot-state.json'), 'utf-8')
      );
      console.log(`Resuming run: ${resumeId}`);
    }

    // Parse DIRECTIVES/TASKS section from implementation plan
    const taskRegex = /(?:## TASKS|## DIRECTIVES)\s*\n([\s\S]*?)(?:\n##|$)/i;
    const taskMatch = implementationPlan.match(taskRegex);
    const tasksSection = taskMatch ? taskMatch[1] : '';

    // Generate progress.md checklist from tasks section
    const progressPath = join(this.governor.config.stateDir, 'progress.md');
    const progressContent = this.generateProgressChecklist(tasksSection);
    writeFileSync(progressPath, progressContent);

    // Scout performs Technical Reconnaissance & File Mapping
    const fileMapping = await this.scout.performReconnaissance(implementationPlan);
    const context = this.scout.generateContext(fileMapping);

    // Builder executes implementation
    const modifications = await this.builder.executeImplementation(implementationPlan, fileMapping);

    // Peltast verifies modifications
    const verified = await this.peltast.verifyModifications(modifications);

    if (!verified) {
      await this.peltast.triggerRetry('main-orchestration');
    }

    // Update state
    this.governor.state.tasks.push({
      id: 'main-orchestration',
      description: 'Execute implementation plan',
      status: verified ? 'completed' : 'failed',
    });
    this.governor.state.lastCheckpoint = new Date().toISOString();
    this.governor.saveState();

    // Return Governor's SWEEP REPORT
    return this.governor.generateSweepReport();
  }

  /**
   * Generate progress.md checklist from tasks section
   */
  private generateProgressChecklist(tasksSection: string): string {
    let checklist = '# Progress Tracker\n\n';
    const taskLines = tasksSection.split('\n').filter(line => line.trim().startsWith('-'));

    taskLines.forEach((line, index) => {
      const taskId = `task-${index + 1}`;
      checklist += `- [ ] ${line.replace(/^- \[?\]?/i, '').trim()} (${taskId})\n`;
    });

    return checklist;
  }

  /**
   * Skip completed tasks on resume
   */
  skipCompletedTasks(): void {
    const completedTasks = this.governor.state.tasks.filter(t => t.status === 'completed');
    this.governor.state.currentTaskIndex = completedTasks.length;
  }
}
