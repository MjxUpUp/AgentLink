/**
 * AgentLink MCP Server — stdio-mode MCP server that exposes AgentLink
 * capabilities (discover, message, broadcast, status, wait) as MCP tools,
 * resources, and a prompt.
 *
 * Dependencies (identity, TaskManager, TrustManager, etc.) are injected so
 * the server is testable without real network I/O.
 *
 * Use the static `createFromConfig(configDir)` factory to wire all modules
 * together from a config directory, or inject deps directly for testing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AgentIdentity, AgentLinkMessage, Artifact, AgentLinkConfig } from '../core/types.js';
import { DEFAULT_CONFIG, Methods } from '../core/types.js';
import { TaskManager } from '../core/task-manager.js';
import { TrustManager } from '../core/trust-manager.js';
import { AuditLogger } from '../core/audit-logger.js';
import { AddressBook } from '../core/address-book.js';
import { AgentDatabase } from '../db/database.js';
import { Transport } from '../core/transport.js';
import { Discovery } from '../core/discovery.js';
import { loadIdentity, signMessage } from '../core/identity.js';
import { registerTools, registerResources, registerPrompts, type ToolDeps, type AgentOverview } from './tools.js';

export interface AgentLinkServerDeps {
  identity: AgentIdentity;
  taskManager: TaskManager;
  trustManager: TrustManager;
  /** Returns current online agents (typically from discovery service). */
  getOnlineAgents(): AgentOverview[];
  /** Sends a message to a remote agent. */
  sendMessage(to: string, message: string, type: string, artifacts?: Artifact[]): Promise<boolean>;
  /** Waits for a task reply. Default impl polls TaskManager. */
  waitForReply?(taskId: string, timeoutMs: number): Promise<import('../core/types.js').Task | null>;
}

/** Internal handles for modules created by createFromConfig, used during stop(). */
interface WiredModules {
  database: AgentDatabase;
  taskManager: TaskManager;
  auditLogger: AuditLogger;
  transport: Transport;
  discovery: Discovery;
  addressBook: AddressBook;
  config: AgentLinkConfig;
}

export class AgentLinkServer {
  private mcpServer: McpServer;
  private deps: ToolDeps;
  private transport: StdioServerTransport | null = null;
  private wiredModules: WiredModules | null = null;

