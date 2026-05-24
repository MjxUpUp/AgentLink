import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { identityExists, initAction, serveAction } from '../../src/cli/actions.js';
import { getAutoInitOptions } from '../../src/cli/prompts.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-auto-init-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('auto-init logic', () => {
  it('identityExists is false before init, true after', async () => {
    expect(identityExists(tmpDir)).toBe(false);

    const defaults = getAutoInitOptions();
    await initAction(
      { name: defaults.name, type: defaults.type, capabilities: defaults.capabilities },
      tmpDir,
    );

    expect(identityExists(tmpDir)).toBe(true);

    // Verify identity uses default values
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'identity.json'), 'utf-8'));
    expect(data.name).toBe(defaults.name);
    expect(data.agentType).toBe('agent');
    expect(data.capabilities).toEqual([]);
  });

  it('serveAction works after auto-init with defaults', async () => {
    const defaults = getAutoInitOptions();
    await initAction(
      { name: defaults.name, type: defaults.type, capabilities: '' },
      tmpDir,
    );

    const { agentId, server } = await serveAction(tmpDir);
    expect(agentId).toMatch(/^al-/);
    await server.stop();
  });
});
