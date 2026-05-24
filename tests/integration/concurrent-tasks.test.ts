/**
 * Integration: Concurrent tasks
 *
 * Verifies that multiple agents can create and process tasks
 * simultaneously without data corruption or cross-contamination.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TestAgent, cleanupAgents, createAgentMesh } from './helpers/test-harness.js';
import { Methods } from '../../src/core/types.js';
import type { TaskStatus } from '../../src/core/types.js';

let agents: TestAgent[] = [];

afterEach(() => {
  cleanupAgents(agents);
  agents = [];
});

describe('Concurrent tasks', () => {
  it('single agent handles multiple tasks from multiple requesters', async () => {
    agents = await createAgentMesh([
      { name: 'Worker', agentType: 'worker', capabilities: ['code', 'test'] },
      { name: 'Client1', agentType: 'client', capabilities: [] },
      { name: 'Client2', agentType: 'client', capabilities: [] },
      { name: 'Client3', agentType: 'client', capabilities: [] },
    ]);

    const [worker, c1, c2, c3] = agents;

    // All clients send tasks to the worker simultaneously
    const taskPromises = [c1, c2, c3].map(async (client, i) => {
      const task = client.createTask({
        executor: worker.identity.agentId,
        type: 'review',
        title: `Task from client ${i}`,
        description: `Description ${i}`,
        priority: 'medium',
      });

      client.sendMessage(worker.identity.agentId, Methods.TASK_CREATE, {
        taskId: task.id,
        type: task.type,
        title: task.title,
        description: task.description,
        priority: task.priority,
        requester: client.identity.agentId,
        executor: worker.identity.agentId,
      });

      return task;
    });

    const tasks = await Promise.all(taskPromises);
    await c1.flush(500);

    // Worker should have received all 3 tasks
    const createMessages = worker.receivedMessages.filter(m => m.msg.method === Methods.TASK_CREATE);
    expect(createMessages.length).toBeGreaterThanOrEqual(3);

    // Verify each task came from a different requester
    const requesterIds = createMessages.map(m => m.agentId);
    const uniqueRequesters = new Set(requesterIds);
    expect(uniqueRequesters.size).toBe(3);

    // Worker processes all tasks locally
    for (const msg of createMessages) {
      const localTask = worker.taskManager.createTask({
        requester: msg.msg.params.requester as string,
        executor: worker.identity.agentId,
        type: msg.msg.params.type as string,
        title: msg.msg.params.title as string,
        description: msg.msg.params.description as string,
        priority: msg.msg.params.priority as string,
      });
      worker.taskManager.acceptTask(localTask.id);
      worker.taskManager.startTask(localTask.id);
      worker.taskManager.completeTask(localTask.id, [
        { type: 'text', name: 'result.txt', content: `Done for ${msg.msg.params.requester}` },
      ]);
    }

    // Verify all tasks are completed on worker side
    const completedTasks = worker.taskManager.listTasks('completed');
    expect(completedTasks.length).toBeGreaterThanOrEqual(3);
  });

  it('task states are isolated — rejecting one does not affect others', async () => {
    const worker = await TestAgent.create({ name: 'Worker', agentType: 'test', capabilities: [] });
    agents.push(worker);

    // Create multiple tasks on worker
    const t1 = worker.createTask({ executor: 'al-any', type: 'a', title: 'T1', description: '', priority: 'low' });
    const t2 = worker.createTask({ executor: 'al-any', type: 'a', title: 'T2', description: '', priority: 'low' });
    const t3 = worker.createTask({ executor: 'al-any', type: 'a', title: 'T3', description: '', priority: 'low' });

    // Accept t1, reject t2, accept + start t3
    worker.taskManager.acceptTask(t1.id);
    worker.taskManager.rejectTask(t2.id);
    worker.taskManager.acceptTask(t3.id);
    worker.taskManager.startTask(t3.id);

    expect(worker.taskManager.getTask(t1.id)!.status).toBe('accepted');
    expect(worker.taskManager.getTask(t2.id)!.status).toBe('rejected');
    expect(worker.taskManager.getTask(t3.id)!.status).toBe('in_progress');

    // Complete t1 (must start first before completing)
    worker.taskManager.startTask(t1.id);
    worker.taskManager.completeTask(t1.id, []);
    expect(worker.taskManager.getTask(t1.id)!.status).toBe('completed');

    // t2 should still be rejected, t3 should still be in_progress
    expect(worker.taskManager.getTask(t2.id)!.status).toBe('rejected');
    expect(worker.taskManager.getTask(t3.id)!.status).toBe('in_progress');
  });

  it('50 tasks can be created and queried efficiently', async () => {
    const agent = await TestAgent.create({ name: 'Bulk', agentType: 'test', capabilities: [] });
    agents.push(agent);

    const taskIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      const task = agent.createTask({
        executor: `al-exec${i % 5}`,
        type: i % 2 === 0 ? 'review' : 'test',
        title: `Task ${i}`,
        description: `Description ${i}`,
        priority: i < 10 ? 'critical' : i < 25 ? 'high' : 'medium',
      });
      taskIds.push(task.id);
    }

    // All should be queryable
    expect(agent.taskManager.listTasks()).toHaveLength(50);

    // Filter by status
    expect(agent.taskManager.listTasks('created')).toHaveLength(50);

    // Transition some
    for (let i = 0; i < 25; i++) {
      agent.taskManager.acceptTask(taskIds[i]);
    }
    expect(agent.taskManager.listTasks('accepted')).toHaveLength(25);
    expect(agent.taskManager.listTasks('created')).toHaveLength(25);

    // Each task ID is unique
    expect(new Set(taskIds).size).toBe(50);
  });

  it('simultaneous messages from multiple senders all arrive', async () => {
    agents = await createAgentMesh([
      { name: 'Hub', agentType: 'hub', capabilities: [] },
      { name: 'S1', agentType: 'sender', capabilities: [] },
      { name: 'S2', agentType: 'sender', capabilities: [] },
    ]);

    const [hub, s1, s2] = agents;

    // Both senders send messages simultaneously
    s1.sendMessage(hub.identity.agentId, Methods.TASK_CREATE, { from: 'S1', data: 'alpha' });
    s2.sendMessage(hub.identity.agentId, Methods.TASK_CREATE, { from: 'S2', data: 'beta' });

    const msgs = await hub.waitForMessages(Methods.TASK_CREATE, 2);

    const fromS1 = msgs.find(m => m.msg.params.from === 'S1');
    const fromS2 = msgs.find(m => m.msg.params.from === 'S2');
    expect(fromS1).toBeDefined();
    expect(fromS2).toBeDefined();
    expect(fromS1!.msg.params.data).toBe('alpha');
    expect(fromS2!.msg.params.data).toBe('beta');
  });

  it('task artifacts do not leak between tasks', async () => {
    const agent = await TestAgent.create({ name: 'Worker', agentType: 'test', capabilities: [] });
    agents.push(agent);

    const t1 = agent.createTask({ executor: 'al-x', type: 'a', title: 'T1', description: '', priority: 'low' });
    const t2 = agent.createTask({ executor: 'al-y', type: 'a', title: 'T2', description: '', priority: 'low' });

    agent.taskManager.acceptTask(t1.id);
    agent.taskManager.startTask(t1.id);
    agent.taskManager.completeTask(t1.id, [{ type: 'text', name: 'artifact-1', content: 'only for t1' }]);

    // t2 should still have no artifacts
    const reloadedT2 = agent.taskManager.getTask(t2.id);
    expect(reloadedT2!.artifacts).toHaveLength(0);
    expect(reloadedT2!.status).toBe('created');
  });
});
