import net from 'node:net';
import { createRequire } from 'node:module';
import type { AgentIdentity, AgentLinkMessage } from './types.js';
import { Methods } from './types.js';
import { signMessage, verifyMessage, deriveAgentId } from './identity.js';

const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers');

let sodiumReady = false;

async function ensureSodium(): Promise<void> {
  if (!sodiumReady) {
    await sodium.ready;
    sodiumReady = true;
  }
}

// Internal peer connection state
interface PeerConnection {
  socket: net.Socket;
  agentId: string;
  publicKey: Uint8Array;
  pushState: unknown;
  pullState: unknown;
  lastPing: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  remoteHost: string;
  remotePort: number;
}

interface PendingHandshake {
  socket: net.Socket;
  buffer: Buffer;
  isServer: boolean;
  peerPublicKey: Uint8Array | null;
  peerAgentId: string | null;
  // Derived crypto state
  pushState: unknown | null;
  pullState: unknown | null;
  // Which phase of the handshake we're in
  phase: 'wait-pk' | 'wait-header' | 'wait-card';
}

type TransportEventType = 'connect' | 'disconnect' | 'message' | 'error';

export class Transport {
  private server: net.Server | null = null;
  private connections: Map<string, PeerConnection> = new Map();
  private pendingHandshakes: Map<net.Socket, PendingHandshake> = new Map();
  private identity: AgentIdentity;
  private onMessage: (agentId: string, msg: AgentLinkMessage) => void;
  private listeners: Map<TransportEventType, Set<(...args: unknown[]) => void>> = new Map();
  private serverPort: number = 0;
  private stopped: boolean = false;
  private onAudit?: (event: { timestamp: string; eventType: string; agentId?: string; direction?: string; details: Record<string, unknown> }) => void;

  private static readonly MAX_CONNECTIONS = 20;
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000;
  private static readonly HEARTBEAT_TIMEOUT_MS = 90_000;
  private static readonly HEADER_SIZE = 4;
  private static readonly PUBLIC_KEY_SIZE = 32;

  constructor(
    identity: AgentIdentity,
    onMessage: (agentId: string, msg: AgentLinkMessage) => void,
    onAudit?: (event: { timestamp: string; eventType: string; agentId?: string; direction?: string; details: Record<string, unknown> }) => void,
  ) {
    this.identity = identity;
    this.onMessage = onMessage;
    this.onAudit = onAudit;
  }

  get connectedPeers(): string[] {
    return Array.from(this.connections.keys());
  }

  get listeningPort(): number {
    return this.serverPort;
  }

  // --- Server lifecycle ---

