import { LlamaClient } from './llama-client.js';
import { HelotConfig, TaskRole } from '../config.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import * as path from 'path';
import { getAllFiles } from './file-utils.js';
import { execSync } from 'child_process';
import { stripThinking } from './text-utils.js';


/**
 * HELLOT PSILOI ARCHITECTURAL ANCHOR
 * Core Pattern: The Triad (Scout, Builder, Peltast)
 * Non-Negotiable: executeRun and runSubagent orchestration logic
 */

interface HelotTask {
  id: string;
  description: string;
  status: 'pending' | 'completed' | 'failed' | 'blocked';
  file?: string;
  targetSymbol?: string;
  lineRange?: [number, number];
  dependsOn?: string[];
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
        fileMapping[filePath] = readFileSync(filePath, "utf-8");
      }
    }

    return fileMapping;
  }

  /**
   * PORTABLE BEHAVIORAL SLICER
   * Analyzes file structure without external AST dependencies.
   */
  public getSymbolSlice(filePath: string, symbolName: string): string {
    if (!existsSync(filePath)) return "";
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    // 1. Find the symbol definition
    let startLine = -1;
    let endLine = -1;
    let braceCount = 0;
    let foundStart = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!foundStart && (line.includes(`function ${symbolName}`) || line.includes(`${symbolName}(`) || line.includes(`class ${symbolName}`))) {
        startLine = i;
        foundStart = true;
      }

      if (foundStart) {
        braceCount += (line.match(/{/g) || []).length;
        braceCount -= (line.match(/}/g) || []).length;
        if (braceCount === 0 && line.includes("}")) {
          endLine = i;
          break;
        }
      }
    }

    if (startLine === -1) return lines.slice(0, 100).join("\n"); // Fallback to head

    // 2. Simple Dependency Extraction (Regex-based)
    const sliceLines = lines.slice(startLine, endLine + 1);
    const sliceContent = sliceLines.join("\n");

    // Find calls to other potential symbols in the same file
    const potentialCalls = Array.from(new Set(content.match(/[a-zA-Z0-9_]+(?=\()/g) || []));
    let extraContext = "";

    for (const call of potentialCalls) {
      if (call === symbolName) continue;
      if (sliceContent.includes(`${call}(`)) {
        // Greedy recursive slice (1 level deep)
        const depSlice = this.getRawSymbol(lines, call);
        if (depSlice) extraContext += `\n--- DEPENDENCY: ${call} ---\n${depSlice}\n`;
      }
    }

    return `--- TARGET SYMBOL: ${symbolName} ---\n${sliceContent}\n${extraContext}`;
  }

  private getRawSymbol(lines: string[], name: string): string | null {
    let start = -1;
    let found = false;
    let braces = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!found && (lines[i].includes(`function ${name}`) || lines[i].includes(`${name}(`) || lines[i].includes(`class ${name}`))) {
        start = i;
        found = true;
      }
      if (found) {
        braces += (lines[i].match(/{/g) || []).length;
        braces -= (lines[i].match(/}/g) || []).length;
        if (braces === 0 && lines[i].includes("}")) return lines.slice(start, i + 1).join("\n");
      }
    }
    return null;
  }

  /**
   * Generate context.md for Builder based on reconnaissance
   */
  generateContext(fileMapping: Record<string, string>): string {
    let context = "## FILE MAPPING CONTEXT\n\n";
    for (const [filePath, content] of Object.entries(fileMapping)) {
      context += `### ${filePath}\n\n\`\`\`\n${content.substring(0, 500)}${content.length > 500 ? "..." : ""}\n\`\`\`\n\n`;
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
    const traceFile = join(this.governor.config.stateDir, "trace.jsonl");

    // BUG FIX 3: use appendFileSync so each phase gets its own line, never overwrite
    const writeTrace = (data: any) => {
      try {
        appendFileSync(traceFile, JSON.stringify({ ts: new Date().toISOString(), ...data }) + "\n");
      } catch { }
    };

    const globalContext = await this.getGlobalContext();
    mkdirSync(this.governor.config.stateDir, { recursive: true });
    this.sessionTotalTokens = 0;

    onUpdate?.({ text: `🚀 Delegating to Aristomenis...` });
    const scoutPersona = this.pickName(runId, "Scout");
    this.currentPhase = "Scout";
    this.currentTaskTitle = "Mapping Workspace Territory";

    // --- 1. SCOUT PHASE (Local Scan) ---
    onUpdate?.({ text: `### 🛡️ Helot ${scoutPersona.name} is scouting\n**${this.currentTaskTitle}**\n[Scout] | [Session: 0 tokens]\n---\nScanning workspace for Project Map...` });
    const fileList = getAllFiles(process.cwd(), this.governor.config.stateDir);
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
You are Aristomenis, the Architect. DESIGN the technical implementation checklist with SPARTAN SIMPLICITY.
Based on the Project Map and the Frontier Plan, create a granular checklist in \`progress.md\`.

SPARTAN CODE PRINCIPLES:
1. MODULARITY: If a Target File exceeds 400 lines, split logic into sub-modules.
2. SURGICAL PRECISION: Each task targets ONE file and ONE symbol.
3. DEPENDENCY AWARENESS: Mark which tasks depend on others using [DEPENDS: N].

TASK FORMAT - use EXACTLY one of these two forms:

NEW FILE (does not exist yet, Scout will NOT read context):
- [ ] N. Create description (Target: src/path/new-file.ts, Action: CREATE) [DEPENDS: none]

EDIT EXISTING (modifies a specific symbol, Scout WILL slice that symbol):
- [ ] N. Edit description (Target: src/path/existing.ts, Symbol: methodName, Action: EDIT) [DEPENDS: M]

RULES:
- Action: CREATE = new file, Builder writes from scratch, no context needed.
- Action: EDIT = existing file, Scout slices ONE symbol for Builder context.
- Never combine CREATE and EDIT in one task.
- Every task must have exactly ONE Target file.

If you NEED MORE DATA:
NEED MORE DATA: [specific research question]

RESPOND ONLY WITH THE CHECKLIST OR DATA REQUEST.`;

    this.currentPhase = "Architect";
    this.currentTaskTitle = "Designing Implementation Checklist";
    onUpdate?.({ text: `[Aristomenis] Designing implementation strategy...` });
    // FIX 9: Use INSTRUCT_GENERAL (thinking disabled) — structured checklist output
    // doesn't benefit from extended reasoning chains; thinking mode wastes token budget
    let checklist = await this.runSubagent('Aristomenis', 'Aristomenis', aristomenisSystem, `Project Map: ${manifestRaw}\n\nFrontier Plan: ${implementationPlan}`, onUpdate, {}, 'THINKING_GENERAL', modelName);

    // AUTO-SLINGER TRIGGER
    if (checklist.includes("NEED MORE DATA:")) {
      const query = checklist.split("NEED MORE DATA:")[1].trim();
      onUpdate?.({ text: `🏹 Aristomenis requested data. Deploying Slinger...` });
      const slingerReport = await this.executeSlinger(query, undefined, onUpdate);
      checklist = await this.runSubagent('Aristomenis', 'Aristomenis', aristomenisSystem, `RE-PLANNING with Slinger Report:\n${slingerReport}\n\nProject Map: ${manifestRaw}\n\nFrontier Plan: ${implementationPlan}`, onUpdate, {}, 'THINKING_GENERAL', modelName);
    }

    // FIX 7: Strip thinking-chain preamble before using the checklist
    checklist = stripThinking(checklist);

    onUpdate?.({ text: `📋 **Spartan Checklist Generated:**\n${checklist}` });

    // BUG FIX 1: always write progress.md before early return so it's available in PLAN ONLY mode too
    writeFileSync(progressFile, checklist);

    if (implementationPlan.includes("[PLAN ONLY]")) {
      writeTrace({ phase: "aristomenis", status: "plan_only" });
      return `[PLAN ONLY] Mode: Checklist drafted at ${progressFile}. Review and call again without [PLAN ONLY] to execute.\n\n${checklist}`;
    }
    writeTrace({ phase: "aristomenis", status: "complete" });

    // HIE-1: Interactive Markdown Preview
    // FIX 8: Only render preview when running inside the Pi terminal (TERM_PROGRAM=pi)
    // spawnSync blocks the process if no interactive terminal is present (e.g. MCP stdio mode)
    if (process.env.TERM_PROGRAM === 'pi' || process.env.PI_TERMINAL === '1') {
      try {
        onUpdate?.({ text: `[Aristomenis] Rendering terminal preview for progress checklist...` });
        const { spawnSync } = require('child_process');
        spawnSync('pi', ['preview', '--terminal', progressFile], { stdio: 'inherit', shell: true });
      } catch (e: any) {
        onUpdate?.({ text: `[Aristomenis] ⚠️ Preview skipped: ${String(e.message).split('\n')[0]}` });
      }
    }

    // --- 3. SEQUENTIAL DEPENDENCY ORCHESTRATOR ---
    const taskNodes: HelotTask[] = checklist.split("\n")
      .filter(l => l.includes("- [ ]"))
      .map(line => {
        const idMatch = line.match(/^\- \[ \]\s*(\d+)\./);
        const fileMatch = line.match(/\(Target:\s*([^,\]\)]+)/);
        const symbolMatch = line.match(/Symbol:\s*([^,\]\)]+)/);
        const actionMatch = line.match(/Action:\s*(CREATE|EDIT)/i);
        const dependsMatch = line.match(/\[DEPENDS:\s*([^\]]+)\]/);
        const isCreate = actionMatch?.[1]?.toUpperCase() === 'CREATE';

        return {
          id: idMatch ? idMatch[1] : Math.random().toString(36).substr(2, 5),
          description: line.split("(")[0].replace(/^- \[ \]\s*\d+\.\s*/, "").trim(),
          status: 'pending' as const,
          file: fileMatch ? fileMatch[1].trim() : undefined,
          // For CREATE tasks, skip Scout slicing — no existing symbol to read
          targetSymbol: (!isCreate && symbolMatch) ? symbolMatch[1].trim() : undefined,
          dependsOn: dependsMatch ? dependsMatch[1].split(",").map(d => d.trim()).filter(d => d !== "none") : []
        };
      });

    writeFileSync(reviewFile, `# Aristomenis Review Report\nImplementation Plan: ${taskSummary}\n\n`);

    for (let i = 0; i < taskNodes.length; i++) {
      const task = taskNodes[i];

      // Dependency Check
      const blockers = task.dependsOn?.filter(depId => {
        const depTask = taskNodes.find(t => t.id === depId);
        return depTask && depTask.status !== 'completed';
      });

      if (blockers && blockers.length > 0) {
        onUpdate?.({ text: `🚫 Task ${task.id} is BLOCKED by: ${blockers.join(", ")}` });
        task.status = 'blocked';
        continue;
      }

      this.currentTaskTitle = task.description;
      onUpdate?.({ text: `🛠️ Starting Task ${task.id}/${taskNodes.length}: ${task.description}` });

      // --- 🏹 SCOUT SLICING ---
      let contextContent = "";
      if (task.file && task.targetSymbol) {
        onUpdate?.({ text: `🏹 Scout slicing symbol: ${task.targetSymbol} from ${task.file}...` });
        contextContent = this.scout.getSymbolSlice(path.resolve(task.file), task.targetSymbol);
      } else if (task.file) {
        try {
          contextContent = readFileSync(path.resolve(task.file), "utf-8");
          onUpdate?.({ text: `📖 Smart Read: ${task.file} loaded (Full File).` });
        } catch {
          onUpdate?.({ text: `⚠️ Smart Read failed for ${task.file}.` });
        }
      }

      let taskPassed = false;
      let lastPeltastFeedback = "";
      // Hoist stash state outside tryCount loop so rollback block can access it
      const { execSync } = require("node:child_process");
      let stashCreated = false;
      const backupDir = path.join(this.governor.config.stateDir, `backup-task-${task.id}`);

      for (let tryCount = 1; tryCount <= 3; tryCount++) {
        const builderSystem = `${globalContext}
You are the Builder. IMPLEMENT the following task with LACONIC SIMPLICITY: ${task.description}
${task.file ? `Target File: ${task.file}` : ""}

SPARTAN BUILDER GUIDELINES:
1. LACONISM: Use the minimum code required. 
2. BEHAVIORAL CONTEXT: You have been provided a surgical "Slice" or full file context below. Use it to ensure your edits are precise.
3. CONTEXT GUARD: If you detect >70% pressure, STOP and request Slinger verification.

${contextContent ? `CONTEXT (Behavioral Slice):\n${contextContent}` : ""}

${lastPeltastFeedback ? `PREVIOUS FAILURE FEEDBACK:\n${lastPeltastFeedback}\n\nFix the issues and try again.` : ""}

Output the file content using Markdown blocks:
### [path/to/file.ts]
\`\`\`typescript
(code)
\`\`\``;

        const builder = this.pickName(runId, `Builder-${task.id}-${tryCount}`);
        this.currentPhase = `Builder (Task ${task.id})`;
        onUpdate?.({ text: `[Builder] Designing changes for Task ${task.id} (Try ${tryCount})...` });
        const builderOut = await this.runSubagent("Builder", builder.name, builderSystem, `Mission ID: ${runId}\nTask: ${task.description}`, onUpdate, psiloiMetrics.builder, "THINKING_CODE", modelName);

        // ── GUARDRAIL: pre-parse Builder output, backup existing files before any write ──
        // git stash is unreliable on clean working trees (exits code 1 = nothing to stash).
        // Instead: copy each file the Builder intends to write to backupDir BEFORE writing.
        // Track new files (didn't exist before) so we can delete them on rollback.
        mkdirSync(backupDir, { recursive: true });

        // Pre-scan all file paths from Builder output without writing yet
        const fileRegex = /###\s*\[([^\]]+)\]\s*\n\s*```[a-z]*\n([\s\S]*?)\n```/gi;
        const filesToWrite: Array<{ filePath: string; fullPath: string; content: string }> = [];
        const newFiles: string[] = [];   // files that didn't exist before (for rollback deletion)
        let match;
        while ((match = fileRegex.exec(builderOut)) !== null) {
          const filePath = match[1].trim();
          const fullPath = path.resolve(filePath);
          const content = match[2];
          filesToWrite.push({ filePath, fullPath, content });
          if (existsSync(fullPath)) {
            // Backup existing file keyed by sanitised relative path
            const safeKey = filePath.replace(/[/\\]/g, '__');
            try { writeFileSync(path.join(backupDir, safeKey), readFileSync(fullPath)); } catch { }
          } else {
            newFiles.push(fullPath);
          }
        }

        // Now write all files
        for (const { filePath, fullPath, content } of filesToWrite) {
          mkdirSync(path.dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, content);
          onUpdate?.({ text: `💾 Written: ${filePath}` });
        }

        // ── PELTAST PHASE ────────────────────────────────────────
        const peltastSystem = `${globalContext}
You are the Peltast. Use THOROUGH REASONING to check if the Builder completed: ${task.description}
Verify logic, signatures, and Spartan Simplicity.

Output VERDICT: PASS or FAIL with reason.`;

        const peltast = this.pickName(runId, `Peltast-${task.id}-${tryCount}`);
        this.currentPhase = `Peltast Verification (Task ${task.id})`;
        onUpdate?.({ text: `[Peltast] Verifying Task ${task.id}...` });
        const peltastOut = await this.runSubagent("Peltast", peltast.name, peltastSystem,
          `Builder output:\n${builderOut}\n\nVerify this completed the task: ${task.description}`,
          onUpdate, psiloiMetrics.peltast, "THINKING_REASONING", modelName);

        appendFileSync(reviewFile, `\n## Task: ${task.description} (Try ${tryCount})\n${peltastOut}\n`);

        if (peltastOut.includes("VERDICT: PASS")) {
          // PASS: keep written files, clean up backups, then commit
          try {
            const safeKeys = readdirSync(backupDir);
            for (const k of safeKeys) { try { require('fs').unlinkSync(path.join(backupDir, k)); } catch { } }
            require('fs').rmdirSync(backupDir);
          } catch { }
          taskPassed = true;
          task.status = 'completed';
          break;
        } else {
          // FAIL: restore all backed-up files from backupDir, delete newly created files
          onUpdate?.({ text: `⚠️ Peltast rejected task ${task.id} (Try ${tryCount}). Restoring files and retrying...` });
          try {
            for (const { filePath, fullPath } of filesToWrite) {
              const safeKey = filePath.replace(/[/\\]/g, '__');
              const backupPath = path.join(backupDir, safeKey);
              if (existsSync(backupPath)) {
                writeFileSync(fullPath, readFileSync(backupPath));
                onUpdate?.({ text: `⏮️ Restored: ${filePath}` });
              }
            }
            // Delete files that were newly created (didn't exist before)
            for (const f of newFiles) {
              try { require('fs').unlinkSync(f); } catch { }
            }
          } catch { }
          lastPeltastFeedback = peltastOut;
        }
      }

      if (!taskPassed) {
        task.status = 'failed';
        onUpdate?.({ text: `❌ Task ${task.id} failed after 3 attempts. All file changes reverted.` });
        return `Pipeline halted at Task ${task.id}. Dependents blocked.`;
      }

      // ── GIT COMMIT ───────────────────────────────────────────
      try {
        execSync("git add .", { cwd: process.cwd() });
        let gitIdentity = "";
        try {
          execSync("git config user.name", { stdio: 'ignore', cwd: process.cwd() });
        } catch {
          gitIdentity = "-c user.name=\"Aristomenis\" -c user.email=\"aristomenis@helots.com\" ";
        }
        execSync(`git ${gitIdentity}commit -m "[Aristomenis] Task ${task.id}: ${task.description}"`, { cwd: process.cwd() });
        onUpdate?.({ text: `📦 GIT: Task ${task.id} committed` });
      } catch { }
    }

    // BUG FIX 2 (cont): normalize onUpdate shape
    onUpdate?.({ text: `✅ Execution complete! All tasks processed.` });
    return this.governor.generateSweepReport();
  }

  /**
   * SLINGER RECONNAISSANCE
   * Upgraded based on pi-finder-subagent: 
   * Strict turn budgets, read-only sandboxing, and Evidence/Locations reporting.
   */
  async executeSlinger(researchTask: string, targetFiles: string[] | undefined, onUpdate?: (data: any) => void): Promise<string> {
    const runId = this.governor.getRunId();
    const { modelName } = await this.client.getProps();
    const slingerMetrics = { in: 0, out: 0, tps: 0 };
    const slingerPersona = this.pickName(runId, "Slinger");

    let slingerHistory = "";
    if (targetFiles && targetFiles.length > 0) {
      onUpdate?.({ text: `📖 Slinger reading ${targetFiles.length} files...` });
      for (const f of targetFiles) {
        try {
          const content = readFileSync(path.resolve(f), "utf-8");
          slingerHistory += `\n--- FILE: ${f} ---\n${content}\n`;
        } catch (e: any) {
          slingerHistory += `\n--- FILE: ${f} ---\n(Error reading file: ${e.message})\n`;
        }
      }
    }

    const isWindows = process.platform === 'win32';
    const osSkillBoard = isWindows
      ? `\n[WINDOWS POWERSHELL SKILL ACTIVE]
- Use 'Select-String -Path "src/core/*.ts" -Pattern "SymbolName"' for deep searching.
- Use 'Get-ChildItem -Recurse -Filter "*.ts" src/core/' to find files.
- Use 'cat' or 'Get-Content' to read files.
- Use 'ls' as a native alias for directory listing.`
      : `\n[UNIX BASH SKILL ACTIVE]
- Use 'rg "Pattern" src/' for fast searching.
- Use 'find src/ -name "*.ts"' to locate files.
- Use 'cat' or 'ls' for file operations.`;

    const slingerSystem = `${await this.getGlobalContext()}
You are the Slinger, a specialized Reconnaissance Subagent (inspired by pi-finder).
Your absolute goal is to search the codebase and find structural evidence to answer the Architect's query.

${osSkillBoard}

You operate in a strict read-only tool sandbox. You have a budget of up to 5 turns.
To execute a read command, reply EXCLUSIVELY with the following block:
### COMMAND
[your command here]
### END_COMMAND

Supported tools: rg, cat, ls, find, Select-String, Get-ChildItem, Get-Content. 
DO NOT write code or mutate files. Do not use markdown tags like \`\`\`bash around the command inside the block.
The environment will reply with the output of your command.

When you have found the answer, or if you run out of turns, you MUST output your final report EXACTLY in this format:
### SUMMARY
[Concise answer to the Architect's query]

### LOCATIONS
[Exact file paths and line numbers where the relevant code lives]

### EVIDENCE
[Raw code snippets proving your architecture summary]`;

    onUpdate?.({ content: [{ type: "text", text: `🏹 Slinger ${slingerPersona.name} of ${slingerPersona.city} deployed (Run ID: ${runId})` }] });

    let finalReport = "";
    const MAX_TURNS = 5;

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      onUpdate?.({ text: `⏳ Slinger Turn ${turn}/${MAX_TURNS}...` });

      const userPrompt = `Research Query: ${researchTask}\n\nSearch History / File Content:\n${slingerHistory || "(No history yet. Execute a COMMAND to begin searching.)"}`;
      // HALT SIGNAL: Break stream if Slinger outputs ### END_COMMAND to prevent hallucination
      const result = await this.runSubagent("Slinger", slingerPersona.name, slingerSystem, userPrompt, onUpdate, slingerMetrics, "INSTRUCT_GENERAL", modelName, ["### END_COMMAND"]);

      // Check if Slinger executed a command
      const cmdMatch = result.match(/### COMMAND\n([\s\S]*)\n### END_COMMAND/);
      if (cmdMatch) {
        const command = cmdMatch[1].trim();
        onUpdate?.({ text: `💲 [Slinger Executing]: ${command.slice(0, 60)}...` });

        let cmdOutput = "";
        try {
          // STRICT SANDBOXING: Enforce read-only commands
          const allowedPattern = /^(rg|cat|ls|find|Select-String|Get-ChildItem|Get-Content|type)\b/i;
          if (!allowedPattern.test(command)) {
            cmdOutput = "ERROR: Command rejected by Sandbox. Only read-only reconnaissance tools are permitted.";
          } else {
            // Execute safely
            const shell = process.platform === 'win32' ? 'powershell.exe' : undefined;
            cmdOutput = execSync(command, { cwd: process.cwd(), stdio: 'pipe', shell }).toString();
            if (cmdOutput.length > 3000) {
              cmdOutput = cmdOutput.slice(0, 3000) + "\n...[TRUNCATED BY SANDBOX: output too large (run tighter rg filters)]...";
            }
          }
        } catch (e: any) {
          cmdOutput = `Command Failed: ${e.message}\n${e.stdout?.toString() || ""}`;
        }

        slingerHistory += `\n[Turn ${turn}] Executed: ${command}\nOutput:\n${cmdOutput}\n`;
      } else if (result.includes("### SUMMARY")) {
        // Slinger reached a conclusion
        finalReport = result;
        break;
      } else {
        // Did not comply with strict formatting, but stopped issuing commands
        finalReport = result;
        break;
      }

      if (turn === MAX_TURNS) {
        finalReport = result + "\n\n[WARNING: Slinger exhausted all 5 turns and was forced to halt.]";
      }
    }

    return `🏹 **Slinger Pi-Finder Report** (by ${slingerPersona.name} of ${slingerPersona.city})\n\n${finalReport}`;
  }

  private async runSubagent(role: string, name: string, systemPrompt: string, userPrompt: string, onUpdate: any, metrics: any, profile: string, model: string, haltOn?: string[]): Promise<string> {
    let fullResponse = "";
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    let updateBuffer = "";
    const baseTokensPrior = this.sessionTotalTokens;

    // BUG FIX 6: Repetition loop guard — track complete repeated lines only
    // We only check lines that arrive complete (chunk contains '\n') to avoid false positives from partials
    let lastCompleteLine = "";
    let repeatCount = 0;
    const MAX_REPEATS = 8;       // abort if same complete line repeats this many times
    // NOTE: per-call token cap intentionally removed — let profile max_tokens govern this
    let streamAborted = false;

    const verbMap: Record<string, string> = {
      'Aristomenis': 'planning',
      'Architect': 'planning',
      'Builder': 'building',
      'Slinger': 'exploring',
      'Peltast': 'testing',
      'Scout': 'scouting',
      'Governor': 'reviewing'
    };
    const verb = verbMap[role] || 'tasking';
    const headerPrefix = `### 🛡️ Helot ${name} is ${verb}`;

    try {
      await this.client.streamCompletion(messages, role as TaskRole, profile, (chunk, m) => {
        if (streamAborted) return;

        fullResponse += chunk;
        updateBuffer += chunk;

        // Repetition detection — only check on chunks that contain a newline (complete lines)
        if (chunk.includes('\n') && !streamAborted) {
          const lines = chunk.split('\n');
          const completedLine = lines[lines.length - 2]?.trim() ?? "";

          // HALT LOGIC: Interrupt stream if model outputs a stop trigger
          if (haltOn && haltOn.some(stop => fullResponse.includes(stop))) {
            streamAborted = true;
            return;
          }

          if (completedLine.length > 15 && completedLine === lastCompleteLine) {
            repeatCount++;
            if (repeatCount >= MAX_REPEATS) {
              streamAborted = true;
              onUpdate?.({ text: `⚠️ [${role}] Repetition loop detected ("${completedLine.slice(0, 40)}...") — truncating.` });
              return;
            }
          } else if (completedLine.length > 15) {
            repeatCount = 0;
            lastCompleteLine = completedLine;
          }
        }

        // Hard token cap removed — profile max_tokens governs output length

        const currentRequestTokens = m.promptTokens + m.genTokens;
        this.sessionTotalTokens = baseTokensPrior + currentRequestTokens;

        const { maxTokens } = m as any;
        const pressure = maxTokens ? Math.round((m.promptTokens / maxTokens) * 100) : 0;
        const pressureWarning = pressure > 70 ? ` | ⚠️ [CONTEXT PRESSURE: ${pressure}%]` : "";

        // STATUS BAR + CONTENT SEPARATOR PROTOCOL
        // mcp-server.ts renderUpdate() splits on "\n---\n":
        //   text before separator = status bar (updated in-place)
        //   text after separator  = content delta (streamed below)
        if (updateBuffer.length > 20 || chunk.includes('\n')) {
          const statusBar = `🛡️ ${name} [${this.currentPhase}] ${m.genTps.toFixed(1)}t/s | ${m.genTokens}tok${pressureWarning}`;
          onUpdate?.({ text: `${statusBar}\n---\n${updateBuffer}` });
          updateBuffer = "";
        }

        if (metrics) metrics.out += chunk.length;
      }, () => {
        const metricsInfo = `[${this.currentPhase}] | [Session: ${this.sessionTotalTokens.toLocaleString()} tokens]`;
        onUpdate?.({ text: `${headerPrefix}\n**${this.currentTaskTitle}**\n${metricsInfo}\n---\n${fullResponse}` });
      });
    } catch (e: any) {
      // Stream errors are logged but don't crash — return what we have
      onUpdate?.({ text: `⚠️ [${role}] Stream error: ${e.message}` });
    }

    return fullResponse;
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
