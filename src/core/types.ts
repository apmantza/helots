import { HelotConfig } from '../config.js';

export type HelotPhase = 
    | 'idle'
    | 'scout'
    | 'aristomenis'    // Plan phase
    | 'builder'        // Execute phase
    | 'peltast'        // Verify phase
    | 'review'         // Review phase
    | 'finished';

export interface HelotTask {
    id: string;
    description: string;
    status: 'pending' | 'completed' | 'failed' | 'blocked';
    file?: string;
    targetSymbol?: string;
    lineRange?: [number, number];
    dependsOn?: string[];
    changes?: string;   // per-task change spec from frontier (bypasses Aristomenis prose plan)
    skipLintCodes?: string[];  // ruff error codes peltast will not flag as "introduced" (e.g. ["F401"])
}

/** Structured task shape accepted directly from the frontier — bypasses Aristomenis planning. */
export interface FrontierTask {
    id: string;
    description: string;
    file: string;
    symbol?: string;
    dependsOn?: string[];
    changes: string;    // exact before→after diff instructions for the Builder
}

export interface HelotState {
    runId: string;
    tasks: HelotTask[];
    currentTaskIndex: number;
    lastCheckpoint: string;
    phase: HelotPhase;
    planOnly: boolean;  // New: explicit plan-only mode
    strikes: Record<string, number>;  // Strike counters for oversight
    vision?: string;  // User's original intent
    plan?: string;    // High-level plan
    tasksContent?: string;  // Aristomenis-generated tasks
    approved: boolean;
}

export interface HelotContext {
    implementationPlan: string;
    fileMapping: Record<string, string>;
    progress: HelotState;
}

export interface VerificationResult {
    passed: boolean;
    message: string;
    details?: any;
}

export type RunSubagentFn = (
  role: string, name: string, sys: string, user: string,
  onUpdate: ((data: any) => void) | undefined,
  metrics: any, profile: string, model: string,
  haltOn?: string[], maxTokensOverride?: number
) => Promise<string>;

export type WriteEventFn = (event: Record<string, any>) => void;
