import { readFileSync, existsSync } from 'fs';
import * as path from 'path';
import { HelotConfig } from '../config.js';

/**
 * SCOUT - Technical Reconnaissance & File Mapping
 * Maps Gorgo's plan to file structure, generates context for Builder
 */
export class Scout {
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
