#!/usr/bin/env node

/**
 * GORGO'S COMMAND - CLI Entry Point
 * Orchestrates Helot Swarm execution with Governor oversight
 */

import { HelotEngine } from './src/core/engine.js';
import { HelotConfig } from './src/config.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const config: HelotConfig = {
  projectRoot: process.cwd(),
  stateDir: join(process.cwd(), '.helot-state'),
  llamaUrl: process.env.LLAMA_URL || 'http://localhost:11434',
  apiKey: process.env.API_KEY || '',
  denseModel: 'Qwen/Qwen3.5-27B',
  moeModel: 'Qwen/Qwen3.5-35B-A3B',
};

const engine = new HelotEngine(config);

/**
 * Parse CLI arguments
 */
function parseArgs(): { resumeId?: string; batPath?: string } {
  const args = process.argv.slice(2);
  const result: { resumeId?: string; batPath?: string } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resume' && args[i + 1]) {
      result.resumeId = args[i + 1];
      i++;
    }
    if (args[i] === '--bat' && args[i + 1]) {
      result.batPath = args[i + 1];
      i++;
    }
  }

  return result;
}

/**
 * Server Restart Coaching
 * Provides user with BAT file path for server restart
 */
function provideRestartCoaching(batPath?: string): string {
  const defaultBatPath = './restart-server.bat';
  const effectiveBatPath = batPath || defaultBatPath;

  return `
=== SERVER RESTART COACHING ===
If your server needs to be restarted, use the following command:

${effectiveBatPath}

Or manually restart the server process.
================================
`;
}

/**
 * Main execution
 */
async function main(): Promise<void> {
  const args = parseArgs();

  // Load implementation plan
  const planPath = join(process.cwd(), 'gorgo_run.ts');
  const implementationPlan = readFileSync(planPath, 'utf-8');

  // Execute run with resume support
  const report = await engine.executeRun(implementationPlan, args.resumeId);

  // Provide restart coaching if needed
  const coaching = provideRestartCoaching(args.batPath);

  console.log(report);
  console.log(coaching);
}

main().catch(console.error);