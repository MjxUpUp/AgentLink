import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import type { AgentIdentity } from '../../src/core/types.js';
import { Discovery } from '../../src/core/discovery.js';
import type { BonjourInstance } from '../../src/core/discovery.js';

// --- Mock infrastructure ---

interface MockService extends EventEmitter {
  stop: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  published: boolean;
  destroyed: boolean;
  name: string;
  type: string;
  port: number;
  txt: Record<string, string>;
}

interface MockBrowser extends EventEmitter {
  stop: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
}

function createMockService(opts: Record<string, unknown>): MockService {
  const svc = new EventEmitter() as MockService;
  svc.stop = vi.fn();
  svc.start = vi.fn();
  svc.published = false;
  svc.destroyed = false;
  svc.name = opts.name as string;
  svc.type = opts.type as string;
  svc.port = opts.port as number;
  svc.txt = (opts.txt as Record<string, string>) || {};
  return svc;
}

function createMockBrowser(): MockBrowser {
  const browser = new EventEmitter() as MockBrowser;
  browser.stop = vi.fn();
  browser.start = vi.fn();
  return browser;
}

// Current mock instances — set by createMockBonjourFactory
let mockService: MockService;
let mockBrowser: MockBrowser;
let mockDestroyFn: ReturnType<typeof vi.fn>;

function createMockBonjourFactory(): () => BonjourInstance {
  return () => {
    mockDestroyFn = vi.fn();
    mockBrowser = createMockBrowser();
    return {
      publish(opts: Record<string, unknown>) {
        mockService = createMockService(opts);
        return mockService;
      },
      find() {
        return mockBrowser;
      },
      destroy(cb?: () => void) {
        mockDestroyFn();
        if (cb) cb();
      },
    };
  };
}

// --- Test fixtures ---

function createTestIdentity(): AgentIdentity {
  return {
    agentId: 'al-TEST0001-TEST0002-TEST0003',
    publicKey: new Uint8Array(32).fill(1),
    secretKey: new Uint8Array(64).fill(2),
    name: 'test-agent',
    agentType: 'assistant',
    capabilities: ['code', 'search'],
  };
}

// --- Tests ---

