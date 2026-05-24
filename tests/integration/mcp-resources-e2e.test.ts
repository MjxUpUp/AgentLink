/**
 * Integration: MCP resources end-to-end
 *
 * Verifies that MCP resource handlers return data consistent with
 * the real TaskManager, TrustManager, and online agent state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerResources, type ToolDeps, type AgentOverview } from '../../src/mcp/tools.js';
import { TaskManager } from '../../src/core/task-manager.js';
import { TrustManager } from '../../src/core/trust-manager.js';
import type { AgentIdentity } from '../../src/core/types.js';
import { generateIdentity } from '../../src/core/identity.js';

let tmpDir: string;
let taskManager: TaskManager;
let trustManager: TrustManager;
let identity: AgentIdentity;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-mcp-res-'));
  taskManager = new TaskManager(path.join(tmpDir, 'tasks.db'));
  trustManager = new TrustManager(path.join(tmpDir, 'trust.json'));
  identity = await generateIdentity({ name: 'ResBot', agentType: 'test', capabilities: [] });
});

afterEach(() => {
  taskManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function captureResourceHandler(
  uri: string,
  onlineAgents: AgentOverview[],
): (uri: URL) => Promise<any> {
  let capturedHandler: ((uri: URL) => Promise<any>) | null = null;

  const mockServer = {
    tool: () => {},
    resource: (_name: string, resourceUri: string, handler: (uri: URL) => Promise<any>) => {
      if (resourceUri === uri) capturedHandler = handler;
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
  if (!capturedHandler) throw new Error(`Resource not found: ${uri}`);
  return capturedHandler;
}

describe('MCP resources e2e', () => {
  describe('agentlink://agents', () => {
    it('returns current online agents', async () => {
      const agents: AgentOverview[] = [
        { agentId: 'al-a1', name: 'Agent1', status: 'online', capabilities: ['code'] },
        { agentId: 'al-a2', name: 'Agent2', status: 'online', capabilities: ['test'] },
      ];

      const handler = captureResourceHandler('agentlink://agents', agents);
      const result = await handler(new URL('agentlink://agents'));
      const parsed = JSON.parse(result.contents[0].text as string);

      expect(parsed).toHaveLength(2);
      expect(parsed[0].agentId).toBe('al-a1');
      expect(parsed[1].capabilities).toEqual(['test']);
    });

    it('returns empty array when no agents online', async () => {
      const handler = captureResourceHandler('agentlink://agents', []);
      const result = await handler(new URL('agentlink://agents'));
      const parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed).toHaveLength(0);
    });

    it('reflects changes in online agents between calls', async () => {
      let agents: AgentOverview[] = [
        { agentId: 'al-a', status: 'online' },
      ];

      const handler = captureResourceHandler('agentlink://agents', agents);

      // First call — 1 agent
      let result = await handler(new URL('agentlink://agents'));
      let parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed).toHaveLength(1);

      // "Agent goes offline" — next call should reflect empty
      // (since our getOnlineAgents closure captures the mutable array)
      agents.length = 0;
      result = await handler(new URL('agentlink://agents'));
      parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed).toHaveLength(0);
    });
  });

  describe('agentlink://tasks', () => {
    it('returns only active (non-terminal) tasks', async () => {
      const t1 = taskManager.createTask({
        requester: 'a', executor: 'b', type: 't', title: 'Active', description: '', priority: 'low',
      });
      const t2 = taskManager.createTask({
        requester: 'a', executor: 'b', type: 't', title: 'Completed', description: '', priority: 'low',
      });
      const t3 = taskManager.createTask({
        requester: 'a', executor: 'b', type: 't', title: 'Failed', description: '', priority: 'low',
      });

      taskManager.acceptTask(t2.id);
      taskManager.startTask(t2.id);
      taskManager.completeTask(t2.id, []);

      taskManager.acceptTask(t3.id);
      taskManager.startTask(t3.id);
      taskManager.failTask(t3.id, 'error');

      const handler = captureResourceHandler('agentlink://tasks', []);
      const result = await handler(new URL('agentlink://tasks'));
      const parsed = JSON.parse(result.contents[0].text as string);

      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe(t1.id);
      expect(parsed[0].status).toBe('created');
    });

    it('returns empty when all tasks are terminal', async () => {
      const t = taskManager.createTask({
        requester: 'a', executor: 'b', type: 't', title: 'X', description: '', priority: 'low',
      });
      // Use 'completed' which IS in the terminal filter (completed/failed/cancelled)
      taskManager.acceptTask(t.id);
      taskManager.startTask(t.id);
      taskManager.completeTask(t.id, []);

      const handler = captureResourceHandler('agentlink://tasks', []);
      const result = await handler(new URL('agentlink://tasks'));
      const parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed).toHaveLength(0);
    });

    it('returns multiple active tasks in different states', async () => {
      const t1 = taskManager.createTask({
        requester: 'a', executor: 'b', type: 't', title: 'Created', description: '', priority: 'low',
      });
      const t2 = taskManager.createTask({
        requester: 'a', executor: 'b', type: 't', title: 'Accepted', description: '', priority: 'low',
      });
      const t3 = taskManager.createTask({
        requester: 'a', executor: 'b', type: 't', title: 'InProgress', description: '', priority: 'low',
      });

      taskManager.acceptTask(t2.id);
      taskManager.acceptTask(t3.id);
      taskManager.startTask(t3.id);

      const handler = captureResourceHandler('agentlink://tasks', []);
      const result = await handler(new URL('agentlink://tasks'));
      const parsed = JSON.parse(result.contents[0].text as string);

      expect(parsed).toHaveLength(3);
      const statuses = parsed.map((t: any) => t.status);
      expect(statuses).toContain('created');
      expect(statuses).toContain('accepted');
      expect(statuses).toContain('in_progress');
    });

    it('reflects task status changes between calls', async () => {
      const t = taskManager.createTask({
        requester: 'a', executor: 'b', type: 't', title: 'Dynamic', description: '', priority: 'low',
      });

      const handler = captureResourceHandler('agentlink://tasks', []);

      // Initially active
      let result = await handler(new URL('agentlink://tasks'));
      let parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed).toHaveLength(1);

      // Complete the task
      taskManager.acceptTask(t.id);
      taskManager.startTask(t.id);
      taskManager.completeTask(t.id, []);

      // Now should be empty
      result = await handler(new URL('agentlink://tasks'));
      parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed).toHaveLength(0);
    });
  });

  describe('agentlink://trust', () => {
    it('returns trusted agents with correct details', async () => {
      trustManager.addTrust('al-trusted1', new Uint8Array(32), 'Agent One');
      trustManager.addTrust('al-trusted2', new Uint8Array(32), 'Agent Two');

      const handler = captureResourceHandler('agentlink://trust', []);
      const result = await handler(new URL('agentlink://trust'));
      const parsed = JSON.parse(result.contents[0].text as string);

      expect(parsed).toHaveLength(2);
      expect(parsed[0].agentId).toBe('al-trusted1');
      expect(parsed[0].alias).toBe('Agent One');
      expect(parsed[0].trustLevel).toBe('trusted');
      expect(parsed[0].autoApprove).toBe(true);
    });

    it('returns empty when no trusted agents', async () => {
      const handler = captureResourceHandler('agentlink://trust', []);
      const result = await handler(new URL('agentlink://trust'));
      const parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed).toHaveLength(0);
    });

    it('reflects trust changes between calls', async () => {
      trustManager.addTrust('al-t1', new Uint8Array(32));

      const handler = captureResourceHandler('agentlink://trust', []);

      let result = await handler(new URL('agentlink://trust'));
      let parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed).toHaveLength(1);

      trustManager.removeTrust('al-t1');

      result = await handler(new URL('agentlink://trust'));
      parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed).toHaveLength(0);
    });
  });
});
