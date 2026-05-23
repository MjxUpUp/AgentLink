import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3');

export class AgentLinkDB {
  public db: any;

  constructor(dbPath: string) {
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS address_book (
        agent_id TEXT PRIMARY KEY,
        ip TEXT NOT NULL,
        port INTEGER NOT NULL,
        hostname TEXT,
        source TEXT NOT NULL DEFAULT 'static',
        last_seen INTEGER NOT NULL,
        connection_count INTEGER NOT NULL DEFAULT 1
      );
    `);
  }

  close(): void {
    this.db.close();
  }
}
