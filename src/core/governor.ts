import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { HelotConfig } from '../config.js';
import { HelotState, HelotPhase, VerificationResult } from './types';

/**
 * ARISTOMENIS
 * Phase-aware state management with verification gates
 */
export class Aristomenis {
    public state: HelotState;
    public config: HelotConfig;

    constructor(config: HelotConfig) {
        this.config = config;
        this.state = this.loadState();
    }

    private loadState(): HelotState {
        const statePath = join(this.config.stateDir, 'helot-state.json');
        if (existsSync(statePath)) {
            const loaded = JSON.parse(readFileSync(statePath, 'utf-8'));
            // Ensure new fields exist
            return {
                runId: loaded.runId || this.generateRunId(),
                tasks: loaded.tasks || [],
                currentTaskIndex: loaded.currentTaskIndex || 0,
                lastCheckpoint: loaded.lastCheckpoint || '',
                phase: loaded.phase || 'idle',
                planOnly: loaded.planOnly || false,
                strikes: loaded.strikes || {},
                vision: loaded.vision,
                plan: loaded.plan,
                tasksContent: loaded.tasksContent,
                approved: loaded.approved || false,
            };
        }
        return {
            runId: this.generateRunId(),
            tasks: [],
            currentTaskIndex: 0,
            lastCheckpoint: '',
            phase: 'idle',
            planOnly: false,
            strikes: {},
            approved: false,
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

    // ============================================
    // PHASE MANAGEMENT
    // ============================================
    
    setPhase(phase: HelotPhase): void {
        const oldPhase = this.state.phase;
        this.state.phase = phase;
        this.saveState();
    }

    getPhase(): HelotPhase {
        return this.state.phase;
    }

    /**
     * Check if we can transition to a new phase
     * Returns the allowed next phases
     */
    getNextPhases(currentPhase: HelotPhase): HelotPhase[] {
        const phaseTransitions: Record<HelotPhase, HelotPhase[]> = {
            'idle': ['scout', 'aristomenis'],
            'scout': ['aristomenis', 'scout'],  // Can re-scout
            'aristomenis': ['builder', 'finished', 'idle'],
            'builder': ['peltast', 'builder'],  // Can re-try build
            'peltast': ['builder', 'review', 'finished'],
            'review': ['finished', 'builder'],
            'finished': ['idle'],
        };
        return phaseTransitions[currentPhase] || [];
    }

    /**
     * Check if phase transition is valid
     */
    canTransitionTo(phase: HelotPhase): boolean {
        const allowed = this.getNextPhases(this.state.phase);
        return allowed.includes(phase);
    }

    // ============================================
    // PLAN-ONLY MODE
    // ============================================

    setPlanOnly(planOnly: boolean): void {
        this.state.planOnly = planOnly;
        this.saveState();
    }

    isPlanOnly(): boolean {
        return this.state.planOnly;
    }

    // ============================================
    // VERIFICATION GATE
    // ============================================

    /**
     * Check if commits are allowed based on verification status
     */
    private lastVerification: VerificationResult | null = null;
    private lastSourceEdit: number = 0;
    private lastVerificationTime: number = 0;

    recordSourceEdit(): void {
        this.lastSourceEdit = Date.now();
    }

    recordVerification(result: VerificationResult): void {
        this.lastVerification = result;
        this.lastVerificationTime = Date.now();
    }

    /**
     * Can we commit? Only if:
     * 1. Last verification passed, AND
     * 2. No source edits after the last verification
     */
    canCommit(): { allowed: boolean; reason: string } {
        if (!this.lastVerification) {
            return { allowed: false, reason: 'No verification has run yet.' };
        }

        if (!this.lastVerification.passed) {
            return { allowed: false, reason: `Last verification failed: ${this.lastVerification.message}` };
        }

        if (this.lastSourceEdit > this.lastVerificationTime) {
            return { allowed: false, reason: 'Source files edited after last verification. Run verification again.' };
        }

        return { allowed: true, reason: 'Verification passed and no changes since.' };
    }

    // ============================================
    // STRIKE COUNTER (Oversight Model)
    // ============================================
    
    private strikeThresholds: Record<string, number> = {
        'task-default': 2,  // Default 2 strikes before escalation
    };

    addStrike(category: string): number {
        this.state.strikes[category] = (this.state.strikes[category] || 0) + 1;
        this.saveState();
        return this.state.strikes[category];
    }

    getStrikes(category: string): number {
        return this.state.strikes[category] || 0;
    }

    checkStrikes(category: string): { blocked: boolean; message: string; strikes: number } {
        const count = this.state.strikes[category] || 0;
        const threshold = this.strikeThresholds[category] || this.strikeThresholds['task-default'];
        
        if (count === 0) {
            return { blocked: false, message: '', strikes: 0 };
        } else if (count < threshold) {
            return { 
                blocked: false, 
                message: `⚠️ Warning: ${count} strike(s) for ${category}. Continue?`, 
                strikes: count 
            };
        } else {
            return { 
                blocked: true, 
                message: `🚫 BLOCKED: ${count} strikes for ${category} (threshold: ${threshold}). Override required.`, 
                strikes: count 
            };
        }
    }

    resetStrikes(category?: string): void {
        if (category) {
            delete this.state.strikes[category];
        } else {
            this.state.strikes = {};
        }
        this.saveState();
    }

    setStrikeThreshold(category: string, threshold: number): void {
        this.strikeThresholds[category] = threshold;
    }

    // ============================================
    // VISION WORKFLOW STATE
    // ============================================

    saveVisionWorkflow(vision: string, plan: string, tasks: string): void {
        this.state.vision = vision;
        this.state.plan = plan;
        this.state.tasksContent = tasks;
        this.state.approved = false;
        this.saveState();
    }

    getVisionWorkflow(): { vision?: string; plan?: string; tasks?: string; approved: boolean } {
        return {
            vision: this.state.vision,
            plan: this.state.plan,
            tasks: this.state.tasksContent,
            approved: this.state.approved,
        };
    }

    setApproved(approved: boolean): void {
        this.state.approved = approved;
        this.saveState();
    }

    // ============================================
    // SWEEP REPORT
    // ============================================

    generateSweepReport(): string {
        const completed = this.state.tasks.filter(t => t.status === 'completed').length;
        const total = this.state.tasks.length;
        const failed = this.state.tasks.filter(t => t.status === 'failed').length;

        return `
=== ARISTOMENIS SWEEP REPORT ===
Run ID: ${this.state.runId}
Phase: ${this.state.phase}
Plan Only: ${this.state.planOnly ? 'YES' : 'NO'}
---
Total Tasks: ${total}
Completed: ${completed}
Failed: ${failed}
Current Task Index: ${this.state.currentTaskIndex}
Last Checkpoint: ${this.state.lastCheckpoint}
---
Status: ${failed > 0 ? '🔴 RECOVERY REQUIRED' : completed === total ? '🟢 MISSION ACCOMPLISHED' : '🟡 IN PROGRESS'}
================================
`;
    }

    getRunId(): string {
        return this.state.runId;
    }
}
