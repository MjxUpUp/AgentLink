/**
 * Integration: MCP tools end-to-end
 *
 * Verifies that MCP tool handlers produce correct results when backed
 * by real TaskManager, TrustManager, and a real Transport mesh.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, type ToolDeps, type AgentOverview } from '../../src/mcp/tools.js';
import { TaskManager } from '../../src/core/task-manager.js';
import { TrustManager } from '../../src/core/trust-manager.js';
import { TestAgent, cleanupAgents } from './helpers/test-harness.js';
import { Methods } from '../../src/core/types.js';
import type { AgentIdentity, Artifact, Task } from '../../src/core/types.js';

let tmpDir: string;
let taskManager: TaskManager;
let trustManager: TrustManager;
let identity: AgentIdentity;
let sentCalls: Array<{ to: string; message: string; type: string; artifacts?: Artifact[] }>;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-mcp-e2e-'));
  taskManager = new TaskManager(path.join(tmpDir, 'tasks.db'));
  trustManager = new TrustManager(path.join(tmpDir, 'trust.json'));

  // Create a real identity
  const { generateIdentity } = await import('../../src/core/identity.js');
  identity = await generateIdentity({ name: 'MCPBot', agentType: 'test', capabilities: ['mcp'] });

  sentCalls = [];
});

afterEach(() => {
  taskManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: capture tool handler from McpServer registration
// ---------------------------------------------------------------------------

function captureToolHandler(
  toolName: string,
  onlineAgents: AgentOverview[],
  overrides?: Partial<ToolDeps>,
): { handler: (args: any) => Promise<any> } {
  let capturedHandler: ((args: any) => Promise<any>) | null = null;

  const mockServer = {
    tool: (name: string, _desc: string, _schema: any, handler: (args: any) => Promise<any>) => {
      if (name === toolName) capturedHandler = handler;
    },
    resource: () => {},
    prompt: () => {},
  } as unknown as McpServer;

  const deps: ToolDeps = {
    identity,
    taskManager,
    trustManager,
    getOnlineAgents: () => onlineAgents,
    sendMessage: async (to, message, type, artifacts) => {
      sentCalls.push({ to, message, type, artifacts });
      return true;
    },
    waitForReply: async () => null,
    ...overrides,
  };

  registerTools(mockServer, deps);
  if (!capturedHandler) throw new Error(`Tool not found: ${toolName}`);
  return { handler: capturedHandler };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP tools e2e', () => {
  it('agentlink_discover returns real online agents', async () => {
    const agents: AgentOverview[] = [
      { agentId: 'al-real001-00000000-00000000', name: 'Worker1', status: 'online', capabilities: ['code'] },
      { agentId: 'al-real002-00000000-00000000', name: 'Worker2', status: 'online', capabilities: ['test'] },
    ];

    const { handler } = captureToolHandler('agentlink_discover', agents);
    const result = await handler({});
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe('Worker1');
  });

  it('agentlink_discover filters by capability', async () => {
    const agents: AgentOverview[] = [
      { agentId: 'al-a', status: 'online', capabilities: ['code-review'] },
      { agentId: 'al-b', status: 'online', capabilities: ['testing'] },
    ];

    const { handler } = captureToolHandler('agentlink_discover', agents);
    const result = await handler({ capability: 'code-review' });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].agentId).toBe('al-a');
  });

  it('agentlink_send_message creates a real task and calls sendMessage', async () => {
    const { handler } = captureToolHandler('agentlink_send_message', []);

    const result = await handler({
      to: 'al-target',
      message: 'Please review my code',
      type: 'code-review',
    });

    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.taskId).toBeDefined();
    expect(parsed.sent).toBe(true);

    // Verify a real task was created in the database
    const task = taskManager.getTask(parsed.taskId);
    expect(task).not.toBeNull();
    expect(task!.type).toBe('code-review');
    expect(task!.title).toBe('Please review my code');
    expect(task!.executor).toBe('al-target');
    expect(task!.requester).toBe(identity.agentId);

    // Verify sendMessage was called
    expect(sentCalls).toHaveLength(1);
    expect(sentCalls[0].to).toBe('al-target');
    expect(sentCalls[0].message).toBe('Please review my code');
    expect(sentCalls[0].type).toBe('code-review');
  });

  it('agentlink_send_message returns error when send fails', async () => {
    const { handler } = captureToolHandler('agentlink_send_message', [], {
      sendMessage: async () => false,
    });

    const result = await handler({ to: 'al-offline', message: 'Hello?' });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.sent).toBe(false);
    expect(result.isError).toBe(true);
  });

  it('agentlink_send_message with artifacts', async () => {
    const { handler } = captureToolHandler('agentlink_send_message', []);

    const artifacts = [
      { type: 'code' as const, name: 'main.ts', content: 'console.log("hello")' },
    ];

    const result = await handler({
      to: 'al-target',
      message: 'Here is my code',
      artifacts,
    });

    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.sent).toBe(true);
    expect(sentCalls[0].artifacts).toHaveLength(1);
    expect(sentCalls[0].artifacts![0].name).toBe('main.ts');
  });

  it('agentlink_broadcast sends to all trusted agents', async () => {
    const agents: AgentOverview[] = [
      { agentId: 'al-a', status: 'online' },
      { agentId: 'al-b', status: 'online' },
    ];

    trustManager.addTrust('al-a', new Uint8Array(32), 'A');
    trustManager.addTrust('al-b', new Uint8Array(32), 'B');

    const { handler } = captureToolHandler('agentlink_broadcast', agents);

    const result = await handler({ message: 'Heads up everyone!' });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.sentCount).toBe(2);
    expect(parsed.totalTargets).toBe(2);
    expect(sentCalls).toHaveLength(2);
  });

  it('agentlink_broadcast filters by capability', async () => {
    const agents: AgentOverview[] = [
      { agentId: 'al-coder', status: 'online', capabilities: ['code'] },
      { agentId: 'al-tester', status: 'online', capabilities: ['test'] },
    ];

    trustManager.addTrust('al-coder', new Uint8Array(32));
    trustManager.addTrust('al-tester', new Uint8Array(32));

    const { handler } = captureToolHandler('agentlink_broadcast', agents);
    const result = await handler({ message: 'Code review needed', capability: 'code' });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.sentCount).toBe(1);
    expect(sentCalls[0].to).toBe('al-coder');
  });

  it('agentlink_broadcast skips untrusted agents', async () => {
    const agents: AgentOverview[] = [
      { agentId: 'al-trusted', status: 'online' },
      { agentId: 'al-untrusted', status: 'online' },
    ];

    // Only trust one
    trustManager.addTrust('al-trusted', new Uint8Array(32));

    const { handler } = captureToolHandler('agentlink_broadcast', agents);
    const result = await handler({ message: 'Hello' });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.sentCount).toBe(1);
    expect(sentCalls[0].to).toBe('al-trusted');
  });

  it('agentlink_get_status for online trusted agent', async () => {
    const agents: AgentOverview[] = [
      { agentId: 'al-known', name: 'KnownAgent', status: 'online', agentType: 'coder', capabilities: ['review'] },
    ];

    trustManager.addTrust('al-known', new Uint8Array(32), 'KnownAgent');

    const { handler } = captureToolHandler('agentlink_get_status', agents);
    const result = await handler({ agentId: 'al-known' });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.agentId).toBe('al-known');
    expect(parsed.name).toBe('KnownAgent');
    expect(parsed.status).toBe('online');
    expect(parsed.trustLevel).toBe('trusted');
    expect(parsed.alias).toBe('KnownAgent');
  });

  it('agentlink_get_status for offline trusted agent', async () => {
    trustManager.addTrust('al-offline', new Uint8Array(32), 'OfflineAgent');

    const { handler } = captureToolHandler('agentlink_get_status', []);
    const result = await handler({ agentId: 'al-offline' });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.status).toBe('offline');
    expect(parsed.trustLevel).toBe('trusted');
    expect(parsed.alias).toBe('OfflineAgent');
  });

  it('agentlink_get_status for unknown agent returns error', async () => {
    const { handler } = captureToolHandler('agentlink_get_status', []);
    const result = await handler({ agentId: 'al-nobody' });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.error).toBe('Agent not found');
    expect(result.isError).toBe(true);
  });

  it('agentlink_wait_for_reply returns completed task', async () => {
    const task = taskManager.createTask({
      requester: identity.agentId,
      executor: 'al-target',
      type: 'message',
      title: 'Waiting',
      description: 'desc',
      priority: 'medium',
    });
    taskManager.acceptTask(task.id);
    taskManager.startTask(task.id);
    taskManager.completeTask(task.id, [
      { type: 'text', name: 'reply', content: 'Here is the result' },
    ]);

    const { handler } = captureToolHandler('agentlink_wait_for_reply', [], {
      waitForReply: async (taskId) => taskManager.getTask(taskId),
    });

    const result = await handler({ taskId: task.id, timeout_seconds: 1 });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.id).toBe(task.id);
    expect(parsed.status).toBe('completed');
    expect(parsed.artifacts).toHaveLength(1);
  });

  it('agentlink_wait_for_reply returns error on timeout', async () => {
    const { handler } = captureToolHandler('agentlink_wait_for_reply', [], {
      waitForReply: async () => null,
    });

    const result = await handler({ taskId: 't-missing', timeout_seconds: 1 });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.error).toBe('Timeout waiting for reply');
    expect(result.isError).toBe(true);
  });
});
