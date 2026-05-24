/**
 * Integration: CLI init → serve full lifecycle
 *
 * Verifies the complete CLI workflow: init creates identity/config,
 * serve wires all modules together, and the server can accept connections.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  initAction,
  serveAction,
  trustListAction,
  trustRemoveAction,
  statusAction,
  identityExists,
} from '../../src/cli/actions.js';
import { loadIdentity } from '../../src/core/identity.js';
import { TrustManager } from '../../src/core/trust-manager.js';
import { AgentLinkServer } from '../../src/mcp/server.js';
import type { AgentLinkConfig } from '../../src/core/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-cli-lifecycle-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CLI init → serve lifecycle', () => {
  it('init creates identity and config files on disk', async () => {
    const result = await initAction(
      { name: 'LifecycleBot', type: 'assistant', capabilities: 'code,review,test' },
      tmpDir,
    );

    expect(result.agentId).toMatch(/^al-/);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{16}$/);

    // Verify files on disk
    expect(fs.existsSync(path.join(tmpDir, 'identity.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'config.json'))).toBe(true);

    // Verify identity content
    const identityData = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'identity.json'), 'utf-8'),
    );
    expect(identityData.agentId).toBe(result.agentId);
    expect(identityData.name).toBe('LifecycleBot');
    expect(identityData.agentType).toBe('assistant');
    expect(identityData.capabilities).toEqual(['code', 'review', 'test']);

    // Verify config content
    const configData = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'),
    ) as AgentLinkConfig;
    expect(configData.identity.name).toBe('LifecycleBot');
    expect(configData.network.port).toBe(9876);
  });

  it('init throws when identity already exists', async () => {
    await initAction(
      { name: 'First', type: 'test', capabilities: '' },
      tmpDir,
    );

    await expect(
      initAction({ name: 'Second', type: 'test', capabilities: '' }, tmpDir),
    ).rejects.toThrow('already exists');

    // Original should be preserved
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'identity.json'), 'utf-8'));
    expect(data.name).toBe('First');
  });

  it('serveAction creates a wired server from config dir', async () => {
    await initAction(
      { name: 'ServeBot', type: 'worker', capabilities: 'code' },
      tmpDir,
    );

    const { agentId, server } = await serveAction(tmpDir);
    expect(agentId).toMatch(/^al-/);

    // Server should have an MCP server instance
    expect(server.server).toBeDefined();

    // Clean up
    await server.stop();
  });

  it('serveAction throws when no identity', async () => {
    await expect(serveAction(tmpDir)).rejects.toThrow('No identity');
  });

  it('full workflow: init → trust → status → list → remove', async () => {
    const { agentId } = await initAction(
      { name: 'WorkflowBot', type: 'test', capabilities: 'monitor' },
      tmpDir,
    );

    // Status before trust
    const statusBefore = statusAction(tmpDir);
    expect(statusBefore.agentId).toBe(agentId);
    expect(statusBefore.name).toBe('WorkflowBot');
    expect(statusBefore.trustedAgents).toBe(0);

    // Add trust
    const trustPath = path.join(tmpDir, 'trust.json');
    const tm = new TrustManager(trustPath);
    tm.addTrust('al-peer0000-00000000-00000000', new Uint8Array(32), 'Peer');
    tm.addTrust('al-peer0001-00000000-00000000', new Uint8Array(32), 'Peer2');

    // Status after trust
    const statusAfter = statusAction(tmpDir);
    expect(statusAfter.trustedAgents).toBe(2);

    // List trust
    const list = trustListAction(tmpDir);
    expect(list).toHaveLength(2);
    expect(list[0].alias).toBe('Peer');

    // Remove one
    const removed = trustRemoveAction(tmpDir, 'al-peer0000-00000000-00000000');
    expect(removed).toBe(true);

    // Verify removal
    const listAfter = trustListAction(tmpDir);
    expect(listAfter).toHaveLength(1);
    expect(listAfter[0].agentId).toBe('al-peer0001-00000000-00000000');

    // Status reflects removal
    const statusFinal = statusAction(tmpDir);
    expect(statusFinal.trustedAgents).toBe(1);
  });

  it('statusAction shows zero active tasks for fresh init', async () => {
    await initAction(
      { name: 'EmptyBot', type: 'test', capabilities: '' },
      tmpDir,
    );

    const status = statusAction(tmpDir);
    expect(status.activeTasks).toBe(0);
  });

  it('trustListAction returns empty when no trust file', () => {
    const list = trustListAction(tmpDir);
    expect(list).toEqual([]);
  });

  it('trustRemoveAction returns false for nonexistent agent', () => {
    const removed = trustRemoveAction(tmpDir, 'al-noone00-00000000-00000000');
    expect(removed).toBe(false);
  });

  it('statusAction throws when no identity exists', () => {
    expect(() => statusAction(tmpDir)).toThrow('No identity found');
  });

  it('init with complex capabilities', async () => {
    const result = await initAction(
      {
        name: 'ComplexBot',
        type: 'fullstack',
        capabilities: 'code-review,unit-test,integration-test,deploy,monitor,alert',
      },
      tmpDir,
    );

    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'identity.json'), 'utf-8'));
    expect(data.capabilities).toEqual([
      'code-review', 'unit-test', 'integration-test', 'deploy', 'monitor', 'alert',
    ]);
  });

  it('init with empty capabilities', async () => {
    await initAction(
      { name: 'NoCapBot', type: 'basic', capabilities: '' },
      tmpDir,
    );

    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'identity.json'), 'utf-8'));
    expect(data.capabilities).toEqual([]);
  });

  it('identityExists returns false when no identity', () => {
    expect(identityExists(tmpDir)).toBe(false);
  });

  it('identityExists returns true after init', async () => {
    await initAction(
      { name: 'ExistBot', type: 'test', capabilities: '' },
      tmpDir,
    );
    expect(identityExists(tmpDir)).toBe(true);
  });
});
