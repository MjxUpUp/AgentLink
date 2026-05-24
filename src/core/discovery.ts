import { createRequire } from 'node:module';
import os from 'node:os';
import type { AgentIdentity } from './types.js';
import { AGENTLINK_VERSION } from './types.js';
import { getFingerprint } from './identity.js';

const require = createRequire(import.meta.url);

export interface DiscoveryCallbacks {
  onAgentFound: (info: {
    agentId: string;
    name: string;
    agentType: string;
    capabilities: string[];
    ip: string;
    port: number;
    source: 'mdns';
  }) => void;
  onAgentLost: (agentId: string) => void;
  onNetworkChange?: (endpoints: { ips: string[]; port: number }) => void;
}

export interface DiscoveryConfig {
  mdns: boolean;
  peers: Array<{ host: string; port: number; id?: string }>;
}

const SERVICE_TYPE = '_agentlink._tcp';
const LOST_DELAY_MS = 30_000;

export interface BonjourInstance {
  publish(opts: Record<string, unknown>): any;
  find(opts: Record<string, unknown>): any;
  destroy(callback?: () => void): void;
}

export type BonjourFactory = () => BonjourInstance;

export class Discovery {
  private bonjour: BonjourInstance | null = null;
  private service: any = null;
  private browser: any = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private lostTimers: Map<string, NodeJS.Timeout> = new Map();
  private stopped = false;
  private bonjourFactory: BonjourFactory;

  // Network interface monitoring
  private networkCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastKnownIPs: Set<string> = new Set();

  constructor(
    private identity: AgentIdentity,
    private port: number,
    private callbacks: DiscoveryCallbacks,
    private config: DiscoveryConfig,
    bonjourFactory?: BonjourFactory,
  ) {
    this.bonjourFactory = bonjourFactory ?? (() => {
      const Bonjour = require('bonjour-service');
      return new Bonjour() as BonjourInstance;
    });
  }

  start(): void {
    this.stopped = false;

    // Start network interface monitoring
    this.lastKnownIPs = this.getCurrentIPs();
    this.startNetworkMonitor();

    if (this.config.mdns) {
      try {
        this.bonjour = this.bonjourFactory();
        this.publishService();
        this.startBrowsing();
        this.startRefreshTimer();
        return;
      } catch {
        // mDNS failed — fall through to static peers
      }
    }

    this.useStaticPeers();
  }

  stop(): void {
    this.stopped = true;

    // Clear network monitor timer
    if (this.networkCheckTimer) {
      clearInterval(this.networkCheckTimer);
      this.networkCheckTimer = null;
    }

    // Clear refresh timer
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    // Clear all lost timers
    for (const [id, timer] of this.lostTimers) {
      clearTimeout(timer);
    }
    this.lostTimers.clear();

    // Destroy bonjour service
    if (this.service) {
      this.service.stop();
      this.service = null;
    }

    // Stop browser
    if (this.browser) {
      this.browser.stop();
      this.browser = null;
    }

    // Destroy bonjour instance
    if (this.bonjour) {
      this.bonjour.destroy();
      this.bonjour = null;
    }
  }

  refresh(): void {
    if (this.stopped) return;

    // Re-publish: stop old service, publish new one
    if (this.bonjour) {
      if (this.service) {
        this.service.stop();
        this.service = null;
      }
      this.publishService();
    }
  }

  private publishService(): void {
    if (!this.bonjour) return;

    this.service = this.bonjour.publish({
      name: this.identity.name,
      type: SERVICE_TYPE,
      port: this.port,
      txt: {
        id: this.identity.agentId,
        cap: this.identity.capabilities.join(','),
        status: 'online',
        type: this.identity.agentType,
        ver: AGENTLINK_VERSION,
        fp: `sha256:${getFingerprint(this.identity.publicKey)}`,
      },
    });
  }

  private startBrowsing(): void {
    if (!this.bonjour) return;

    this.browser = this.bonjour.find({ type: SERVICE_TYPE });

    this.browser.on('up', (svc: any) => {
      this.handleServiceUp(svc);
    });

    this.browser.on('down', (svc: any) => {
      this.handleServiceDown(svc);
    });
  }

  private handleServiceUp(svc: any): void {
    const txt = svc.txt || {};
    const agentId = txt.id;
    if (!agentId) return;

    // Ignore self
    if (agentId === this.identity.agentId) return;

    // Cancel any pending lost timer for this agent
    const existingTimer = this.lostTimers.get(agentId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.lostTimers.delete(agentId);
    }

    const capabilities = typeof txt.cap === 'string' && txt.cap.length > 0
      ? txt.cap.split(',').filter(Boolean)
      : [];

    const ip = svc.referer?.address
      || (svc.addresses && svc.addresses.length > 0 ? svc.addresses[0] : '')
      || svc.host
      || '';

    this.callbacks.onAgentFound({
      agentId,
      name: svc.name || '',
      agentType: txt.type || '',
      capabilities,
      ip,
      port: svc.port || 0,
      source: 'mdns',
    });
  }

  private handleServiceDown(svc: any): void {
    const txt = svc.txt || {};
    const agentId = txt.id;
    if (!agentId) return;

    // Ignore self
    if (agentId === this.identity.agentId) return;

    // Only set up a lost timer if there isn't one already
    if (this.lostTimers.has(agentId)) return;

    const timer = setTimeout(() => {
      this.lostTimers.delete(agentId);
      if (!this.stopped) {
        this.callbacks.onAgentLost(agentId);
      }
    }, LOST_DELAY_MS);

    this.lostTimers.set(agentId, timer);
  }

  private startRefreshTimer(): void {
    this.refreshTimer = setInterval(() => {
      this.refresh();
    }, 60_000);
  }

  private getCurrentIPs(): Set<string> {
    const ips = new Set<string>();
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] ?? []) {
        // Only track non-internal IPv4 addresses
        if (!iface.internal && iface.family === 'IPv4') {
          ips.add(iface.address);
        }
      }
    }
    return ips;
  }

  private startNetworkMonitor(): void {
    if (this.networkCheckTimer) {
      clearInterval(this.networkCheckTimer);
    }

    this.networkCheckTimer = setInterval(() => {
      this.checkNetworkChange();
    }, 5_000);
  }

  private checkNetworkChange(): void {
    const currentIPs = this.getCurrentIPs();

    // Check if the IP set has changed
    if (currentIPs.size !== this.lastKnownIPs.size) {
      this.lastKnownIPs = currentIPs;
      this.handleNetworkChange();
      return;
    }

    for (const ip of currentIPs) {
      if (!this.lastKnownIPs.has(ip)) {
        this.lastKnownIPs = currentIPs;
        this.handleNetworkChange();
        return;
      }
    }
  }

  private handleNetworkChange(): void {
    // Re-publish the mDNS service with updated info
    this.refresh();
    // Notify via callback with current endpoints
    const ips = Array.from(this.getCurrentIPs());
    this.callbacks.onNetworkChange?.({ ips, port: this.port });
  }

  private useStaticPeers(): void {
    for (const peer of this.config.peers) {
      const agentId = peer.id ?? `static-${peer.host}:${peer.port}`;
      this.callbacks.onAgentFound({
        agentId,
        name: peer.id ? `peer-${peer.id}` : `static-${peer.host}`,
        agentType: 'unknown',
        capabilities: [],
        ip: peer.host,
        port: peer.port,
        source: 'mdns',
      });
    }
  }
}
