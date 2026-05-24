/**
 * Integration: Audit trail integrity
 *
 * Verifies that all inbound/outbound operations produce audit log
 * entries, and the log format is correct and complete.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TestAgent, cleanupAgents } from './helpers/test-harness.js';
import { AuditLogger } from '../../src/core/audit-logger.js';
import { Methods } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let agents: TestAgent[] = [];

afterEach(() => {
  cleanupAgents(agents);
  agents = [];
});

describe('Audit trail integrity', () => {
  it('AuditLogger writes valid JSONL to disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-audit-'));
    try {
      const logger = new AuditLogger(dir);

      logger.log({
        timestamp: '2026-01-01T00:00:00.000Z',
        eventType: 'test.event',
        agentId: 'al-test0000',
        direction: 'inbound',
        details: { key: 'value' },
      });

      logger.log({
        timestamp: '2026-01-01T00:00:01.000Z',
        eventType: 'another.event',
        details: { count: 42 },
      });

      // Read the log file
      const files = fs.readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^audit-\d{4}-\d{2}-\d{2}\.jsonl$/);

      const content = fs.readFileSync(path.join(dir, files[0]), 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);

      const entry1 = JSON.parse(lines[0]);
      expect(entry1.eventType).toBe('test.event');
      expect(entry1.agentId).toBe('al-test0000');
      expect(entry1.direction).toBe('inbound');
      expect(entry1.details.key).toBe('value');

      const entry2 = JSON.parse(lines[1]);
      expect(entry2.eventType).toBe('another.event');
      expect(entry2.details.count).toBe(42);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('transport audit events are emitted for outbound messages', async () => {
    const a = await TestAgent.create({ name: 'Sender', agentType: 'test', capabilities: [] });
    const b = await TestAgent.create({ name: 'Receiver', agentType: 'test', capabilities: [] });
    agents.push(a, b);

    await a.start();
    await b.start();
    await a.connectTo(b);

    a.sendMessage(b.identity.agentId, Methods.TASK_CREATE, { title: 'Audit test' });
    await a.flush(300);

    // Check audit events emitted by transport
    const outboundAudits = a.auditEvents.filter(
      e => e.direction === 'outbound' && e.eventType === Methods.TASK_CREATE,
    );
    expect(outboundAudits.length).toBeGreaterThanOrEqual(1);
    expect(outboundAudits[0].details.targetAgentId).toBe(b.identity.agentId);
  });

  it('transport audit events are emitted for inbound messages', async () => {
    const a = await TestAgent.create({ name: 'Sender', agentType: 'test', capabilities: [] });
    const b = await TestAgent.create({ name: 'Receiver', agentType: 'test', capabilities: [] });
    agents.push(a, b);

    await a.start();
    await b.start();
    await a.connectTo(b);

    a.sendMessage(b.identity.agentId, Methods.TASK_CREATE, { title: 'Inbound audit' });
    await b.waitForMessage(Methods.TASK_CREATE);

    const inboundAudits = b.auditEvents.filter(
      e => e.direction === 'inbound' && e.eventType === Methods.TASK_CREATE,
    );
    expect(inboundAudits.length).toBeGreaterThanOrEqual(1);
  });

  it('handshake produces audit events', async () => {
    const a = await TestAgent.create({ name: 'Client', agentType: 'test', capabilities: [] });
    const b = await TestAgent.create({ name: 'Server', agentType: 'test', capabilities: [] });
    agents.push(a, b);

    await a.start();
    await b.start();
    await a.connectTo(b);

    const handshakeAudits = a.auditEvents.filter(
      e => e.eventType === 'handshake',
    );
    expect(handshakeAudits.length).toBeGreaterThanOrEqual(1);
    expect(handshakeAudits[0].details.step).toBe('keys-exchanged');
  });

  it('agent.card exchange produces audit events', async () => {
    const a = await TestAgent.create({ name: 'A', agentType: 'test', capabilities: [] });
    const b = await TestAgent.create({ name: 'B', agentType: 'test', capabilities: [] });
    agents.push(a, b);

    await a.start();
    await b.start();
    await a.connectTo(b);

    const cardAudits = b.auditEvents.filter(
      e => e.eventType === Methods.AGENT_CARD,
    );
    expect(cardAudits.length).toBeGreaterThanOrEqual(1);
  });

  it('multiple messages produce sequential audit entries', async () => {
    const a = await TestAgent.create({ name: 'Sender', agentType: 'test', capabilities: [] });
    const b = await TestAgent.create({ name: 'Receiver', agentType: 'test', capabilities: [] });
    agents.push(a, b);

    await a.start();
    await b.start();
    await a.connectTo(b);

    // Send 3 messages
    for (let i = 0; i < 3; i++) {
      a.sendMessage(b.identity.agentId, Methods.TASK_PROGRESS, { step: i });
    }
    await a.flush(300);

    const outboundAudits = a.auditEvents.filter(
      e => e.direction === 'outbound' && e.eventType === Methods.TASK_PROGRESS,
    );
    expect(outboundAudits.length).toBeGreaterThanOrEqual(3);
  });

  it('audit event contains all required fields', async () => {
    const a = await TestAgent.create({ name: 'A', agentType: 'test', capabilities: [] });
    const b = await TestAgent.create({ name: 'B', agentType: 'test', capabilities: [] });
    agents.push(a, b);

    await a.start();
    await b.start();
    await a.connectTo(b);

    a.sendMessage(b.identity.agentId, Methods.TASK_CREATE, { test: true });
    await a.flush(300);

    const event = a.auditEvents.find(
      e => e.direction === 'outbound' && e.eventType === Methods.TASK_CREATE,
    );
    expect(event).toBeDefined();
    expect(event!.timestamp).toBeTruthy();
    expect(event!.eventType).toBe(Methods.TASK_CREATE);
    expect(event!.details).toBeDefined();
  });

  it('readAuditLog returns parsed entries from disk', async () => {
    const a = await TestAgent.create({ name: 'AuditTest', agentType: 'test', capabilities: [] });
    agents.push(a);

    // Write an audit event
    a.auditLogger.log({
      timestamp: new Date().toISOString(),
      eventType: 'manual.test',
      details: { manual: true },
    });

    const logs = a.readAuditLog();
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs.find(l => l.eventType === 'manual.test')).toBeDefined();
  });
});
