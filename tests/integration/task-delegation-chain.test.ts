/**
 * Integration: Task delegation chain (A → B → C)
 *
 * Verifies that a task can be delegated across a chain of agents,
 * artifacts accumulate correctly through the chain, and each agent's
 * local TaskManager state stays consistent.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TestAgent, cleanupAgents } from './helpers/test-harness.js';
import { Methods } from '../../src/core/types.js';
import type { Artifact } from '../../src/core/types.js';

let agents: TestAgent[] = [];

afterEach(() => {
  cleanupAgents(agents);
  agents = [];
});

describe('Task delegation chain', () => {
  it('delegates a task through A → B → C with artifacts', async () => {
    const a = await TestAgent.create({ name: 'Planner', agentType: 'planner', capabilities: ['plan'] });
    const b = await TestAgent.create({ name: 'Coder', agentType: 'coder', capabilities: ['code'] });
    const c = await TestAgent.create({ name: 'Tester', agentType: 'tester', capabilities: ['test'] });
    agents.push(a, b, c);

    await a.start();
    await b.start();
    await c.start();

    // Chain topology: A → B → C (linear, not full mesh)
    a.trustOther(b);
    b.trustOther(c);

    await a.connectTo(b);
    await b.connectTo(c);

    // ---- Step 1: A creates a task and sends to B ----
    const taskOnA = a.createTask({
      executor: b.identity.agentId,
      type: 'implement',
      title: 'Implement auth module',
      description: 'Write authentication module with JWT',
      priority: 'high',
    });

    a.sendMessage(b.identity.agentId, Methods.TASK_CREATE, {
      taskId: taskOnA.id,
      type: taskOnA.type,
      title: taskOnA.title,
      description: taskOnA.description,
      priority: taskOnA.priority,
      requester: a.identity.agentId,
      executor: b.identity.agentId,
    });

    const msgAtB = await b.waitForMessage(Methods.TASK_CREATE);
    expect(msgAtB.msg.params.title).toBe('Implement auth module');

    // ---- Step 2: B accepts and starts the task ----
    const taskOnB = b.taskManager.createTask({
      requester: a.identity.agentId,
      executor: b.identity.agentId,
      type: msgAtB.msg.params.type as string,
      title: msgAtB.msg.params.title as string,
      description: msgAtB.msg.params.description as string,
      priority: msgAtB.msg.params.priority as string,
    });

    b.taskManager.acceptTask(taskOnB.id);
    b.taskManager.startTask(taskOnB.id);

    b.sendMessage(a.identity.agentId, Methods.TASK_ACCEPT, {
      taskId: taskOnB.id,
      acceptedBy: b.identity.agentId,
    });

    const acceptAtA = await a.waitForMessage(Methods.TASK_ACCEPT);
    expect(acceptAtA.msg.params.acceptedBy).toBe(b.identity.agentId);

    // ---- Step 3: B delegates a sub-task to C ----
    const subTask = b.createTask({
      executor: c.identity.agentId,
      type: 'test',
      title: 'Write tests for auth module',
      description: 'Unit and integration tests',
      priority: 'high',
    });

    b.sendMessage(c.identity.agentId, Methods.TASK_CREATE, {
      taskId: subTask.id,
      type: subTask.type,
      title: subTask.title,
      description: subTask.description,
      priority: subTask.priority,
      requester: b.identity.agentId,
      executor: c.identity.agentId,
    });

    const msgAtC = await c.waitForMessage(Methods.TASK_CREATE);
    expect(msgAtC.msg.params.title).toBe('Write tests for auth module');
    expect(msgAtC.agentId).toBe(b.identity.agentId);

    // ---- Step 4: C completes the sub-task with artifacts ----
    const testArtifact: Artifact = {
      type: 'code',
      name: 'auth.test.ts',
      content: 'describe("auth", () => { it("should validate JWT", () => {}); });',
      mimeType: 'text/typescript',
    };

    const taskOnC = c.taskManager.createTask({
      requester: b.identity.agentId,
      executor: c.identity.agentId,
      type: 'test',
      title: 'Write tests for auth module',
      description: 'Unit and integration tests',
      priority: 'high',
    });
    c.taskManager.acceptTask(taskOnC.id);
    c.taskManager.startTask(taskOnC.id);
    c.taskManager.completeTask(taskOnC.id, [testArtifact]);

    c.sendMessage(b.identity.agentId, Methods.TASK_COMPLETE, {
      taskId: taskOnC.id,
      artifacts: [testArtifact],
    });

    const completeAtB = await b.waitForMessage(Methods.TASK_COMPLETE);
    expect(completeAtB.msg.params.artifacts).toHaveLength(1);
    expect((completeAtB.msg.params.artifacts as Artifact[])[0].name).toBe('auth.test.ts');

    // ---- Step 5: B completes its task with combined artifacts ----
    const implArtifact: Artifact = {
      type: 'code',
      name: 'auth.ts',
      content: 'export function validateJWT(token: string): boolean { return true; }',
      mimeType: 'text/typescript',
    };

    b.taskManager.completeTask(taskOnB.id, [implArtifact, testArtifact]);

    b.sendMessage(a.identity.agentId, Methods.TASK_COMPLETE, {
      taskId: taskOnB.id,
      artifacts: [implArtifact, testArtifact],
    });

    const completeAtA = await a.waitForMessage(Methods.TASK_COMPLETE);
    const receivedArtifacts = completeAtA.msg.params.artifacts as Artifact[];
    expect(receivedArtifacts).toHaveLength(2);
    expect(receivedArtifacts.find(ar => ar.name === 'auth.ts')).toBeDefined();
    expect(receivedArtifacts.find(ar => ar.name === 'auth.test.ts')).toBeDefined();

    // ---- Verify final state on all agents ----
    expect(a.taskManager.getTask(taskOnA.id)!.status).toBe('created'); // local task on A
    expect(b.taskManager.getTask(taskOnB.id)!.status).toBe('completed');
    expect(b.taskManager.getTask(taskOnB.id)!.artifacts).toHaveLength(2);
    expect(c.taskManager.getTask(taskOnC.id)!.status).toBe('completed');
    expect(c.taskManager.getTask(taskOnC.id)!.artifacts[0].name).toBe('auth.test.ts');
  });

  it('task rejection propagates back through the chain', async () => {
    const a = await TestAgent.create({ name: 'Requester', agentType: 'test', capabilities: [] });
    const b = await TestAgent.create({ name: 'Rejector', agentType: 'test', capabilities: [] });
    agents.push(a, b);

    await a.start();
    await b.start();
    a.trustOther(b);
    await a.connectTo(b);

    const task = a.createTask({
      executor: b.identity.agentId,
      type: 'review',
      title: 'Review code',
      description: 'Please review',
      priority: 'medium',
    });

    a.sendMessage(b.identity.agentId, Methods.TASK_CREATE, {
      taskId: task.id,
      title: 'Review code',
    });

    await b.waitForMessage(Methods.TASK_CREATE);

    // B rejects
    b.sendMessage(a.identity.agentId, Methods.TASK_REJECT, {
      taskId: task.id,
      reason: 'Not enough context',
    });

    const rejectAtA = await a.waitForMessage(Methods.TASK_REJECT);
    expect(rejectAtA.msg.params.reason).toBe('Not enough context');
  });

  it('progress updates flow through the chain', async () => {
    const a = await TestAgent.create({ name: 'Manager', agentType: 'test', capabilities: [] });
    const b = await TestAgent.create({ name: 'Worker', agentType: 'test', capabilities: [] });
    agents.push(a, b);

    await a.start();
    await b.start();
    a.trustOther(b);
    await a.connectTo(b);

    // B sends multiple progress updates to A
    for (let i = 25; i <= 100; i += 25) {
      b.sendMessage(a.identity.agentId, Methods.TASK_PROGRESS, {
        taskId: 't-progress',
        percent: i,
        note: `${i}% done`,
      });
    }

    const msgs = await a.waitForMessages(Methods.TASK_PROGRESS, 4);
    const percents = msgs.map(m => m.msg.params.percent);
    expect(percents).toEqual([25, 50, 75, 100]);
  });
});
