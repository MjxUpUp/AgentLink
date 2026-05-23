import { AgentLinkDB } from '../db/database.js';

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
  private db: AgentLinkDB;

  constructor(db: AgentLinkDB) {
    this.db = db;
  }

  updateAddress(agentId: string, ip: string, port: number, source: 'mdns' | 'static' | 'address-book'): void {
    const now = Date.now();

    const existing = this.db.db.prepare('SELECT connection_count FROM address_book WHERE agent_id = ?').get(agentId) as { connection_count: number } | undefined;

    if (existing) {
      this.db.db.prepare(`
        UPDATE address_book
        SET ip = ?, port = ?, source = ?, last_seen = ?, connection_count = ?
        WHERE agent_id = ?
      `).run(ip, port, source, now, existing.connection_count + 1, agentId);
    } else {
      this.db.db.prepare(`
        INSERT INTO address_book (agent_id, ip, port, source, last_seen, connection_count)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(agentId, ip, port, source, now);
    }
  }

  resolveAddress(agentId: string): { ip: string; port: number } | null {
    const row = this.db.db.prepare('SELECT ip, port FROM address_book WHERE agent_id = ?').get(agentId) as { ip: string; port: number } | undefined;

    if (!row) {
      return null;
    }

    return { ip: row.ip, port: row.port };
  }

  removeAgent(agentId: string): void {
    this.db.db.prepare('DELETE FROM address_book WHERE agent_id = ?').run(agentId);
  }

  listAgents(): AddressBookEntry[] {
    const rows = this.db.db.prepare(`
      SELECT agent_id, hostname, ip, port, last_seen, source, connection_count
      FROM address_book
      ORDER BY last_seen DESC
    `).all() as Array<{
      agent_id: string;
      hostname: string | null;
      ip: string;
      port: number;
      last_seen: number;
      source: string;
      connection_count: number;
    }>;

    return rows.map(row => ({
      agentId: row.agent_id,
      hostname: row.hostname ?? undefined,
      ip: row.ip,
      port: row.port,
      lastSeen: row.last_seen,
      source: row.source,
      connectionCount: row.connection_count,
    }));
  }
}
