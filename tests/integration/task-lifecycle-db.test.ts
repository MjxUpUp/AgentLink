/**
 * Integration: TaskManager + AgentDatabase
 *
 * Verifies the full task state machine, concurrent task creation,
 * database persistence, and query operations backed by real SQLite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TaskManager } from '../../src/core/task-manager.js';
import { AgentDatabase } from '../../src/db/database.js';
import type { Task, Artifact } from '../../src/core/types.js';

let tmpDir: string;
let taskManager: TaskManager;
let database: AgentDatabase;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-task-db-'));
  // Use separate DB files because TaskManager and AgentDatabase both create
  // a "tasks" table with different schemas (TaskManager adds a progress column).
  database = new AgentDatabase(path.join(tmpDir, 'agentlink.db'));
  taskManager = new TaskManager(path.join(tmpDir, 'taskmanager.db'));
});

afterEach(() => {
  taskManager.close();
  try { database.close(); } catch { /* nop */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTask(tm: TaskManager, index: number) {
  return tm.createTask({
    requester: `al-requester${index}`,
    executor: `al-executor${index}`,
    type: 'code-review',
    title: `Task #${index}`,
    description: `Description for task ${index}`,
    priority: index % 2 === 0 ? 'high' : 'medium',
  });
}

describe('TaskManager + AgentDatabase integration', () => {
  // -----------------------------------------------------------------------
  // Full lifecycle
  // -----------------------------------------------------------------------

  it('complete happy path: create → accept → start → progress → complete', () => {
    const task = makeTask(taskManager, 1);
    expect(task.status).toBe('created');
    expect(task.timeoutAt).toBeGreaterThan(0);

    const accepted = taskManager.acceptTask(task.id);
    expect(accepted.status).toBe('accepted');

    const started = taskManager.startTask(task.id);
    expect(started.status).toBe('in_progress');

    const progress = taskManager.updateProgress(task.id, { percent: 75, note: 'Almost done' });
    expect(progress.updatedAt).toBeGreaterThanOrEqual(started.updatedAt);

    const artifact: Artifact = {
      type: 'code',
      name: 'fix.patch',
      content: '--- a/file.ts\n+++ b/file.ts\n',
      mimeType: 'text/x-diff',
    };
    const completed = taskManager.completeTask(task.id, [artifact]);
    expect(completed.status).toBe('completed');
    expect(completed.artifacts).toHaveLength(1);
    expect(completed.artifacts[0].name).toBe('fix.patch');
  });

  it('reject path: create → reject', () => {
    const task = makeTask(taskManager, 1);
    const rejected = taskManager.rejectTask(task.id);
    expect(rejected.status).toBe('rejected');
  });

  it('fail path: create → accept → start → fail', () => {
    const task = makeTask(taskManager, 1);
    taskManager.acceptTask(task.id);
    taskManager.startTask(task.id);

    const failed = taskManager.failTask(task.id, 'OOM: out of memory');
    expect(failed.status).toBe('failed');
    // failTask writes artifacts to DB; re-read to verify persistence
    const reloaded = taskManager.getTask(task.id);
    expect(reloaded!.artifacts).toHaveLength(1);
    expect(reloaded!.artifacts[0].name).toBe('error');
    expect(reloaded!.artifacts[0].content).toBe('OOM: out of memory');
  });

  it('cancel path: create → cancel', () => {
    const task = makeTask(taskManager, 1);
    const cancelled = taskManager.cancelTask(task.id);
    expect(cancelled.status).toBe('cancelled');
  });

  it('cancel from accepted state', () => {
    const task = makeTask(taskManager, 1);
    taskManager.acceptTask(task.id);
    const cancelled = taskManager.cancelTask(task.id);
    expect(cancelled.status).toBe('cancelled');
  });

  // -----------------------------------------------------------------------
  // Invalid transitions
  // -----------------------------------------------------------------------

  it('throws on invalid transition: completed → accepted', () => {
    const task = makeTask(taskManager, 1);
    taskManager.acceptTask(task.id);
    taskManager.startTask(task.id);
    taskManager.completeTask(task.id, []);

    expect(() => taskManager.acceptTask(task.id)).toThrow(/Invalid transition/);
  });

  it('throws on invalid transition: rejected → anything', () => {
    const task = makeTask(taskManager, 1);
    taskManager.rejectTask(task.id);

    expect(() => taskManager.acceptTask(task.id)).toThrow(/Invalid transition/);
    expect(() => taskManager.startTask(task.id)).toThrow(/Invalid transition/);
  });

  it('throws on progress update for non-started task', () => {
    const task = makeTask(taskManager, 1);
    expect(() => taskManager.updateProgress(task.id, { percent: 10 })).toThrow(/Cannot update progress/);
  });

  it('throws on nonexistent task', () => {
    expect(() => taskManager.acceptTask('nonexistent')).toThrow(/Task not found/);
  });

  // -----------------------------------------------------------------------
  // Query operations
  // -----------------------------------------------------------------------

  it('getTask returns null for nonexistent ID', () => {
    expect(taskManager.getTask('nonexistent')).toBeNull();
  });

  it('listTasks returns all tasks', () => {
    makeTask(taskManager, 1);
    makeTask(taskManager, 2);
    makeTask(taskManager, 3);
    expect(taskManager.listTasks()).toHaveLength(3);
  });

  it('listTasks filters by status', () => {
    const t1 = makeTask(taskManager, 1);
    makeTask(taskManager, 2);
    taskManager.acceptTask(t1.id);

    const accepted = taskManager.listTasks('accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0].id).toBe(t1.id);
  });

  // -----------------------------------------------------------------------
  // Concurrent task creation
  // -----------------------------------------------------------------------

  it('creates many tasks with unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const task = makeTask(taskManager, i);
      ids.add(task.id);
    }
    expect(ids.size).toBe(50);
    expect(taskManager.listTasks()).toHaveLength(50);
  });

  // -----------------------------------------------------------------------
  // Database persistence — verify via TaskManager re-read
  // -----------------------------------------------------------------------

  it('TaskManager persists task to SQLite and can re-read', () => {
    const task = makeTask(taskManager, 1);
    const reloaded = taskManager.getTask(task.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.id).toBe(task.id);
    expect(reloaded!.status).toBe('created');
  });

  it('AgentDatabase CRUD for tasks works on its own DB', () => {
    // Use AgentDatabase directly (separate DB) for agent-focused queries
    database.upsertTask({
      id: 't-adb-001',
      type: 'review',
      title: 'DB task',
      description: 'test',
      requester: 'al-a',
      executor: 'al-b',
      status: 'created',
      priority: 'medium',
      artifacts: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const row = database.getTask('t-adb-001');
    expect(row).not.toBeNull();
    expect((row as any).title).toBe('DB task');

    database.updateTaskStatus('t-adb-001', 'accepted');
    const updated = database.getTask('t-adb-001');
    expect((updated as any).status).toBe('accepted');

    database.removeTask('t-adb-001');
    expect(database.getTask('t-adb-001')).toBeNull();
  });

  it('AgentDatabase listTasks returns tasks from its own DB', () => {
    database.upsertTask({
      id: 't-list-1', type: 't', title: 'T1', description: '',
      requester: 'a', executor: 'b', status: 'created', priority: 'low',
      artifacts: [], createdAt: Date.now(), updatedAt: Date.now(),
    });
    database.upsertTask({
      id: 't-list-2', type: 't', title: 'T2', description: '',
      requester: 'a', executor: 'b', status: 'created', priority: 'low',
      artifacts: [], createdAt: Date.now(), updatedAt: Date.now(),
    });
    expect(database.listTasks()).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // Artifacts
  // -----------------------------------------------------------------------

  it('stores and retrieves multiple artifacts', () => {
    const task = makeTask(taskManager, 1);
    taskManager.acceptTask(task.id);
    taskManager.startTask(task.id);

    const artifacts: Artifact[] = [
      { type: 'text', name: 'report.md', content: '# Report\nAll good.' },
      { type: 'code', name: 'main.ts', content: 'console.log("hello")', mimeType: 'text/typescript' },
      { type: 'file_reference', name: 'screenshot.png', content: '/tmp/screenshot.png' },
    ];

    const completed = taskManager.completeTask(task.id, artifacts);
    expect(completed.artifacts).toHaveLength(3);

    // Reload from DB
    const reloaded = taskManager.getTask(task.id);
    expect(reloaded!.artifacts).toHaveLength(3);
    expect(reloaded!.artifacts[0].type).toBe('text');
    expect(reloaded!.artifacts[1].mimeType).toBe('text/typescript');
    expect(reloaded!.artifacts[2].name).toBe('screenshot.png');
  });

  // -----------------------------------------------------------------------
  // Timestamps
  // -----------------------------------------------------------------------

  it('timestamps advance on state transitions', () => {
    const task = makeTask(taskManager, 1);
    const created = task.createdAt;

    const accepted = taskManager.acceptTask(task.id);
    expect(accepted.updatedAt).toBeGreaterThanOrEqual(created);

    const started = taskManager.startTask(task.id);
    expect(started.updatedAt).toBeGreaterThanOrEqual(accepted.updatedAt);
  });
});
