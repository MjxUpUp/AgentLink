import { createRequire } from 'node:module';
import { v4 as uuidv4 } from 'uuid';
import type { Task, TaskStatus, Artifact } from './types.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  created: ['accepted', 'rejected', 'cancelled'],
  accepted: ['in_progress', 'rejected', 'cancelled'],
  rejected: [],
  in_progress: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export class TaskManager {
  private db: any;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        requester TEXT NOT NULL,
        executor TEXT NOT NULL,
        status TEXT DEFAULT 'created',
        priority TEXT DEFAULT 'medium',
        artifacts TEXT DEFAULT '[]',
        progress TEXT DEFAULT '{}',
        created_at INTEGER,
        updated_at INTEGER,
        timeout_at INTEGER
      )
    `);
  }

  createTask(opts: {
    requester: string;
    executor: string;
    type: string;
    title: string;
    description: string;
    priority: string;
  }): Task {
    const now = Date.now();
    const id = uuidv4();
    const task: Task = {
      id,
      type: opts.type,
      title: opts.title,
      description: opts.description,
      requester: opts.requester,
      executor: opts.executor,
      status: 'created',
      priority: opts.priority as Task['priority'],
      artifacts: [],
      createdAt: now,
      updatedAt: now,
      timeoutAt: now + 10 * 60 * 1000, // 10 minutes
    };

    this.db.prepare(`
      INSERT INTO tasks (id, type, title, description, requester, executor, status, priority, artifacts, created_at, updated_at, timeout_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.type, task.title, task.description,
      task.requester, task.executor, task.status, task.priority,
      JSON.stringify(task.artifacts),
      task.createdAt, task.updatedAt, task.timeoutAt,
    );

    return task;
  }

  private transition(taskId: string, newStatus: TaskStatus): Task {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    if (!VALID_TRANSITIONS[task.status].includes(newStatus)) {
      throw new Error(`Invalid transition: ${task.status} → ${newStatus}`);
    }

    const now = Date.now();
    this.db.prepare(`
      UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?
    `).run(newStatus, now, taskId);

    task.status = newStatus;
    task.updatedAt = now;
    return task;
  }

  acceptTask(taskId: string): Task {
    return this.transition(taskId, 'accepted');
  }

  startTask(taskId: string): Task {
    return this.transition(taskId, 'in_progress');
  }

  rejectTask(taskId: string): Task {
    return this.transition(taskId, 'rejected');
  }

  completeTask(taskId: string, artifacts: Artifact[]): Task {
    const task = this.transition(taskId, 'completed');
    const now = Date.now();
    this.db.prepare(`
      UPDATE tasks SET artifacts = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(artifacts), now, taskId);
    task.artifacts = artifacts;
    task.updatedAt = now;
    return task;
  }

  failTask(taskId: string, error: string): Task {
    const task = this.transition(taskId, 'failed');
    const now = Date.now();
    const artifacts = [{ type: 'text' as const, name: 'error', content: error }];
    this.db.prepare(`
      UPDATE tasks SET artifacts = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(artifacts), now, taskId);
    return task;
  }

  cancelTask(taskId: string): Task {
    return this.transition(taskId, 'cancelled');
  }

  updateProgress(taskId: string, progress: Record<string, unknown>): Task {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'in_progress') {
      throw new Error(`Cannot update progress for task in status: ${task.status}`);
    }

    const now = Date.now();
    this.db.prepare(`
      UPDATE tasks SET progress = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(progress), now, taskId);

    task.updatedAt = now;
    return task;
  }

  getTask(taskId: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!row) return null;

    return this.rowToTask(row);
  }

  listTasks(status?: TaskStatus): Task[] {
    if (status) {
      const rows = this.db.prepare('SELECT * FROM tasks WHERE status = ?').all(status);
      return rows.map((r: any) => this.rowToTask(r));
    }
    const rows = this.db.prepare('SELECT * FROM tasks').all();
    return rows.map((r: any) => this.rowToTask(r));
  }

  private rowToTask(row: any): Task {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      description: row.description || '',
      requester: row.requester,
      executor: row.executor,
      status: row.status,
      priority: row.priority,
      artifacts: JSON.parse(row.artifacts || '[]'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      timeoutAt: row.timeout_at,
    };
  }

  close(): void {
    this.db.close();
  }
}
