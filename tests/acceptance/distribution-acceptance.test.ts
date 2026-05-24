/**
 * Acceptance tests: Distribution mechanism
 *
 * Verifies the dual-track distribution implementation:
 * 1. CLI process-level auto-init (non-TTY / MCP host mode)
 * 2. CLI process-level auto-init skip (identity already exists)
 * 3. Init command default values
 * 4. package.json publish readiness
 * 5. manifest.json DXT format validity
 * 6. README dual-track Quick Start content
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const CLI_PATH = path.join(PROJECT_ROOT, 'dist/cli/index.js');

// ── Helper: run CLI in a temp config dir ──────────────────────────────────────

function runCli(args: string[], envDir: string, options?: { input?: string }): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, AGENTLINK_DIR: envDir },
      timeout: 15000,
      encoding: 'utf-8',
      input: options?.input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: err.status ?? 1,
    };
  }
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

  it('serve auto-creates identity with defaults when none exists', async () => {
    // serve will auto-init then try to start the server.
    // In non-TTY mode it auto-inits silently, then server.start() will
    // fail because stdio isn't connected to an MCP host — that's fine,
    // we just care that identity was created.
    const result = runCli(['serve'], tmpDir);

    // Should have auto-initialized (stderr warnings)
    expect(result.stderr).toContain('Auto-initializing with defaults');
    expect(result.stderr).toContain('WARNING: Secret key created');

    // Verify identity file was created on disk
    expect(fs.existsSync(path.join(tmpDir, 'identity.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'config.json'))).toBe(true);

    // Verify identity content uses defaults
    const identity = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'identity.json'), 'utf-8'),
    );
    expect(identity.agentType).toBe('agent');
    expect(identity.name).toBe(os.hostname());
    expect(identity.agentId).toMatch(/^al-/);
  });

  it('serve skips auto-init when identity already exists', async () => {
    // First: create identity via init
    const initResult = runCli(
      ['init', '--name', 'PreExistBot', '--type', 'coder'],
      tmpDir,
    );
    expect(initResult.exitCode).toBe(0);

    // Second: serve should NOT auto-init — no warnings on stderr
    const serveResult = runCli(['serve'], tmpDir);

    expect(serveResult.stderr).not.toContain('Auto-initializing');

    // Identity should still be the original
    const identity = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'identity.json'), 'utf-8'),
    );
    expect(identity.name).toBe('PreExistBot');
    expect(identity.agentType).toBe('coder');
  });

  it('auto-init creates valid identity that serveAction can use', async () => {
    // Trigger auto-init via serve
    runCli(['serve'], tmpDir);

    // Now load the identity and verify serveAction works
    const { loadIdentity } = await import('../../src/core/identity.js');
    const identity = loadIdentity(tmpDir);
    expect(identity).not.toBeNull();
    expect(identity!.agentId).toMatch(/^al-/);
    expect(identity!.name).toBe(os.hostname());
  });
});

// ── 2. Init command default values ───────────────────────────────────────────

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
});

// ── 3. package.json publish readiness ─────────────────────────────────────────

describe('Acceptance: package.json publish readiness', () => {
  let pkg: any;

  beforeEach(() => {
    pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'),
    );
  });

  it('has required npm publish fields', () => {
    expect(pkg.name).toBe('@agentlink/server');
    expect(pkg.version).toBeDefined();
    expect(pkg.description).toBeDefined();
    expect(pkg.license).toBe('MIT');
    expect(pkg.files).toEqual(['dist']);
  });

  it('has repository field for npm discoverability', () => {
    expect(pkg.repository).toBeDefined();
    expect(pkg.repository.type).toBe('git');
    expect(pkg.repository.url).toContain('github.com');
  });

  it('has keywords for npm search', () => {
    expect(pkg.keywords).toBeDefined();
    expect(pkg.keywords).toContain('mcp');
    expect(pkg.keywords).toContain('agent');
    expect(pkg.keywords).toContain('p2p');
  });

  it('has bin field for CLI', () => {
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin.agentlink).toBe('./dist/cli/index.js');
  });

  it('has prepublishOnly for build-before-publish', () => {
    expect(pkg.scripts.prepublishOnly).toBe('npm run build');
  });

  it('has pack:mcpb script for .mcpb packaging', () => {
    expect(pkg.scripts['pack:mcpb']).toBeDefined();
    expect(pkg.scripts['pack:mcpb']).toContain('dxt pack');
  });

  it('declares zod as direct dependency', () => {
    expect(pkg.dependencies.zod).toBeDefined();
  });

  it('does NOT use prepare (which would break consumers)', () => {
    expect(pkg.scripts.prepare).toBeUndefined();
  });
});

// ── 4. manifest.json DXT format validity ──────────────────────────────────────

describe('Acceptance: manifest.json DXT format', () => {
  let manifest: any;

  beforeEach(() => {
    manifest = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'manifest.json'), 'utf-8'),
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

  it('has server config pointing to correct entry point', () => {
    expect(manifest.server).toBeDefined();
    expect(manifest.server.type).toBe('node');
    expect(manifest.server.entry_point).toBe('dist/cli/index.js');
  });

  it('has mcp_config with serve argument', () => {
    expect(manifest.server.mcp_config).toBeDefined();
    expect(manifest.server.mcp_config.command).toBe('node');
    expect(manifest.server.mcp_config.args).toContain('serve');
  });

  it('declares tools_generated true (tools are dynamic)', () => {
    expect(manifest.tools_generated).toBe(true);
  });

  it('has empty user_config (init is handled at runtime)', () => {
    expect(manifest.user_config).toEqual({});
  });

  it('declares node >=18 compatibility', () => {
    expect(manifest.compatibility).toBeDefined();
    expect(manifest.compatibility.node).toContain('18');
  });
});

// ── 5. README dual-track content ──────────────────────────────────────────────

describe('Acceptance: README dual-track Quick Start', () => {
  it('English README has all 4 Quick Start sections', () => {
    const readme = fs.readFileSync(
      path.join(PROJECT_ROOT, 'README.md'), 'utf-8',
    );

    // Option 1: .mcpb one-click
    expect(readme).toContain('One-click install');
    expect(readme).toContain('agentlink.mcpb');

    // Option 2: command line
    expect(readme).toContain('npx @agentlink/server serve');

    // MCP host config
    expect(readme).toContain('"mcpServers"');
    expect(readme).toContain('@agentlink/server');

    // Manual init (optional)
    expect(readme).toContain('Manual init');
  });

  it('Chinese README has all 4 Quick Start sections', () => {
    const readme = fs.readFileSync(
      path.join(PROJECT_ROOT, 'README_CN.md'), 'utf-8',
    );

    // 方式一：一键安装
    expect(readme).toContain('一键安装');
    expect(readme).toContain('agentlink.mcpb');

    // 方式二：命令行
    expect(readme).toContain('npx @agentlink/server serve');

    // MCP 宿主配置
    expect(readme).toContain('"mcpServers"');

    // 手动初始化
    expect(readme).toContain('手动初始化');
  });
});
