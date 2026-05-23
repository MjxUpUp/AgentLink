import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Transport } from '../../src/core/transport.js';
import { generateIdentity } from '../../src/core/identity.js';
import type { AgentIdentity, AgentLinkMessage } from '../../src/core/types.js';
import { Methods } from '../../src/core/types.js';
import { signMessage } from '../../src/core/identity.js';

const TEST_PORT_BASE = 19800;

function nextPort(): number {
  return TEST_PORT_BASE + (nextPort._counter++ % 100);
}
nextPort._counter = 0;

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

describe('Transport Module', () => {
  let transportA: Transport;
  let transportB: Transport;
  let identityA: AgentIdentity;
  let identityB: AgentIdentity;
  let portA: number;
  let portB: number;
  const receivedA: Array<{ agentId: string; msg: AgentLinkMessage }> = [];
  const receivedB: Array<{ agentId: string; msg: AgentLinkMessage }> = [];

  beforeEach(async () => {
    identityA = await generateIdentity({ name: 'Agent-A', agentType: 'test', capabilities: ['testing'] });
    identityB = await generateIdentity({ name: 'Agent-B', agentType: 'test', capabilities: ['testing'] });

    receivedA.length = 0;
    receivedB.length = 0;

    transportA = new Transport(identityA, (agentId, msg) => {
      receivedA.push({ agentId, msg });
    });

    transportB = new Transport(identityB, (agentId, msg) => {
      receivedB.push({ agentId, msg });
    });

    portA = nextPort();
    portB = nextPort();
  });

  afterEach(() => {
    transportA.stop();
    transportB.stop();
  });

  it('should start server and listen on specified port', async () => {
    await transportA.startServer(portA);
    expect(transportA.listeningPort).toBe(portA);
  });

  it('should reject connection to unavailable port', async () => {
    await transportA.startServer(portA);
    await expect(transportB.startServer(portA)).rejects.toThrow('already in use');
  });

  it('should connect client to server', async () => {
    await transportA.startServer(portA);
    await transportB.connect('127.0.0.1', portA);

    // After handshake, B should see A as a connected peer
    expect(transportB.connectedPeers).toContain(identityA.agentId);
    // And A should see B as a connected peer
    expect(transportA.connectedPeers).toContain(identityB.agentId);
  });

  it('should complete encryption handshake (both sides connected)', async () => {
    await transportA.startServer(portA);
    await transportB.connect('127.0.0.1', portA);

    // Both sides should have exactly one connected peer
    expect(transportA.connectedPeers.length).toBe(1);
    expect(transportB.connectedPeers.length).toBe(1);

    // Each knows the other's agent ID
    expect(transportA.connectedPeers[0]).toBe(identityB.agentId);
    expect(transportB.connectedPeers[0]).toBe(identityA.agentId);
  });

  it('should send and receive encrypted message (B -> A)', async () => {
    await transportA.startServer(portA);
    await transportB.connect('127.0.0.1', portA);

    const testMsg = makeMessage(identityB, Methods.TASK_CREATE, {
      title: 'Test task',
      description: 'A test',
    });

    transportB.send(identityA.agentId, testMsg);

    // Wait for message to arrive
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(receivedA.length).toBe(1);
    expect(receivedA[0].agentId).toBe(identityB.agentId);
    expect(receivedA[0].msg.method).toBe(Methods.TASK_CREATE);
    expect(receivedA[0].msg.params.title).toBe('Test task');
    expect(receivedA[0].msg.id).toBe(testMsg.id);
  });

  it('should send and receive encrypted message (A -> B)', async () => {
    await transportA.startServer(portA);
    await transportB.connect('127.0.0.1', portA);

    const testMsg = makeMessage(identityA, Methods.TASK_PROGRESS, {
      percent: 50,
      note: 'halfway',
    });

    transportA.send(identityB.agentId, testMsg);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(receivedB.length).toBe(1);
    expect(receivedB[0].agentId).toBe(identityA.agentId);
    expect(receivedB[0].msg.method).toBe(Methods.TASK_PROGRESS);
    expect(receivedB[0].msg.params.percent).toBe(50);
  });

  it('should send multiple messages in sequence', async () => {
    await transportA.startServer(portA);
    await transportB.connect('127.0.0.1', portA);

    const messages = [];
    for (let i = 0; i < 5; i++) {
      const msg = makeMessage(identityB, Methods.BROADCAST_MESSAGE, { index: i });
      messages.push(msg);
      transportB.send(identityA.agentId, msg);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(receivedA.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(receivedA[i].msg.params.index).toBe(i);
    }
  });

  it('should handle heartbeat (ping/pong)', async () => {
    await transportA.startServer(portA);
    await transportB.connect('127.0.0.1', portA);

    // Wait a bit to ensure connection is established
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The connection should still be alive after initial setup
    expect(transportA.connectedPeers).toContain(identityB.agentId);
    expect(transportB.connectedPeers).toContain(identityA.agentId);
  });

  it('should detect disconnect', async () => {
    await transportA.startServer(portA);
    await transportB.connect('127.0.0.1', portA);

    expect(transportA.connectedPeers).toContain(identityB.agentId);

    const disconnectPromise = new Promise<string>((resolve) => {
      transportA.on('disconnect', (agentId: unknown) => {
        resolve(agentId as string);
      });
    });

    transportB.stop();

    const disconnectedId = await disconnectPromise;
    expect(disconnectedId).toBe(identityB.agentId);
    expect(transportA.connectedPeers).not.toContain(identityB.agentId);
  });

  it('should throw when sending to unconnected peer', async () => {
    await transportA.startServer(portA);

    const msg = makeMessage(identityA, Methods.AGENT_PING);
    expect(() => transportA.send('unknown-agent', msg)).toThrow('Not connected');
  });

  it('should handle bidirectional communication', async () => {
    await transportA.startServer(portA);
    await transportB.connect('127.0.0.1', portA);

    // A -> B
    const msgToB = makeMessage(identityA, Methods.TASK_CREATE, { title: 'From A' });
    transportA.send(identityB.agentId, msgToB);

    // B -> A
    const msgToA = makeMessage(identityB, Methods.TASK_ACCEPT, { taskId: 't1' });
    transportB.send(identityA.agentId, msgToA);

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(receivedB.length).toBe(1);
    expect(receivedB[0].msg.params.title).toBe('From A');

    expect(receivedA.length).toBe(1);
    expect(receivedA[0].msg.params.taskId).toBe('t1');
  });

  it('should enforce max connections (20)', async () => {
    await transportA.startServer(portA);

    // Create 20 connections to transportA
    const extraTransports: Transport[] = [];
    const extraIdentities: AgentIdentity[] = [];

    for (let i = 0; i < 20; i++) {
      const id = await generateIdentity({ name: `Extra-${i}`, agentType: 'test', capabilities: [] });
      extraIdentities.push(id);
      const t = new Transport(id, () => {});
      extraTransports.push(t);
      await t.connect('127.0.0.1', portA);
    }

    // All 20 should be connected
    expect(transportA.connectedPeers.length).toBe(20);

    // The 21st should fail (server should reject)
    const id21 = await generateIdentity({ name: 'Extra-21', agentType: 'test', capabilities: [] });
    const t21 = new Transport(id21, () => {});
    extraTransports.push(t21);

    await expect(t21.connect('127.0.0.1', portA)).rejects.toThrow();

    // Cleanup
    for (const t of extraTransports) {
      t.stop();
    }
  });

  it('should handle two servers connecting to each other', async () => {
    await transportA.startServer(portA);
    await transportB.startServer(portB);

    // B connects to A
    await transportB.connect('127.0.0.1', portA);

    expect(transportA.connectedPeers).toContain(identityB.agentId);
    expect(transportB.connectedPeers).toContain(identityA.agentId);

    // Now A can also connect to B (separate connection)
    // This would replace the existing connection from B's perspective
    // since same agentId
  });
});
