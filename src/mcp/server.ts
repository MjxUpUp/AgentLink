/**
 * AgentLink MCP Server — stdio-mode MCP server that exposes AgentLink
 * capabilities (discover, message, broadcast, status, wait) as MCP tools,
 * resources, and a prompt.
 *
 * Dependencies (identity, TaskManager, TrustManager, etc.) are injected so
 * the server is testable without real network I/O.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AgentIdentity } from '../core/types.js';
import type { TaskManager } from '../core/task-manager.js';
import type { TrustManager } from '../core/trust-manager.js';
import { registerTools, registerResources, registerPrompts, type ToolDeps, type AgentOverview } from './tools.js';

export interface AgentLinkServerDeps {
  identity: AgentIdentity;
  taskManager: TaskManager;
  trustManager: TrustManager;
  /** Returns current online agents (typically from discovery service). */
  getOnlineAgents(): AgentOverview[];
  /** Sends a message to a remote agent. */
  sendMessage(to: string, message: string, type: string, artifacts?: import('../core/types.js').Artifact[]): Promise<boolean>;
  /** Waits for a task reply. Default impl polls TaskManager. */
  waitForReply?(taskId: string, timeoutMs: number): Promise<import('../core/types.js').Task | null>;
}

export class AgentLinkServer {
  private mcpServer: McpServer;
  private deps: ToolDeps;
  private transport: StdioServerTransport | null = null;

  constructor(deps: AgentLinkServerDeps) {
    this.mcpServer = new McpServer({
      name: 'agentlink',
      version: '0.1.0',
    });

    // Build the waitForReply default implementation if not provided
    const defaultWaitForReply = async (taskId: string, timeoutMs: number): Promise<import('../core/types.js').Task | null> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const task = deps.taskManager.getTask(taskId);
        if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) {
          return task;
        }
        // Poll every 500ms
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return null;
    };

    this.deps = {
      identity: deps.identity,
      taskManager: deps.taskManager,
      trustManager: deps.trustManager,
      getOnlineAgents: deps.getOnlineAgents,
      sendMessage: deps.sendMessage,
      waitForReply: deps.waitForReply ?? defaultWaitForReply,
    };

    // Register all MCP primitives
    registerTools(this.mcpServer, this.deps);
    registerResources(this.mcpServer, this.deps);
    registerPrompts(this.mcpServer);
  }

  /** Expose the underlying McpServer for testing. */
  get server(): McpServer {
    return this.mcpServer;
  }

  /** Start the server on stdio. */
  async start(): Promise<void> {
    this.transport = new StdioServerTransport();
    await this.mcpServer.connect(this.transport);
  }

  /** Gracefully shut down. */
  async stop(): Promise<void> {
    await this.mcpServer.close();
    this.transport = null;
  }
}
