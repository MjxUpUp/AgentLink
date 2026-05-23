import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TrustManager } from '../../src/core/trust-manager.js';
import type { TrustRecord, TeamSeed } from '../../src/core/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-trust-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('TrustManager', () => {
  function trustFilePath(): string {
    return path.join(tmpDir, 'trust.json');
  }

  function makePublicKey(): Uint8Array {
    const key = new Uint8Array(32);
    for (let i = 0; i < 32; i++) key[i] = Math.floor(Math.random() * 256);
    return key;
  }

  it('should add and retrieve a trust record (round-trip)', () => {
    const tm = new TrustManager(trustFilePath());
    const pk = makePublicKey();

    tm.addTrust('al-aaaaaaaa-bbbbbbbb-cccccccc', pk, 'Agent A');

    const record = tm.getTrust('al-aaaaaaaa-bbbbbbbb-cccccccc');
    expect(record).not.toBeNull();
    expect(record!.agentId).toBe('al-aaaaaaaa-bbbbbbbb-cccccccc');
    expect(record!.alias).toBe('Agent A');
    expect(record!.trustLevel).toBe('trusted');
    expect(record!.autoApprove).toBe(true);
    expect(record!.trustedAt).toBeGreaterThan(0);
    expect(Buffer.from(record!.publicKey).equals(Buffer.from(pk))).toBe(true);
  });

  it('should return null for unknown agent', () => {
    const tm = new TrustManager(trustFilePath());
    const record = tm.getTrust('al-unknown000-00000000-00000000');
    expect(record).toBeNull();
  });

  it('should remove trust and return true/false', () => {
    const tm = new TrustManager(trustFilePath());
    const pk = makePublicKey();

    tm.addTrust('al-remove0000-00000000-00000000', pk);

    expect(tm.removeTrust('al-remove0000-00000000-00000000')).toBe(true);
    expect(tm.getTrust('al-remove0000-00000000-00000000')).toBeNull();

    // Removing non-existent returns false
    expect(tm.removeTrust('al-nope00000-00000000-00000000')).toBe(false);
  });

  it('should list all trusted agents', () => {
    const tm = new TrustManager(trustFilePath());

    const pk1 = makePublicKey();
    const pk2 = makePublicKey();
    const pk3 = makePublicKey();

    tm.addTrust('al-agent0001-00000000-00000000', pk1, 'One');
    tm.addTrust('al-agent0002-00000000-00000000', pk2, 'Two');
    tm.addTrust('al-agent0003-00000000-00000000', pk3, 'Three');

    const list = tm.listTrusted();
    expect(list).toHaveLength(3);

    const ids = list.map((r) => r.agentId).sort();
    expect(ids).toEqual([
      'al-agent0001-00000000-00000000',
      'al-agent0002-00000000-00000000',
      'al-agent0003-00000000-00000000',
    ]);
  });

  it('should check isTrusted correctly', () => {
    const tm = new TrustManager(trustFilePath());
    const pk = makePublicKey();

    expect(tm.isTrusted('al-check0000-00000000-00000000')).toBe(false);

    tm.addTrust('al-check0000-00000000-00000000', pk);

    expect(tm.isTrusted('al-check0000-00000000-00000000')).toBe(true);
    expect(tm.isTrusted('al-other0000-00000000-00000000')).toBe(false);
  });

  it('should check shouldAutoApprove for trusted entries', () => {
    const tm = new TrustManager(trustFilePath());
    const pk = makePublicKey();

    expect(tm.shouldAutoApprove('al-auto00000-00000000-00000000')).toBe(false);

    tm.addTrust('al-auto00000-00000000-00000000', pk);

    expect(tm.shouldAutoApprove('al-auto00000-00000000-00000000')).toBe(true);
  });

  it('should import team seed with multiple entries', () => {
    const tm = new TrustManager(trustFilePath());

    const pk1 = makePublicKey();
    const pk2 = makePublicKey();

    const seed: TeamSeed = {
      version: 1,
      members: [
        {
          agentId: 'al-seed00001-00000000-00000000',
          publicKey: Buffer.from(pk1).toString('base64'),
          alias: 'Seed Agent 1',
        },
        {
          agentId: 'al-seed00002-00000000-00000000',
          publicKey: Buffer.from(pk2).toString('base64'),
        },
      ],
      exportedAt: new Date().toISOString(),
    };

    const count = tm.importTeamSeed(seed);
    expect(count).toBe(2);

    const r1 = tm.getTrust('al-seed00001-00000000-00000000');
    expect(r1).not.toBeNull();
    expect(r1!.alias).toBe('Seed Agent 1');
    expect(Buffer.from(r1!.publicKey).equals(Buffer.from(pk1))).toBe(true);

    const r2 = tm.getTrust('al-seed00002-00000000-00000000');
    expect(r2).not.toBeNull();
    expect(r2!.alias).toBeUndefined();
    expect(Buffer.from(r2!.publicKey).equals(Buffer.from(pk2))).toBe(true);
  });

  it('should export team seed with valid structure', () => {
    const tm = new TrustManager(trustFilePath());

    const pk1 = makePublicKey();
    const pk2 = makePublicKey();

    tm.addTrust('al-exp000001-00000000-00000000', pk1, 'Export 1');
    tm.addTrust('al-exp000002-00000000-00000000', pk2);

    const seed = tm.exportTeamSeed();

    expect(seed.version).toBe(1);
    expect(seed.members).toHaveLength(2);
    expect(seed.exportedAt).toBeTruthy();

    const ids = seed.members.map((m) => m.agentId).sort();
    expect(ids).toEqual([
      'al-exp000001-00000000-00000000',
      'al-exp000002-00000000-00000000',
    ]);

    // Verify public key round-trip
    const m1 = seed.members.find((m) => m.agentId === 'al-exp000001-00000000-00000000')!;
    expect(m1.publicKey).toBe(Buffer.from(pk1).toString('base64'));
    expect(m1.alias).toBe('Export 1');

    const m2 = seed.members.find((m) => m.agentId === 'al-exp000002-00000000-00000000')!;
    expect(m2.publicKey).toBe(Buffer.from(pk2).toString('base64'));
    expect(m2.alias).toBeUndefined();
  });

  it('should persist trust data to file and reload', () => {
    const filePath = trustFilePath();
    const pk = makePublicKey();

    // First instance: add and save
    const tm1 = new TrustManager(filePath);
    tm1.addTrust('al-persist01-00000000-00000000', pk, 'Persist Agent');

    // Verify file was created
    expect(fs.existsSync(filePath)).toBe(true);

    // Second instance: load from same file
    const tm2 = new TrustManager(filePath);
    const record = tm2.getTrust('al-persist01-00000000-00000000');

    expect(record).not.toBeNull();
    expect(record!.agentId).toBe('al-persist01-00000000-00000000');
    expect(record!.alias).toBe('Persist Agent');
    expect(record!.trustLevel).toBe('trusted');
    expect(record!.autoApprove).toBe(true);
    expect(Buffer.from(record!.publicKey).equals(Buffer.from(pk))).toBe(true);
  });

  it('should auto-create parent directory for trust file', () => {
    const nestedPath = path.join(tmpDir, 'deep', 'nested', 'dir', 'trust.json');
    const pk = makePublicKey();

    const tm = new TrustManager(nestedPath);
    tm.addTrust('al-nested000-00000000-00000000', pk);

    expect(fs.existsSync(nestedPath)).toBe(true);
  });

  it('should handle empty trust file on startup', () => {
    const filePath = trustFilePath();
    // No file exists yet
    const tm = new TrustManager(filePath);
    expect(tm.listTrusted()).toHaveLength(0);
    expect(tm.isTrusted('al-noone0000-00000000-00000000')).toBe(false);
  });

  it('should overwrite existing trust entry on re-add', () => {
    const tm = new TrustManager(trustFilePath());
    const pk1 = makePublicKey();
    const pk2 = makePublicKey();

    tm.addTrust('al-overwrite-00000000-00000000', pk1, 'Original');
    tm.addTrust('al-overwrite-00000000-00000000', pk2, 'Updated');

    const record = tm.getTrust('al-overwrite-00000000-00000000');
    expect(record).not.toBeNull();
    expect(record!.alias).toBe('Updated');
    expect(Buffer.from(record!.publicKey).equals(Buffer.from(pk2))).toBe(true);
  });
});
