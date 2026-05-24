// Agent identity
export interface AgentIdentity {
  agentId: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  name: string;
  agentType: string;
  capabilities: string[];
}

// Agent info (what we know about a remote agent)
export interface AgentInfo {
  agentId: string;
  publicKey: Uint8Array;
  name?: string;
  agentType?: string;
  capabilities?: string[];
  hostname?: string;
  ip?: string;
  port?: number;
  status: AgentStatus;
  lastSeen: number;
  source: 'mdns' | 'static' | 'address-book';
  trustLevel: TrustLevel;
}

export type AgentStatus = 'online' | 'offline' | 'unknown';
export type TrustLevel = 'trusted' | 'untrusted';

// JSON-RPC 2.0 message
export interface AgentLinkMessage {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: Record<string, unknown>;
  signature: string;
  timestamp: string;
}

// Task model
export interface Task {
  id: string;
  type: string;
  title: string;
  description: string;
  requester: string;
  executor: string;
  status: TaskStatus;
  priority: TaskPriority;
  artifacts: Artifact[];
  createdAt: number;
  updatedAt: number;
  timeoutAt?: number;
}

export type TaskStatus = 'created' | 'accepted' | 'rejected' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface Artifact {
  type: 'text' | 'code' | 'file_reference';
  name: string;
  content: string;
  mimeType?: string;
}

// Trust record
export interface TrustRecord {
  agentId: string;
  publicKey: Uint8Array;
  alias?: string;
  trustLevel: TrustLevel;
  autoApprove: boolean;
  trustedAt: number;
}

// Config
export interface AgentLinkConfig {
  identity: {
    name: string;
    agentType: string;
    capabilities: string[];
  };
  network: {
    port: number;
    mdns: boolean;
    bindAllInterfaces: boolean;
    excludeInterfaces: string[];
    peers: Array<{ host: string; port: number; id?: string }>;
  };
  security: {
    requireApproval: TrustLevel;
    autoApproveTrusted: boolean;
    maxConcurrentTasks: number;
  };
  logging: {
    level: string;
    auditLog: boolean;
  };
}

// Audit event
export interface AuditEvent {
  timestamp: string;
  eventType: string;
  agentId?: string;
  direction?: 'inbound' | 'outbound';
  details: Record<string, unknown>;
}

// Team seed file format
export interface TeamSeed {
  version: 1;
  members: Array<{
    agentId: string;
    publicKey: string; // base64
    alias?: string;
  }>;
  exportedAt: string;
}

// Protocol method names
export const Methods = {
  AGENT_PING: 'agent.ping',
  AGENT_CARD: 'agent.card',
  AGENT_ADDRESS_UPDATE: 'agent.address_update',
  TASK_CREATE: 'task.create',
  TASK_ACCEPT: 'task.accept',
  TASK_REJECT: 'task.reject',
  TASK_PROGRESS: 'task.progress',
  TASK_COMPLETE: 'task.complete',
  TASK_FAIL: 'task.fail',
  TASK_CANCEL: 'task.cancel',
  BROADCAST_MESSAGE: 'broadcast.message',
} as const;

export const DEFAULT_CONFIG: AgentLinkConfig = {
  identity: {
    name: '',
    agentType: 'agent',
    capabilities: [],
  },
  network: {
    port: 9876,
    mdns: true,
    bindAllInterfaces: true,
    excludeInterfaces: ['docker0', 'veth*', 'lo'],
    peers: [],
  },
  security: {
    requireApproval: 'untrusted',
    autoApproveTrusted: true,
    maxConcurrentTasks: 3,
  },
  logging: {
    level: 'info',
    auditLog: true,
  },
};

export const AGENTLINK_VERSION = '0.1.0';

export const DEFAULT_CONFIG_DIR = '.agentlink';
export const IDENTITY_FILE = 'identity.json';
export const CONFIG_FILE = 'config.json';
export const TRUST_FILE = 'trust.json';
export const DB_FILE = 'agentlink.db';
export const LOGS_DIR = 'logs';
