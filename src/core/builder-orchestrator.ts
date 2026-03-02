import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import * as path from 'path';
import { HelotConfig } from '../config.js';

/**
 * BUILDER - Implementation Agent
 * Performs actual file writes/edits based on Scout's context
 */
export class Builder {
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
                const fullPath = path.join(this.config.projectRoot, filePath);
                mkdirSync(path.dirname(fullPath), { recursive: true });
                writeFileSync(fullPath, content);
                modifications.push(`Modified: ${filePath}`);
            }
        }

        return modifications;
    }
}
