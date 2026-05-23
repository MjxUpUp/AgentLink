import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AuditLogger } from '../../src/core/audit-logger.js';
import type { AuditEvent } from '../../src/core/types.js';

let tmpDir: string;
let logger: AuditLogger;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-audit-test-'));
  logger = new AuditLogger(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('AuditLogger', () => {
  it('should write a valid JSON line to the correct file', () => {
    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      eventType: 'agent.connected',
      details: { peer: 'al-12345678' },
    };

    logger.log(event);

    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(tmpDir, `audit-${today}.jsonl`);
    expect(fs.existsSync(filePath)).toBe(true);

    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed).toEqual(event);
  });

  it('should use today\'s date in the filename', () => {
    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      eventType: 'test',
      details: {},
    };

    logger.log(event);

    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBe(1);

    const today = new Date().toISOString().slice(0, 10);
    expect(files[0]).toBe(`audit-${today}.jsonl`);
  });

  it('should auto-create the log directory if missing', () => {
    const nestedDir = path.join(tmpDir, 'sub', 'dir', 'logs');
    const nestedLogger = new AuditLogger(nestedDir);

    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      eventType: 'test.auto-create',
      details: { created: true },
    };

    nestedLogger.log(event);

    expect(fs.existsSync(nestedDir)).toBe(true);
    const files = fs.readdirSync(nestedDir);
    expect(files.length).toBe(1);

    const content = fs.readFileSync(path.join(nestedDir, files[0]), 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.eventType).toBe('test.auto-create');
  });

  it('should include all required fields in each line', () => {
    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      eventType: 'task.create',
      agentId: 'al-ABCDEFGH-12345678-IJKLMNOPQ',
      direction: 'inbound',
      details: { taskId: 't-001', priority: 'high' },
    };

    logger.log(event);

    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(tmpDir, `audit-${today}.jsonl`);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8').trim());

    expect(parsed).toHaveProperty('timestamp');
    expect(parsed).toHaveProperty('eventType');
    expect(parsed).toHaveProperty('details');
    expect(parsed.timestamp).toBe(event.timestamp);
    expect(parsed.eventType).toBe(event.eventType);
    expect(parsed.agentId).toBe(event.agentId);
    expect(parsed.direction).toBe(event.direction);
    expect(parsed.details).toEqual(event.details);
  });

  it('should append multiple log calls to the same file', () => {
    const events: AuditEvent[] = [
      {
        timestamp: new Date().toISOString(),
        eventType: 'agent.connected',
        details: { peer: 'agent-1' },
      },
      {
        timestamp: new Date().toISOString(),
        eventType: 'task.create',
        agentId: 'al-12345678',
        direction: 'inbound',
        details: { taskId: 't-001' },
      },
      {
        timestamp: new Date().toISOString(),
        eventType: 'task.complete',
        agentId: 'al-12345678',
        direction: 'outbound',
        details: { taskId: 't-001', result: 'success' },
      },
    ];

    for (const event of events) {
      logger.log(event);
    }

    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(tmpDir, `audit-${today}.jsonl`);
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');

    expect(lines.length).toBe(3);

    for (let i = 0; i < events.length; i++) {
      const parsed = JSON.parse(lines[i]);
      expect(parsed).toEqual(events[i]);
    }
  });
});
