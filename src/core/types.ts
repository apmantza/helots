import { HelotConfig } from '../config.js';

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
