/**
 * Integration: Multi-agent mesh topology
 *
 * Verifies that 3+ agents can form a fully-connected mesh,
 * broadcast messages fan out correctly, and tasks reach the
 * right executor without cross-contamination.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TestAgent, cleanupAgents, createAgentMesh } from './helpers/test-harness.js';
import { Methods } from '../../src/core/types.js';

let agents: TestAgent[] = [];

afterEach(() => {
  cleanupAgents(agents);
  agents = [];
});

describe('Multi-agent mesh', () => {
  it('forms a fully-connected 3-agent mesh', async () => {
    agents = await createAgentMesh([
      { name: 'Alpha', agentType: 'coder', capabilities: ['review'] },
      { name: 'Beta', agentType: 'tester', capabilities: ['test'] },
      { name: 'Gamma', agentType: 'deployer', capabilities: ['deploy'] },
    ]);

    // Full mesh: each agent sees the other two as peers
    for (const agent of agents) {
      expect(agent.transport.connectedPeers.length).toBe(2);
    }

    // Verify specific connections
    const [a, b, c] = agents;
    expect(a.transport.connectedPeers).toContain(b.identity.agentId);
    expect(a.transport.connectedPeers).toContain(c.identity.agentId);
    expect(b.transport.connectedPeers).toContain(a.identity.agentId);
    expect(b.transport.connectedPeers).toContain(c.identity.agentId);
    expect(c.transport.connectedPeers).toContain(a.identity.agentId);
    expect(c.transport.connectedPeers).toContain(b.identity.agentId);
  });

  it('trust is mutual across all pairs in the mesh', async () => {
    agents = await createAgentMesh([
      { name: 'A', agentType: 'test', capabilities: [] },
      { name: 'B', agentType: 'test', capabilities: [] },
      { name: 'C', agentType: 'test', capabilities: [] },
    ]);

    const [a, b, c] = agents;

    expect(a.trustManager.isTrusted(b.identity.agentId)).toBe(true);
    expect(a.trustManager.isTrusted(c.identity.agentId)).toBe(true);
    expect(b.trustManager.isTrusted(a.identity.agentId)).toBe(true);
    expect(b.trustManager.isTrusted(c.identity.agentId)).toBe(true);
    expect(c.trustManager.isTrusted(a.identity.agentId)).toBe(true);
    expect(c.trustManager.isTrusted(b.identity.agentId)).toBe(true);
  });

  it('point-to-point message reaches only the target', async () => {
    agents = await createAgentMesh([
      { name: 'Sender', agentType: 'test', capabilities: [] },
      { name: 'Target', agentType: 'test', capabilities: [] },
      { name: 'Bystander', agentType: 'test', capabilities: [] },
    ]);

    const [sender, target, bystander] = agents;

    sender.sendMessage(target.identity.agentId, Methods.TASK_CREATE, {
      taskId: 't-private',
      title: 'Private task',
    });

    await sender.flush(300);

    // Target should receive the message
    const targetMsg = target.receivedMessages.find(m => m.msg.method === Methods.TASK_CREATE);
    expect(targetMsg).toBeDefined();
    expect(targetMsg!.msg.params.title).toBe('Private task');

    // Bystander should NOT receive the message
    const bystanderMsg = bystander.receivedMessages.find(m => m.msg.method === Methods.TASK_CREATE);
    expect(bystanderMsg).toBeUndefined();
  });

  it('broadcast from one agent reaches all others', async () => {
    agents = await createAgentMesh([
      { name: 'Caster', agentType: 'test', capabilities: [] },
      { name: 'Receiver1', agentType: 'test', capabilities: [] },
      { name: 'Receiver2', agentType: 'test', capabilities: [] },
    ]);

    const [caster, r1, r2] = agents;

    // Caster sends broadcast to each peer individually
    caster.sendMessage(r1.identity.agentId, Methods.BROADCAST_MESSAGE, { message: 'Hello all' });
    caster.sendMessage(r2.identity.agentId, Methods.BROADCAST_MESSAGE, { message: 'Hello all' });

    await caster.flush(300);

    expect(r1.receivedMessages.filter(m => m.msg.method === Methods.BROADCAST_MESSAGE)).toHaveLength(1);
    expect(r2.receivedMessages.filter(m => m.msg.method === Methods.BROADCAST_MESSAGE)).toHaveLength(1);
  });

  it('concurrent tasks from multiple agents are isolated', async () => {
    agents = await createAgentMesh([
      { name: 'RequesterA', agentType: 'coder', capabilities: [] },
      { name: 'RequesterB', agentType: 'coder', capabilities: [] },
      { name: 'Executor', agentType: 'worker', capabilities: [] },
    ]);

    const [reqA, reqB, executor] = agents;

    // Both requesters send a task to the executor
    const taskA = reqA.createTask({
      executor: executor.identity.agentId,
      type: 'review',
      title: 'Review from A',
      description: 'Task from requester A',
      priority: 'high',
    });
    reqA.sendMessage(executor.identity.agentId, Methods.TASK_CREATE, {
      taskId: taskA.id, title: 'Review from A',
    });

    const taskB = reqB.createTask({
      executor: executor.identity.agentId,
      type: 'test',
      title: 'Test from B',
      description: 'Task from requester B',
      priority: 'medium',
    });
    reqB.sendMessage(executor.identity.agentId, Methods.TASK_CREATE, {
      taskId: taskB.id, title: 'Test from B',
    });

    const msgs = await executor.waitForMessages(Methods.TASK_CREATE, 2);
    expect(msgs).toHaveLength(2);

    // Verify task IDs are different
    const taskIds = msgs.map(m => m.msg.params.taskId);
    expect(taskIds[0]).not.toBe(taskIds[1]);

    // Verify each came from the correct requester
    expect(msgs.find(m => m.agentId === reqA.identity.agentId)).toBeDefined();
    expect(msgs.find(m => m.agentId === reqB.identity.agentId)).toBeDefined();
  });

  it('4-agent mesh connects all 6 bidirectional links', async () => {
    agents = await createAgentMesh([
      { name: 'A', agentType: 'test', capabilities: [] },
      { name: 'B', agentType: 'test', capabilities: [] },
      { name: 'C', agentType: 'test', capabilities: [] },
      { name: 'D', agentType: 'test', capabilities: [] },
    ]);

    // 4 agents → each has 3 peers = 12 total, bidirectional = 6 unique links
    for (const agent of agents) {
      expect(agent.transport.connectedPeers.length).toBe(3);
    }
  });

  it('message ordering is preserved per sender', async () => {
    agents = await createAgentMesh([
      { name: 'Sender', agentType: 'test', capabilities: [] },
      { name: 'Receiver', agentType: 'test', capabilities: [] },
    ]);

    const [sender, receiver] = agents;

    for (let i = 0; i < 10; i++) {
      sender.sendMessage(receiver.identity.agentId, Methods.TASK_PROGRESS, { step: i });
    }

    await sender.flush(500);

    const progress = receiver.receivedMessages.filter(m => m.msg.method === Methods.TASK_PROGRESS);
    expect(progress.length).toBeGreaterThanOrEqual(10);

    for (let i = 0; i < 10; i++) {
      expect(progress[i].msg.params.step).toBe(i);
    }
  });
});
