/**
 * Acceptance tests: Distribution mechanism
 *
 * Verifies the dual-track distribution implementation across 7 areas:
 * 1. CLI process-level auto-init (non-TTY / MCP host mode)
 * 2. promptForInit readline behavior (unit-level with mock)
 * 3. CLI edge cases (corrupt identity, missing config, etc.)
 * 4. Init command default values and output
 * 5. package.json publish readiness + dist/ existence
 * 6. manifest.json DXT format validity
 * 7. README dual-track Quick Start content
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const CLI_PATH = path.join(PROJECT_ROOT, 'dist/cli/index.js');

// ── Helper: run CLI in a temp config dir ──────────────────────────────────────

function runCli(args: string[], envDir: string, options?: { input?: string; timeout?: number }): {
  stdout: string;
  stderr: string;
  exitCode: number | null;
} {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, AGENTLINK_DIR: envDir },
    timeout: options?.timeout ?? 15000,
    encoding: 'utf-8',
    input: options?.input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status,
  };
}

// ── 1. CLI process-level: auto-init in non-TTY mode ───────────────────────────

describe('Acceptance: CLI auto-init (non-TTY / MCP host mode)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-acceptance-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serve auto-creates identity with defaults when none exists', () => {
    const result = runCli(['serve'], tmpDir);

    expect(result.stderr).toContain('Auto-initializing with defaults');
    expect(result.stderr).toContain('WARNING: Secret key created');
    expect(result.stderr).toContain(path.join(tmpDir, 'identity.json'));

    expect(fs.existsSync(path.join(tmpDir, 'identity.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'config.json'))).toBe(true);

    const identity = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'identity.json'), 'utf-8'),
    );
    expect(identity.agentType).toBe('agent');
    expect(identity.name).toBe(os.hostname());
    expect(identity.agentId).toMatch(/^al-/);
    expect(identity.capabilities).toEqual([]);
  });

  it('auto-init creates config.json with correct defaults', () => {
    runCli(['serve'], tmpDir);

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'),
    );
    expect(config.identity.name).toBe(os.hostname());
    expect(config.identity.agentType).toBe('agent');
    expect(config.identity.capabilities).toEqual([]);
    expect(config.network.port).toBe(9876);
    expect(config.network.mdns).toBe(true);
    expect(config.security.autoApproveTrusted).toBe(true);
  });

  it('auto-init does not pollute stdout (MCP transport channel)', () => {
    const result = runCli(['serve'], tmpDir);

    expect(result.stdout).not.toContain('Auto-initializing');
    expect(result.stdout).not.toContain('WARNING');
    expect(result.stdout).not.toContain('Welcome to AgentLink');
    expect(result.stdout).not.toContain('AgentLink initialized');
  });

  it('serve skips auto-init when identity already exists', () => {
    const initResult = runCli(
      ['init', '--name', 'PreExistBot', '--type', 'coder'],
      tmpDir,
    );
    expect(initResult.exitCode).toBe(0);

    const serveResult = runCli(['serve'], tmpDir);

    expect(serveResult.stderr).not.toContain('Auto-initializing');

    const identity = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'identity.json'), 'utf-8'),
    );
    expect(identity.name).toBe('PreExistBot');
    expect(identity.agentType).toBe('coder');
  });

  it('auto-init creates identity loadable by serveAction', async () => {
    runCli(['serve'], tmpDir);

    const { loadIdentity } = await import('../../src/core/identity.js');
    const identity = loadIdentity(tmpDir);
    expect(identity).not.toBeNull();
    expect(identity!.agentId).toMatch(/^al-/);
    expect(identity!.publicKey).toBeInstanceOf(Uint8Array);
    expect(identity!.publicKey.length).toBeGreaterThan(0);
  });
});

// ── 2. promptForInit readline behavior (unit-level mock) ───────────────────────

describe('Acceptance: promptForInit readline interaction', () => {
  it('promptForInit returns user input for each question', async () => {
    // Mock readline to simulate user answers
    const mockAnswers = ['MyTestAgent', 'reviewer', 'code-review,testing'];
    let callIndex = 0;

    const mockRl = {
      question: vi.fn((_prompt: string, cb: (answer: string) => void) => {
        cb(mockAnswers[callIndex++] || '');
      }),
      close: vi.fn(),
    };

    vi.spyOn(readline, 'createInterface').mockReturnValue(mockRl as any);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { promptForInit } = await import('../../src/cli/prompts.js');
    const result = await promptForInit();

    expect(result.name).toBe('MyTestAgent');
    expect(result.type).toBe('reviewer');
    expect(result.capabilities).toBe('code-review,testing');

    // Verify all 3 questions were asked
    expect(mockRl.question).toHaveBeenCalledTimes(3);
    expect(mockRl.close).toHaveBeenCalledOnce();

    vi.restoreAllMocks();
  });

  it('promptForInit falls back to defaults on empty input', async () => {
    const mockAnswers = ['', '', ''];
    let callIndex = 0;

    const mockRl = {
      question: vi.fn((_prompt: string, cb: (answer: string) => void) => {
        cb(mockAnswers[callIndex++] || '');
      }),
      close: vi.fn(),
    };

    vi.spyOn(readline, 'createInterface').mockReturnValue(mockRl as any);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { promptForInit } = await import('../../src/cli/prompts.js');
    const result = await promptForInit();

    expect(result.name).toBe(os.hostname());
    expect(result.type).toBe('agent');
    expect(result.capabilities).toBe('');

    vi.restoreAllMocks();
  });
});

// ── 3. CLI edge cases ─────────────────────────────────────────────────────────

describe('Acceptance: CLI edge cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-edge-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serve handles corrupt identity.json gracefully', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'identity.json'), 'not valid json {{{');

    const result = runCli(['serve'], tmpDir);

    // Should not auto-init (identity file exists) but should fail loading it
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('serve handles config.json without identity.json', () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
      identity: { name: 'Orphan', agentType: 'test', capabilities: [] },
      network: { port: 9876, mdns: true, bindAllInterfaces: true, excludeInterfaces: [], peers: [] },
      security: { requireApproval: 'untrusted', autoApproveTrusted: true, maxConcurrentTasks: 3 },
      logging: { level: 'info', auditLog: true },
    }));

    // No identity → should auto-init
    const result = runCli(['serve'], tmpDir);

    expect(result.stderr).toContain('Auto-initializing');
    expect(fs.existsSync(path.join(tmpDir, 'identity.json'))).toBe(true);
  });

  it('status command fails gracefully without identity', () => {
    const result = runCli(['status'], tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No identity');
  });

  it('trust list returns empty without trust file', () => {
    // init first
    runCli(['init'], tmpDir);
    const result = runCli(['trust', 'list'], tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No trusted agents');
  });

  it('identity file has secretKey field (not empty)', () => {
    runCli(['init'], tmpDir);

    const identity = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'identity.json'), 'utf-8'),
    );
    expect(identity.secretKey).toBeDefined();
    expect(typeof identity.secretKey).toBe('string');
    expect(identity.secretKey.length).toBeGreaterThan(0);
  });
});

// ── 4. Init command default values and output ─────────────────────────────────

describe('Acceptance: init command defaults', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-init-defaults-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('init with no flags uses hostname as name and agent as type', () => {
    const result = runCli(['init'], tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('AgentLink initialized');
    expect(result.stdout).toContain('Agent ID:');
    expect(result.stdout).toMatch(/al-[0-9A-Z]+-[0-9A-Z]+-[0-9A-Z]+/);

    const identity = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'identity.json'), 'utf-8'),
    );
    expect(identity.name).toBe(os.hostname());
    expect(identity.agentType).toBe('agent');
    expect(identity.capabilities).toEqual([]);
  });

  it('init with explicit flags overrides defaults', () => {
    const result = runCli(
      ['init', '--name', 'CustomBot', '--type', 'reviewer', '--capabilities', 'rust,go'],
      tmpDir,
    );
    expect(result.exitCode).toBe(0);

    const identity = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'identity.json'), 'utf-8'),
    );
    expect(identity.name).toBe('CustomBot');
    expect(identity.agentType).toBe('reviewer');
    expect(identity.capabilities).toEqual(['rust', 'go']);
  });

  it('init prints MCP host config in output', () => {
    const result = runCli(['init'], tmpDir);
    expect(result.stdout).toContain('"mcpServers"');
    expect(result.stdout).toContain('@agentlink/server');
    expect(result.stdout).toContain('serve');
  });

  it('init fails with error if identity already exists', () => {
    runCli(['init'], tmpDir);
    const result = runCli(['init'], tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('already exists');
  });

  it('init creates config.json matching identity values', () => {
    runCli(['init', '--name', 'ConfigBot', '--type', 'coder'], tmpDir);

    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'),
    );
    expect(config.identity.name).toBe('ConfigBot');
    expect(config.identity.agentType).toBe('coder');
    expect(config.network.port).toBe(9876);
    expect(config.logging.auditLog).toBe(true);
  });
});

// ── 5. package.json publish readiness + dist/ existence ────────────────────────

describe('Acceptance: package.json publish readiness', () => {
  let pkg: any;

  beforeEach(() => {
    pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'),
    );
  });

  it('has required npm publish fields', () => {
    expect(pkg.name).toBe('@agentlink/server');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pkg.description).toBeDefined();
    expect(pkg.license).toBe('MIT');
    expect(pkg.files).toEqual(['dist']);
  });

  it('has repository field for npm discoverability', () => {
    expect(pkg.repository.type).toBe('git');
    expect(pkg.repository.url).toContain('github.com');
  });

  it('has keywords for npm search', () => {
    expect(pkg.keywords).toContain('mcp');
    expect(pkg.keywords).toContain('agent');
    expect(pkg.keywords).toContain('p2p');
  });

  it('has bin field for CLI entry point', () => {
    expect(pkg.bin.agentlink).toBe('./dist/cli/index.js');
  });

  it('has prepublishOnly for build-before-publish', () => {
    expect(pkg.scripts.prepublishOnly).toBe('npm run build');
  });

  it('has pack:mcpb script for .mcpb packaging', () => {
    expect(pkg.scripts['pack:mcpb']).toContain('dxt pack');
  });

  it('declares zod as direct dependency', () => {
    expect(pkg.dependencies.zod).toBeDefined();
  });

  it('declares dxt as devDependency for packaging', () => {
    expect(pkg.devDependencies['@anthropic-ai/dxt']).toBeDefined();
  });

  it('does NOT use prepare (which would break consumers)', () => {
    expect(pkg.scripts.prepare).toBeUndefined();
  });

  it('type is ESM module', () => {
    expect(pkg.type).toBe('module');
  });

  it('dist/ directory exists and contains CLI entry point', () => {
    const distCliPath = path.join(PROJECT_ROOT, 'dist/cli/index.js');
    expect(fs.existsSync(distCliPath)).toBe(true);

    const content = fs.readFileSync(distCliPath, 'utf-8');
    expect(content).toContain('agentlink');
  });
});

// ── 6. manifest.json DXT format validity ──────────────────────────────────────

describe('Acceptance: manifest.json DXT format', () => {
  let manifest: any;
  let pkg: any;

  beforeEach(() => {
    manifest = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'manifest.json'), 'utf-8'),
    );
    pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'),
    );
  });

  it('has correct manifest_version', () => {
    expect(manifest.manifest_version).toBe('0.2');
  });

  it('has required metadata fields', () => {
    expect(manifest.name).toBe('AgentLink');
    expect(manifest.version).toBeDefined();
    expect(manifest.description).toBeDefined();
    expect(manifest.author).toBeDefined();
  });

  it('version matches package.json', () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it('entry_point file exists in dist/', () => {
    const entryPath = path.join(PROJECT_ROOT, manifest.server.entry_point);
    expect(fs.existsSync(entryPath)).toBe(true);
  });

  it('has server config pointing to correct entry point', () => {
    expect(manifest.server.type).toBe('node');
    expect(manifest.server.entry_point).toBe('dist/cli/index.js');
  });

  it('has mcp_config with serve argument and __dirname interpolation', () => {
    expect(manifest.server.mcp_config.command).toBe('node');
    expect(manifest.server.mcp_config.args[0]).toContain('${__dirname}');
    expect(manifest.server.mcp_config.args).toContain('serve');
  });

  it('declares tools_generated true', () => {
    expect(manifest.tools_generated).toBe(true);
  });

  it('has empty user_config', () => {
    expect(manifest.user_config).toEqual({});
  });

  it('declares node >=18 compatibility', () => {
    expect(manifest.compatibility.node).toContain('18');
  });

  it('declares platform support', () => {
    expect(manifest.compatibility.platforms).toContain('win32');
    expect(manifest.compatibility.platforms).toContain('darwin');
    expect(manifest.compatibility.platforms).toContain('linux');
  });
});

// ── 7. README dual-track content ──────────────────────────────────────────────

describe('Acceptance: README dual-track Quick Start', () => {
  it('English README has all Quick Start sections in correct order', () => {
    const readme = fs.readFileSync(
      path.join(PROJECT_ROOT, 'README.md'), 'utf-8',
    );

    const oneClickIdx = readme.indexOf('One-click install');
    const cliIdx = readme.indexOf('npx @agentlink/server serve');
    const mcpHostIdx = readme.indexOf('"mcpServers"');
    const manualIdx = readme.indexOf('Manual init');

    expect(oneClickIdx).toBeGreaterThan(-1);
    expect(cliIdx).toBeGreaterThan(-1);
    expect(mcpHostIdx).toBeGreaterThan(-1);
    expect(manualIdx).toBeGreaterThan(-1);

    expect(oneClickIdx).toBeLessThan(cliIdx);
    expect(cliIdx).toBeLessThan(mcpHostIdx);
    expect(mcpHostIdx).toBeLessThan(manualIdx);
  });

  it('Chinese README has all Quick Start sections in correct order', () => {
    const readme = fs.readFileSync(
      path.join(PROJECT_ROOT, 'README_CN.md'), 'utf-8',
    );

    const oneClickIdx = readme.indexOf('一键安装');
    const cliIdx = readme.indexOf('npx @agentlink/server serve');
    const mcpHostIdx = readme.indexOf('"mcpServers"');
    const manualIdx = readme.indexOf('手动初始化');

    expect(oneClickIdx).toBeGreaterThan(-1);
    expect(cliIdx).toBeGreaterThan(-1);
    expect(mcpHostIdx).toBeGreaterThan(-1);
    expect(manualIdx).toBeGreaterThan(-1);

    expect(oneClickIdx).toBeLessThan(cliIdx);
    expect(cliIdx).toBeLessThan(mcpHostIdx);
    expect(mcpHostIdx).toBeLessThan(manualIdx);
  });

  it('English README contains .mcpb download link', () => {
    const readme = fs.readFileSync(
      path.join(PROJECT_ROOT, 'README.md'), 'utf-8',
    );
    expect(readme).toMatch(/agentlink\.mcpb/);
    expect(readme).toMatch(/releases/);
  });

  it('Chinese README contains .mcpb download link', () => {
    const readme = fs.readFileSync(
      path.join(PROJECT_ROOT, 'README_CN.md'), 'utf-8',
    );
    expect(readme).toMatch(/agentlink\.mcpb/);
    expect(readme).toMatch(/releases/);
  });
});
