import { HelotEngine } from '../core/engine';
import { HelotConfig } from '../config';
import * as fs from 'fs';
import * as path from 'path';

/**
 * MCP Adapter for Helot Psiloi
 * Theme: Gorgo of Sparta (Civ6-inspired)
 * 
 * This adapter handles Model Context Protocol communication
 * for the Helot Psiloi orchestration system.
 */

export class MCPAdapter {
  private engine: HelotEngine;
  private config: HelotConfig;

  constructor() {
    this.config = this.loadConfig();
    this.engine = new HelotEngine(this.config);
  }

  private loadConfig(): HelotConfig {
    let config: HelotConfig = {
      llamaUrl: process.env.HELOT_LLM_URL || "http://127.0.0.1:8080",
      apiKey: process.env.HELOT_API_KEY || "",
      denseModel: process.env.HELOT_DENSE_MODEL || "Qwen/Qwen3.5-27B",
      moeModel: process.env.HELOT_MOE_MODEL || "Qwen/Qwen3.5-35B-A3B",
      stateDir: process.env.HELOT_STATE_DIR || ".helot-state",
      projectRoot: process.cwd()
    };

    try {
      const configPath = path.join(process.cwd(), ".helots", "config.json");
      if (fs.existsSync(configPath)) {
        const overrideRaw = fs.readFileSync(configPath, "utf-8");
        const overrides = JSON.parse(overrideRaw);
        config = { ...config, ...overrides };
      }
    } catch { }

    return config;
  }

  /**
   * Initialize MCP connection
   * @returns Connection status
   */
  async initialize(): Promise<boolean> {
    console.log('[Gorgo of Sparta] MCP Adapter initializing...');
    return true;
  }

  /**
   * Process MCP request through Helot Swarm
   * @param request The MCP request to process
   * @returns Processed response
   */
  async processRequest(request: any): Promise<any> {
    console.log('[Gorgo of Sparta] Processing MCP request through Gorgo of Sparta Psiloi...');

    const plan = this.extractPlan(request);
    const result = await this.engine.executeRun(plan);

    return this.formatResponse(result);
  }

  private extractPlan(request: any): string {
    return request.plan || request.task || 'default task';
  }

  private formatResponse(result: any): any {
    return {
      status: 'success',
      data: result,
      theme: 'Gorgo of Sparta'
    };
  }
}