  constructor(deps: AgentLinkServerDeps) {
    this.mcpServer = new McpServer({
      name: 'agentlink',
      version: '0.1.0',
    });

    // Build the waitForReply default implementation if not provided
    const defaultWaitForReply = async (taskId: string, timeoutMs: number): Promise<import('../core/types.js').Task | null> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const task = deps.taskManager.getTask(taskId);
        if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) {
          return task;
        }
        // Poll every 500ms
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return null;
    };

    this.deps = {
      identity: deps.identity,
      taskManager: deps.taskManager,
      trustManager: deps.trustManager,
      getOnlineAgents: deps.getOnlineAgents,
      sendMessage: deps.sendMessage,
      waitForReply: deps.waitForReply ?? defaultWaitForReply,
    };

    // Register all MCP primitives
    registerTools(this.mcpServer, this.deps);
    registerResources(this.mcpServer, this.deps);
    registerPrompts(this.mcpServer);
  }

  /**
   * Factory method that creates all AgentLink modules from a config directory
   * and wires them together.
   *
   * Loads identity, config, creates database, audit logger, trust manager,
   * task manager, transport, discovery, and address book. Wires discovery
   * callbacks to update the address book and transport, and transport
   * messages to create tasks in the task manager.
   */
  static createFromConfig(configDir: string): AgentLinkServer {
    // 1. Load identity
    const identity = loadIdentity(configDir);
    if (!identity) {
      throw new Error('No identity found. Run `agentlink init` first.');
    }

    // 2. Load config
    const configPath = path.join(configDir, 'config.json');
    let config: AgentLinkConfig = DEFAULT_CONFIG;
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) as AgentLinkConfig };
      } catch {
        // Use defaults
      }
    }

    // 3. Create AgentDatabase
    const dbPath = path.join(configDir, 'agentlink.db');
    const database = new AgentDatabase(dbPath);

    // 4. Create AuditLogger
    const logsDir = path.join(configDir, 'logs');
    const auditLogger = new AuditLogger(logsDir);

    // 5. Create TrustManager
    const trustPath = path.join(configDir, 'trust.json');
    const trustManager = new TrustManager(trustPath);

    // 6. Create TaskManager
    const taskManager = new TaskManager(dbPath);

    // 7. Create AddressBook
    const addressBook = new AddressBook(database);

    // 8. Online agents registry (kept in memory, updated by discovery)
    const onlineAgents: Map<string, AgentOverview> = new Map();

    // 9. Create Transport
    const onMessage = (agentId: string, msg: AgentLinkMessage): void => {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        eventType: msg.method,
        agentId,
        direction: 'inbound',
        details: { params: msg.params },
      });

      // Handle incoming task messages
      if (msg.method === Methods.TASK_CREATE) {
        const params = msg.params;
        taskManager.createTask({
          requester: agentId,
          executor: identity.agentId,
          type: (params.type as string) || 'message',
          title: (params.title as string) || 'Incoming task',
          description: (params.description as string) || '',
          priority: (params.priority as string) || 'medium',
        });
      } else if (msg.method === Methods.AGENT_ADDRESS_UPDATE) {
        const endpoints = msg.params.endpoints as Array<{ ip: string; port: number }>;
        if (endpoints && endpoints.length > 0) {
          addressBook.updateAddress(agentId, endpoints[0].ip, endpoints[0].port, 'address-book');
        }
      }
    };

    const onAudit = (event: { timestamp: string; eventType: string; agentId?: string; direction?: string; details: Record<string, unknown> }): void => {
      auditLogger.log({
        timestamp: event.timestamp,
        eventType: event.eventType,
        agentId: event.agentId,
        direction: event.direction as 'inbound' | 'outbound' | undefined,
        details: event.details,
      });
    };

    const transport = new Transport(identity, onMessage, onAudit);

    // 10. Create Discovery
    const discovery = new Discovery(
      identity,
      config.network.port,
      {
        onAgentFound(info) {
          onlineAgents.set(info.agentId, {
            agentId: info.agentId,
            name: info.name,
            agentType: info.agentType,
            capabilities: info.capabilities,
            status: 'online',
            ip: info.ip,
            port: info.port,
          });

          // Update address book
          addressBook.updateAddress(info.agentId, info.ip, info.port, 'mdns');
        },
        onAgentLost(agentId) {
          onlineAgents.delete(agentId);
        },
        onNetworkChange(endpoints) {
          // Send address_update to all connected peers
          for (const peerId of transport.connectedPeers) {
            const msg: AgentLinkMessage = {
              jsonrpc: '2.0',
              id: `addr-${Date.now()}-${peerId.slice(0, 8)}`,
              method: Methods.AGENT_ADDRESS_UPDATE,
              params: {
                endpoints: endpoints.ips.map(ip => ({ ip, port: endpoints.port })),
              },
              signature: '',
              timestamp: new Date().toISOString(),
            };
            msg.signature = signMessage(msg, identity.secretKey);
            try {
              transport.send(peerId, msg);
            } catch {
              // Peer may have disconnected
            }
          }
        },
      },
      {
        mdns: config.network.mdns,
        peers: config.network.peers,
      },
    );

    // 11. Wire getOnlineAgents
    const getOnlineAgents = (): AgentOverview[] => {
      return Array.from(onlineAgents.values());
    };

    // 12. Wire sendMessage
    const sendMessage = async (
      to: string,
      message: string,
      type: string,
      artifacts?: Artifact[],
    ): Promise<boolean> => {
      // Resolve address from address book
      const addr = addressBook.resolveAddress(to);
      if (!addr) {
        return false;
      }

      // Check if already connected
      if (!transport.connectedPeers.includes(to)) {
        try {
          await transport.connect(addr.ip, addr.port);
        } catch {
          return false;
        }
      }

      // Build the message
      const msg: AgentLinkMessage = {
        jsonrpc: '2.0',
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        method: type === 'broadcast' ? Methods.BROADCAST_MESSAGE : Methods.TASK_CREATE,
        params: {
          message,
          type,
          artifacts: artifacts ?? [],
        },
        signature: '',
        timestamp: new Date().toISOString(),
      };

      // Sign and send
      msg.signature = signMessage(msg, identity.secretKey);

      try {
        transport.send(to, msg);
        auditLogger.log({
          timestamp: new Date().toISOString(),
          eventType: msg.method,
          agentId: to,
          direction: 'outbound',
          details: { message },
        });
        return true;
      } catch {
        return false;
      }
    };

    // 13. Build the server with all wired deps
    const server = new AgentLinkServer({
      identity,
      taskManager,
      trustManager,
      getOnlineAgents,
      sendMessage,
    });

    // Attach wired modules for lifecycle management
    server.wiredModules = {
      database,
      taskManager,
      auditLogger,
      transport,
      discovery,
      addressBook,
      config,
    };

    return server;
  }

  /** Expose the underlying McpServer for testing. */
  get server(): McpServer {
    return this.mcpServer;
  }

  /** Start the server on stdio. Also starts network transport and discovery if wired. */
  async start(): Promise<void> {
    // Start network transport if wired
    if (this.wiredModules) {
      const port = this.wiredModules.config.network.port;
      await this.wiredModules.transport.startServer(port);
      this.wiredModules.discovery.start();
    }

    this.transport = new StdioServerTransport();
    await this.mcpServer.connect(this.transport);
  }

  /** Gracefully shut down. */
  async stop(): Promise<void> {
    await this.mcpServer.close();
    this.transport = null;

    // Stop wired modules if present
    if (this.wiredModules) {
      this.wiredModules.discovery.stop();
      this.wiredModules.transport.stop();
      this.wiredModules.taskManager.close();
      this.wiredModules.database.close();
      this.wiredModules = null;
    }
  }
}
