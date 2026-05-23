import fs from 'node:fs';
import path from 'node:path';
import type { AuditEvent } from './types.js';

export class AuditLogger {
  private logDir: string;

  constructor(logDir: string) {
    this.logDir = logDir;
  }

  log(event: AuditEvent): void {
    fs.mkdirSync(this.logDir, { recursive: true });

    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(this.logDir, `audit-${today}.jsonl`);
    const line = JSON.stringify(event) + '\n';

    fs.appendFileSync(filePath, line, 'utf-8');
  }
}
