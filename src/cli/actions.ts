import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateIdentity,
  saveIdentity,
  loadIdentity,
  getFingerprint,
} from '../core/identity.js';
import { TrustManager } from '../core/trust-manager.js';
import { AgentLinkServer } from '../mcp/server.js';
import type { AgentLinkConfig } from '../core/types.js';
import { DEFAULT_CONFIG } from '../core/types.js';

// Allow config dir override via env var for testing
export function getConfigDir(): string {
  const envDir = process.env.AGENTLINK_DIR;
  if (envDir) return envDir;
  return path.join(os.homedir(), '.agentlink');
}

export function identityExists(configDir: string): boolean {
  const identityPath = path.join(configDir, 'identity.json');
  return fs.existsSync(identityPath);
}

export function loadConfig(configDir: string): AgentLinkConfig | null {
  const configPath = path.join(configDir, 'config.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as AgentLinkConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: AgentLinkConfig, configDir: string): void {
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// ── init ──────────────────────────────────────────────────────────────────────

export interface InitOptions {
  name: string;
  type: string;
  capabilities: string;
}

export async function initAction(
  opts: InitOptions,
  configDir: string,
): Promise<{ agentId: string; fingerprint: string }> {
  const identityPath = path.join(configDir, 'identity.json');

  if (fs.existsSync(identityPath)) {
    throw new Error('Identity already exists at ' + identityPath);
  }

  const capabilities = opts.capabilities
    ? opts.capabilities.split(',').map((c: string) => c.trim()).filter(Boolean)
    : [];

  const identity = await generateIdentity({
    name: opts.name,
    agentType: opts.type,
    capabilities,
  });

  saveIdentity(identity, configDir);

  const config: AgentLinkConfig = {
    ...DEFAULT_CONFIG,
    identity: {
      name: opts.name,
      agentType: opts.type,
      capabilities,
    },
  };
  saveConfig(config, configDir);

  const fingerprint = getFingerprint(identity.publicKey);

  return { agentId: identity.agentId, fingerprint };
}

// ── serve ─────────────────────────────────────────────────────────────────────

export async function serveAction(
  configDir: string,
): Promise<{ agentId: string; server: AgentLinkServer }> {
  const identity = loadIdentity(configDir);
  if (!identity) {
    throw new Error('No identity found. Run `agentlink init` first.');
  }

  const config = loadConfig(configDir);
  if (!config) {
    throw new Error('No config found. Run `agentlink init` first.');
  }

  const server = AgentLinkServer.createFromConfig(configDir);
  return { agentId: identity.agentId, server };
}

// ── trust list ────────────────────────────────────────────────────────────────

export interface TrustListEntry {
  agentId: string;
  alias: string;
  trustedSince: string;
}

export function trustListAction(configDir: string): TrustListEntry[] {
  const trustPath = path.join(configDir, 'trust.json');

  if (!fs.existsSync(trustPath)) {
    return [];
  }

  const tm = new TrustManager(trustPath);
  const trusted = tm.listTrusted();

  return trusted.map((record) => ({
    agentId: record.agentId,
    alias: record.alias || '-',
    trustedSince: new Date(record.trustedAt).toISOString(),
  }));
}

// ── trust remove ──────────────────────────────────────────────────────────────

export function trustRemoveAction(configDir: string, agentId: string): boolean {
  const trustPath = path.join(configDir, 'trust.json');
  const tm = new TrustManager(trustPath);
  return tm.removeTrust(agentId);
}

// ── status ────────────────────────────────────────────────────────────────────

export interface StatusInfo {
  agentId: string;
  name: string;
  agentType: string;
  capabilities: string[];
  trustedAgents: number;
  activeTasks: number;
}

export function statusAction(configDir: string): StatusInfo {
  const identity = loadIdentity(configDir);
  if (!identity) {
    throw new Error('No identity found. Run `agentlink init` first.');
  }

  // Count trusted agents
  const trustPath = path.join(configDir, 'trust.json');
  let trustedAgents = 0;
  if (fs.existsSync(trustPath)) {
    const tm = new TrustManager(trustPath);
    trustedAgents = tm.listTrusted().length;
  }

  // Count active tasks from database
  const dbPath = path.join(configDir, 'agentlink.db');
  let activeTasks = 0;
  if (fs.existsSync(dbPath)) {
    try {
      const { createRequire } = require('node:module');
      const req = createRequire(import.meta.url);
      const Database = req('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare(
        "SELECT COUNT(*) as count FROM tasks WHERE status IN ('created', 'in_progress')"
      ).get() as { count: number };
      activeTasks = row.count;
      db.close();
    } catch {
      // Database might not exist or be empty
    }
  }

  return {
    agentId: identity.agentId,
    name: identity.name,
    agentType: identity.agentType,
    capabilities: identity.capabilities,
    trustedAgents,
    activeTasks,
  };
}