  async startServer(port: number): Promise<void> {
    await ensureSodium();

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleIncomingConnection(socket);
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${port} is already in use`));
        } else {
          reject(err);
        }
      });

      this.server.listen(port, () => {
        this.serverPort = port;
        resolve();
      });
    });
  }

  // --- Client connect ---

  async connect(host: string, port: number): Promise<void> {
    await ensureSodium();

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        // Phase 1: Client sends its Ed25519 public key first
        socket.write(Buffer.from(this.identity.publicKey));

        const handshake: PendingHandshake = {
          socket,
          buffer: Buffer.alloc(0),
          isServer: false,
          peerPublicKey: null,
          peerAgentId: null,
          pushState: null,
          pullState: null,
          phase: 'wait-pk',
        };
        this.pendingHandshakes.set(socket, handshake);

        const onData = (data: Buffer) => {
          this.processHandshake(handshake, data, resolve, reject);
        };
        const onError = (err: Error) => {
          this.pendingHandshakes.delete(socket);
          reject(err);
        };
        const onClose = () => {
          this.pendingHandshakes.delete(socket);
        };

        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', onClose);
      });

      socket.on('error', (err) => {
        reject(err);
      });
    });
  }

  // --- Send a message ---

  send(agentId: string, message: AgentLinkMessage): void {
    const conn = this.connections.get(agentId);
    if (!conn) {
      throw new Error(`Not connected to agent ${agentId}`);
    }

    const payload = Buffer.from(JSON.stringify(message), 'utf-8');
    const encrypted = sodium.crypto_secretstream_xchacha20poly1305_push(
      conn.pushState,
      payload,
      null,
      0,
    );

    this.sendFrame(conn.socket, encrypted);
    this.audit('outbound', message.method, { targetAgentId: agentId });
  }

  // --- Disconnect a specific peer ---

  disconnect(agentId: string): void {
    const conn = this.connections.get(agentId);
    if (!conn) return;

    this.cleanupConnection(conn);
    this.connections.delete(agentId);
    this.emit('disconnect', agentId);
  }

  // --- Stop everything ---

  stop(): void {
    this.stopped = true;

    for (const [agentId, conn] of this.connections) {
      this.cleanupConnection(conn);
      this.emit('disconnect', agentId);
    }
    this.connections.clear();

    for (const [, hs] of this.pendingHandshakes) {
      hs.socket.destroy();
    }
    this.pendingHandshakes.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  // --- Event helpers ---

  on(event: TransportEventType, listener: (...args: unknown[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  off(event: TransportEventType, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  private emit(event: TransportEventType, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach((fn) => fn(...args));
  }

  // --- Incoming connection handler (server side) ---

  private handleIncomingConnection(socket: net.Socket): void {
    if (this.connections.size >= Transport.MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }

    const handshake: PendingHandshake = {
      socket,
      buffer: Buffer.alloc(0),
      isServer: true,
      peerPublicKey: null,
      peerAgentId: null,
      pushState: null,
      pullState: null,
      phase: 'wait-pk',
    };
    this.pendingHandshakes.set(socket, handshake);

    socket.on('data', (data: Buffer) => {
      // Server handshake has no resolve/reject
      this.processHandshake(handshake, data, undefined, undefined);
    });

    socket.on('error', () => {
      this.pendingHandshakes.delete(socket);
    });

    socket.on('close', () => {
      this.pendingHandshakes.delete(socket);
    });
  }

  // --- Handshake state machine ---

  private processHandshake(
    hs: PendingHandshake,
    data: Buffer,
    resolve?: () => void,
    reject?: (err: Error) => void,
  ): void {
    hs.buffer = Buffer.concat([hs.buffer, data]);

    switch (hs.phase) {
      case 'wait-pk':
        this.handleWaitPk(hs, resolve, reject);
        break;
      case 'wait-header':
        this.handleWaitHeader(hs, resolve, reject);
        break;
      case 'wait-card':
        this.handleWaitCard(hs, resolve, reject);
        break;
    }
  }

  private handleWaitPk(hs: PendingHandshake, resolve?: () => void, reject?: (err: Error) => void): void {
    if (hs.buffer.length < Transport.PUBLIC_KEY_SIZE) return;

    const peerEdPk = new Uint8Array(hs.buffer.subarray(0, Transport.PUBLIC_KEY_SIZE));
    hs.buffer = hs.buffer.subarray(Transport.PUBLIC_KEY_SIZE);
    hs.peerPublicKey = peerEdPk;

    if (hs.isServer) {
      // Server sends its public key back
      hs.socket.write(Buffer.from(this.identity.publicKey));
    }

    // Convert Ed25519 keys to X25519 for crypto_kx
    const myKxPk = sodium.crypto_sign_ed25519_pk_to_curve25519(this.identity.publicKey);
    const myKxSk = sodium.crypto_sign_ed25519_sk_to_curve25519(this.identity.secretKey);
    const peerKxPk = sodium.crypto_sign_ed25519_pk_to_curve25519(peerEdPk);

    // Derive session keys
    let sessionKeys: { sharedRx: Uint8Array; sharedTx: Uint8Array };
    if (hs.isServer) {
      sessionKeys = sodium.crypto_kx_server_session_keys(myKxPk, myKxSk, peerKxPk);
    } else {
      sessionKeys = sodium.crypto_kx_client_session_keys(myKxPk, myKxSk, peerKxPk);
    }

    // Init push with TX key (what we send)
    const pushInit = sodium.crypto_secretstream_xchacha20poly1305_init_push(sessionKeys.sharedTx);
    hs.pushState = pushInit.state;

    // Send our push header (24 bytes) so peer can init their pull
    hs.socket.write(Buffer.from(pushInit.header));

    hs.phase = 'wait-header';

    this.audit('inbound', 'handshake', { step: 'keys-exchanged', isServer: hs.isServer });

    // Process remaining buffer
    if (hs.buffer.length > 0) {
      this.processHandshake(hs, Buffer.alloc(0), resolve, reject);
    }
  }

  private handleWaitHeader(hs: PendingHandshake, resolve?: () => void, reject?: (err: Error) => void): void {
    const headerBytes = sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
    if (hs.buffer.length < headerBytes) return;

    const peerHeader = new Uint8Array(hs.buffer.subarray(0, headerBytes));
    hs.buffer = hs.buffer.subarray(headerBytes);

    // Derive session keys again to get the RX key
    const myKxPk = sodium.crypto_sign_ed25519_pk_to_curve25519(this.identity.publicKey);
    const myKxSk = sodium.crypto_sign_ed25519_sk_to_curve25519(this.identity.secretKey);
    const peerKxPk = sodium.crypto_sign_ed25519_pk_to_curve25519(hs.peerPublicKey!);

    let sessionKeys: { sharedRx: Uint8Array; sharedTx: Uint8Array };
    if (hs.isServer) {
      sessionKeys = sodium.crypto_kx_server_session_keys(myKxPk, myKxSk, peerKxPk);
    } else {
      sessionKeys = sodium.crypto_kx_client_session_keys(myKxPk, myKxSk, peerKxPk);
    }

    // Init pull with RX key (what we receive) and peer's header
    hs.pullState = sodium.crypto_secretstream_xchacha20poly1305_init_pull(peerHeader, sessionKeys.sharedRx);

    // Send our signed agent.card (encrypted)
    const card = this.buildAgentCard();
    const cardPayload = Buffer.from(JSON.stringify(card), 'utf-8');
    const encryptedCard = sodium.crypto_secretstream_xchacha20poly1305_push(
      hs.pushState!,
      cardPayload,
      null,
      0,
    );
    this.sendFrame(hs.socket, encryptedCard);

    hs.phase = 'wait-card';

    if (hs.buffer.length > 0) {
      this.processHandshake(hs, Buffer.alloc(0), resolve, reject);
    }
  }

  private handleWaitCard(hs: PendingHandshake, resolve?: () => void, reject?: (err: Error) => void): void {
    // Read framed encrypted card
    if (hs.buffer.length < Transport.HEADER_SIZE) return;

    const frameLen = hs.buffer.readUInt32BE(0);
    if (hs.buffer.length < Transport.HEADER_SIZE + frameLen) return;

    const encryptedCard = new Uint8Array(
      hs.buffer.subarray(Transport.HEADER_SIZE, Transport.HEADER_SIZE + frameLen),
    );
    hs.buffer = hs.buffer.subarray(Transport.HEADER_SIZE + frameLen);

    try {
      const decrypted = sodium.crypto_secretstream_xchacha20poly1305_pull(
        hs.pullState!,
        encryptedCard,
        null,
      );

      const cardJson = Buffer.from(decrypted.message).toString('utf-8');
      const card = JSON.parse(cardJson);

      // Verify the card signature
      const peerAgentId = deriveAgentId(hs.peerPublicKey!);
      const valid = verifyMessage(
        {
          jsonrpc: card.jsonrpc,
          id: card.id,
          method: card.method,
          params: card.params,
          timestamp: card.timestamp,
        },
        card.signature,
        hs.peerPublicKey!,
      );

      if (!valid) {
        hs.socket.destroy();
        this.pendingHandshakes.delete(hs.socket);
        reject?.(new Error('Agent card signature verification failed'));
        return;
      }

      hs.peerAgentId = peerAgentId;

      // Check max connections
      if (this.connections.size >= Transport.MAX_CONNECTIONS) {
        hs.socket.destroy();
        this.pendingHandshakes.delete(hs.socket);
        return;
      }

      // Replace existing connection to same peer
      const existing = this.connections.get(peerAgentId);
      if (existing) {
        this.cleanupConnection(existing);
        this.connections.delete(peerAgentId);
      }

      // Create the peer connection
      const conn: PeerConnection = {
        socket: hs.socket,
        agentId: peerAgentId,
        publicKey: hs.peerPublicKey!,
        pushState: hs.pushState,
        pullState: hs.pullState,
        lastPing: Date.now(),
        heartbeatTimer: null,
        remoteHost: hs.socket.remoteAddress ?? 'unknown',
        remotePort: hs.socket.remotePort ?? 0,
      };

      this.connections.set(peerAgentId, conn);
      this.pendingHandshakes.delete(hs.socket);

      // Replace data handlers for encrypted communication
      hs.socket.removeAllListeners('data');
      hs.socket.removeAllListeners('error');
      hs.socket.removeAllListeners('close');

      let readBuffer = hs.buffer;
      hs.socket.on('data', (newData: Buffer) => {
        readBuffer = Buffer.concat([readBuffer, newData]);
        readBuffer = this.processEncryptedData(conn, readBuffer);
      });

      hs.socket.on('error', () => {
        this.handleConnectionError(conn);
      });

      hs.socket.on('close', () => {
        this.handleConnectionClose(conn);
      });

      // Start heartbeat
      this.startHeartbeat(conn);

      this.audit('inbound', Methods.AGENT_CARD, { agentId: peerAgentId });
      this.emit('connect', peerAgentId);

      resolve?.();
    } catch (err) {
      hs.socket.destroy();
      this.pendingHandshakes.delete(hs.socket);
      reject?.(new Error(`Handshake failed: ${err}`));
    }
  }

  // --- Encrypted message processing ---

  private processEncryptedData(conn: PeerConnection, buffer: Buffer): Buffer {
    while (buffer.length >= Transport.HEADER_SIZE) {
      const frameLen = buffer.readUInt32BE(0);
      if (buffer.length < Transport.HEADER_SIZE + frameLen) break;

      const encrypted = new Uint8Array(
        buffer.subarray(Transport.HEADER_SIZE, Transport.HEADER_SIZE + frameLen),
      );
      buffer = buffer.subarray(Transport.HEADER_SIZE + frameLen);

      try {
        const decrypted = sodium.crypto_secretstream_xchacha20poly1305_pull(
          conn.pullState,
          encrypted,
          null,
        );

        const messageStr = Buffer.from(decrypted.message).toString('utf-8');
        const message: AgentLinkMessage = JSON.parse(messageStr);

        if (message.method === Methods.AGENT_PING) {
          // Respond with pong
          conn.lastPing = Date.now();
          const pong = this.buildPong(message.id);
          const pongPayload = Buffer.from(JSON.stringify(pong), 'utf-8');
          const encryptedPong = sodium.crypto_secretstream_xchacha20poly1305_push(
            conn.pushState,
            pongPayload,
            null,
            0,
          );
          this.sendFrame(conn.socket, encryptedPong);
          this.audit('inbound', Methods.AGENT_PING, { agentId: conn.agentId });
        } else if (message.method === 'agent.pong') {
          conn.lastPing = Date.now();
          this.audit('inbound', 'agent.pong', { agentId: conn.agentId });
        } else {
          conn.lastPing = Date.now();
          this.onMessage(conn.agentId, message);
          this.audit('inbound', message.method, { agentId: conn.agentId });
        }
      } catch {
        this.audit('inbound', 'decrypt-error', { agentId: conn.agentId });
      }
    }

    return buffer;
  }

  // --- Heartbeat ---

  private startHeartbeat(conn: PeerConnection): void {
    if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer);

    conn.heartbeatTimer = setInterval(() => {
      if (Date.now() - conn.lastPing > Transport.HEARTBEAT_TIMEOUT_MS) {
        this.handleConnectionError(conn);
        return;
      }

      try {
        const ping = this.buildPing();
        const payload = Buffer.from(JSON.stringify(ping), 'utf-8');
        const encrypted = sodium.crypto_secretstream_xchacha20poly1305_push(
          conn.pushState,
          payload,
          null,
          0,
        );
        this.sendFrame(conn.socket, encrypted);
      } catch {
        this.handleConnectionError(conn);
      }
    }, Transport.HEARTBEAT_INTERVAL_MS);
  }

  // --- Connection error/close handlers ---

  private handleConnectionError(conn: PeerConnection): void {
    const agentId = conn.agentId;
    if (!this.connections.has(agentId)) return;
    this.cleanupConnection(conn);
    this.connections.delete(agentId);
    this.emit('disconnect', agentId);
  }

  private handleConnectionClose(conn: PeerConnection): void {
    const agentId = conn.agentId;
    if (!this.connections.has(agentId)) return;
    this.cleanupConnection(conn);
    this.connections.delete(agentId);
    this.emit('disconnect', agentId);
  }

  // --- Utility ---

  private cleanupConnection(conn: PeerConnection): void {
    if (conn.heartbeatTimer) {
      clearInterval(conn.heartbeatTimer);
      conn.heartbeatTimer = null;
    }
    try {
      conn.socket.destroy();
    } catch {
      // ignore
    }
  }

  private sendFrame(socket: net.Socket, data: Uint8Array): void {
    const header = Buffer.alloc(Transport.HEADER_SIZE);
    header.writeUInt32BE(data.length, 0);
    socket.write(Buffer.concat([header, Buffer.from(data)]));
  }

  private buildAgentCard(): AgentLinkMessage {
    const msg = {
      jsonrpc: '2.0' as const,
      id: `card-${Date.now()}`,
      method: Methods.AGENT_CARD,
      params: {
        name: this.identity.name,
        agentType: this.identity.agentType,
        capabilities: this.identity.capabilities,
      },
      timestamp: new Date().toISOString(),
    };

    const signature = signMessage(msg, this.identity.secretKey);
    return { ...msg, signature };
  }

  private buildPing(): AgentLinkMessage {
    const msg = {
      jsonrpc: '2.0' as const,
      id: `ping-${Date.now()}`,
      method: Methods.AGENT_PING,
      params: {},
      timestamp: new Date().toISOString(),
    };
    const signature = signMessage(msg, this.identity.secretKey);
    return { ...msg, signature };
  }

  private buildPong(pingId: string): AgentLinkMessage {
    const msg = {
      jsonrpc: '2.0' as const,
      id: `pong-${pingId}`,
      method: 'agent.pong',
      params: { pingId },
      timestamp: new Date().toISOString(),
    };
    const signature = signMessage(msg, this.identity.secretKey);
    return { ...msg, signature };
  }

  private audit(direction: string, method: string, details: Record<string, unknown>): void {
    if (this.onAudit) {
      this.onAudit({
        timestamp: new Date().toISOString(),
        eventType: method,
        agentId: this.identity.agentId,
        direction,
        details,
      });
    }
  }
}
