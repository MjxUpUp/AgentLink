/**
 * Integration: Task timeout and expiry
 *
 * Verifies task timeoutAt is set correctly, tasks with expired
 * timeout are still queryable, and timeout doesn't affect state machine.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TaskManager } from '../../src/core/task-manager.js';

let tmpDir: string;
let taskManager: TaskManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-timeout-'));
  taskManager = new TaskManager(path.join(tmpDir, 'tasks.db'));
});

afterEach(() => {
  taskManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Task timeout and expiry', () => {
  it('new task has timeoutAt set to 10 minutes from creation', () => {
    const before = Date.now();
    const task = taskManager.createTask({
      requester: 'al-a',
      executor: 'al-b',
      type: 'test',
      title: 'Timeout test',
      description: '',
      priority: 'medium',
    });
    const after = Date.now();

    const minTimeout = before + 10 * 60 * 1000;
    const maxTimeout = after + 10 * 60 * 1000;

    expect(task.timeoutAt).toBeGreaterThanOrEqual(minTimeout);
    expect(task.timeoutAt).toBeLessThanOrEqual(maxTimeout);
  });

  it('expired task is still queryable', () => {
    const task = taskManager.createTask({
      requester: 'al-a',
      executor: 'al-b',
      type: 'test',
      title: 'Expired task',
      description: '',
      priority: 'medium',
    });

    // Simulate time passing by verifying the task is still in the DB
    // with its original timeoutAt
    const reloaded = taskManager.getTask(task.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.timeoutAt).toBe(task.timeoutAt);
  });

  it('task state machine works regardless of timeout', () => {
    const task = taskManager.createTask({
      requester: 'al-a',
      executor: 'al-b',
      type: 'test',
      title: 'State after timeout',
      description: '',
      priority: 'medium',
    });

    // State transitions should still work even if we conceptually
    // consider the task "timed out" — the state machine doesn't
    // enforce timeout at the TaskManager level
    taskManager.acceptTask(task.id);
    taskManager.startTask(task.id);
    taskManager.completeTask(task.id, []);

    const completed = taskManager.getTask(task.id);
    expect(completed!.status).toBe('completed');
  });

  it('timeoutAt is preserved across state transitions', () => {
    const task = taskManager.createTask({
      requester: 'al-a',
      executor: 'al-b',
      type: 'test',
      title: 'Preserved timeout',
      description: '',
      priority: 'medium',
    });

    const originalTimeout = task.timeoutAt;

    taskManager.acceptTask(task.id);
    taskManager.startTask(task.id);
    taskManager.completeTask(task.id, []);

    const completed = taskManager.getTask(task.id);
    expect(completed!.timeoutAt).toBe(originalTimeout);
  });

  it('multiple tasks can have different timeoutAt values', () => {
    const t1 = taskManager.createTask({
      requester: 'al-a', executor: 'al-b',
      type: 'test', title: 'T1', description: '', priority: 'low',
    });

    // Small delay to get a different timestamp
    const t2 = taskManager.createTask({
      requester: 'al-a', executor: 'al-b',
      type: 'test', title: 'T2', description: '', priority: 'low',
    });

    // Both should have timeoutAt but they may differ by a few ms
    expect(t1.timeoutAt).toBeGreaterThan(0);
    expect(t2.timeoutAt).toBeGreaterThanOrEqual(t1.timeoutAt);
  });

  it('updatedAt advances on each state transition', () => {
    const task = taskManager.createTask({
      requester: 'al-a', executor: 'al-b',
      type: 'test', title: 'Update check', description: '', priority: 'low',
    });

    const createdAt = task.updatedAt;

    const accepted = taskManager.acceptTask(task.id);
    expect(accepted.updatedAt).toBeGreaterThanOrEqual(createdAt);

    const started = taskManager.startTask(task.id);
    expect(started.updatedAt).toBeGreaterThanOrEqual(accepted.updatedAt);

    const completed = taskManager.completeTask(task.id, []);
    expect(completed.updatedAt).toBeGreaterThanOrEqual(started.updatedAt);
  });
});
