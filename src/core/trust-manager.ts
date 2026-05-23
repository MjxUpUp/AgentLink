import fs from 'node:fs';
import path from 'node:path';
import type { TrustRecord, TeamSeed } from './types.js';

interface TrustFileRecord {
  agentId: string;
  publicKey: string; // base64
  alias?: string;
  trustLevel: 'trusted' | 'untrusted';
  autoApprove: boolean;
  trustedAt: number;
}

interface TrustFile {
  records: TrustFileRecord[];
}

export class TrustManager {
  private filePath: string;
  private records: Map<string, TrustRecord>;

  constructor(trustFilePath: string) {
    this.filePath = trustFilePath;
    this.records = new Map();
    this.load();
  }

  addTrust(agentId: string, publicKey: Uint8Array, alias?: string): void {
    const record: TrustRecord = {
      agentId,
      publicKey: new Uint8Array(publicKey),
      alias,
      trustLevel: 'trusted',
      autoApprove: true,
      trustedAt: Date.now(),
    };
    this.records.set(agentId, record);
    this.save();
  }

  removeTrust(agentId: string): boolean {
    const existed = this.records.delete(agentId);
    if (existed) {
      this.save();
    }
    return existed;
  }

  getTrust(agentId: string): TrustRecord | null {
    return this.records.get(agentId) ?? null;
  }

  listTrusted(): TrustRecord[] {
    return Array.from(this.records.values());
  }

  isTrusted(agentId: string): boolean {
    const record = this.records.get(agentId);
    return record?.trustLevel === 'trusted';
  }

  shouldAutoApprove(agentId: string): boolean {
    const record = this.records.get(agentId);
    return record?.trustLevel === 'trusted' && record.autoApprove === true;
  }

  importTeamSeed(seed: TeamSeed): number {
    let count = 0;
    for (const member of seed.members) {
      const publicKey = new Uint8Array(Buffer.from(member.publicKey, 'base64'));
      this.records.set(member.agentId, {
        agentId: member.agentId,
        publicKey,
        alias: member.alias,
        trustLevel: 'trusted',
        autoApprove: true,
        trustedAt: Date.now(),
      });
      count++;
    }
    this.save();
    return count;
  }

  exportTeamSeed(): TeamSeed {
    return {
      version: 1,
      members: Array.from(this.records.values()).map((r) => ({
        agentId: r.agentId,
        publicKey: Buffer.from(r.publicKey).toString('base64'),
        ...(r.alias ? { alias: r.alias } : {}),
      })),
      exportedAt: new Date().toISOString(),
    };
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data: TrustFile = JSON.parse(raw);

      if (data.records && Array.isArray(data.records)) {
        for (const rec of data.records) {
          this.records.set(rec.agentId, {
            agentId: rec.agentId,
            publicKey: new Uint8Array(Buffer.from(rec.publicKey, 'base64')),
            alias: rec.alias,
            trustLevel: rec.trustLevel,
            autoApprove: rec.autoApprove,
            trustedAt: rec.trustedAt,
          });
        }
      }
    } catch {
      // If file is corrupt or unreadable, start fresh
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });

    const data: TrustFile = {
      records: Array.from(this.records.values()).map((r) => ({
        agentId: r.agentId,
        publicKey: Buffer.from(r.publicKey).toString('base64'),
        ...(r.alias ? { alias: r.alias } : {}),
        trustLevel: r.trustLevel,
        autoApprove: r.autoApprove,
        trustedAt: r.trustedAt,
      })),
    };

    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }
}
