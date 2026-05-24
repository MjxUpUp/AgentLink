/**
 * Reusable test harness for spinning up fully-wired AgentLink nodes
 * in integration tests.
 *
 * Each TestAgent bundles: Identity, Transport, TaskManager, TrustManager,
 * AuditLogger, AddressBook, and an in-memory SQLite database — all backed
 * by real I/O (temp dirs, real TCP sockets, real libsodium crypto).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateIdentity, signMessage } from '../../../src/core/identity.js';
import { Transport } from '../../../src/core/transport.js';
import { TaskManager } from '../../../src/core/task-manager.js';
import { TrustManager } from '../../../src/core/trust-manager.js';
import { AuditLogger } from '../../../src/core/audit-logger.js';
import { AddressBook } from '../../../src/core/address-book.js';
import { AgentDatabase } from '../../../src/db/database.js';
import type { AgentIdentity, AgentLinkMessage } from '../../../src/core/types.js';
import { nextPort } from './port-allocator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestAgentOptions {
  name: string;
  agentType: string;
  capabilities: string[];
  port?: number;
}

export interface CapturedMessage {
  agentId: string;
  msg: AgentLinkMessage;
}

export class TestAgent {
  identity: AgentIdentity;
  transport!: Transport;
  taskManager: TaskManager;
  trustManager: TrustManager;
  auditLogger: AuditLogger;
  addressBook: AddressBook;
  database: AgentDatabase;
  port: number;
  name: string;

  receivedMessages: CapturedMessage[] = [];
  auditEvents: Array<{
    timestamp: string;
    eventType: string;
    agentId?: string;
    direction?: string;
    details: Record<string, unknown>;
  }> = [];

  tempDir: string;

  private constructor(
    identity: AgentIdentity,
    taskManager: TaskManager,
    trustManager: TrustManager,
    auditLogger: AuditLogger,
    addressBook: AddressBook,
    database: AgentDatabase,
    port: number,
    tempDir: string,
    name: string,
  ) {
    this.identity = identity;
    this.taskManager = taskManager;
    this.trustManager = trustManager;
    this.auditLogger = auditLogger;
    this.addressBook = addressBook;
    this.database = database;
    this.port = port;
    this.tempDir = tempDir;
    this.name = name;
  }

  // -----------------------------------------------------------------------
  // Factory
  // -----------------------------------------------------------------------

  static async create(opts: TestAgentOptions): Promise<TestAgent> {
    const identity = await generateIdentity({
      name: opts.name,
      agentType: opts.agentType,
      capabilities: opts.capabilities,
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `agentlink-${opts.name}-`));
    const port = opts.port ?? nextPort();

    const dbPath = path.join(tempDir, 'agentlink.db');
    const database = new AgentDatabase(dbPath);
    const taskManager = new TaskManager(dbPath);
    const trustManager = new TrustManager(path.join(tempDir, 'trust.json'));
    const auditLogger = new AuditLogger(path.join(tempDir, 'logs'));
    const addressBook = new AddressBook(database);

    const agent = new TestAgent(
      identity, taskManager, trustManager,
      auditLogger, addressBook, database, port, tempDir, opts.name,
    );

    // Create transport AFTER agent so callbacks can reference agent fields
    const transport = new Transport(
      identity,
      (agentId, msg) => {
        agent.receivedMessages.push({ agentId, msg });
      },
      (event) => {
        agent.auditEvents.push(event);
      },
    );

    agent.transport = transport;
    return agent;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    await this.transport.startServer(this.port);
  }

  stop(): void {
    this.transport.stop();
    this.taskManager.close();
    try { this.database.close(); } catch { /* nop */ }
  }

  cleanup(): void {
    this.stop();
    if (this.tempDir) {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  trustOther(other: TestAgent): void {
    this.trustManager.addTrust(other.identity.agentId, other.identity.publicKey, other.name);
    other.trustManager.addTrust(this.identity.agentId, this.identity.publicKey, this.name);
  }

  async connectTo(other: TestAgent): Promise<void> {
    await this.transport.connect('127.0.0.1', other.port);
  }

  sendMessage(to: string, method: string, params: Record<string, unknown> = {}): void {
    const msg = {
      jsonrpc: '2.0' as const,
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      params,
      timestamp: new Date().toISOString(),
    };
    const signature = signMessage(msg, this.identity.secretKey);
    this.transport.send(to, { ...msg, signature });
  }

  async waitForMessage(method: string, timeoutMs = 3000): Promise<CapturedMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.receivedMessages.find(m => m.msg.method === method);
      if (found) return found;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for message: ${method}`);
  }

  async waitForMessages(method: string, count: number, timeoutMs = 5000): Promise<CapturedMessage[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.receivedMessages.filter(m => m.msg.method === method);
      if (found.length >= count) return found.slice(0, count);
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for ${count} messages: ${method}`);
  }

  async flush(ms = 200): Promise<void> {
    await new Promise(r => setTimeout(r, ms));
  }

  createTask(opts: {
    executor: string;
    type: string;
    title: string;
    description: string;
    priority: string;
  }) {
    return this.taskManager.createTask({
      requester: this.identity.agentId,
      executor: opts.executor,
      ...opts,
    });
  }

  readAuditLog(): any[] {
    const logs: any[] = [];
    const logDir = path.join(this.tempDir, 'logs');
    if (!fs.existsSync(logDir)) return logs;

    const files = fs.readdirSync(logDir);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const content = fs.readFileSync(path.join(logDir, file), 'utf-8');
      for (const line of content.split('\n').filter(Boolean)) {
        logs.push(JSON.parse(line));
      }
    }
    return logs;
  }
}

// ---------------------------------------------------------------------------
// Utility: create N fully-wired, mutually-trusted, interconnected agents.
// ---------------------------------------------------------------------------

export async function createAgentMesh(opts: Array<TestAgentOptions>): Promise<TestAgent[]> {
  const agents: TestAgent[] = [];

  for (const opt of opts) {
    const agent = await TestAgent.create(opt);
    await agent.start();
    agents.push(agent);
  }

  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      agents[i].trustOther(agents[j]);
      await agents[i].connectTo(agents[j]);
    }
  }

  return agents;
}

export function cleanupAgents(agents: TestAgent[]): void {
  for (const agent of agents) {
    agent.cleanup();
  }
}
