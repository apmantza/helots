import { LlamaClient } from './llama-client.js';
import { HelotConfig, TaskRole } from '../config.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import * as path from 'path';
import { execSync } from 'child_process';

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
  private sessionTotalTokens: number = 0;
  private currentPhase: string = "Setup";
  private currentTaskTitle: string = "";

  constructor(config: HelotConfig) {
    this.governor = new Governor(config);
    this.scout = new Scout(config);
    this.builder = new Builder(config);
    this.peltast = new Peltast(config);
    this.client = new LlamaClient(config);
  }

  /**
   * ARISTOMENIS ORCHESTRATION (Execute Run)
   * Main orchestration loop using Aristomenis (Dense) to design task progress.md
   */
  async executeHelots(
    taskSummary: string,
    implementationPlan: string,
    onUpdate?: (data: any) => void
  ): Promise<string> {
    const runId = this.governor.getRunId();
    const { modelName } = await this.client.getProps();
    const psiloiMetrics = { scout: { in: 0, out: 0, tps: 0 }, builder: { in: 0, out: 0, tps: 0 }, peltast: { in: 0, out: 0, tps: 0 } };

    const contextFile = join(this.governor.config.stateDir, "context.json");
    const progressFile = join(this.governor.config.stateDir, "progress.md");
    const reviewFile = join(this.governor.config.stateDir, "review.md");
    const traceFile = join(this.governor.config.stateDir, "trace.json");

    const writeTrace = async (data: any) => {
      try {
        const existing = existsSync(traceFile) ? JSON.parse(readFileSync(traceFile, 'utf-8')) : {};
        writeFileSync(traceFile, JSON.stringify({ ...existing, ...data }, null, 2));
      } catch { }
    };

    const globalContext = await this.getGlobalContext();
    mkdirSync(this.governor.config.stateDir, { recursive: true });
    this.sessionTotalTokens = 0;

    onUpdate?.({ text: `🚀 Delegating to Aristomenis...` });
    this.currentPhase = "Scout";

    // --- 1. SCOUT PHASE (Local Scan) ---
    onUpdate?.({ text: `[Scout] Scanning workspace for Project Map...` });
    const fileList = this.getAllFiles(process.cwd());
    const manifest = {
      files: fileList.map(f => ({
        path: path.relative(process.cwd(), f),
        size: existsSync(f) ? readFileSync(f).length : 0
      }))
    };
    const manifestRaw = JSON.stringify(manifest, null, 2).slice(0, 32000); // Guard context window
    writeFileSync(contextFile, manifestRaw);
    await writeTrace({ phase: "scout", status: "complete", fileCount: fileList.length });

    // --- 2. ARISTOMENIS PHASE (Dense) ---
    const aristomenisSystem = `${globalContext}
You are Aristomenis, the Architect. DESIGN the technical implementation checklist.
Based on the Project Map and the Frontier Plan, create a granular checklist in \`progress.md\`.
EACH TASK SHOULD TARGET ONE FILE. 
Use DEPENDS: N or PARALLEL: N to mark task relationships.
Checklist format:
- [ ] 1. Task Description (Target: path/to/file.ts) [DEPENDS: none]
- [ ] 2. Next Task (Target: path/to/other.ts) [DEPENDS: 1]

If you NEED MORE DATA to make a plan, output only:
NEED MORE DATA: [specific research question or file path]

RESPOND ONLY WITH THE CHECKLIST OR DATA REQUEST.`;

    this.currentPhase = "Architect";
    this.currentTaskTitle = "Designing Implementation Checklist";
    onUpdate?.({ text: `[Aristomenis] Designing implementation strategy...` });
    let checklist = await this.runSubagent('Aristomenis', 'Aristomenis', aristomenisSystem, `Project Map: ${manifestRaw}\n\nFrontier Plan: ${implementationPlan}`, onUpdate, {}, 'THINKING_GENERAL', modelName);

    // AUTO-SLINGER TRIGGER
    if (checklist.includes("NEED MORE DATA:")) {
      const query = checklist.split("NEED MORE DATA:")[1].trim();
      onUpdate?.({ text: `🏹 Aristomenis requested data. Deploying Slinger...` });
      const slingerReport = await this.executeSlinger(query, undefined, onUpdate);
      checklist = await this.runSubagent('Aristomenis', 'Aristomenis', aristomenisSystem, `RE-PLANNING with Slinger Report:\n${slingerReport}\n\nProject Map: ${manifestRaw}\n\nFrontier Plan: ${implementationPlan}`, onUpdate, {}, 'THINKING_GENERAL', modelName);
    }

    onUpdate?.({ text: `📋 **Spartan Checklist Generated:**\n${checklist}` });

    if (implementationPlan.includes("[PLAN ONLY]")) {
      return `[PLAN ONLY] Mode: Checklist drafted. Review and call again without [PLAN ONLY] to execute.\n\n${checklist}`;
    }

    writeFileSync(progressFile, checklist);
    await writeTrace({ phase: "aristomenis", status: "complete" });

    // --- 3. BUILDER LOOP (MoE) ---
    let progressContent;
    try {
      progressContent = readFileSync(progressFile, "utf-8");
    } catch {
      return `❌ Aristomenis failed to create ${progressFile}. Pipeline aborted.`;
    }

    const tasks = checklist.split("\n").filter(l => l.includes("- [ ]"));
    writeFileSync(reviewFile, `# Aristomenis Review Report\nImplementation Plan: ${taskSummary}\n\n`);

    for (let index = 0; index < tasks.length; index++) {
      const checklistTask = tasks[index];
      this.currentTaskTitle = checklistTask.replace(/^- \[ \]\s*/, '').split('(')[0].trim();
      onUpdate?.({ text: `🛠️ Starting Task ${index + 1}/${tasks.length}: ${checklistTask}` });

      const fileMatch = checklistTask.match(/\(Target:\s*([^\)]+)\)/);
      const targetFile = fileMatch ? fileMatch[1].trim() : "unknown";

      // Smart Read
      let targetFileContent = "";
      if (targetFile !== "unknown") {
        try {
          targetFileContent = readFileSync(path.resolve(targetFile), "utf-8");
          onUpdate?.({ text: `📖 Smart Read: ${targetFile} loaded.` });
        } catch {
          onUpdate?.({ text: `⚠️ Smart Read failed for ${targetFile}. Proceeding with blind edit.` });
        }
      }

      let taskPassed = false;
      let lastPeltastFeedback = "";

      for (let tryCount = 1; tryCount <= 3; tryCount++) {
        const builderSystem = `${globalContext}
You are the Builder. IMPLEMENT the following task: ${checklistTask}
Existing file state: 
${targetFileContent || "(New File)"}

${lastPeltastFeedback ? `PREVIOUS FAILURE FEEDBACK:\n${lastPeltastFeedback}\n\nFix the issues and try again.` : ""}

Output the file content using Markdown blocks:
### [path/to/file.ts]
\`\`\`typescript
(code)
\`\`\``;

        const builder = this.pickName(runId, `Builder-${index}-${tryCount}`);
        this.currentPhase = `Builder (Task ${index + 1}/${tasks.length})`;
        onUpdate?.({ text: `[Builder] Designing changes for Task ${index + 1} (Try ${tryCount})...` });
        const builderOut = await this.runSubagent("Builder", builder.name, builderSystem, `Checklist: ${progressContent}\n\nImplementation Plan: ${implementationPlan}`, onUpdate, psiloiMetrics.builder, "THINKING_CODE", modelName);

        // Manual Parsing for Markdown blocks
        const fileRegex = /###\s*\[([^\]]+)\]\s*\n\s*```[a-z]*\n([\s\S]*?)\n```/gi;
        let match;
        while ((match = fileRegex.exec(builderOut)) !== null) {
          const filePath = match[1].trim();
          const content = match[2];
          const fullPath = path.resolve(filePath);
          mkdirSync(path.dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, content);
          onUpdate?.({ text: `💾 Written: ${filePath}` });
        }

        // --- 4. PELTAST PHASE (MoE+Thinking) ---
        const peltastSystem = `${globalContext}
You are the Peltast. Use THOROUGH REASONING to check if the Builder completed: ${checklistTask}.
Verify imports, logic, and formatting. Output: VERDICT: PASS if correct, else FAIL with reason.`;

        const peltast = this.pickName(runId, `Peltast-${index}-${tryCount}`);
        this.currentPhase = `Peltast Verification (Task ${index + 1}/${tasks.length})`;
        onUpdate?.({ text: `[Peltast] Verifying Task ${index + 1}...` });
        const peltastOut = await this.runSubagent("Peltast", peltast.name, peltastSystem,
          `Builder output:\n${builderOut}\n\nVerify this completed the task: ${checklistTask}`,
          onUpdate, psiloiMetrics.peltast, "THINKING_REASONING", modelName);

        appendFileSync(reviewFile, `\n## Task: ${checklistTask} (Try ${tryCount})\n${peltastOut}\n`);

        if (peltastOut.includes("VERDICT: PASS")) {
          taskPassed = true;
          break;
        } else {
          lastPeltastFeedback = peltastOut;
          onUpdate?.({ content: [{ type: "text", text: `⚠️ Peltast rejected task. Retrying...` }] });
        }
      }

      if (!taskPassed) {
        onUpdate?.({ content: [{ type: "text", text: `❌ Task failed after 3 attempts. TRIGGERING FAIL-FAST ROLLBACK...` }] });
        try {
          const { execSync } = require("node:child_process");
          execSync("git reset --hard HEAD~1", { cwd: process.cwd() });
          onUpdate?.({ content: [{ type: "text", text: `⏮️ Git rolled back to previous checkpoint.` }] });
        } catch { }
        return `Pipeline halted at Task ${index + 1}. Check ${reviewFile}.`;
      }

      progressContent = progressContent.replace(checklistTask, checklistTask.replace("- [ ]", "- [x]"));
      writeFileSync(progressFile, progressContent);

      // --- GIT COMMIT (Optional) ---
      try {
        const { execSync } = require("node:child_process");
        const cleanTask = checklistTask.replace("- [ ]", "").trim();
        execSync("git add .", { cwd: process.cwd() });

        let gitIdentity = "";
        try {
          execSync("git config user.name", { stdio: 'ignore', cwd: process.cwd() });
          execSync("git config user.email", { stdio: 'ignore', cwd: process.cwd() });
        } catch {
          gitIdentity = "-c user.name=\"Aristomenis\" -c user.email=\"aristomenis@helots.com\" ";
        }

        execSync(`git ${gitIdentity}commit -m "[Aristomenis] ${cleanTask}"`, { cwd: process.cwd() });
        onUpdate?.({ text: `📦 GIT: [Aristomenis] ${cleanTask} Commited` });
      } catch { }
    }

    onUpdate?.({ content: [{ type: "text", text: `✅ Execution complete! All items checked off.` }] });
    return this.governor.generateSweepReport();
  }

  /**
   * SLINGER RECONNAISSANCE
   * Performs deep reading/research to answer specific questions
   */
  async executeSlinger(researchTask: string, targetFiles: string[] | undefined, onUpdate?: (data: any) => void): Promise<string> {
    const runId = this.governor.getRunId();
    const { modelName } = await this.client.getProps();
    const slingerMetrics = { in: 0, out: 0, tps: 0 };
    const slingerPersona = this.pickName(runId, "Slinger");

    let fileContext = "";
    if (targetFiles && targetFiles.length > 0) {
      onUpdate?.({ content: [{ type: "text", text: `📖 Slinger reading ${targetFiles.length} files...` }] });
      for (const f of targetFiles) {
        try {
          const content = readFileSync(path.resolve(f), "utf-8");
          fileContext += `\n--- FILE: ${f} ---\n${content}\n`;
        } catch (e: any) {
          fileContext += `\n--- FILE: ${f} ---\n(Error reading file: ${e.message})\n`;
        }
      }
    }

    const slingerSystem = `${await this.getGlobalContext()}
You are the Slinger, a specialized reconnaissance subagent.
Your goal is to perform deep reading and research on the codebase to answer the Architect's specific questions.
Analyze the provided context and provide a concise, technical, and accurate summary or answer.
Avoid fluff. Focus on architectural patterns, logic flow, and specific implementation details.

${fileContext ? `FILE CONTENT TO ANALYZE:\n${fileContext}` : ""}`;

    onUpdate?.({ content: [{ type: "text", text: `🏹 Slinger ${slingerPersona.name} of ${slingerPersona.city} deployed (Run ID: ${runId})` }] });
    const result = await this.runSubagent("Slinger", slingerPersona.name, slingerSystem, researchTask, onUpdate, slingerMetrics, "THINKING_GENERAL", modelName);

    return `🏹 **Slinger Research Report** (by ${slingerPersona.name} of ${slingerPersona.city})\n\n${result}`;
  }

  private async runSubagent(role: string, name: string, systemPrompt: string, userPrompt: string, onUpdate: any, metrics: any, profile: string, model: string): Promise<string> {
    let fullResponse = "";
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    let updateBuffer = "";
    const baseTokensPrior = this.sessionTotalTokens;

    const verbMap: Record<string, string> = {
      'Aristomenis': 'planning',
      'Architect': 'planning',
      'Builder': 'building',
      'Slinger': 'exploring',
      'Peltast': 'testing',
      'Governor': 'reviewing'
    };
    const verb = verbMap[role] || 'tasking';
    const headerPrefix = `### 🛡️ Helot ${name} is ${verb}`;

    await this.client.streamCompletion(messages, role as TaskRole, profile, (chunk, m) => {
      fullResponse += chunk;
      updateBuffer += chunk;

      const currentRequestTokens = m.promptTokens + m.genTokens;
      this.sessionTotalTokens = baseTokensPrior + currentRequestTokens;

      const metricsInfo = `[${this.currentPhase}] | [Session: ${this.sessionTotalTokens.toLocaleString()} tokens] | [Gen: ${m.genTps.toFixed(1)} t/s]`;
      const currentHeader = `${headerPrefix}\n**${this.currentTaskTitle}**\n${metricsInfo}\n---\n`;

      // Buffer updates to avoid UI overwhelming, but ensure progress is visible
      if (updateBuffer.length > 20 || chunk.includes('\n')) {
        onUpdate?.({ text: `${currentHeader}${fullResponse}` });
        updateBuffer = "";
      }

      if (metrics) metrics.out += chunk.length;
    }, () => {
      // Final update for completeness
      const metricsInfo = `[${this.currentPhase}] | [Session: ${this.sessionTotalTokens.toLocaleString()} tokens]`;
      onUpdate?.({ text: `${headerPrefix}\n**${this.currentTaskTitle}**\n${metricsInfo}\n---\n${fullResponse}` });
    });
    return fullResponse;
  }

  private getAllFiles(dir: string, fileList: string[] = []): string[] {
    const files = readdirSync(dir);
    for (const file of files) {
      if (file === 'node_modules' || file === '.git' || file === '.helot-state') continue;
      const name = join(dir, file);
      if (statSync(name).isDirectory()) {
        this.getAllFiles(name, fileList);
      } else {
        fileList.push(name);
      }
    }
    return fileList;
  }

  private pickName(runId: string, role: string) {
    const cities = ["Sparta", "Messene", "Korinth", "Argos", "Thebes"];
    const names = ["Aristides", "Leonidas", "Brasidas", "Gylippus", "Lysander"];
    const city = cities[Math.floor(Math.random() * cities.length)];
    const name = names[Math.floor(Math.random() * names.length)];
    return { name, city };
  }

  private async getGlobalContext(): Promise<string> {
    return "You are a Helot subagent in the service of Sparta.";
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
