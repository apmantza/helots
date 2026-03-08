/**
 * worktree-manager.ts — Git worktree lifecycle for isolated helot runs.
 *
 * Each helot_run gets its own branch + worktree. Builder writes happen in
 * the worktree, leaving main untouched. Claude merges on success or discards
 * the branch on failure.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';

export class WorktreeManager {
  constructor(private projectRoot: string) {}

  /** Create a new worktree at worktreePath on a new branch. */
  create(branch: string, worktreePath: string): void {
    execSync(`git worktree add "${worktreePath}" -b "${branch}"`, {
      cwd: this.projectRoot,
      stdio: 'pipe',
    });
  }

  /** Remove a worktree and its branch (force in case of unclean state). */
  remove(worktreePath: string, branch: string): void {
    if (existsSync(worktreePath)) {
      execSync(`git worktree remove --force "${worktreePath}"`, {
        cwd: this.projectRoot,
        stdio: 'pipe',
      });
    }
    try {
      execSync(`git branch -D "${branch}"`, {
        cwd: this.projectRoot,
        stdio: 'pipe',
      });
    } catch {
      // Branch may already be gone — not fatal
    }
  }

  /** Derive the branch name for a run. */
  static branchName(runId: string): string {
    return `helots/${runId}`;
  }

  /** Derive the worktree path inside the state directory. */
  static worktreePath(stateDir: string, runId: string): string {
    return path.join(stateDir, 'worktrees', runId);
  }
}
