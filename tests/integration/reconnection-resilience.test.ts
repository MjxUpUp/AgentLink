/**
 * Integration: Reconnection resilience
 *
 * Verifies that when a connection drops, the transport attempts
 * reconnection and messages resume after the link is re-established.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TestAgent, cleanupAgents } from './helpers/test-harness.js';
import { Methods } from '../../src/core/types.js';

let agents: TestAgent[] = [];

afterEach(() => {
  cleanupAgents(agents);
  agents = [];
});

describe('Reconnection resilience', () => {
  it('reconnects after disconnect and resumes messaging', async () => {
    const a = await TestAgent.create({ name: 'Server', agentType: 'test', capabilities: [] });
    const b = await TestAgent.create({ name: 'Client', agentType: 'test', capabilities: [] });
    agents.push(a, b);

    await a.start();
    await b.start();
    a.trustOther(b);
    await b.connectTo(a);

    // Verify initial connection
    expect(b.transport.connectedPeers).toContain(a.identity.agentId);

    // Send a message first
    b.sendMessage(a.identity.agentId, Methods.TASK_CREATE, { msg: 'before-disconnect' });
    await b.flush(200);
    const beforeDisconnect = a.receivedMessages.find(m => m.msg.params.msg === 'before-disconnect');
    expect(beforeDisconnect).toBeDefined();

    // Disconnect B from A
    b.transport.disconnect(a.identity.agentId);
    await b.flush(100);

    expect(b.transport.connectedPeers).not.toContain(a.identity.agentId);

    // Reconnect
    await b.connectTo(a);
    expect(b.transport.connectedPeers).toContain(a.identity.agentId);

    // Send a message after reconnection
    b.sendMessage(a.identity.agentId, Methods.TASK_CREATE, { msg: 'after-reconnect' });
    await b.flush(300);

    const afterReconnect = a.receivedMessages.find(m => m.msg.params.msg === 'after-reconnect');
    expect(afterReconnect).toBeDefined();
  });

  it('server stays alive when client disconnects', async () => {
    const server = await TestAgent.create({ name: 'Server', agentType: 'test', capabilities: [] });
    const client = await TestAgent.create({ name: 'Client', agentType: 'test', capabilities: [] });
    agents.push(server, client);

    await server.start();
    await client.start();
    await client.connectTo(server);

    expect(server.transport.connectedPeers).toContain(client.identity.agentId);

    // Client disconnects
    client.transport.disconnect(server.identity.agentId);
    await client.flush(200);

    // Server should detect the disconnect
    // Server's listening port should still be bound
    expect(server.transport.listeningPort).toBe(server.port);

    // A new client can still connect to the server
    const client2 = await TestAgent.create({ name: 'Client2', agentType: 'test', capabilities: [] });
    agents.push(client2);
    await client2.start();
    await client2.connectTo(server);

    expect(server.transport.connectedPeers).toContain(client2.identity.agentId);

    client2.sendMessage(server.identity.agentId, Methods.TASK_CREATE, { hello: 'client2' });
    await client2.flush(200);

    const msg = server.receivedMessages.find(m => m.msg.params.hello === 'client2');
    expect(msg).toBeDefined();
  });

  it('multiple disconnect-reconnect cycles work', async () => {
    const a = await TestAgent.create({ name: 'Server', agentType: 'test', capabilities: [] });
    const b = await TestAgent.create({ name: 'Client', agentType: 'test', capabilities: [] });
    agents.push(a, b);

    await a.start();
    await b.start();

    for (let cycle = 0; cycle < 3; cycle++) {
      await b.connectTo(a);
      expect(b.transport.connectedPeers).toContain(a.identity.agentId);

      b.sendMessage(a.identity.agentId, Methods.TASK_CREATE, { cycle });
      await b.flush(200);

      const msg = a.receivedMessages.find(m => m.msg.params.cycle === cycle);
      expect(msg).toBeDefined();

      b.transport.disconnect(a.identity.agentId);
      await b.flush(100);
    }
  });

  it('stop clears all connections cleanly', async () => {
    const a = await TestAgent.create({ name: 'A', agentType: 'test', capabilities: [] });
    const b = await TestAgent.create({ name: 'B', agentType: 'test', capabilities: [] });
    agents.push(a, b);

    await a.start();
    await b.start();
    await a.connectTo(b);
    await b.connectTo(a);

    expect(a.transport.connectedPeers.length).toBeGreaterThan(0);

    a.stop();

    expect(a.transport.connectedPeers).toHaveLength(0);
    // Transport.stop() closes the server but does not reset listeningPort
    expect(a.transport.listeningPort).toBeGreaterThan(0);
  });

  it('connecting to a non-listening port rejects', async () => {
    const a = await TestAgent.create({ name: 'A', agentType: 'test', capabilities: [] });
    agents.push(a);
    // Connect to a port where nothing is listening
    await expect(a.transport.connect('127.0.0.1', 19999)).rejects.toThrow();
  });
});
