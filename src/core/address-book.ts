import { AgentDatabase } from '../db/database.js';

export interface AddressBookEntry {
  agentId: string;
  hostname?: string;
  ip?: string;
  port?: number;
  lastSeen: number;
  source: string;
  connectionCount: number;
}

export class AddressBook {
  private db: AgentDatabase;

  constructor(db: AgentDatabase) {
    this.db = db;
  }

  updateAddress(agentId: string, ip: string, port: number, source: 'mdns' | 'static' | 'address-book'): void {
    const now = Date.now();

    const existing = this.db.getAddress(agentId);
    const connectionCount = existing
      ? ((existing as any).connection_count as number) + 1
      : 1;

    this.db.upsertAddress({
      agentId,
      lastKnownIp: ip,
      port,
      lastSeen: now,
      source,
      connectionCount,
    });
  }

  resolveAddress(agentId: string): { ip: string; port: number } | null {
    const row = this.db.getAddress(agentId) as Record<string, unknown> | null;

    if (!row || !row['last_known_ip']) {
      return null;
    }

    return {
      ip: row['last_known_ip'] as string,
      port: row['port'] as number,
    };
  }

  removeAgent(agentId: string): void {
    // Use a direct delete — we need a helper in the db
    // For now use the db's prepare to do it
    this.db.prepare('DELETE FROM address_book WHERE agent_id = ?').run(agentId);
  }

  listAgents(): AddressBookEntry[] {
    const rows = this.db.listAddresses() as Array<Record<string, unknown>>;

    return rows.map(row => ({
      agentId: row['agent_id'] as string,
      hostname: (row['hostname'] as string) || undefined,
      ip: (row['last_known_ip'] as string) || undefined,
      port: row['port'] as number | undefined,
      lastSeen: row['last_seen'] as number,
      source: row['source'] as string,
      connectionCount: row['connection_count'] as number,
    }));
  }
}
