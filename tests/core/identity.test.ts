import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateIdentity,
  deriveAgentId,
  signMessage,
  verifyMessage,
  getFingerprint,
  saveIdentity,
  loadIdentity,
} from '../../src/core/identity.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Identity Module', () => {
  it('should generate valid Ed25519 keypair', async () => {
    const identity = await generateIdentity({
      name: 'Test Agent',
      agentType: 'test',
      capabilities: ['testing'],
    });

    expect(identity.publicKey).toBeInstanceOf(Uint8Array);
    expect(identity.publicKey.length).toBe(32);
    expect(identity.secretKey).toBeInstanceOf(Uint8Array);
    expect(identity.secretKey.length).toBe(64);
    expect(identity.name).toBe('Test Agent');
    expect(identity.agentType).toBe('test');
    expect(identity.capabilities).toEqual(['testing']);
  });

  it('should derive agent ID with al- prefix and Base32 groups', async () => {
    const identity = await generateIdentity({
      name: 'Test',
      agentType: 'test',
      capabilities: [],
    });

    expect(identity.agentId).toMatch(/^al-[0-9A-HJ-KM-NP-TV-Z]{8}-[0-9A-HJ-KM-NP-TV-Z]{8}-[0-9A-HJ-KM-NP-TV-Z]{8}$/);
  });

  it('should derive same agent ID from same public key', async () => {
    const identity = await generateIdentity({
      name: 'Test',
      agentType: 'test',
      capabilities: [],
    });

    const derived = deriveAgentId(identity.publicKey);
    expect(derived).toBe(identity.agentId);
  });

  it('should sign and verify messages', async () => {
    const identity = await generateIdentity({
      name: 'Test',
      agentType: 'test',
      capabilities: [],
    });

    const message = {
      jsonrpc: '2.0' as const,
      id: 'test-123',
      method: 'agent.ping',
      params: {},
      timestamp: new Date().toISOString(),
    };

    const signature = signMessage(message, identity.secretKey);
    expect(typeof signature).toBe('string');
    expect(signature.length).toBeGreaterThan(0);

    const valid = verifyMessage(message, signature, identity.publicKey);
    expect(valid).toBe(true);
  });

  it('should reject tampered message signatures', async () => {
    const identity = await generateIdentity({
      name: 'Test',
      agentType: 'test',
      capabilities: [],
    });

    const identity2 = await generateIdentity({
      name: 'Other',
      agentType: 'test',
      capabilities: [],
    });

    const message = {
      jsonrpc: '2.0' as const,
      id: 'test-123',
      method: 'agent.ping',
      params: {},
      timestamp: new Date().toISOString(),
    };

    const signature = signMessage(message, identity.secretKey);
    // Verify with wrong key should fail
    const valid = verifyMessage(message, signature, identity2.publicKey);
    expect(valid).toBe(false);
  });

  it('should generate 16-char hex fingerprint', async () => {
    const identity = await generateIdentity({
      name: 'Test',
      agentType: 'test',
      capabilities: [],
    });

    const fp = getFingerprint(identity.publicKey);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('should generate different fingerprints for different keys', async () => {
    const id1 = await generateIdentity({ name: 'A', agentType: 't', capabilities: [] });
    const id2 = await generateIdentity({ name: 'B', agentType: 't', capabilities: [] });

    expect(getFingerprint(id1.publicKey)).not.toBe(getFingerprint(id2.publicKey));
  });

  it('should save and load identity', async () => {
    const identity = await generateIdentity({
      name: 'Persist Test',
      agentType: 'test',
      capabilities: ['persistence'],
    });

    saveIdentity(identity, tmpDir);

    const loaded = loadIdentity(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.agentId).toBe(identity.agentId);
    expect(loaded!.name).toBe(identity.name);
    expect(loaded!.agentType).toBe(identity.agentType);
    expect(loaded!.capabilities).toEqual(identity.capabilities);

    // Verify key round-trip
    expect(Buffer.from(loaded!.publicKey).equals(Buffer.from(identity.publicKey))).toBe(true);
    expect(Buffer.from(loaded!.secretKey).equals(Buffer.from(identity.secretKey))).toBe(true);
  });

  it('should return null when no identity exists', () => {
    const loaded = loadIdentity(tmpDir);
    expect(loaded).toBeNull();
  });

  it('should generate unique agent IDs', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const identity = await generateIdentity({
        name: `Agent ${i}`,
        agentType: 'test',
        capabilities: [],
      });
      ids.add(identity.agentId);
    }
    expect(ids.size).toBe(10);
  });
});
