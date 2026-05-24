/**
 * Integration: Signature tamper protection
 *
 * Verifies that messages with tampered content or forged signatures
 * are detected and rejected by the verification system.
 */

import { describe, it, expect } from 'vitest';
import { generateIdentity, signMessage, verifyMessage } from '../../src/core/identity.js';
import { TestAgent, cleanupAgents } from './helpers/test-harness.js';
import { Methods } from '../../src/core/types.js';

let agents: TestAgent[] = [];

describe('Signature tamper protection', () => {
  it('tampered message params fails verification', async () => {
    const alice = await generateIdentity({ name: 'Alice', agentType: 'test', capabilities: [] });

    const original = {
      jsonrpc: '2.0' as const,
      id: 'msg-001',
      method: Methods.TASK_CREATE,
      params: { title: 'Original task', priority: 'low' },
      timestamp: new Date().toISOString(),
    };

    const signature = signMessage(original, alice.secretKey);

    // Tamper with params
    const tampered = {
      ...original,
      params: { title: 'INJECTED MALICIOUS TASK', priority: 'critical' },
    };

    expect(verifyMessage(tampered, signature, alice.publicKey)).toBe(false);
    expect(verifyMessage(original, signature, alice.publicKey)).toBe(true);
  });

  it('tampered method name fails verification', async () => {
    const alice = await generateIdentity({ name: 'Alice', agentType: 'test', capabilities: [] });

    const original = {
      jsonrpc: '2.0' as const,
      id: 'msg-002',
      method: Methods.TASK_CREATE,
      params: {},
      timestamp: new Date().toISOString(),
    };

    const signature = signMessage(original, alice.secretKey);

    const tampered = {
      ...original,
      method: Methods.TASK_COMPLETE, // Changed method
    };

    expect(verifyMessage(tampered, signature, alice.publicKey)).toBe(false);
  });

  it('tampered message ID fails verification', async () => {
    const alice = await generateIdentity({ name: 'Alice', agentType: 'test', capabilities: [] });

    const original = {
      jsonrpc: '2.0' as const,
      id: 'msg-original',
      method: Methods.TASK_CREATE,
      params: {},
      timestamp: new Date().toISOString(),
    };

    const signature = signMessage(original, alice.secretKey);

    const tampered = {
      ...original,
      id: 'msg-replay-attack',
    };

    expect(verifyMessage(tampered, signature, alice.publicKey)).toBe(false);
  });

  it('timestamp is NOT covered by signature (by design)', async () => {
    // signMessage signs {jsonrpc, id, method, params} — not timestamp.
    // Tampering with timestamp alone does NOT invalidate the signature.
    const alice = await generateIdentity({ name: 'Alice', agentType: 'test', capabilities: [] });

    const original = {
      jsonrpc: '2.0' as const,
      id: 'msg-003',
      method: Methods.TASK_CREATE,
      params: { data: 'important' },
      timestamp: '2026-01-01T00:00:00.000Z',
    };

    const signature = signMessage(original, alice.secretKey);

    const tampered = {
      ...original,
      timestamp: '2026-12-31T23:59:59.000Z',
    };

    // Signature still valid — timestamp is not part of signed payload
    expect(verifyMessage(tampered, signature, alice.publicKey)).toBe(true);
    // But tampering with params DOES break it
    const tamperedParams = { ...original, params: { data: 'tampered' } };
    expect(verifyMessage(tamperedParams, signature, alice.publicKey)).toBe(false);
  });

  it('signature from wrong key fails verification', async () => {
    const alice = await generateIdentity({ name: 'Alice', agentType: 'test', capabilities: [] });
    const eve = await generateIdentity({ name: 'Eve', agentType: 'attacker', capabilities: [] });

    const msg = {
      jsonrpc: '2.0' as const,
      id: 'msg-004',
      method: Methods.TASK_CREATE,
      params: { title: 'Forged task' },
      timestamp: new Date().toISOString(),
    };

    // Eve signs a message claiming to be Alice
    const forgedSignature = signMessage(msg, eve.secretKey);

    // Verification with Alice's public key should fail
    expect(verifyMessage(msg, forgedSignature, alice.publicKey)).toBe(false);

    // Verification with Eve's public key should succeed (Eve did sign it)
    expect(verifyMessage(msg, forgedSignature, eve.publicKey)).toBe(true);
  });

  it('random garbage signature fails verification', async () => {
    const alice = await generateIdentity({ name: 'Alice', agentType: 'test', capabilities: [] });

    const msg = {
      jsonrpc: '2.0' as const,
      id: 'msg-005',
      method: Methods.TASK_CREATE,
      params: {},
      timestamp: new Date().toISOString(),
    };

    // Random base64 garbage as signature
    const fakeSignature = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('base64');

    expect(verifyMessage(msg, fakeSignature, alice.publicKey)).toBe(false);
  });

  it('empty signature fails verification', async () => {
    const alice = await generateIdentity({ name: 'Alice', agentType: 'test', capabilities: [] });

    const msg = {
      jsonrpc: '2.0' as const,
      id: 'msg-006',
      method: Methods.TASK_CREATE,
      params: {},
      timestamp: new Date().toISOString(),
    };

    expect(verifyMessage(msg, '', alice.publicKey)).toBe(false);
  });

  it('signature is deterministic for same message and key', async () => {
    const alice = await generateIdentity({ name: 'Alice', agentType: 'test', capabilities: [] });

    const msg = {
      jsonrpc: '2.0' as const,
      id: 'msg-007',
      method: Methods.TASK_CREATE,
      params: { data: 'test' },
      timestamp: new Date().toISOString(),
    };

    const sig1 = signMessage(msg, alice.secretKey);
    const sig2 = signMessage(msg, alice.secretKey);

    expect(sig1).toBe(sig2);
  });

  it('different messages produce different signatures', async () => {
    const alice = await generateIdentity({ name: 'Alice', agentType: 'test', capabilities: [] });

    const msg1 = {
      jsonrpc: '2.0' as const,
      id: 'msg-008',
      method: Methods.TASK_CREATE,
      params: { title: 'Task A' },
      timestamp: new Date().toISOString(),
    };
    const msg2 = {
      jsonrpc: '2.0' as const,
      id: 'msg-009',
      method: Methods.TASK_CREATE,
      params: { title: 'Task B' },
      timestamp: new Date().toISOString(),
    };

    const sig1 = signMessage(msg1, alice.secretKey);
    const sig2 = signMessage(msg2, alice.secretKey);

    expect(sig1).not.toBe(sig2);
  });
});
