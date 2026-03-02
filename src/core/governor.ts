import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { HelotConfig } from '../config.js';
import { HelotState } from './types.js';

/**
 * GOVERNOR (formerly Ephor)
 * Performs final SWEEP REPORT to ensure strategic alignment
 */
export class Governor {
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