describe('Discovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should create a service and browser on start() when mDNS is enabled', () => {
    const onAgentFound = vi.fn();
    const onAgentLost = vi.fn();
    const identity = createTestIdentity();

    const discovery = new Discovery(
      identity,
      9876,
      { onAgentFound, onAgentLost },
      { mdns: true, peers: [] },
      createMockBonjourFactory(),
    );

    discovery.start();

    // Service should be published
    expect(mockService).toBeDefined();
    expect(mockService.name).toBe('test-agent');
    expect(mockService.type).toBe('_agentlink._tcp');
    expect(mockService.port).toBe(9876);
    expect(mockService.txt).toEqual({
      id: 'al-TEST0001-TEST0002-TEST0003',
      cap: 'code,search',
      status: 'online',
      type: 'assistant',
    });

    // Browser should be created
    expect(mockBrowser).toBeDefined();

    discovery.stop();
  });

  it('should call onAgentFound with correct data when a service "up" event fires', () => {
    const onAgentFound = vi.fn();
    const onAgentLost = vi.fn();
    const identity = createTestIdentity();

    const discovery = new Discovery(
      identity,
      9876,
      { onAgentFound, onAgentLost },
      { mdns: true, peers: [] },
      createMockBonjourFactory(),
    );

    discovery.start();

    // Simulate a remote service appearing
    mockBrowser.emit('up', {
      name: 'remote-agent',
      type: '_agentlink._tcp',
      port: 9999,
      txt: {
        id: 'al-REMOTE0001-REMOTE0002',
        cap: 'chat,translate',
        status: 'online',
        type: 'worker',
      },
      referer: { address: '192.168.1.50', family: 'IPv4', port: 5353, size: 100 },
      addresses: ['192.168.1.50'],
    });

    expect(onAgentFound).toHaveBeenCalledWith({
      agentId: 'al-REMOTE0001-REMOTE0002',
      name: 'remote-agent',
      agentType: 'worker',
      capabilities: ['chat', 'translate'],
      ip: '192.168.1.50',
      port: 9999,
      source: 'mdns',
    });

    discovery.stop();
  });

  it('should ignore self in "up" events', () => {
    const onAgentFound = vi.fn();
    const onAgentLost = vi.fn();
    const identity = createTestIdentity();

    const discovery = new Discovery(
      identity,
      9876,
      { onAgentFound, onAgentLost },
      { mdns: true, peers: [] },
      createMockBonjourFactory(),
    );

    discovery.start();

    // Simulate self appearing
    mockBrowser.emit('up', {
      name: 'test-agent',
      type: '_agentlink._tcp',
      port: 9876,
      txt: {
        id: 'al-TEST0001-TEST0002-TEST0003',
        cap: 'code,search',
        status: 'online',
        type: 'assistant',
      },
      referer: { address: '192.168.1.10', family: 'IPv4', port: 5353, size: 100 },
    });

    expect(onAgentFound).not.toHaveBeenCalled();

    discovery.stop();
  });

  it('should call onAgentLost after 30s delay when service "down" fires', () => {
    const onAgentFound = vi.fn();
    const onAgentLost = vi.fn();
    const identity = createTestIdentity();

    const discovery = new Discovery(
      identity,
      9876,
      { onAgentFound, onAgentLost },
      { mdns: true, peers: [] },
      createMockBonjourFactory(),
    );

    discovery.start();

    // First, agent comes up
    mockBrowser.emit('up', {
      name: 'remote-agent',
      type: '_agentlink._tcp',
      port: 9999,
      txt: {
        id: 'al-REMOTE0001-REMOTE0002',
        cap: 'chat',
        status: 'online',
        type: 'worker',
      },
      referer: { address: '192.168.1.50', family: 'IPv4', port: 5353, size: 100 },
    });

    // Now the agent goes down
    mockBrowser.emit('down', {
      name: 'remote-agent',
      txt: { id: 'al-REMOTE0001-REMOTE0002' },
    });

    // Not called immediately
    expect(onAgentLost).not.toHaveBeenCalled();

    // Advance time by 29 seconds — still not called
    vi.advanceTimersByTime(29_000);
    expect(onAgentLost).not.toHaveBeenCalled();

    // Advance to 30 seconds — should be called
    vi.advanceTimersByTime(1_000);
    expect(onAgentLost).toHaveBeenCalledWith('al-REMOTE0001-REMOTE0002');

    discovery.stop();
  });

  it('should cancel lost timer if agent comes back before delay', () => {
    const onAgentFound = vi.fn();
    const onAgentLost = vi.fn();
    const identity = createTestIdentity();

    const discovery = new Discovery(
      identity,
      9876,
      { onAgentFound, onAgentLost },
      { mdns: true, peers: [] },
      createMockBonjourFactory(),
    );

    discovery.start();

    // Agent goes down
    mockBrowser.emit('down', {
      name: 'remote-agent',
      txt: { id: 'al-REMOTE0001-REMOTE0002' },
    });

    // Advance 15 seconds
    vi.advanceTimersByTime(15_000);

    // Agent comes back up
    mockBrowser.emit('up', {
      name: 'remote-agent',
      type: '_agentlink._tcp',
      port: 9999,
      txt: {
        id: 'al-REMOTE0001-REMOTE0002',
        cap: 'chat',
        status: 'online',
        type: 'worker',
      },
      referer: { address: '192.168.1.50', family: 'IPv4', port: 5353, size: 100 },
    });

    // Advance past the original 30s window
    vi.advanceTimersByTime(20_000);

    // onAgentLost should NOT be called because the agent came back
    expect(onAgentLost).not.toHaveBeenCalled();

    discovery.stop();
  });

  it('should correctly populate TXT record', () => {
    const onAgentFound = vi.fn();
    const onAgentLost = vi.fn();
    const identity: AgentIdentity = {
      agentId: 'al-ABCDEF00-12345678-DEADBEEF',
      publicKey: new Uint8Array(32).fill(42),
      secretKey: new Uint8Array(64).fill(99),
      name: 'my-special-agent',
      agentType: 'planner',
      capabilities: ['plan', 'execute', 'review'],
    };

    const discovery = new Discovery(
      identity,
      5555,
      { onAgentFound, onAgentLost },
      { mdns: true, peers: [] },
      createMockBonjourFactory(),
    );

    discovery.start();

    expect(mockService.txt).toEqual({
      id: 'al-ABCDEF00-12345678-DEADBEEF',
      cap: 'plan,execute,review',
      status: 'online',
      type: 'planner',
    });

    discovery.stop();
  });

  it('should handle empty capabilities in TXT record', () => {
    const onAgentFound = vi.fn();
    const onAgentLost = vi.fn();
    const identity: AgentIdentity = {
      agentId: 'al-NOPE0000-NOPE0000-NOPE0000',
      publicKey: new Uint8Array(32).fill(7),
      secretKey: new Uint8Array(64).fill(8),
      name: 'bare-agent',
      agentType: 'minimal',
      capabilities: [],
    };

    const discovery = new Discovery(
      identity,
      3000,
      { onAgentFound, onAgentLost },
      { mdns: true, peers: [] },
      createMockBonjourFactory(),
    );

    discovery.start();

    expect(mockService.txt.cap).toBe('');

    discovery.stop();
  });

  it('should re-publish service on refresh()', () => {
    const onAgentFound = vi.fn();
    const onAgentLost = vi.fn();
    const identity = createTestIdentity();

    const discovery = new Discovery(
      identity,
      9876,
      { onAgentFound, onAgentLost },
      { mdns: true, peers: [] },
      createMockBonjourFactory(),
    );

    discovery.start();

    const firstService = mockService;
    expect(firstService).toBeDefined();

    discovery.refresh();

    // Old service should have been stopped
    expect(firstService.stop).toHaveBeenCalled();

    // New service should be published (mockService was updated by publish)
    expect(mockService).toBeDefined();
    expect(mockService.name).toBe('test-agent');
    expect(mockService.txt.id).toBe('al-TEST0001-TEST0002-TEST0003');

    discovery.stop();
  });

  it('should clean up everything on stop()', () => {
    const onAgentFound = vi.fn();
    const onAgentLost = vi.fn();
    const identity = createTestIdentity();

    const discovery = new Discovery(
      identity,
      9876,
      { onAgentFound, onAgentLost },
      { mdns: true, peers: [] },
      createMockBonjourFactory(),
    );

    discovery.start();

    const serviceRef = mockService;
    const browserRef = mockBrowser;

    discovery.stop();

    expect(serviceRef.stop).toHaveBeenCalled();
    expect(browserRef.stop).toHaveBeenCalled();
    expect(mockDestroyFn).toHaveBeenCalled();
  });

  it('should clear lost timers on stop()', () => {
    const onAgentFound = vi.fn();
    const onAgentLost = vi.fn();
    const identity = createTestIdentity();

    const discovery = new Discovery(
      identity,
      9876,
      { onAgentFound, onAgentLost },
      { mdns: true, peers: [] },
      createMockBonjourFactory(),
    );

    discovery.start();

    // Agent goes down — starts a lost timer
    mockBrowser.emit('down', {
      name: 'remote-agent',
      txt: { id: 'al-REMOTE0001-REMOTE0002' },
    });

    discovery.stop();

    // Advance past the 30s delay — onAgentLost should NOT be called
    vi.advanceTimersByTime(35_000);
    expect(onAgentLost).not.toHaveBeenCalled();
  });

  it('should use static peer fallback when mDNS is disabled', () => {
    const onAgentFound = vi.fn();
    const onAgentLost = vi.fn();
    const identity = createTestIdentity();

    const discovery = new Discovery(
      identity,
      9876,
      { onAgentFound, onAgentLost },
      {
        mdns: false,
        peers: [
          { host: '10.0.0.5', port: 9000 },
          { host: '10.0.0.6', port: 9001 },
        ],
      },
      createMockBonjourFactory(),
    );

    discovery.start();

    expect(onAgentFound).toHaveBeenCalledTimes(2);
    expect(onAgentFound).toHaveBeenCalledWith({
      agentId: 'static-10.0.0.5:9000',
      name: 'static-10.0.0.5',
      agentType: 'unknown',
      capabilities: [],
      ip: '10.0.0.5',
      port: 9000,
      source: 'mdns',
    });
    expect(onAgentFound).toHaveBeenCalledWith({
      agentId: 'static-10.0.0.6:9001',
      name: 'static-10.0.0.6',
      agentType: 'unknown',
      capabilities: [],
      ip: '10.0.0.6',
      port: 9001,
      source: 'mdns',
    });

    discovery.stop();
  });

  it('should set up a 60-second refresh timer on start()', () => {
    const onAgentFound = vi.fn();
    const onAgentLost = vi.fn();
    const identity = createTestIdentity();

    const discovery = new Discovery(
      identity,
      9876,
      { onAgentFound, onAgentLost },
      { mdns: true, peers: [] },
      createMockBonjourFactory(),
    );

    discovery.start();

    const firstService = mockService;
    expect(firstService).toBeDefined();

    // Advance 60 seconds — refresh should fire
    vi.advanceTimersByTime(60_000);

    // Old service should be stopped, new one published
    expect(firstService.stop).toHaveBeenCalled();
    expect(mockService).toBeDefined();
    expect(mockService.txt.id).toBe('al-TEST0001-TEST0002-TEST0003');

    discovery.stop();
  });

  it('should handle services without referer by falling back to addresses array', () => {
    const onAgentFound = vi.fn();
    const onAgentLost = vi.fn();
    const identity = createTestIdentity();

    const discovery = new Discovery(
      identity,
      9876,
      { onAgentFound, onAgentLost },
      { mdns: true, peers: [] },
      createMockBonjourFactory(),
    );

    discovery.start();

    // Service with no referer but with addresses array
    mockBrowser.emit('up', {
      name: 'remote-agent',
      type: '_agentlink._tcp',
      port: 7777,
      txt: {
        id: 'al-FALLBACK0-FALLBACK0',
        cap: 'test',
        status: 'online',
        type: 'tester',
      },
      addresses: ['10.0.0.100', 'fe80::1'],
    });

    expect(onAgentFound).toHaveBeenCalledWith(
      expect.objectContaining({
        ip: '10.0.0.100',
        port: 7777,
      }),
    );

    discovery.stop();
  });

  it('should handle services with no txt id gracefully', () => {
    const onAgentFound = vi.fn();
    const onAgentLost = vi.fn();
    const identity = createTestIdentity();

    const discovery = new Discovery(
      identity,
      9876,
      { onAgentFound, onAgentLost },
      { mdns: true, peers: [] },
      createMockBonjourFactory(),
    );

    discovery.start();

    // Service with no id in TXT
    mockBrowser.emit('up', {
      name: 'bad-agent',
      port: 9999,
      txt: {},
      addresses: ['10.0.0.1'],
    });

    expect(onAgentFound).not.toHaveBeenCalled();

    discovery.stop();
  });

  describe('Network interface monitoring', () => {
    it('should start network monitor on start()', () => {
      const onAgentFound = vi.fn();
      const onAgentLost = vi.fn();
      const identity = createTestIdentity();

      const discovery = new Discovery(
        identity,
        9876,
        { onAgentFound, onAgentLost },
        { mdns: true, peers: [] },
        createMockBonjourFactory(),
      );

      discovery.start();

      // Advance by 5 seconds — network check should fire without error
      vi.advanceTimersByTime(5_000);

      // Service should still be published (no crash)
      expect(mockService).toBeDefined();

      discovery.stop();
    });

    it('should clear network monitor timer on stop()', () => {
      const onAgentFound = vi.fn();
      const onAgentLost = vi.fn();
      const onNetworkChange = vi.fn();
      const identity = createTestIdentity();

      const discovery = new Discovery(
        identity,
        9876,
        { onAgentFound, onAgentLost, onNetworkChange },
        { mdns: true, peers: [] },
        createMockBonjourFactory(),
      );

      discovery.start();
      discovery.stop();

      // Advance past 5 seconds — network check should NOT fire after stop
      vi.advanceTimersByTime(10_000);

      expect(onNetworkChange).not.toHaveBeenCalled();
    });

    it('should call refresh() and onNetworkChange when IPs change', () => {
      const onAgentFound = vi.fn();
      const onAgentLost = vi.fn();
      const onNetworkChange = vi.fn();
      const identity = createTestIdentity();

      // Mock os.networkInterfaces to return initial IPs
      const originalNetworkInterfaces = os.networkInterfaces;
      let callCount = 0;
      vi.spyOn(os, 'networkInterfaces').mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          // Initial calls (start + first check)
          return {
            eth0: [
              { address: '192.168.1.10', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '192.168.1.10/24' },
            ],
          } as any;
        }
        // Subsequent calls — IP changed (DHCP renewal)
        return {
          eth0: [
            { address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '192.168.1.20/24' },
          ],
        } as any;
      });

      const discovery = new Discovery(
        identity,
        9876,
        { onAgentFound, onAgentLost, onNetworkChange },
        { mdns: true, peers: [] },
        createMockBonjourFactory(),
      );

      discovery.start();

      const firstService = mockService;

      // Advance 5 seconds — first network check (IPs same as initial, no change yet)
      vi.advanceTimersByTime(5_000);
      expect(onNetworkChange).not.toHaveBeenCalled();

      // Advance another 5 seconds — IPs now different
      vi.advanceTimersByTime(5_000);

      expect(onNetworkChange).toHaveBeenCalledTimes(1);

      // Service should have been refreshed (old one stopped, new one published)
      expect(firstService.stop).toHaveBeenCalled();
      expect(mockService).toBeDefined();
      expect(mockService.txt.id).toBe('al-TEST0001-TEST0002-TEST0003');

      discovery.stop();
      vi.restoreAllMocks();
    });

    it('should not trigger network change when IPs remain the same', () => {
      const onAgentFound = vi.fn();
      const onAgentLost = vi.fn();
      const onNetworkChange = vi.fn();
      const identity = createTestIdentity();

      // Mock stable IPs
      vi.spyOn(os, 'networkInterfaces').mockImplementation(() => ({
        eth0: [
          { address: '192.168.1.10', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '192.168.1.10/24' },
        ],
      }) as any);

      const discovery = new Discovery(
        identity,
        9876,
        { onAgentFound, onAgentLost, onNetworkChange },
        { mdns: true, peers: [] },
        createMockBonjourFactory(),
      );

      discovery.start();

      // Advance multiple check intervals
      vi.advanceTimersByTime(20_000);

      expect(onNetworkChange).not.toHaveBeenCalled();

      discovery.stop();
      vi.restoreAllMocks();
    });
  });
});
