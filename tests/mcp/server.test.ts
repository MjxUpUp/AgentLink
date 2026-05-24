/**
 * Tests for the AgentLink MCP server tools, resources, and prompt.
 *
 * Strategy: create the McpServer with all registrations and call tool/resource
 * handlers directly (no stdio transport). Dependencies are backed by real
 * in-memory TaskManager and TrustManager instances (temp dirs).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AgentLinkServer } from '../../src/mcp/server.js';
import { registerTools, registerResources, registerPrompts, type ToolDeps, type AgentOverview } from '../../src/mcp/tools.js';
import { TaskManager } from '../../src/core/task-manager.js';
import { TrustManager } from '../../src/core/trust-manager.js';
import type { AgentIdentity, Artifact, Task } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIdentity(): AgentIdentity {
  return {
    agentId: 'al-self0000-0000-0000-000000000001',
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(64),
    name: 'test-agent',
    agentType: 'test',
    capabilities: ['testing'],
  };
}

let tmpDir: string;
let taskManager: TaskManager;
let trustManager: TrustManager;
let identity: AgentIdentity;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-mcp-test-'));
  taskManager = new TaskManager(path.join(tmpDir, 'tasks.db'));
  trustManager = new TrustManager(path.join(tmpDir, 'trust.json'));
  identity = makeIdentity();
});

afterEach(() => {
  taskManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AgentLinkServer construction
// ---------------------------------------------------------------------------

describe('AgentLinkServer', () => {
  it('should construct and register tools/resources/prompt', () => {
    const server = new AgentLinkServer({
      identity,
      taskManager,
      trustManager,
      getOnlineAgents: () => [],
      sendMessage: async () => true,
    });

    // The McpServer should be accessible
    expect(server.server).toBeDefined();
  });

  it('should expose the underlying McpServer', () => {
    const server = new AgentLinkServer({
      identity,
      taskManager,
      trustManager,
      getOnlineAgents: () => [],
      sendMessage: async () => true,
    });

    expect(server.server).toBeInstanceOf(McpServer);
  });
});

// ---------------------------------------------------------------------------
// Tool handler tests — we test via direct handler invocation
// ---------------------------------------------------------------------------

describe('Tool: agentlink_discover', () => {
  it('should return all online agents when no filters', async () => {
    const agents: AgentOverview[] = [
      { agentId: 'al-agent-a', name: 'Agent A', status: 'online', capabilities: ['code-review'] },
      { agentId: 'al-agent-b', name: 'Agent B', status: 'online', capabilities: ['testing'] },
    ];

    const { handler } = captureToolHandler('agentlink_discover', agents);

    const result = await handler({});
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].agentId).toBe('al-agent-a');
  });

  it('should filter by capability', async () => {
    const agents: AgentOverview[] = [
      { agentId: 'al-agent-a', status: 'online', capabilities: ['code-review'] },
      { agentId: 'al-agent-b', status: 'online', capabilities: ['testing'] },
    ];

    const { handler } = captureToolHandler('agentlink_discover', agents);

    const result = await handler({ capability: 'code-review' });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].agentId).toBe('al-agent-a');
  });

  it('should filter by status', async () => {
    const agents: AgentOverview[] = [
      { agentId: 'al-agent-a', status: 'online' },
      { agentId: 'al-agent-b', status: 'offline' },
    ];

    const { handler } = captureToolHandler('agentlink_discover', agents);

    const result = await handler({ status: 'online' });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].agentId).toBe('al-agent-a');
  });

  it('should return empty array when no agents match', async () => {
    const { handler } = captureToolHandler('agentlink_discover', []);

    const result = await handler({});
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed).toHaveLength(0);
  });
});

describe('Tool: agentlink_send_message', () => {
  it('should create a task and send message', async () => {
    let sentTo: string | null = null;
    const { handler } = captureToolHandler('agentlink_send_message', [], {
      sendMessage: async (to: string) => { sentTo = to; return true; },
    });

    const result = await handler({
      to: 'al-target',
      message: 'Hello agent',
    });

    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.taskId).toBeDefined();
    expect(parsed.sent).toBe(true);
    expect(sentTo).toBe('al-target');

    // Verify task was created in TaskManager
    const task = taskManager.getTask(parsed.taskId);
    expect(task).not.toBeNull();
    expect(task!.executor).toBe('al-target');
    expect(task!.requester).toBe(identity.agentId);
  });

  it('should return error when send fails', async () => {
    const { handler } = captureToolHandler('agentlink_send_message', [], {
      sendMessage: async () => false,
    });

    const result = await handler({
      to: 'al-target',
      message: 'Hello',
    });

    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.sent).toBe(false);
    expect(result.isError).toBe(true);
  });

  it('should use default type "message" when type not provided', async () => {
    const { handler } = captureToolHandler('agentlink_send_message', [], {
      sendMessage: async () => true,
    });

    const result = await handler({
      to: 'al-target',
      message: 'Test',
    });

    const parsed = JSON.parse((result.content as any)[0].text);
    const task = taskManager.getTask(parsed.taskId);
    expect(task!.type).toBe('message');
  });

  it('should use provided type', async () => {
    const { handler } = captureToolHandler('agentlink_send_message', [], {
      sendMessage: async () => true,
    });

    const result = await handler({
      to: 'al-target',
      message: 'Test',
      type: 'code-review',
    });

    const parsed = JSON.parse((result.content as any)[0].text);
    const task = taskManager.getTask(parsed.taskId);
    expect(task!.type).toBe('code-review');
  });
});

describe('Tool: agentlink_broadcast', () => {
  it('should broadcast to all trusted online agents', async () => {
    const agents: AgentOverview[] = [
      { agentId: 'al-agent-a', status: 'online', capabilities: ['review'] },
      { agentId: 'al-agent-b', status: 'online', capabilities: ['test'] },
    ];

    // Trust both agents
    trustManager.addTrust('al-agent-a', new Uint8Array(32), 'Agent A');
    trustManager.addTrust('al-agent-b', new Uint8Array(32), 'Agent B');

    const sentMessages: string[] = [];
    const { handler } = captureToolHandler('agentlink_broadcast', agents, {
      sendMessage: async (to: string) => { sentMessages.push(to); return true; },
    });

    const result = await handler({ message: 'Hello all!' });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.sentCount).toBe(2);
    expect(sentMessages).toHaveLength(2);
  });

  it('should only broadcast to trusted agents', async () => {
    const agents: AgentOverview[] = [
      { agentId: 'al-agent-a', status: 'online' },
      { agentId: 'al-agent-b', status: 'online' },
    ];

    // Only trust one agent
    trustManager.addTrust('al-agent-a', new Uint8Array(32), 'Agent A');

    const sentMessages: string[] = [];
    const { handler } = captureToolHandler('agentlink_broadcast', agents, {
      sendMessage: async (to: string) => { sentMessages.push(to); return true; },
    });

    const result = await handler({ message: 'Hello!' });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.sentCount).toBe(1);
    expect(sentMessages).toEqual(['al-agent-a']);
  });

  it('should filter by capability', async () => {
    const agents: AgentOverview[] = [
      { agentId: 'al-agent-a', status: 'online', capabilities: ['code-review'] },
      { agentId: 'al-agent-b', status: 'online', capabilities: ['testing'] },
    ];

    trustManager.addTrust('al-agent-a', new Uint8Array(32));
    trustManager.addTrust('al-agent-b', new Uint8Array(32));

    const sentMessages: string[] = [];
    const { handler } = captureToolHandler('agentlink_broadcast', agents, {
      sendMessage: async (to: string) => { sentMessages.push(to); return true; },
    });

    const result = await handler({ message: 'Review needed', capability: 'code-review' });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.sentCount).toBe(1);
    expect(sentMessages).toEqual(['al-agent-a']);
  });

  it('should return zero when no agents match', async () => {
    const { handler } = captureToolHandler('agentlink_broadcast', []);

    const result = await handler({ message: 'Nobody here' });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.sentCount).toBe(0);
  });
});

describe('Tool: agentlink_get_status', () => {
  it('should return agent details for an online agent', async () => {
    const agents: AgentOverview[] = [
      { agentId: 'al-agent-a', name: 'Agent A', status: 'online', agentType: 'coder', capabilities: ['review'] },
    ];

    trustManager.addTrust('al-agent-a', new Uint8Array(32));

    const { handler } = captureToolHandler('agentlink_get_status', agents);

    const result = await handler({ agentId: 'al-agent-a' });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.agentId).toBe('al-agent-a');
    expect(parsed.name).toBe('Agent A');
    expect(parsed.status).toBe('online');
    expect(parsed.trustLevel).toBe('trusted');
  });

  it('should return offline trusted agent from trust records', async () => {
    trustManager.addTrust('al-agent-a', new Uint8Array(32), 'Agent A');

    // No online agents
    const { handler } = captureToolHandler('agentlink_get_status', []);

    const result = await handler({ agentId: 'al-agent-a' });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.agentId).toBe('al-agent-a');
    expect(parsed.status).toBe('offline');
    expect(parsed.trustLevel).toBe('trusted');
  });

  it('should return error for unknown agent', async () => {
    const { handler } = captureToolHandler('agentlink_get_status', []);

    const result = await handler({ agentId: 'al-unknown' });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.error).toBe('Agent not found');
    expect(result.isError).toBe(true);
  });
});

describe('Tool: agentlink_wait_for_reply', () => {
  it('should return task when completed before timeout', async () => {
    // Create a task and immediately complete it
    const task = taskManager.createTask({
      requester: identity.agentId,
      executor: 'al-target',
      type: 'message',
      title: 'Test',
      description: 'Test task',
      priority: 'medium',
    });
    taskManager.acceptTask(task.id);
    taskManager.startTask(task.id);
    taskManager.completeTask(task.id, [
      { type: 'text', name: 'reply', content: 'Done!' },
    ]);

    const { handler } = captureToolHandler('agentlink_wait_for_reply', [], {
      waitForReply: async (taskId: string) => {
        return taskManager.getTask(taskId);
      },
    });

    const result = await handler({ taskId: task.id, timeout_seconds: 1 });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.id).toBe(task.id);
    expect(parsed.status).toBe('completed');
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0].content).toBe('Done!');
  });

  it('should return error on timeout', async () => {
    const { handler } = captureToolHandler('agentlink_wait_for_reply', [], {
      waitForReply: async () => null,
    });

    const result = await handler({ taskId: 'nonexistent', timeout_seconds: 1 });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.error).toBe('Timeout waiting for reply');
    expect(result.isError).toBe(true);
  });

  it('should use default timeout of 300 seconds', async () => {
    let receivedTimeout = 0;
    const { handler } = captureToolHandler('agentlink_wait_for_reply', [], {
      waitForReply: async (_taskId: string, timeoutMs: number) => {
        receivedTimeout = timeoutMs;
        return null;
      },
    });

    await handler({ taskId: 'some-task' });
    expect(receivedTimeout).toBe(300 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Resource tests
// ---------------------------------------------------------------------------

describe('Resources', () => {
  it('agentlink://agents should return online agents', async () => {
    const agents: AgentOverview[] = [
      { agentId: 'al-agent-a', name: 'A', status: 'online' },
    ];

    const handler = captureResourceHandler('agentlink://agents', agents);
    const result = await handler(new URL('agentlink://agents'));
    const parsed = JSON.parse(result.contents[0].text as string);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].agentId).toBe('al-agent-a');
  });

  it('agentlink://tasks should return active (non-terminal) tasks', async () => {
    // Create tasks in different states
    const t1 = taskManager.createTask({
      requester: 'a', executor: 'b', type: 't', title: 'Active', description: '', priority: 'low',
    });
    const t2 = taskManager.createTask({
      requester: 'a', executor: 'b', type: 't', title: 'Done', description: '', priority: 'low',
    });
    taskManager.acceptTask(t2.id);
    taskManager.startTask(t2.id);
    taskManager.completeTask(t2.id, []);

    const handler = captureResourceHandler('agentlink://tasks', []);
    const result = await handler(new URL('agentlink://tasks'));
    const parsed = JSON.parse(result.contents[0].text as string);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(t1.id);
  });

  it('agentlink://trust should return trusted agents', async () => {
    trustManager.addTrust('al-trusted', new Uint8Array(32), 'Trusted Agent');

    const handler = captureResourceHandler('agentlink://trust', []);
    const result = await handler(new URL('agentlink://trust'));
    const parsed = JSON.parse(result.contents[0].text as string);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].agentId).toBe('al-trusted');
    expect(parsed[0].alias).toBe('Trusted Agent');
    expect(parsed[0].trustLevel).toBe('trusted');
  });
});

// ---------------------------------------------------------------------------
// Prompt tests
// ---------------------------------------------------------------------------

describe('Prompt: agentlink-setup-guide', () => {
  it('should return a guide with tool descriptions', async () => {
    const handler = capturePromptHandler();
    const result = await handler({});

    expect(result.messages).toHaveLength(1);
    const text = result.messages[0].content.text as string;
    expect(text).toContain('agentlink_discover');
    expect(text).toContain('agentlink_send_message');
    expect(text).toContain('agentlink_broadcast');
    expect(text).toContain('agentlink_get_status');
    expect(text).toContain('agentlink_wait_for_reply');
    expect(text).toContain('agentlink://agents');
    expect(text).toContain('agentlink://tasks');
    expect(text).toContain('agentlink://trust');
  });
});

// ---------------------------------------------------------------------------
// Utility: capture handlers from McpServer registration
// ---------------------------------------------------------------------------

type ToolHandler = (args: any) => Promise<any>;
type ResourceHandler = (uri: URL) => Promise<any>;
type PromptHandler = (args: any) => Promise<any>;

/**
 * Captures a tool handler by registering tools on a fresh McpServer
 * and intercepting the handler for the named tool.
 */
