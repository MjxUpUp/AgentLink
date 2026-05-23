import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { AgentDatabase } from '../../src/db/database.js';
import { AddressBook } from '../../src/core/address-book.js';

const require = createRequire(import.meta.url);

let tmpDir: string;
let db: AgentDatabase;
let addressBook: AddressBook;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-ab-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  db = new AgentDatabase(dbPath);
  addressBook = new AddressBook(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('AddressBook', () => {
  it('should add a new address entry', () => {
    addressBook.updateAddress('agent-1', '192.168.1.10', 9876, 'mdns');

    const addr = addressBook.resolveAddress('agent-1');
    expect(addr).not.toBeNull();
    expect(addr!.ip).toBe('192.168.1.10');
    expect(addr!.port).toBe(9876);
  });

  it('should update an existing address entry', () => {
    addressBook.updateAddress('agent-1', '192.168.1.10', 9876, 'mdns');
    addressBook.updateAddress('agent-1', '10.0.0.5', 9000, 'static');

    const addr = addressBook.resolveAddress('agent-1');
    expect(addr).not.toBeNull();
    expect(addr!.ip).toBe('10.0.0.5');
    expect(addr!.port).toBe(9000);
  });

  it('should return known address via resolveAddress', () => {
    addressBook.updateAddress('agent-2', '172.16.0.1', 5555, 'address-book');

    const addr = addressBook.resolveAddress('agent-2');
    expect(addr).toEqual({ ip: '172.16.0.1', port: 5555 });
  });

  it('should return null for unknown agent via resolveAddress', () => {
    const addr = addressBook.resolveAddress('unknown-agent');
    expect(addr).toBeNull();
  });

  it('should remove an agent entry', () => {
    addressBook.updateAddress('agent-3', '192.168.1.20', 8080, 'static');
    expect(addressBook.resolveAddress('agent-3')).not.toBeNull();

    addressBook.removeAgent('agent-3');
    expect(addressBook.resolveAddress('agent-3')).toBeNull();
  });

  it('should list all known agents', () => {
    addressBook.updateAddress('agent-a', '10.0.0.1', 1000, 'mdns');
    addressBook.updateAddress('agent-b', '10.0.0.2', 2000, 'static');

    const agents = addressBook.listAgents();
    expect(agents).toHaveLength(2);

    const ids = agents.map(a => a.agentId).sort();
    expect(ids).toEqual(['agent-a', 'agent-b']);

    const agentA = agents.find(a => a.agentId === 'agent-a')!;
    expect(agentA.ip).toBe('10.0.0.1');
    expect(agentA.port).toBe(1000);
    expect(agentA.source).toBe('mdns');
    expect(agentA.connectionCount).toBe(1);
    expect(typeof agentA.lastSeen).toBe('number');
  });

  it('should increment connection_count on multiple updates', () => {
    addressBook.updateAddress('agent-1', '192.168.1.10', 9876, 'mdns');
    addressBook.updateAddress('agent-1', '192.168.1.10', 9876, 'mdns');
    addressBook.updateAddress('agent-1', '192.168.1.11', 9877, 'static');

    const agents = addressBook.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].connectionCount).toBe(3);
  });
});
