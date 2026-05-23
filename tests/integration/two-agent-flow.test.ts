import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateIdentity, signMessage } from '../../src/core/identity.js';
import { Transport } from '../../src/core/transport.js';
import { TaskManager } from '../../src/core/task-manager.js';
import { TrustManager } from '../../src/core/trust-manager.js';
import type { AgentIdentity, AgentLinkMessage, Artifact } from '../../src/core/types.js';
import { Methods } from '../../src/core/types.js';

// Use ports well above the unit test range to avoid collisions
const TEST_PORT_BASE = 29800;
let portCounter = 0;
function nextPort(): number {
  return TEST_PORT_BASE + (portCounter++ % 100);
}

function makeMessage(
  identity: AgentIdentity,
  method: string,
  params: Record<string, unknown> = {},
): AgentLinkMessage {
  const msg = {
    jsonrpc: '2.0' as const,
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    method,
    params,
    timestamp: new Date().toISOString(),
  };
  const signature = signMessage(msg, identity.secretKey);
  return { ...msg, signature };
}

describe('Two-agent end-to-end flow', () => {
  let identityA: AgentIdentity;
  let identityB: AgentIdentity;
  let taskManagerA: TaskManager;
  let taskManagerB: TaskManager;
  let trustManagerA: TrustManager;
  let trustManagerB: TrustManager;
  let transportA: Transport;
  let transportB: Transport;
  let portA: number;

  // Collected messages for each side
  const receivedA: Array<{ agentId: string; msg: AgentLinkMessage }> = [];
  const receivedB: Array<{ agentId: string; msg: AgentLinkMessage }> = [];

  // Temp directories for this test run
  let tempDir: string;

  beforeEach(async () => {
    portCounter = 0;
    receivedA.length = 0;
    receivedB.length = 0;

    // 1. Create two agent identities
    identityA = await generateIdentity({
      name: 'Agent-A',
      agentType: 'coder',
      capabilities: ['code-review', 'refactoring'],
    });
    identityB = await generateIdentity({
      name: 'Agent-B',
      agentType: 'tester',
      capabilities: ['testing', 'qa'],
    });

    // Prepare temp directory for SQLite and trust files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-integ-'));

    // 2. Create two TaskManager instances (temp SQLite DBs)
    taskManagerA = new TaskManager(path.join(tempDir, 'agent-a.db'));
    taskManagerB = new TaskManager(path.join(tempDir, 'agent-b.db'));

    // 3. Create two TrustManager instances — have them trust each other
    trustManagerA = new TrustManager(path.join(tempDir, 'agent-a-trust.json'));
    trustManagerB = new TrustManager(path.join(tempDir, 'agent-b-trust.json'));

    trustManagerA.addTrust(identityB.agentId, identityB.publicKey, 'Agent-B');
    trustManagerB.addTrust(identityA.agentId, identityA.publicKey, 'Agent-A');

    // 4. Start two Transport instances on different ports
    transportA = new Transport(identityA, (agentId, msg) => {
      receivedA.push({ agentId, msg });
    });
    transportB = new Transport(identityB, (agentId, msg) => {
      receivedB.push({ agentId, msg });
    });

    portA = nextPort();
    await transportA.startServer(portA);
  });

  afterEach(() => {
    // 14. Clean up all resources
    transportA.stop();
    transportB.stop();
    taskManagerA.close();
    taskManagerB.close();

    // Remove temp directory
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should complete the full two-agent task lifecycle', async () => {
    // Verify mutual trust was established
    expect(trustManagerA.isTrusted(identityB.agentId)).toBe(true);
    expect(trustManagerB.isTrusted(identityA.agentId)).toBe(true);

    // 5. Agent B connects to Agent A's server
    await transportB.connect('127.0.0.1', portA);

    // 6. Verify both sides see each other as connected peers
    expect(transportA.connectedPeers).toContain(identityB.agentId);
    expect(transportB.connectedPeers).toContain(identityA.agentId);

    // --- Phase 1: Agent A sends task.create to Agent B ---

    // Agent A creates a task locally first
    const task = taskManagerA.createTask({
      requester: identityA.agentId,
      executor: identityB.agentId,
      type: 'code-review',
      title: 'Review authentication module',
      description: 'Please review the auth module for security issues',
      priority: 'high',
    });

    // 7. Agent A sends task.create message to Agent B
    const taskCreateMsg = makeMessage(identityA, Methods.TASK_CREATE, {
      taskId: task.id,
      type: task.type,
      title: task.title,
      description: task.description,
      priority: task.priority,
      requester: identityA.agentId,
      executor: identityB.agentId,
    });
    transportA.send(identityB.agentId, taskCreateMsg);

    // 8. Agent B receives the message
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(receivedB.length).toBe(1);
    expect(receivedB[0].agentId).toBe(identityA.agentId);
    expect(receivedB[0].msg.method).toBe(Methods.TASK_CREATE);
    expect(receivedB[0].msg.params.title).toBe('Review authentication module');

    // 9. Agent B creates a task in its TaskManager
    const receivedParams = receivedB[0].msg.params;
    const taskOnB = taskManagerB.createTask({
      requester: receivedParams.requester as string,
      executor: receivedParams.executor as string,
      type: receivedParams.type as string,
      title: receivedParams.title as string,
      description: receivedParams.description as string,
      priority: receivedParams.priority as string,
    });
    expect(taskOnB.status).toBe('created');

    // 10. Agent B sends task.accept back to Agent A
    const acceptedTask = taskManagerB.acceptTask(taskOnB.id);
    expect(acceptedTask.status).toBe('in_progress');

    const taskAcceptMsg = makeMessage(identityB, Methods.TASK_ACCEPT, {
      taskId: taskOnB.id,
      acceptedBy: identityB.agentId,
    });
    transportB.send(identityA.agentId, taskAcceptMsg);

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Agent A should have received the accept message
    const acceptMsgForA = receivedA.find((r) => r.msg.method === Methods.TASK_ACCEPT);
    expect(acceptMsgForA).toBeDefined();
    expect(acceptMsgForA!.msg.params.taskId).toBe(taskOnB.id);

    // 11. Agent B sends task.progress with 50%
    const taskProgressMsg = makeMessage(identityB, Methods.TASK_PROGRESS, {
      taskId: taskOnB.id,
      percent: 50,
      note: 'Halfway through review',
    });
    transportB.send(identityA.agentId, taskProgressMsg);

    // Update progress locally on B side too
    taskManagerB.updateProgress(taskOnB.id, { percent: 50, note: 'Halfway through review' });

    await new Promise((resolve) => setTimeout(resolve, 200));

    // 12. Agent B sends task.complete with an artifact
    const artifact: Artifact = {
      type: 'text',
      name: 'review-report.md',
      content: '# Code Review Report\n\n## Summary\nNo critical security issues found.\n\n## Recommendations\n- Add rate limiting to login endpoint\n- Use bcrypt instead of SHA-256 for passwords',
      mimeType: 'text/markdown',
    };

    const completedTask = taskManagerB.completeTask(taskOnB.id, [artifact]);
    expect(completedTask.status).toBe('completed');

    const taskCompleteMsg = makeMessage(identityB, Methods.TASK_COMPLETE, {
      taskId: taskOnB.id,
      artifacts: [artifact],
    });
    transportB.send(identityA.agentId, taskCompleteMsg);

    await new Promise((resolve) => setTimeout(resolve, 300));

    // 13. Verify Agent A received all messages in order
    expect(receivedA.length).toBeGreaterThanOrEqual(3);

    // Check task.accept
    const acceptMsg = receivedA.find((r) => r.msg.method === Methods.TASK_ACCEPT);
    expect(acceptMsg).toBeDefined();
    expect(acceptMsg!.agentId).toBe(identityB.agentId);
    expect(acceptMsg!.msg.params.acceptedBy).toBe(identityB.agentId);

    // Check task.progress
    const progressMsg = receivedA.find((r) => r.msg.method === Methods.TASK_PROGRESS);
    expect(progressMsg).toBeDefined();
    expect(progressMsg!.msg.params.percent).toBe(50);
    expect(progressMsg!.msg.params.note).toBe('Halfway through review');

    // Check task.complete
    const completeMsg = receivedA.find((r) => r.msg.method === Methods.TASK_COMPLETE);
    expect(completeMsg).toBeDefined();
    expect(completeMsg!.msg.params.taskId).toBe(taskOnB.id);

    // Verify the artifact was received correctly
    const receivedArtifacts = completeMsg!.msg.params.artifacts as Artifact[];
    expect(receivedArtifacts).toHaveLength(1);
    expect(receivedArtifacts[0].type).toBe('text');
    expect(receivedArtifacts[0].name).toBe('review-report.md');
    expect(receivedArtifacts[0].content).toContain('No critical security issues found');
    expect(receivedArtifacts[0].mimeType).toBe('text/markdown');

    // Verify message ordering: accept before progress, progress before complete
    const acceptIdx = receivedA.findIndex((r) => r.msg.method === Methods.TASK_ACCEPT);
    const progressIdx = receivedA.findIndex((r) => r.msg.method === Methods.TASK_PROGRESS);
    const completeIdx = receivedA.findIndex((r) => r.msg.method === Methods.TASK_COMPLETE);
    expect(acceptIdx).toBeLessThan(progressIdx);
    expect(progressIdx).toBeLessThan(completeIdx);

    // Verify task state on B side is complete
    const finalTaskOnB = taskManagerB.getTask(taskOnB.id);
    expect(finalTaskOnB!.status).toBe('completed');
    expect(finalTaskOnB!.artifacts).toHaveLength(1);
    expect(finalTaskOnB!.artifacts[0].name).toBe('review-report.md');

    // Verify trust still holds
    expect(trustManagerA.isTrusted(identityB.agentId)).toBe(true);
    expect(trustManagerB.isTrusted(identityA.agentId)).toBe(true);
  });
}, 30000);
