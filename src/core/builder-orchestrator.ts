import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { HelotConfig } from '../config.js';

const TS_JS_EXTS  = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const PYTHON_EXTS = new Set(['.py']);
const RUST_EXTS   = new Set(['.rs']);

function which(bin: string): boolean {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
    return r.status === 0;
}

function detectFormatter(filePath: string, projectRoot: string): string[] | null {
    const ext = path.extname(filePath).toLowerCase();

    if (TS_JS_EXTS.has(ext)) {
        const localBiome = path.join(projectRoot, 'node_modules', '.bin', 'biome');
        if (existsSync(path.join(projectRoot, 'biome.json')) && existsSync(localBiome))
            return [localBiome, 'format', '--write'];
        if (which('biome'))    return ['biome',    'format', '--write'];
        const localPrettier = path.join(projectRoot, 'node_modules', '.bin', 'prettier');
        const hasPrettierRc = ['.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml', 'prettier.config.js']
            .some(c => existsSync(path.join(projectRoot, c)));
        if (hasPrettierRc && existsSync(localPrettier)) return [localPrettier, '--write'];
        if (which('prettier')) return ['prettier', '--write'];
    }

    if (PYTHON_EXTS.has(ext)) {
        if (which('ruff'))  return ['ruff',  'format'];
        if (which('black')) return ['black'];
    }

    if (RUST_EXTS.has(ext)) {
        if (which('rustfmt')) return ['rustfmt'];
    }

    return null;
}

function formatFile(fullPath: string, projectRoot: string): void {
    const cmd = detectFormatter(fullPath, projectRoot);
    if (!cmd) return;
    spawnSync(cmd[0], [...cmd.slice(1), fullPath], { cwd: projectRoot, stdio: 'ignore' });
}

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
                formatFile(fullPath, this.config.projectRoot);
                modifications.push(`Modified: ${filePath}`);
            }
        }

        return modifications;
    }
}
