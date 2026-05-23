import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentDatabase } from '../../src/db/database.js';
import type { AgentInfo, Task, AgentStatus, TrustLevel } from '../../src/core/types.js';

let tmpDir: string;
let dbPath: string;
let db: AgentDatabase;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-db-test-'));
  dbPath = path.join(tmpDir, 'test.db');
  db = new AgentDatabase(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    agentId: 'al-TESTTEST-TESTTEST-TESTTEST',
    publicKey: new Uint8Array(32).fill(1),
    name: 'Test Agent',
    agentType: 'test',
    capabilities: ['testing'],
    status: 'online' as AgentStatus,
    lastSeen: Date.now(),
    source: 'mdns' as const,
    trustLevel: 'untrusted' as TrustLevel,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-001',
    type: 'code-review',
    title: 'Review PR',
    description: 'Review the database module',
    requester: 'al-REQREQR-REQREQR-REQREQR',
    executor: 'al-EXEEXEE-EXEEXEE-EXEEXEE',
    status: 'created',
    priority: 'medium',
    artifacts: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('AgentDatabase', () => {
  it('should initialize with correct tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('agents');
    expect(tableNames).toContain('tasks');
    expect(tableNames).toContain('address_book');
  });

  it('should enable WAL journal mode', () => {
    const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(result[0].journal_mode).toBe('wal');
  });

  describe('Agent CRUD', () => {
    it('should insert and retrieve an agent', () => {
      const agent = makeAgent();
      db.upsertAgent(agent);

      const retrieved = db.getAgent(agent.agentId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.agent_id).toBe(agent.agentId);
      expect(retrieved!.name).toBe(agent.name);
      expect(retrieved!.agent_type).toBe(agent.agentType);
      expect(retrieved!.status).toBe('online');
      expect(retrieved!.trust_level).toBe('untrusted');
      expect(retrieved!.capabilities).toBe(JSON.stringify(agent.capabilities));
      expect(retrieved!.public_key).toEqual(Buffer.from(agent.publicKey));
    });

    it('should update an existing agent via upsert', () => {
      const agent = makeAgent();
      db.upsertAgent(agent);

      const updated = makeAgent({
        name: 'Updated Agent',
        status: 'offline',
        trustLevel: 'trusted',
      });
      db.upsertAgent(updated);

      const retrieved = db.getAgent(agent.agentId);
      expect(retrieved!.name).toBe('Updated Agent');
      expect(retrieved!.status).toBe('offline');
      expect(retrieved!.trust_level).toBe('trusted');
    });

    it('should list all agents', () => {
      db.upsertAgent(makeAgent({ agentId: 'agent-1', name: 'Agent 1' }));
      db.upsertAgent(makeAgent({ agentId: 'agent-2', name: 'Agent 2' }));

      const agents = db.listAgents();
      expect(agents).toHaveLength(2);
      const names = agents.map((a) => a.name);
      expect(names).toContain('Agent 1');
      expect(names).toContain('Agent 2');
    });

    it('should remove an agent', () => {
      const agent = makeAgent();
      db.upsertAgent(agent);
      expect(db.getAgent(agent.agentId)).not.toBeNull();

      db.removeAgent(agent.agentId);
      expect(db.getAgent(agent.agentId)).toBeNull();
    });
  });

  describe('Task CRUD', () => {
    it('should insert and retrieve a task', () => {
      const task = makeTask();
      db.upsertTask(task);

      const retrieved = db.getTask(task.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(task.id);
      expect(retrieved!.type).toBe(task.type);
      expect(retrieved!.title).toBe(task.title);
      expect(retrieved!.description).toBe(task.description);
      expect(retrieved!.requester).toBe(task.requester);
      expect(retrieved!.executor).toBe(task.executor);
      expect(retrieved!.status).toBe('created');
      expect(retrieved!.priority).toBe('medium');
      expect(retrieved!.artifacts).toBe(JSON.stringify(task.artifacts));
    });

    it('should update an existing task via upsert', () => {
      const task = makeTask();
      db.upsertTask(task);

      const updated = makeTask({
        title: 'Updated Task',
        status: 'in_progress',
        priority: 'high',
      });
      db.upsertTask(updated);

      const retrieved = db.getTask(task.id);
      expect(retrieved!.title).toBe('Updated Task');
      expect(retrieved!.status).toBe('in_progress');
      expect(retrieved!.priority).toBe('high');
    });

    it('should list all tasks', () => {
      db.upsertTask(makeTask({ id: 'task-1', title: 'Task 1' }));
      db.upsertTask(makeTask({ id: 'task-2', title: 'Task 2' }));
      db.upsertTask(makeTask({ id: 'task-3', title: 'Task 3' }));

      const tasks = db.listTasks();
      expect(tasks).toHaveLength(3);
    });

    it('should list tasks filtered by status', () => {
      db.upsertTask(makeTask({ id: 'task-1', status: 'created' }));
      db.upsertTask(makeTask({ id: 'task-2', status: 'in_progress' }));
      db.upsertTask(makeTask({ id: 'task-3', status: 'created' }));

      const createdTasks = db.listTasks('created');
      expect(createdTasks).toHaveLength(2);
      expect(createdTasks.every((t) => t.status === 'created')).toBe(true);
    });

    it('should update task status', () => {
      const task = makeTask();
      db.upsertTask(task);

      db.updateTaskStatus(task.id, 'completed');

      const retrieved = db.getTask(task.id);
      expect(retrieved!.status).toBe('completed');
    });

    it('should remove a task', () => {
      const task = makeTask();
      db.upsertTask(task);
      expect(db.getTask(task.id)).not.toBeNull();

      db.removeTask(task.id);
      expect(db.getTask(task.id)).toBeNull();
    });
  });

  describe('Address Book CRUD', () => {
    it('should insert and retrieve an address entry', () => {
      const entry = {
        agentId: 'agent-addr-1',
        hostname: 'test-agent.local',
        lastKnownIp: '192.168.1.100',
        port: 9876,
        lastSeen: Date.now(),
        source: 'mdns' as const,
        connectionCount: 3,
      };
      db.upsertAddress(entry);

      const retrieved = db.getAddress(entry.agentId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.agent_id).toBe(entry.agentId);
      expect(retrieved!.hostname).toBe(entry.hostname);
      expect(retrieved!.last_known_ip).toBe(entry.lastKnownIp);
      expect(retrieved!.port).toBe(entry.port);
      expect(retrieved!.source).toBe('mdns');
      expect(retrieved!.connection_count).toBe(3);
    });

    it('should update an existing address via upsert', () => {
      const entry = {
        agentId: 'agent-addr-1',
        hostname: 'test-agent.local',
        lastKnownIp: '192.168.1.100',
        port: 9876,
        lastSeen: Date.now(),
        source: 'mdns' as const,
        connectionCount: 1,
      };
      db.upsertAddress(entry);

      const updated = {
        ...entry,
        lastKnownIp: '192.168.1.200',
        port: 9999,
        connectionCount: 5,
      };
      db.upsertAddress(updated);

      const retrieved = db.getAddress(entry.agentId);
      expect(retrieved!.last_known_ip).toBe('192.168.1.200');
      expect(retrieved!.port).toBe(9999);
      expect(retrieved!.connection_count).toBe(5);
    });

    it('should list all addresses', () => {
      db.upsertAddress({
        agentId: 'addr-1',
        hostname: 'a.local',
        lastKnownIp: '10.0.0.1',
        port: 9876,
        lastSeen: Date.now(),
        source: 'mdns',
        connectionCount: 0,
      });
      db.upsertAddress({
        agentId: 'addr-2',
        hostname: 'b.local',
        lastKnownIp: '10.0.0.2',
        port: 9876,
        lastSeen: Date.now(),
        source: 'static',
        connectionCount: 0,
      });

      const addresses = db.listAddresses();
      expect(addresses).toHaveLength(2);
    });
  });

  describe('close', () => {
    it('should close the database without error', () => {
      expect(() => db.close()).not.toThrow();
    });
  });
});
