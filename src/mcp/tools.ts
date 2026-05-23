/**
 * MCP tool, resource, and prompt definitions for AgentLink.
 *
 * This module exports pure functions that register all MCP primitives onto
 * an McpServer instance.  Separating registration from server lifecycle
 * makes it straightforward to unit-test handlers without a real stdio
 * transport.
 */

import { z } from 'zod';
import type { McpServer, RegisteredTool, RegisteredResource, RegisteredPrompt } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentIdentity, Task, Artifact } from '../core/types.js';
import type { TaskManager } from '../core/task-manager.js';
import type { TrustManager } from '../core/trust-manager.js';

// ---------------------------------------------------------------------------
// Types for the dependency bag injected into every handler
// ---------------------------------------------------------------------------

export interface ToolDeps {
  identity: AgentIdentity;
  taskManager: TaskManager;
  trustManager: TrustManager;
  /** Returns the current list of online agents (from discovery / address-book). */
  getOnlineAgents(): AgentOverview[];
  /** Sends a message to a remote agent. Returns true on success. */
  sendMessage(to: string, message: string, type: string, artifacts?: Artifact[]): Promise<boolean>;
  /** Waits for a task reply, resolving with the completed task or null on timeout. */
  waitForReply(taskId: string, timeoutMs: number): Promise<Task | null>;
}

export interface AgentOverview {
  agentId: string;
  name?: string;
  agentType?: string;
  capabilities?: string[];
  status: string;
  ip?: string;
  port?: number;
}

// ---------------------------------------------------------------------------
// Zod schemas (input validation)
// ---------------------------------------------------------------------------

const DiscoverSchema = {
  capability: z.string().optional().describe('Filter agents by capability'),
  status: z.string().optional().describe('Filter agents by status (online/offline)'),
};

const SendMessageSchema = {
  to: z.string().describe('Target agent ID'),
  message: z.string().describe('Message payload'),
  type: z.string().optional().describe('Message type (defaults to "task.create")'),
  artifacts: z.array(z.object({
    type: z.enum(['text', 'code', 'file_reference']),
    name: z.string(),
    content: z.string(),
    mimeType: z.string().optional(),
  })).optional().describe('Optional artifacts to attach'),
};

const BroadcastSchema = {
  message: z.string().describe('Message to broadcast'),
  capability: z.string().optional().describe('Only broadcast to agents with this capability'),
};

const GetStatusSchema = {
  agentId: z.string().describe('Agent ID to look up'),
};

