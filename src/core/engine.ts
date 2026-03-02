import { LlamaClient } from './llama-client.js';
import { HelotConfig, TaskRole } from '../config.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, copyFileSync } from 'fs';
import { join, resolve, dirname, relative, basename } from 'path';
import * as path from 'path';
import { getAllFiles } from './file-utils.js';
import { execSync } from 'child_process';
import { stripThinking } from './text-utils.js';
import { Governor } from './governor.js';
import { Scout } from './scout.js';
import { Builder } from './builder-orchestrator.js';
import { Peltast } from './peltast-orchestrator.js';
import { pickName, getGlobalContext } from './persona-utils.js';

/**
 * HELLOT ENGINE - Orchestration Layer
 * Maintains the Triad orchestration loop (Scout, Builder, Peltast)
 * Features Surgical Slicing, Sequential Dependencies, and Technical Backups
 */
export interface HelotTask {
  id: string;
  description: string;
  status: 'pending' | 'completed' | 'failed' | 'blocked';
  file?: string;
  targetSymbol?: string;
  lineRange?: [number, number];
  dependsOn?: string[];
}

export interface HelotState {
  runId: string;
  tasks: HelotTask[];
  currentTaskIndex: number;
  lastCheckpoint: string;
}

export interface HelotContext {
  implementationPlan: string;
  fileMapping: Record<string, string>;
  progress: HelotState;
}

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

    const writeTrace = (data: any) => {
      try {
        appendFileSync(traceFile, JSON.stringify({ ts: new Date().toISOString(), ...data }) + "\n");
      } catch { }
    };

    const globalContext = await getGlobalContext();
    mkdirSync(this.governor.config.stateDir, { recursive: true });
    this.sessionTotalTokens = 0;

    onUpdate?.({ text: `🚀 Delegating to Aristomenis...` });
    const scoutPersona = pickName(runId, "Scout");
    this.currentPhase = "Scout";
    this.currentTaskTitle = "Mapping Workspace Territory";

    // --- 1. SCOUT PHASE (Local Scan) ---
    onUpdate?.({ text: `### 🛡️ Helot ${scoutPersona.name} is scouting\n**${this.currentTaskTitle}**\n[Scout] | [Session: 0 tokens]\n---\nScanning workspace for Project Map...` });
    const fileList = getAllFiles(process.cwd(), this.governor.config.stateDir);
    const manifest = {
      files: fileList.map(f => ({
        path: relative(process.cwd(), f),
        size: existsSync(f) ? readFileSync(f).length : 0
      }))
    };
    const manifestRaw = JSON.stringify(manifest, null, 2).slice(0, 32000);
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

NEW FILE:
- [ ] N. Create description (Target: src/path/new-file.ts, Action: CREATE) [DEPENDS: none]

EDIT EXISTING:
- [ ] N. Edit description (Target: src/path/existing.ts, Symbol: methodName, Action: EDIT) [DEPENDS: M]

