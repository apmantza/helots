import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { HelotConfig } from '../config.js';
import { LlamaClient } from './llama-client.js';
import { Governor } from './governor.js';
import { HelotTask, HelotState, HelotContext } from './types.js';

export class SlingerOrchestrator {
    private config: HelotConfig;
    private client: LlamaClient;
    private governor: Governor;
    private engine: any; // Reference back to engine for core runners

    constructor(config: HelotConfig, client: LlamaClient, governor: Governor, engine: any) {
        this.config = config;
        this.client = client;
        this.governor = governor;
        this.engine = engine;
    }

    async executeSlinger(researchTask: string, targetFiles: string[] | undefined, onUpdate?: (data: any) => void): Promise<string> {
        const runId = this.governor.getRunId();
        const { modelName } = await this.client.getProps();
        const slingerMetrics = { in: 0, out: 0, tps: 0 };
        const slingerPersona = this.engine.pickName(runId, "Slinger");

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

        const slingerSystem = `${await this.engine.getGlobalContext()}
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
            const result = await this.engine.runSubagent("Slinger", slingerPersona.name, slingerSystem, userPrompt, onUpdate, slingerMetrics, "INSTRUCT_GENERAL", modelName, ["### END_COMMAND"]);

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
        }

        return finalReport;
    }
}
