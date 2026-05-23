import { createRequire } from 'node:module';
import type { AgentInfo, Task } from '../core/types.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

type BetterSqlite3Database = InstanceType<typeof Database>;
type Statement = ReturnType<BetterSqlite3Database['prepare']>;

const CREATE_AGENTS = `
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  name TEXT,
  agent_type TEXT,
  capabilities TEXT,
  status TEXT DEFAULT 'unknown',
  trust_level TEXT DEFAULT 'untrusted',
  last_seen INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);
`;

const CREATE_TASKS = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  requester TEXT NOT NULL,
  executor TEXT NOT NULL,
  status TEXT DEFAULT 'created',
  priority TEXT DEFAULT 'medium',
  artifacts TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  timeout_at INTEGER
);
`;

const CREATE_ADDRESS_BOOK = `
CREATE TABLE IF NOT EXISTS address_book (
  agent_id TEXT PRIMARY KEY,
  hostname TEXT,
  last_known_ip TEXT,
  port INTEGER,
  last_seen INTEGER,
  source TEXT DEFAULT 'mdns',
  connection_count INTEGER DEFAULT 0
);
`;

export class AgentDatabase {
  /** @internal Exposed for backward compatibility with AddressBook class */
  db: BetterSqlite3Database;

  // Prepared statements
  private stmtUpsertAgent: Statement;
  private stmtGetAgent: Statement;
  private stmtListAgents: Statement;
  private stmtRemoveAgent: Statement;

  private stmtUpsertTask: Statement;
  private stmtGetTask: Statement;
  private stmtListTasks: Statement;
  private stmtListTasksByStatus: Statement;
  private stmtUpdateTaskStatus: Statement;
  private stmtRemoveTask: Statement;

  private stmtUpsertAddress: Statement;
  private stmtGetAddress: Statement;
  private stmtListAddresses: Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);

    // Enable WAL mode
    this.db.pragma('journal_mode = WAL');

    // Create tables
    this.db.exec(CREATE_AGENTS);
    this.db.exec(CREATE_TASKS);
    this.db.exec(CREATE_ADDRESS_BOOK);

    // Prepare agent statements
    this.stmtUpsertAgent = this.db.prepare(`
      INSERT INTO agents (agent_id, public_key, name, agent_type, capabilities, status, trust_level, last_seen)
      VALUES (@agentId, @publicKey, @name, @agentType, @capabilities, @status, @trustLevel, @lastSeen)
      ON CONFLICT(agent_id) DO UPDATE SET
        public_key = @publicKey,
        name = @name,
        agent_type = @agentType,
        capabilities = @capabilities,
        status = @status,
        trust_level = @trustLevel,
        last_seen = @lastSeen
    `);

    this.stmtGetAgent = this.db.prepare('SELECT * FROM agents WHERE agent_id = ?');
    this.stmtListAgents = this.db.prepare('SELECT * FROM agents ORDER BY last_seen DESC');
    this.stmtRemoveAgent = this.db.prepare('DELETE FROM agents WHERE agent_id = ?');

    // Prepare task statements
    this.stmtUpsertTask = this.db.prepare(`
      INSERT INTO tasks (id, type, title, description, requester, executor, status, priority, artifacts, created_at, updated_at, timeout_at)
      VALUES (@id, @type, @title, @description, @requester, @executor, @status, @priority, @artifacts, @createdAt, @updatedAt, @timeoutAt)
      ON CONFLICT(id) DO UPDATE SET
        type = @type,
        title = @title,
        description = @description,
        requester = @requester,
        executor = @executor,
        status = @status,
        priority = @priority,
        artifacts = @artifacts,
        created_at = @createdAt,
        updated_at = @updatedAt,
        timeout_at = @timeoutAt
    `);

    this.stmtGetTask = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    this.stmtListTasks = this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC');
    this.stmtListTasksByStatus = this.db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC');
    this.stmtUpdateTaskStatus = this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?');
    this.stmtRemoveTask = this.db.prepare('DELETE FROM tasks WHERE id = ?');

    // Prepare address book statements
    this.stmtUpsertAddress = this.db.prepare(`
      INSERT INTO address_book (agent_id, hostname, last_known_ip, port, last_seen, source, connection_count)
      VALUES (@agentId, @hostname, @lastKnownIp, @port, @lastSeen, @source, @connectionCount)
      ON CONFLICT(agent_id) DO UPDATE SET
        hostname = @hostname,
        last_known_ip = @lastKnownIp,
        port = @port,
        last_seen = @lastSeen,
        source = @source,
        connection_count = @connectionCount
    `);

    this.stmtGetAddress = this.db.prepare('SELECT * FROM address_book WHERE agent_id = ?');
    this.stmtListAddresses = this.db.prepare('SELECT * FROM address_book ORDER BY last_seen DESC');
  }

  // Expose prepare/pragma for tests
  prepare(sql: string): Statement {
    return this.db.prepare(sql);
  }

  pragma(pragma: string): unknown {
    return this.db.pragma(pragma);
  }

  close(): void {
    this.db.close();
  }

  // Agent methods

  upsertAgent(agent: AgentInfo): void {
    this.stmtUpsertAgent.run({
      agentId: agent.agentId,
      publicKey: Buffer.from(agent.publicKey),
      name: agent.name ?? null,
      agentType: agent.agentType ?? null,
      capabilities: agent.capabilities ? JSON.stringify(agent.capabilities) : null,
      status: agent.status,
      trustLevel: agent.trustLevel,
      lastSeen: agent.lastSeen,
    });
  }

  getAgent(agentId: string): Record<string, unknown> | null {
    const row = this.stmtGetAgent.get(agentId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  listAgents(): Array<Record<string, unknown>> {
    return this.stmtListAgents.all() as Array<Record<string, unknown>>;
  }

  removeAgent(agentId: string): void {
    this.stmtRemoveAgent.run(agentId);
  }

  // Task methods

  upsertTask(task: Task): void {
    this.stmtUpsertTask.run({
      id: task.id,
      type: task.type,
      title: task.title,
      description: task.description ?? null,
      requester: task.requester,
      executor: task.executor,
      status: task.status,
      priority: task.priority,
      artifacts: task.artifacts ? JSON.stringify(task.artifacts) : null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      timeoutAt: task.timeoutAt ?? null,
    });
  }

  getTask(taskId: string): Record<string, unknown> | null {
    const row = this.stmtGetTask.get(taskId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  listTasks(status?: string): Array<Record<string, unknown>> {
    if (status) {
      return this.stmtListTasksByStatus.all(status) as Array<Record<string, unknown>>;
    }
    return this.stmtListTasks.all() as Array<Record<string, unknown>>;
  }

  updateTaskStatus(taskId: string, status: string): void {
    this.stmtUpdateTaskStatus.run(status, taskId);
  }

  removeTask(taskId: string): void {
    this.stmtRemoveTask.run(taskId);
  }

  // Address book methods

  upsertAddress(entry: {
    agentId: string;
    hostname?: string;
    lastKnownIp?: string;
    port?: number;
    lastSeen: number;
    source: string;
    connectionCount: number;
  }): void {
    this.stmtUpsertAddress.run({
      agentId: entry.agentId,
      hostname: entry.hostname ?? null,
      lastKnownIp: entry.lastKnownIp ?? null,
      port: entry.port ?? null,
      lastSeen: entry.lastSeen,
      source: entry.source,
      connectionCount: entry.connectionCount,
    });
  }

  getAddress(agentId: string): Record<string, unknown> | null {
    const row = this.stmtGetAddress.get(agentId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  listAddresses(): Array<Record<string, unknown>> {
    return this.stmtListAddresses.all() as Array<Record<string, unknown>>;
  }
}

/** @deprecated Use AgentDatabase instead */
export const AgentLinkDB = AgentDatabase;