RESPOND ONLY WITH THE CHECKLIST OR DATA REQUEST.`;

    this.currentPhase = "Architect";
    this.currentTaskTitle = "Designing Implementation Checklist";
    onUpdate?.({ text: `[Aristomenis] Designing implementation strategy...` });

    let checklist = await this.runSubagent('Aristomenis', 'Aristomenis', aristomenisSystem, `Project Map: ${manifestRaw}\n\nFrontier Plan: ${implementationPlan}`, onUpdate, {}, 'THINKING_GENERAL', modelName);

    if (checklist.includes("NEED MORE DATA:")) {
      const query = checklist.split("NEED MORE DATA:")[1].trim();
      onUpdate?.({ text: `🏹 Aristomenis requested data. Deploying Slinger...` });
      const slingerReport = await this.executeSlinger(query, undefined, onUpdate);
      checklist = await this.runSubagent('Aristomenis', 'Aristomenis', aristomenisSystem, `RE-PLANNING with Slinger Report:\n${slingerReport}\n\nProject Map: ${manifestRaw}\n\nFrontier Plan: ${implementationPlan}`, onUpdate, {}, 'THINKING_GENERAL', modelName);
    }

    checklist = stripThinking(checklist);
    onUpdate?.({ text: `📋 **Spartan Checklist Generated:**\n${checklist}` });
    writeFileSync(progressFile, checklist);

    if (implementationPlan.includes("[PLAN ONLY]")) {
      writeTrace({ phase: "aristomenis", status: "plan_only" });
      return `[PLAN ONLY] Mode: Checklist drafted. review and call without [PLAN ONLY] to execute.\n\n${checklist}`;
    }
    writeTrace({ phase: "aristomenis", status: "complete" });

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
          targetSymbol: (!isCreate && symbolMatch) ? symbolMatch[1].trim() : undefined,
          dependsOn: dependsMatch ? dependsMatch[1].split(",").map(d => d.trim()).filter(d => d !== "none") : []
        };
      });

    writeFileSync(reviewFile, `# Aristomenis Review Report\nImplementation Plan: ${taskSummary}\n\n`);

    for (let i = 0; i < taskNodes.length; i++) {
      const task = taskNodes[i];
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
        contextContent = this.scout.getSymbolSlice(resolve(task.file), task.targetSymbol);
      } else if (task.file && existsSync(resolve(task.file))) {
        contextContent = readFileSync(resolve(task.file), "utf-8");
      }

      let taskPassed = false;
      let lastPeltastFeedback = "";

      for (let tryCount = 1; tryCount <= 3; tryCount++) {
        const builderSystem = `${globalContext}
You are the Builder. IMPLEMENT the following task with LACONIC SIMPLICITY: ${task.description}
${task.file ? `Target File: ${task.file}` : ""}

SPARTAN BUILDER GUIDELINES:
1. LACONISM: Use the minimum code required. 
2. BEHAVIORAL CONTEXT: Use the surgical "Slice" provided below.
3. CONTEXT GUARD: If pressure > 70%, STOP and request Slinger verification.

${contextContent ? `CONTEXT (Behavioral Slice):\n${contextContent}` : ""}

Output the file content using Markdown blocks:
### [path/to/file.ts]
\`\`\`typescript
(code)
\`\`\``;

        const builder = pickName(runId, `Builder-${task.id}-${tryCount}`);
        this.currentPhase = `Builder (Task ${task.id})`;
        const builderOut = await this.runSubagent("Builder", builder.name, builderSystem, `Mission ID: ${runId}\nTask: ${task.description}`, onUpdate, psiloiMetrics.builder, "THINKING_CODE", modelName);

        // --- HARDENED PERSISTENT BACKUP & WRITE ---
        const fileRegex = /###\s*\[([^\]]+)\]\s*\n\s*```[a-z]*\n([\s\S]*?)\n```/gi;
        const filesToProcess: Array<{ filePath: string; fullPath: string; content: string }> = [];
        let match;
        while ((match = fileRegex.exec(builderOut)) !== null) {
          filesToProcess.push({ filePath: match[1].trim(), fullPath: resolve(match[1].trim()), content: match[2] });
        }

        // 1. Create persistent backups
        const backupBaseDir = join(process.cwd(), '.helots', 'backups', runId, task.id);
        mkdirSync(backupBaseDir, { recursive: true });

        for (const { filePath, fullPath } of filesToProcess) {
          if (existsSync(fullPath)) {
            const backupPath = join(backupBaseDir, filePath.replace(/[/\\]/g, '__') + '.bak');
            copyFileSync(fullPath, backupPath);
            onUpdate?.({ text: `📑 Created persistent backup: .helots/backups/.../${basename(backupPath)}` });
          }
        }

        // 2. Perform surgical write
        for (const { fullPath, content } of filesToProcess) {
          mkdirSync(dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, content);
        }

        // ── PELTAST VERIFICATION (ACTUAL CODE ACCESS) ──
        const peltastSystem = `${globalContext}
You are the Peltast. Use THOROUGH REASONING to check if the Builder completed: ${task.description}
Verification logic: Inspect the ACTUAL code written to disk below.

ACTUAL CODE WRITTEN:
${filesToProcess.map(f => `FILE: ${f.filePath}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")}

Output VERDICT: PASS or FAIL with reason.`;

        const peltast = pickName(runId, `Peltast-${task.id}-${tryCount}`);
        this.currentPhase = `Peltast Verification (Task ${task.id})`;
        const peltastOut = await this.runSubagent("Peltast", peltast.name, peltastSystem, `Verify task completion: ${task.description}`, onUpdate, psiloiMetrics.peltast, "THINKING_REASONING", modelName);

        appendFileSync(reviewFile, `\n## Task: ${task.description} (Try ${tryCount})\n${peltastOut}\n`);

        if (peltastOut.includes("VERDICT: PASS")) {
          taskPassed = true;
          task.status = 'completed';
          break;
        } else {
          onUpdate?.({ text: `⚠️ Peltast rejected task ${task.id}. Restoring from backups...` });
          for (const { filePath, fullPath } of filesToProcess) {
            const backupPath = join(backupBaseDir, filePath.replace(/[/\\]/g, '__') + '.bak');
            if (existsSync(backupPath)) {
              copyFileSync(backupPath, fullPath);
            }
          }
          lastPeltastFeedback = peltastOut;
        }
      }

      if (taskPassed) {
        try {
          execSync(`git add . && git commit -m "[Aristomenis] Task ${task.id}: ${task.description}"`, { cwd: process.cwd(), stdio: 'ignore' });
        } catch { }
      } else {
        return `Pipeline halted at Task ${task.id}.`;
      }
    }

    onUpdate?.({ text: `✅ Execution complete! All tasks processed.` });
    return this.governor.generateSweepReport();
  }

  async executeSlinger(researchTask: string, targetFiles: string[] | undefined, onUpdate?: (data: any) => void): Promise<string> {
    const runId = this.governor.getRunId();
    const { modelName } = await this.client.getProps();
    const slingerPersona = pickName(runId, "Slinger");
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'powershell.exe' : undefined;

    const slingerSystem = `${await getGlobalContext()}
You are the Slinger, a specialized Reconnaissance Subagent. Search the codebase for structural evidence.
${isWindows ? "[POWERSHELL SKILL ACTIVE] Use Select-String, Get-ChildItem, cat." : "[BASH SKILL ACTIVE] Use rg, find, cat."}

Supported tools: rg, cat, ls, find, Select-String, Get-ChildItem, Get-Content. 
Output exclusively:
### COMMAND
[command]
### END_COMMAND

On completion, output ### SUMMARY, ### LOCATIONS, and ### EVIDENCE.`;

    onUpdate?.({ text: `🏹 Slinger ${slingerPersona.name} deployed.` });
    let history = "";

    for (let turn = 1; turn <= 5; turn++) {
      const result = await this.runSubagent("Slinger", slingerPersona.name, slingerSystem, `Research: ${researchTask}\nHistory:\n${history}`, onUpdate, {}, "INSTRUCT_GENERAL", modelName, ["### END_COMMAND"]);
      const cmdMatch = result.match(/### COMMAND\n([\s\S]*)\n### END_COMMAND/);

      if (cmdMatch) {
        const command = cmdMatch[1].trim();
        try {
          const out = execSync(command, { cwd: process.cwd(), stdio: 'pipe', shell }).toString().slice(0, 3000);
          history += `\n[Turn ${turn}] Command: ${command}\nOutput:\n${out}\n`;
        } catch (e: any) {
          history += `\n[Turn ${turn}] Command Failed: ${e.message}\n`;
        }
      } else if (result.includes("### SUMMARY")) {
        return result;
      }
    }
    return `Slinger exhausted turns.\n${history}`;
  }

  private async runSubagent(role: string, name: string, systemPrompt: string, userPrompt: string, onUpdate: any, metrics: any, profile: string, model: string, haltOn?: string[]): Promise<string> {
    let fullResponse = "";
    let updateBuffer = "";
    const baseTokensPrior = this.sessionTotalTokens;
    let streamAborted = false;
    let lastCompleteLine = "";
    let repeatCount = 0;

    try {
      await this.client.streamCompletion([{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], role as TaskRole, profile, (chunk, m) => {
        if (streamAborted) return;
        fullResponse += chunk;
        updateBuffer += chunk;

        if (haltOn && haltOn.some(stop => fullResponse.includes(stop))) {
          streamAborted = true;
          return;
        }

        if (chunk.includes('\n')) {
          const completedLine = chunk.split('\n').filter(l => l.trim().length > 15).pop()?.trim() || "";
          if (completedLine === lastCompleteLine) {
            if (++repeatCount > 8) { streamAborted = true; return; }
          } else { repeatCount = 0; lastCompleteLine = completedLine; }
        }

        this.sessionTotalTokens = baseTokensPrior + (m.promptTokens + m.genTokens);
        const pressure = m.maxTokens ? Math.round((m.promptTokens / m.maxTokens) * 100) : 0;
        const pressureWarning = pressure > 70 ? ` | ⚠️ [CONTEXT PRESSURE: ${pressure}%]` : "";

        if (updateBuffer.length > 20 || chunk.includes('\n')) {
          onUpdate?.({ text: `🛡️ ${name} [${this.currentPhase}] ${m.genTps.toFixed(1)}t/s | ${m.genTokens}tok${pressureWarning}\n---\n${updateBuffer}` });
          updateBuffer = "";
        }
      }, () => { });
    } catch { }
    return fullResponse;
  }
}