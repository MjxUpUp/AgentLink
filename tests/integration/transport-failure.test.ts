/**
 * Integration: Transport failure modes
 *
 * Verifies error handling for invalid connections, port conflicts,
 * and resource cleanup on failures.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TestAgent, cleanupAgents } from './helpers/test-harness.js';
import { Transport } from '../../src/core/transport.js';
import { generateIdentity, signMessage } from '../../src/core/identity.js';

let agents: TestAgent[] = [];

afterEach(() => {
  cleanupAgents(agents);
  agents = [];
});

describe('Transport failure modes', () => {
  it('connecting to a non-listening port rejects', async () => {
    const agent = await TestAgent.create({ name: 'Connecter', agentType: 'test', capabilities: [] });
    agents.push(agent);
    // Don't start the agent — no server running

    await expect(
      agent.transport.connect('127.0.0.1', 19999),
    ).rejects.toThrow();
  });

  it('starting server on an already-bound port rejects', async () => {
    const a = await TestAgent.create({ name: 'PortHolder', agentType: 'test', capabilities: [] });
    const b = await TestAgent.create({ name: 'PortConflict', agentType: 'test', capabilities: [], port: a.port });
    agents.push(a, b);

    await a.start();

    await expect(b.start()).rejects.toThrow(/already in use|EADDRINUSE/);
  });

  it('sending to a disconnected peer throws', async () => {
    const a = await TestAgent.create({ name: 'Sender', agentType: 'test', capabilities: [] });
    agents.push(a);

    await a.start();

    expect(() => {
      a.sendMessage('al-nobody00-00000000-00000000', 'test.method', {});
    }).toThrow(/Not connected/);
  });

  it('disconnect on unknown peer is a no-op', async () => {
    const a = await TestAgent.create({ name: 'A', agentType: 'test', capabilities: [] });
    agents.push(a);

    // Should not throw
    a.transport.disconnect('al-nonexist-00000000-00000000');
  });

  it('stop is idempotent — calling twice does not throw', async () => {
    const a = await TestAgent.create({ name: 'A', agentType: 'test', capabilities: [] });
    agents.push(a);

    await a.start();
    a.stop();
    a.stop(); // Second stop should be safe
  });

  it('stop cleans up server and all connections', async () => {
    const a = await TestAgent.create({ name: 'Server', agentType: 'test', capabilities: [] });
    const b = await TestAgent.create({ name: 'Client', agentType: 'test', capabilities: [] });
    agents.push(a, b);

    await a.start();
    await b.start();
    await b.connectTo(a);

    expect(a.transport.connectedPeers.length).toBeGreaterThan(0);
    expect(a.transport.listeningPort).toBeGreaterThan(0);

    a.stop();

    expect(a.transport.connectedPeers).toHaveLength(0);
    // Transport.stop() closes the server but does not reset listeningPort
    expect(a.transport.listeningPort).toBeGreaterThan(0);
  });

  it('transport with real identity handles sodium correctly', async () => {
    const identity = await generateIdentity({ name: 'Real', agentType: 'test', capabilities: [] });
    const received: any[] = [];

    const transport = new Transport(
      identity,
      (agentId, msg) => { received.push({ agentId, msg }); },
    );

    // Transport.startServer stores the requested port (not OS-assigned),
    // so use an explicit port from the allocator.
    const { nextPort } = await import('./helpers/port-allocator.js');
    const port = nextPort();
    await transport.startServer(port);
    expect(transport.listeningPort).toBe(port);

    transport.stop();
  });

  it('multiple clients can connect to same server', async () => {
    const server = await TestAgent.create({ name: 'Server', agentType: 'test', capabilities: [] });
    agents.push(server);
    await server.start();

    const clientCount = 5;
    for (let i = 0; i < clientCount; i++) {
      const client = await TestAgent.create({ name: `Client-${i}`, agentType: 'test', capabilities: [] });
      agents.push(client);
      await client.start();
      await client.connectTo(server);
    }

    expect(server.transport.connectedPeers.length).toBe(clientCount);
  });

  it('sending large message payload works', async () => {
    const a = await TestAgent.create({ name: 'Sender', agentType: 'test', capabilities: [] });
    const b = await TestAgent.create({ name: 'Receiver', agentType: 'test', capabilities: [] });
    agents.push(a, b);

    await a.start();
    await b.start();
    await a.connectTo(b);

    // Send a large payload (100KB)
    const largeContent = 'x'.repeat(100_000);
    a.sendMessage(b.identity.agentId, 'test.large', { payload: largeContent });

    const received = await b.waitForMessage('test.large', 3000);
    expect(received.msg.params.payload).toBe(largeContent);
  });
});
