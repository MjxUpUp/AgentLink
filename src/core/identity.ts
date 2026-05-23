import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type { AgentIdentity, AgentLinkMessage } from './types.js';

const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers');

let sodiumReady = false;

async function ensureSodium() {
  if (!sodiumReady) {
    await sodium.ready;
    sodiumReady = true;
  }
}

export async function generateIdentity(opts: {
  name: string;
  agentType: string;
  capabilities: string[];
}): Promise<AgentIdentity> {
  await ensureSodium();

  const keyPair = sodium.crypto_sign_keypair();
  const publicKey = keyPair.publicKey;
  const secretKey = keyPair.privateKey;
  const agentId = deriveAgentId(publicKey);

  return {
    agentId,
    publicKey: new Uint8Array(publicKey),
    secretKey: new Uint8Array(secretKey),
    name: opts.name,
    agentType: opts.agentType,
    capabilities: opts.capabilities,
  };
}

export function deriveAgentId(publicKey: Uint8Array): string {
  const hash = crypto.createHash('sha256').update(publicKey).digest();
  const first16 = hash.subarray(0, 16);

  // Crockford Base32 encoding (excludes I, L, O, U)
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let num = BigInt('0x' + Buffer.from(first16).toString('hex'));
  let encoded = '';
  const base = BigInt(32);

  if (num === 0n) {
    encoded = '0'.repeat(24);
  } else {
    while (num > 0n) {
      encoded = alphabet[Number(num % base)] + encoded;
      num = num / base;
    }
  }

  // Pad to 24 chars and split into 3 groups of 8
  encoded = encoded.padStart(24, '0');
  const g1 = encoded.substring(0, 8);
  const g2 = encoded.substring(8, 16);
  const g3 = encoded.substring(16, 24);

  return `al-${g1}-${g2}-${g3}`;
}

export function signMessage(
  message: Omit<AgentLinkMessage, 'signature'>,
  secretKey: Uint8Array,
): string {
  const payload = JSON.stringify({
    jsonrpc: message.jsonrpc,
    id: message.id,
    method: message.method,
    params: message.params,
  });

  const signature = sodium.crypto_sign_detached(
    payload,
    secretKey,
  );

  return Buffer.from(signature).toString('base64');
}

export function verifyMessage(
  message: Omit<AgentLinkMessage, 'signature'>,
  signature: string,
  publicKey: Uint8Array,
): boolean {
  const payload = JSON.stringify({
    jsonrpc: message.jsonrpc,
    id: message.id,
    method: message.method,
    params: message.params,
  });

  const sigBytes = Buffer.from(signature, 'base64');

  try {
    return sodium.crypto_sign_verify_detached(sigBytes, payload, publicKey);
  } catch {
    return false;
  }
}

export function getFingerprint(publicKey: Uint8Array): string {
  const hash = crypto.createHash('sha256').update(publicKey).digest();
  return hash.subarray(0, 8).toString('hex');
}

export function saveIdentity(identity: AgentIdentity, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });

  const data = {
    agentId: identity.agentId,
    publicKey: Buffer.from(identity.publicKey).toString('base64'),
    secretKey: Buffer.from(identity.secretKey).toString('base64'),
    name: identity.name,
    agentType: identity.agentType,
    capabilities: identity.capabilities,
  };

  const filePath = path.join(dir, 'identity.json');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function loadIdentity(dir: string): AgentIdentity | null {
  const filePath = path.join(dir, 'identity.json');
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);

  return {
    agentId: data.agentId,
    publicKey: new Uint8Array(Buffer.from(data.publicKey, 'base64')),
    secretKey: new Uint8Array(Buffer.from(data.secretKey, 'base64')),
    name: data.name,
    agentType: data.agentType,
    capabilities: data.capabilities,
  };
}
