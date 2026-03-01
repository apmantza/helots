import { HelotEngine } from '../core/engine';

/**
 * MCP Adapter for Helot Swarm
 * Theme: Gorgo of Sparta (Civ6-inspired)
 * 
 * This adapter handles Model Context Protocol communication
 * for the Helot Swarm orchestration system.
 */

export class MCPAdapter {
  private engine: HelotEngine;

  constructor() {
    this.engine = new HelotEngine();
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
    console.log('[Gorgo of Sparta] Processing MCP request through Gorgo of Sparta swarm...');
    
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