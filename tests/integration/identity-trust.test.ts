/**
 * Integration: Identity + TrustManager
 *
 * Verifies real key generation, signing/verification, trust lifecycle,
 * and team seed export/import round-trip.
 */

import { describe, it, expect } from 'vitest';
import { generateIdentity, deriveAgentId, signMessage, verifyMessage, getFingerprint } from '../../src/core/identity.js';
import { TrustManager } from '../../src/core/trust-manager.js';
import type { TeamSeed } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-id-trust-'));
}

describe('Identity + TrustManager integration', () => {
  it('generates identity with valid agent ID derived from public key', async () => {
    const identity = await generateIdentity({
      name: 'TestBot',
      agentType: 'coder',
      capabilities: ['review', 'deploy'],
    });

    expect(identity.agentId).toMatch(/^al-[0-9A-Z]{8}-[0-9A-Z]{8}-[0-9A-Z]{8}$/);
    expect(identity.agentId).toBe(deriveAgentId(identity.publicKey));
    expect(identity.publicKey).toBeInstanceOf(Uint8Array);
    expect(identity.publicKey.length).toBe(32);
    expect(identity.secretKey).toBeInstanceOf(Uint8Array);
    expect(identity.name).toBe('TestBot');
    expect(identity.agentType).toBe('coder');
    expect(identity.capabilities).toEqual(['review', 'deploy']);
  });

  it('signs and verifies messages with real Ed25519', async () => {
    const identity = await generateIdentity({
      name: 'Signer',
      agentType: 'test',
      capabilities: [],
    });

    const msg = {
      jsonrpc: '2.0' as const,
      id: 'msg-001',
      method: 'task.create',
      params: { title: 'Hello' },
      timestamp: new Date().toISOString(),
    };

    const signature = signMessage(msg, identity.secretKey);
    expect(typeof signature).toBe('string');
    expect(signature.length).toBeGreaterThan(0);

    const valid = verifyMessage(msg, signature, identity.publicKey);
    expect(valid).toBe(true);
  });

  it('rejects tampered message signature', async () => {
    const identity = await generateIdentity({
      name: 'TamperTest',
      agentType: 'test',
      capabilities: [],
    });

    const msg = {
      jsonrpc: '2.0' as const,
      id: 'msg-002',
      method: 'task.create',
      params: { title: 'Original' },
      timestamp: new Date().toISOString(),
    };

    const signature = signMessage(msg, identity.secretKey);

    // Tamper with the message content
    const tampered = { ...msg, params: { title: 'Tampered' } };
    const valid = verifyMessage(tampered, signature, identity.publicKey);
    expect(valid).toBe(false);
  });

  it('rejects signature from a different key pair', async () => {
    const alice = await generateIdentity({ name: 'Alice', agentType: 'test', capabilities: [] });
    const bob = await generateIdentity({ name: 'Bob', agentType: 'test', capabilities: [] });

    const msg = {
      jsonrpc: '2.0' as const,
      id: 'msg-003',
      method: 'ping',
      params: {},
      timestamp: new Date().toISOString(),
    };

    const sig = signMessage(msg, alice.secretKey);

    // Verify with Bob's key — should fail
    expect(verifyMessage(msg, sig, bob.publicKey)).toBe(false);
    // Verify with Alice's key — should succeed
    expect(verifyMessage(msg, sig, alice.publicKey)).toBe(true);
  });

  it('fingerprint is stable for the same public key', async () => {
    const id = await generateIdentity({ name: 'FP', agentType: 'test', capabilities: [] });
    const fp1 = getFingerprint(id.publicKey);
    const fp2 = getFingerprint(id.publicKey);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('different identities produce different agent IDs and fingerprints', async () => {
    const a = await generateIdentity({ name: 'A', agentType: 'test', capabilities: [] });
    const b = await generateIdentity({ name: 'B', agentType: 'test', capabilities: [] });
    expect(a.agentId).not.toBe(b.agentId);
    expect(getFingerprint(a.publicKey)).not.toBe(getFingerprint(b.publicKey));
  });

  it('trust lifecycle: add → check → remove → check', async () => {
    const dir = tmpDir();
    try {
      const tm = new TrustManager(path.join(dir, 'trust.json'));
      const id = await generateIdentity({ name: 'Peer', agentType: 'test', capabilities: [] });

      expect(tm.isTrusted(id.agentId)).toBe(false);

      tm.addTrust(id.agentId, id.publicKey, 'Peer');
      expect(tm.isTrusted(id.agentId)).toBe(true);
      expect(tm.shouldAutoApprove(id.agentId)).toBe(true);

      const record = tm.getTrust(id.agentId);
      expect(record).not.toBeNull();
      expect(record!.alias).toBe('Peer');
      expect(record!.trustLevel).toBe('trusted');

      const removed = tm.removeTrust(id.agentId);
      expect(removed).toBe(true);
      expect(tm.isTrusted(id.agentId)).toBe(false);
      expect(tm.getTrust(id.agentId)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('trust persists to disk and can be reloaded', async () => {
    const dir = tmpDir();
    try {
      const trustPath = path.join(dir, 'trust.json');
      const id = await generateIdentity({ name: 'Persist', agentType: 'test', capabilities: [] });

      const tm1 = new TrustManager(trustPath);
      tm1.addTrust(id.agentId, id.publicKey, 'Persist');

      // Reload from disk
      const tm2 = new TrustManager(trustPath);
      expect(tm2.isTrusted(id.agentId)).toBe(true);
      const record = tm2.getTrust(id.agentId);
      expect(record!.alias).toBe('Persist');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('team seed export/import round-trip preserves all members', async () => {
    const dir = tmpDir();
    try {
      const trustPath = path.join(dir, 'trust.json');
      const tm = new TrustManager(trustPath);

      const idA = await generateIdentity({ name: 'A', agentType: 'test', capabilities: [] });
      const idB = await generateIdentity({ name: 'B', agentType: 'test', capabilities: [] });
      const idC = await generateIdentity({ name: 'C', agentType: 'test', capabilities: [] });

      tm.addTrust(idA.agentId, idA.publicKey, 'Alpha');
      tm.addTrust(idB.agentId, idB.publicKey, 'Beta');
      tm.addTrust(idC.agentId, idC.publicKey, 'Gamma');

      // Export
      const seed: TeamSeed = tm.exportTeamSeed();
      expect(seed.version).toBe(1);
      expect(seed.members).toHaveLength(3);
      expect(seed.exportedAt).toBeTruthy();

      // Import into a fresh TrustManager
      const importPath = path.join(dir, 'imported-trust.json');
      const tm2 = new TrustManager(importPath);
      const count = tm2.importTeamSeed(seed);
      expect(count).toBe(3);

      expect(tm2.isTrusted(idA.agentId)).toBe(true);
      expect(tm2.isTrusted(idB.agentId)).toBe(true);
      expect(tm2.isTrusted(idC.agentId)).toBe(true);

      const recA = tm2.getTrust(idA.agentId);
      expect(recA!.alias).toBe('Alpha');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('listTrusted returns all trusted agents', async () => {
    const dir = tmpDir();
    try {
      const tm = new TrustManager(path.join(dir, 'trust.json'));
      const id = await generateIdentity({ name: 'Peer', agentType: 'test', capabilities: [] });
      tm.addTrust(id.agentId, id.publicKey);
      expect(tm.listTrusted()).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
