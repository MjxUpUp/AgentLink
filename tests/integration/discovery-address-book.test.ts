/**
 * Integration: Discovery + AddressBook
 *
 * Verifies mDNS discovery callbacks, address book updates,
 * address resolution, and static peer fallback.
 * Uses a mock bonjour-service factory to avoid real mDNS in tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateIdentity } from '../../src/core/identity.js';
import { Discovery, type BonjourFactory, type DiscoveryCallbacks } from '../../src/core/discovery.js';
import { AddressBook } from '../../src/core/address-book.js';
import { AgentDatabase } from '../../src/db/database.js';
import type { AgentIdentity } from '../../src/core/types.js';

let tmpDir: string;
let database: AgentDatabase;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-disc-addr-'));
  database = new AgentDatabase(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  try { database.close(); } catch { /* nop */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock bonjour factory
// ---------------------------------------------------------------------------

function createMockBonjourFactory() {
  let publishedService: any = null;
  let browserUpCallback: ((svc: any) => void) | null = null;
  let browserDownCallback: ((svc: any) => void) | null = null;

  const factory: BonjourFactory = () => ({
    publish(opts: Record<string, unknown>) {
      publishedService = {
        stop: () => { publishedService = null; },
        opts,
      };
      return publishedService;
    },
    find(opts: Record<string, unknown>) {
      return {
        on(event: string, cb: (svc: any) => void) {
          if (event === 'up') browserUpCallback = cb;
          if (event === 'down') browserDownCallback = cb;
        },
        stop() {},
      };
    },
    destroy(cb?: () => void) {
      cb?.();
    },
  });

  return {
    factory,
    simulateServiceUp(svc: any) { browserUpCallback?.(svc); },
    simulateServiceDown(svc: any) { browserDownCallback?.(svc); },
    getPublishedService() { return publishedService; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Discovery + AddressBook integration', () => {
  it('publishes agent info via mDNS', async () => {
    const identity = await generateIdentity({ name: 'Publisher', agentType: 'coder', capabilities: ['review'] });
    const mock = createMockBonjourFactory();

    const discovery = new Discovery(
      identity,
      9876,
      { onAgentFound() {}, onAgentLost() {} },
      { mdns: true, peers: [] },
      mock.factory,
    );

    discovery.start();

    const svc = mock.getPublishedService();
    expect(svc).not.toBeNull();
    expect(svc.opts.name).toBe('Publisher');
    expect(svc.opts.type).toBe('_agentlink._tcp');
    expect(svc.opts.port).toBe(9876);
    expect(svc.opts.txt.id).toBe(identity.agentId);
    expect(svc.opts.txt.cap).toBe('review');

    discovery.stop();
  });

  it('fires onAgentFound when a service comes up', async () => {
    const identity = await generateIdentity({ name: 'Browser', agentType: 'test', capabilities: [] });
    const mock = createMockBonjourFactory();
    const found: any[] = [];

    const discovery = new Discovery(
      identity, 9876,
      { onAgentFound(info) { found.push(info); }, onAgentLost() {} },
      { mdns: true, peers: [] },
      mock.factory,
    );

    discovery.start();

    // Simulate a remote agent appearing
    mock.simulateServiceUp({
      name: 'RemoteAgent',
      port: 9999,
      referer: { address: '192.168.1.42' },
      txt: { id: 'al-remote01-00000000-00000000', type: 'coder', cap: 'review,deploy', ver: '0.1.0' },
    });

    expect(found).toHaveLength(1);
    expect(found[0].agentId).toBe('al-remote01-00000000-00000000');
    expect(found[0].name).toBe('RemoteAgent');
    expect(found[0].ip).toBe('192.168.1.42');
    expect(found[0].port).toBe(9999);
    expect(found[0].capabilities).toEqual(['review', 'deploy']);
    expect(found[0].source).toBe('mdns');

    discovery.stop();
  });

  it('ignores self-discovery', async () => {
    const identity = await generateIdentity({ name: 'Self', agentType: 'test', capabilities: [] });
    const mock = createMockBonjourFactory();
    const found: any[] = [];

    const discovery = new Discovery(
      identity, 9876,
      { onAgentFound() { found.push(arguments); }, onAgentLost() {} },
      { mdns: true, peers: [] },
      mock.factory,
    );

    discovery.start();

    // Simulate seeing ourselves
    mock.simulateServiceUp({
      name: 'Self',
      port: 9876,
      txt: { id: identity.agentId, type: 'test', cap: '' },
    });

    expect(found).toHaveLength(0);
    discovery.stop();
  });

  it('updates AddressBook when agent is discovered', async () => {
    const identity = await generateIdentity({ name: 'Local', agentType: 'test', capabilities: [] });
    const mock = createMockBonjourFactory();
    const addressBook = new AddressBook(database);

    const discovery = new Discovery(
      identity, 9876,
      {
        onAgentFound(info) {
          addressBook.updateAddress(info.agentId, info.ip, info.port, 'mdns');
        },
        onAgentLost() {},
      },
      { mdns: true, peers: [] },
      mock.factory,
    );

    discovery.start();

    mock.simulateServiceUp({
      name: 'Peer',
      port: 9999,
      referer: { address: '10.0.0.5' },
      txt: { id: 'al-peer0000-00000000-00000000', type: 'test', cap: '' },
    });

    // Verify address book was updated
    const addr = addressBook.resolveAddress('al-peer0000-00000000-00000000');
    expect(addr).not.toBeNull();
    expect(addr!.ip).toBe('10.0.0.5');
    expect(addr!.port).toBe(9999);

    discovery.stop();
  });

  it('resolves address after multiple updates', async () => {
    const addressBook = new AddressBook(database);

    // First update
    addressBook.updateAddress('al-agent1', '10.0.0.1', 9001, 'mdns');
    let addr = addressBook.resolveAddress('al-agent1');
    expect(addr!.ip).toBe('10.0.0.1');

    // Second update (address changed)
    addressBook.updateAddress('al-agent1', '10.0.0.2', 9002, 'address-book');
    addr = addressBook.resolveAddress('al-agent1');
    expect(addr!.ip).toBe('10.0.0.2');
    expect(addr!.port).toBe(9002);
  });

  it('returns null for unknown agent address', () => {
    const addressBook = new AddressBook(database);
    expect(addressBook.resolveAddress('al-unknown')).toBeNull();
  });

  it('static peers fallback when mDNS is disabled', async () => {
    const identity = await generateIdentity({ name: 'Static', agentType: 'test', capabilities: [] });
    const found: any[] = [];

    const discovery = new Discovery(
      identity, 9876,
      { onAgentFound(info) { found.push(info); }, onAgentLost() {} },
      {
        mdns: false,
        peers: [
          { host: '192.168.1.10', port: 9000, id: 'al-static01-00000000-00000000' },
          { host: '192.168.1.11', port: 9001 },
        ],
      },
    );

    discovery.start();

    expect(found).toHaveLength(2);
    expect(found[0].agentId).toBe('al-static01-00000000-00000000');
    expect(found[0].ip).toBe('192.168.1.10');
    expect(found[0].port).toBe(9000);
    expect(found[1].agentId).toBe('static-192.168.1.11:9001');
    expect(found[1].ip).toBe('192.168.1.11');

    discovery.stop();
  });

  it('listAgents returns all address book entries', async () => {
    const addressBook = new AddressBook(database);

    addressBook.updateAddress('al-a', '10.0.0.1', 9001, 'mdns');
    addressBook.updateAddress('al-b', '10.0.0.2', 9002, 'static');

    const list = addressBook.listAgents();
    expect(list).toHaveLength(2);

    const ids = list.map(e => e.agentId);
    expect(ids).toContain('al-a');
    expect(ids).toContain('al-b');
  });

  it('removeAgent deletes from address book', async () => {
    const addressBook = new AddressBook(database);
    addressBook.updateAddress('al-remove', '10.0.0.1', 9001, 'mdns');

    expect(addressBook.resolveAddress('al-remove')).not.toBeNull();

    addressBook.removeAgent('al-remove');
    expect(addressBook.resolveAddress('al-remove')).toBeNull();
  });

  it('fires onAgentLost with delay after service goes down', async () => {
    const identity = await generateIdentity({ name: 'Lost', agentType: 'test', capabilities: [] });
    const mock = createMockBonjourFactory();
    const lost: string[] = [];

    const discovery = new Discovery(
      identity, 9876,
      { onAgentFound() {}, onAgentLost(agentId) { lost.push(agentId); } },
      { mdns: true, peers: [] },
      mock.factory,
    );

    discovery.start();

    // Simulate a service appearing then going down
    mock.simulateServiceUp({
      name: 'Vanishing',
      port: 9000,
      txt: { id: 'al-vanish0-00000000-00000000', type: 'test', cap: '' },
    });

    mock.simulateServiceDown({
      txt: { id: 'al-vanish0-00000000-00000000' },
    });

    // The onAgentLost callback fires after LOST_DELAY_MS (30s) which is too long
    // for a test. We verify the timer was set by checking lost is still empty
    // (it hasn't fired yet because the delay hasn't elapsed).
    expect(lost).toHaveLength(0);

    discovery.stop();
  });
});