const WaitForReplySchema = {
  taskId: z.string().describe('Task ID to wait for'),
  timeout_seconds: z.number().optional().describe('Timeout in seconds (default 300)'),
};

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, deps: ToolDeps): void {
  // 1. agentlink_discover
  server.tool(
    'agentlink_discover',
    'Discover LAN agents. Optionally filter by capability or status.',
    DiscoverSchema,
    async (params) => {
      let agents = deps.getOnlineAgents();

      if (params.capability) {
        agents = agents.filter(a =>
          a.capabilities?.some(c => c.toLowerCase() === params.capability!.toLowerCase()),
        );
      }

      if (params.status) {
        agents = agents.filter(a => a.status === params.status);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(agents) }],
      };
    },
  );

  // 2. agentlink_send_message
  server.tool(
    'agentlink_send_message',
    'Send a message or task to a specific agent.',
    SendMessageSchema,
    async (params) => {
      const task = deps.taskManager.createTask({
        requester: deps.identity.agentId,
        executor: params.to,
        type: params.type ?? 'message',
        title: params.message.slice(0, 120),
        description: params.message,
        priority: 'medium',
      });

      const sent = await deps.sendMessage(
        params.to,
        params.message,
        params.type ?? 'message',
        params.artifacts,
      );

      if (!sent) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ taskId: task.id, sent: false, error: 'Failed to deliver message' }) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ taskId: task.id, sent: true }) }],
      };
    },
  );

  // 3. agentlink_broadcast
  server.tool(
    'agentlink_broadcast',
    'Broadcast a message to all trusted online agents.',
    BroadcastSchema,
    async (params) => {
      let targets = deps.getOnlineAgents();

      // Only broadcast to trusted agents
      targets = targets.filter(a => deps.trustManager.isTrusted(a.agentId));

      if (params.capability) {
        targets = targets.filter(a =>
          a.capabilities?.some(c => c.toLowerCase() === params.capability!.toLowerCase()),
        );
      }

      let sentCount = 0;
      for (const agent of targets) {
        const ok = await deps.sendMessage(agent.agentId, params.message, 'broadcast');
        if (ok) sentCount++;
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ sentCount, totalTargets: targets.length }) }],
      };
    },
  );

  // 4. agentlink_get_status
  server.tool(
    'agentlink_get_status',
    'Get detailed information about a specific agent.',
    GetStatusSchema,
    async (params) => {
      const agents = deps.getOnlineAgents();
      const agent = agents.find(a => a.agentId === params.agentId);

      if (!agent) {
        // Also check trusted agents (may be offline)
        const trustRecord = deps.trustManager.getTrust(params.agentId);
        if (trustRecord) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                agentId: trustRecord.agentId,
                alias: trustRecord.alias,
                status: 'offline',
                trustLevel: trustRecord.trustLevel,
              }),
            }],
          };
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Agent not found', agentId: params.agentId }) }],
          isError: true,
        };
      }

      const trustRecord = deps.trustManager.getTrust(params.agentId);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ...agent,
            trustLevel: trustRecord?.trustLevel ?? 'untrusted',
            alias: trustRecord?.alias,
          }),
        }],
      };
    },
  );

  // 5. agentlink_wait_for_reply
  server.tool(
    'agentlink_wait_for_reply',
    'Block until a reply is received for a task or the timeout expires.',
    WaitForReplySchema,
    async (params) => {
      const timeoutMs = (params.timeout_seconds ?? 300) * 1000;
      const task = await deps.waitForReply(params.taskId, timeoutMs);

      if (!task) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Timeout waiting for reply', taskId: params.taskId }) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(task) }],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Resource registration
// ---------------------------------------------------------------------------

export function registerResources(server: McpServer, deps: ToolDeps): void {
  // agentlink://agents — online agents
  server.resource(
    'agentlink-agents',
    'agentlink://agents',
    async (_uri) => {
      const agents = deps.getOnlineAgents();
      return {
        contents: [{ uri: 'agentlink://agents', text: JSON.stringify(agents) }],
      };
    },
  );

  // agentlink://tasks — active tasks
  server.resource(
    'agentlink-tasks',
    'agentlink://tasks',
    async (_uri) => {
      const tasks = deps.taskManager.listTasks();
      // Only return non-terminal tasks
      const active = tasks.filter(t =>
        !['completed', 'failed', 'cancelled'].includes(t.status),
      );
      return {
        contents: [{ uri: 'agentlink://tasks', text: JSON.stringify(active) }],
      };
    },
  );

  // agentlink://trust — trusted agents
  server.resource(
    'agentlink-trust',
    'agentlink://trust',
    async (_uri) => {
      const trusted = deps.trustManager.listTrusted().map(r => ({
        agentId: r.agentId,
        alias: r.alias,
        trustLevel: r.trustLevel,
        autoApprove: r.autoApprove,
        trustedAt: r.trustedAt,
      }));
      return {
        contents: [{ uri: 'agentlink://trust', text: JSON.stringify(trusted) }],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Prompt registration
// ---------------------------------------------------------------------------

export function registerPrompts(server: McpServer): void {
  server.prompt(
    'agentlink-setup-guide',
    'Explains how to use AgentLink tools for P2P agent communication.',
    {},
    async () => {
      const guide = `# AgentLink Setup Guide

AgentLink enables P2P communication between AI agents on your local network.

## Available Tools

### agentlink_discover
Discover agents on the LAN. Optionally filter by capability or status.
\`\`\`
agentlink_discover(capability?: string, status?: string)
\`\`\`

### agentlink_send_message
Send a message or task to a specific agent. Returns a taskId for tracking.
\`\`\`
agentlink_send_message(to: string, message: string, type?: string, artifacts?: array)
\`\`\`

### agentlink_broadcast
Broadcast a message to all trusted online agents. Optionally filter by capability.
\`\`\`
agentlink_broadcast(message: string, capability?: string)
\`\`\`

### agentlink_get_status
Get detailed information about a specific agent.
\`\`\`
agentlink_get_status(agentId: string)
\`\`\`

### agentlink_wait_for_reply
Block until a reply is received for a task, or timeout expires (default 300s).
\`\`\`
agentlink_wait_for_reply(taskId: string, timeout_seconds?: number)
\`\`\`

## Typical Workflow

1. **Discover** agents: \`agentlink_discover()\`
2. **Send a message**: \`agentlink_send_message(to: "al-xxx", message: "Please review my code")\`
3. **Wait for reply**: \`agentlink_wait_for_reply(taskId: "returned-task-id")\`
4. **Check status**: \`agentlink_get_status(agentId: "al-xxx")\`

## Resources

- \`agentlink://agents\` — List of currently online agents
- \`agentlink://tasks\` — List of active (non-terminal) tasks
- \`agentlink://trust\` — List of trusted agents and their trust levels
`;

      return {
        messages: [
          {
            role: 'assistant' as const,
            content: { type: 'text' as const, text: guide },
          },
        ],
      };
    },
  );
}
