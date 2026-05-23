import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateIdentity, saveIdentity } from '../../src/core/identity.js';
import { TrustManager } from '../../src/core/trust-manager.js';
import { DEFAULT_CONFIG } from '../../src/core/types.js';
import type { AgentLinkConfig } from '../../src/core/types.js';
import {
  initAction,
  trustListAction,
  trustRemoveAction,
  statusAction,
} from '../../src/cli/actions.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-cli-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CLI actions', () => {
  describe('initAction', () => {
    it('should create identity and config files', async () => {
      const result = await initAction(
        { name: 'TestBot', type: 'assistant', capabilities: 'code,search' },
        tmpDir,
      );

      // Should return agent ID with al- prefix
      expect(result.agentId).toMatch(/^al-/);
      // Should return a 16-char hex fingerprint
      expect(result.fingerprint).toMatch(/^[0-9a-f]{16}$/);

      // Verify identity file was created
      const identityPath = path.join(tmpDir, 'identity.json');
      expect(fs.existsSync(identityPath)).toBe(true);

      const identityData = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
      expect(identityData.name).toBe('TestBot');
      expect(identityData.agentType).toBe('assistant');
      expect(identityData.capabilities).toEqual(['code', 'search']);
      expect(identityData.agentId).toBe(result.agentId);

      // Verify config file was created
      const configPath = path.join(tmpDir, 'config.json');
      expect(fs.existsSync(configPath)).toBe(true);

      const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as AgentLinkConfig;
      expect(configData.identity.name).toBe('TestBot');
      expect(configData.identity.agentType).toBe('assistant');
      expect(configData.identity.capabilities).toEqual(['code', 'search']);
      expect(configData.network.port).toBe(DEFAULT_CONFIG.network.port);
    });

    it('should use default values when capabilities are empty', async () => {
      const result = await initAction(
        { name: 'My Agent', type: 'unknown', capabilities: '' },
        tmpDir,
      );

      expect(result.agentId).toMatch(/^al-/);

      const identityData = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'identity.json'), 'utf-8'),
      );
      expect(identityData.name).toBe('My Agent');
      expect(identityData.agentType).toBe('unknown');
      expect(identityData.capabilities).toEqual([]);
    });

    it('should trim whitespace from capabilities', async () => {
      await initAction(
        { name: 'Test', type: 'test', capabilities: ' code , search , deploy ' },
        tmpDir,
      );

      const identityData = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'identity.json'), 'utf-8'),
      );
      expect(identityData.capabilities).toEqual(['code', 'search', 'deploy']);
    });

    it('should throw when identity already exists', async () => {
      await initAction(
        { name: 'First', type: 'test', capabilities: '' },
        tmpDir,
      );

      await expect(
        initAction({ name: 'Second', type: 'test', capabilities: '' }, tmpDir),
      ).rejects.toThrow('already exists');

      // Verify the original identity was preserved
      const identityData = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'identity.json'), 'utf-8'),
      );
      expect(identityData.name).toBe('First');
    });
  });

  describe('trustListAction', () => {
    it('should return empty array when no trust file exists', () => {
      const entries = trustListAction(tmpDir);
      expect(entries).toEqual([]);
    });

    it('should return empty array when trust file exists but is empty', () => {
      const trustPath = path.join(tmpDir, 'trust.json');
      fs.writeFileSync(trustPath, JSON.stringify({ records: [] }));

      const entries = trustListAction(tmpDir);
      expect(entries).toEqual([]);
    });

    it('should list trusted agents with formatted data', () => {
      const trustPath = path.join(tmpDir, 'trust.json');
      const tm = new TrustManager(trustPath);

      const pk1 = new Uint8Array(32).fill(1);
      const pk2 = new Uint8Array(32).fill(2);

      tm.addTrust('al-aaaa1111-bbbb2222-cccc3333', pk1, 'Agent Alpha');
      tm.addTrust('al-dddd4444-eeee5555-ffff6666', pk2, 'Agent Beta');

      const entries = trustListAction(tmpDir);

      expect(entries).toHaveLength(2);

      expect(entries[0].agentId).toBe('al-aaaa1111-bbbb2222-cccc3333');
      expect(entries[0].alias).toBe('Agent Alpha');
      expect(entries[0].trustedSince).toBeTruthy();

      expect(entries[1].agentId).toBe('al-dddd4444-eeee5555-ffff6666');
      expect(entries[1].alias).toBe('Agent Beta');
      expect(entries[1].trustedSince).toBeTruthy();
    });

    it('should use dash for agents without alias', () => {
      const trustPath = path.join(tmpDir, 'trust.json');
      const tm = new TrustManager(trustPath);
      tm.addTrust('al-noalias0-00000000-00000000', new Uint8Array(32).fill(9));

      const entries = trustListAction(tmpDir);
      expect(entries).toHaveLength(1);
      expect(entries[0].alias).toBe('-');
    });
  });

  describe('trustRemoveAction', () => {
    it('should remove a trusted agent', () => {
      const trustPath = path.join(tmpDir, 'trust.json');
      const tm = new TrustManager(trustPath);
      tm.addTrust('al-remove0000-00000000-00000000', new Uint8Array(32).fill(42), 'ToRemove');

      const removed = trustRemoveAction(tmpDir, 'al-remove0000-00000000-00000000');

      expect(removed).toBe(true);

      // Verify it was actually removed
      const tm2 = new TrustManager(trustPath);
      expect(tm2.getTrust('al-remove0000-00000000-00000000')).toBeNull();
    });

    it('should return false when agent not found', () => {
      const removed = trustRemoveAction(tmpDir, 'al-nonexist00-00000000-00000000');
      expect(removed).toBe(false);
    });
  });

  describe('statusAction', () => {
    it('should throw when no identity exists', () => {
      expect(() => statusAction(tmpDir)).toThrow('No identity found');
    });

    it('should display identity information', async () => {
      const identity = await generateIdentity({
        name: 'StatusBot',
        agentType: 'monitor',
        capabilities: ['watch', 'report'],
      });
      saveIdentity(identity, tmpDir);

      const info = statusAction(tmpDir);

      expect(info.agentId).toBe(identity.agentId);
      expect(info.name).toBe('StatusBot');
      expect(info.agentType).toBe('monitor');
      expect(info.capabilities).toEqual(['watch', 'report']);
      expect(info.trustedAgents).toBe(0);
      expect(info.activeTasks).toBe(0);
    });

    it('should count trusted agents', async () => {
      const identity = await generateIdentity({
        name: 'CountBot',
        agentType: 'test',
        capabilities: [],
      });
      saveIdentity(identity, tmpDir);

      const trustPath = path.join(tmpDir, 'trust.json');
      const tm = new TrustManager(trustPath);
      tm.addTrust('al-trust0001-00000000-00000000', new Uint8Array(32).fill(1), 'One');
      tm.addTrust('al-trust0002-00000000-00000000', new Uint8Array(32).fill(2), 'Two');
      tm.addTrust('al-trust0003-00000000-00000000', new Uint8Array(32).fill(3), 'Three');

      const info = statusAction(tmpDir);
      expect(info.trustedAgents).toBe(3);
    });

    it('should show zero capabilities as empty array', async () => {
      const identity = await generateIdentity({
        name: 'NoCapBot',
        agentType: 'test',
        capabilities: [],
      });
      saveIdentity(identity, tmpDir);

      const info = statusAction(tmpDir);
      expect(info.capabilities).toEqual([]);
    });
  });
});