function captureToolHandler(
  toolName: string,
  onlineAgents: AgentOverview[],
  overrides?: Partial<ToolDeps>,
): { handler: ToolHandler } {
  let capturedHandler: ToolHandler | null = null;

  // We create a mock McpServer-like object that captures the handler
  const mockServer = {
    tool: (name: string, _desc: string, _schema: any, handler: ToolHandler) => {
      if (name === toolName) {
        capturedHandler = handler;
      }
    },
    resource: () => {},
    prompt: () => {},
  } as unknown as McpServer;

  const deps: ToolDeps = {
    identity,
    taskManager,
    trustManager,
    getOnlineAgents: () => onlineAgents,
    sendMessage: async () => true,
    waitForReply: async () => null,
    ...overrides,
  };

  registerTools(mockServer, deps);

  if (!capturedHandler) {
    throw new Error(`Tool handler not captured for: ${toolName}`);
  }

  return { handler: capturedHandler };
}

function captureResourceHandler(
  uri: string,
  onlineAgents: AgentOverview[],
): ResourceHandler {
  let capturedHandler: ResourceHandler | null = null;

  const mockServer = {
    tool: () => {},
    resource: (name: string, resourceUri: string, handler: ResourceHandler) => {
      if (resourceUri === uri) {
        capturedHandler = handler;
      }
    },
    prompt: () => {},
  } as unknown as McpServer;

  const deps: ToolDeps = {
    identity,
    taskManager,
    trustManager,
    getOnlineAgents: () => onlineAgents,
    sendMessage: async () => true,
    waitForReply: async () => null,
  };

  registerResources(mockServer, deps);

  if (!capturedHandler) {
    throw new Error(`Resource handler not captured for: ${uri}`);
  }

  return capturedHandler;
}

function capturePromptHandler(): PromptHandler {
  let capturedHandler: PromptHandler | null = null;

  const mockServer = {
    tool: () => {},
    resource: () => {},
    prompt: (name: string, _desc: string, _schema: any, handler: PromptHandler) => {
      if (name === 'agentlink-setup-guide') {
        capturedHandler = handler;
      }
    },
  } as unknown as McpServer;

  registerPrompts(mockServer);

  if (!capturedHandler) {
    throw new Error('Prompt handler not captured');
  }

  return capturedHandler;
}
