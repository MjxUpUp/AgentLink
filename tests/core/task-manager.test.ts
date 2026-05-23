import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import type { Task, TaskStatus } from '../../src/core/types.js';
import { TaskManager } from '../../src/core/task-manager.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

let tmpDir: string;
let taskManager: TaskManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlink-task-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  taskManager = new TaskManager(dbPath);
});

afterEach(() => {
  taskManager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('TaskManager', () => {
  it('should create a task with status "created"', () => {
    const task = taskManager.createTask({
      requester: 'al-agent-a',
      executor: 'al-agent-b',
      type: 'code-review',
      title: 'Review PR #42',
      description: 'Please review the changes',
      priority: 'high',
    });

    expect(task.id).toBeDefined();
    expect(task.status).toBe('created');
    expect(task.requester).toBe('al-agent-a');
    expect(task.executor).toBe('al-agent-b');
    expect(task.type).toBe('code-review');
    expect(task.title).toBe('Review PR #42');
    expect(task.priority).toBe('high');
    expect(task.artifacts).toEqual([]);
  });

  it('should accept a task (created → in_progress)', () => {
    const task = taskManager.createTask({
      requester: 'al-agent-a',
      executor: 'al-agent-b',
      type: 'code-review',
      title: 'Review',
      description: '',
      priority: 'medium',
    });

    const updated = taskManager.acceptTask(task.id);
    expect(updated.status).toBe('in_progress');
  });

  it('should reject a task (created → rejected)', () => {
    const task = taskManager.createTask({
      requester: 'al-agent-a',
      executor: 'al-agent-b',
      type: 'code-review',
      title: 'Review',
      description: '',
      priority: 'medium',
    });

    const updated = taskManager.rejectTask(task.id);
    expect(updated.status).toBe('rejected');
  });

  it('should complete a task with artifacts', () => {
    const task = taskManager.createTask({
      requester: 'al-agent-a',
      executor: 'al-agent-b',
      type: 'code-review',
      title: 'Review',
      description: '',
      priority: 'medium',
    });

    taskManager.acceptTask(task.id);

    const artifacts = [
      { type: 'text' as const, name: 'summary', content: 'LGTM' },
      { type: 'code' as const, name: 'patch.diff', content: 'diff --git ...' },
    ];

    const updated = taskManager.completeTask(task.id, artifacts);
    expect(updated.status).toBe('completed');
    expect(updated.artifacts).toHaveLength(2);
    expect(updated.artifacts[0].content).toBe('LGTM');
  });

  it('should fail a task with error', () => {
    const task = taskManager.createTask({
      requester: 'al-agent-a',
      executor: 'al-agent-b',
      type: 'code-review',
      title: 'Review',
      description: '',
      priority: 'medium',
    });

    taskManager.acceptTask(task.id);

    const updated = taskManager.failTask(task.id, 'Agent crashed');
    expect(updated.status).toBe('failed');
  });

  it('should cancel a task', () => {
    const task = taskManager.createTask({
      requester: 'al-agent-a',
      executor: 'al-agent-b',
      type: 'code-review',
      title: 'Review',
      description: '',
      priority: 'medium',
    });

    const updated = taskManager.cancelTask(task.id);
    expect(updated.status).toBe('cancelled');
  });

  it('should throw on invalid transitions', () => {
    const task = taskManager.createTask({
      requester: 'al-agent-a',
      executor: 'al-agent-b',
      type: 'code-review',
      title: 'Review',
      description: '',
      priority: 'medium',
    });

    taskManager.acceptTask(task.id);

    // Cannot reject an in_progress task
    expect(() => taskManager.rejectTask(task.id)).toThrow();

    // Cannot accept an already in_progress task
    expect(() => taskManager.acceptTask(task.id)).toThrow();
  });

  it('should not allow transitions from terminal states', () => {
    const task = taskManager.createTask({
      requester: 'al-agent-a',
      executor: 'al-agent-b',
      type: 'code-review',
      title: 'Review',
      description: '',
      priority: 'medium',
    });

    taskManager.rejectTask(task.id);

    expect(() => taskManager.acceptTask(task.id)).toThrow();
    expect(() => taskManager.completeTask(task.id, [])).toThrow();
    expect(() => taskManager.failTask(task.id, 'error')).toThrow();
  });

  it('should get a task by ID', () => {
    const created = taskManager.createTask({
      requester: 'al-agent-a',
      executor: 'al-agent-b',
      type: 'code-review',
      title: 'Review',
      description: '',
      priority: 'medium',
    });

    const found = taskManager.getTask(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.title).toBe('Review');
  });

  it('should return null for unknown task ID', () => {
    expect(taskManager.getTask('non-existent')).toBeNull();
  });

  it('should list tasks filtered by status', () => {
    const t1 = taskManager.createTask({
      requester: 'a', executor: 'b', type: 't', title: 'T1', description: '', priority: 'low',
    });
    const t2 = taskManager.createTask({
      requester: 'a', executor: 'b', type: 't', title: 'T2', description: '', priority: 'low',
    });

    taskManager.acceptTask(t1.id);

    const created = taskManager.listTasks('created');
    expect(created).toHaveLength(1);
    expect(created[0].id).toBe(t2.id);

    const inProgress = taskManager.listTasks('in_progress');
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0].id).toBe(t1.id);
  });

  it('should list all tasks when no filter', () => {
    taskManager.createTask({
      requester: 'a', executor: 'b', type: 't', title: 'T1', description: '', priority: 'low',
    });
    taskManager.createTask({
      requester: 'a', executor: 'b', type: 't', title: 'T2', description: '', priority: 'low',
    });

    const all = taskManager.listTasks();
    expect(all).toHaveLength(2);
  });

  it('should update progress for in_progress tasks', () => {
    const task = taskManager.createTask({
      requester: 'a', executor: 'b', type: 't', title: 'T1', description: '', priority: 'low',
    });

    taskManager.acceptTask(task.id);

    // progress is tracked via the task's updated_at timestamp
    const updated = taskManager.updateProgress(task.id, { percent: 50, message: 'halfway' });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('in_progress');
  });

  it('should throw when updating progress of non in_progress task', () => {
    const task = taskManager.createTask({
      requester: 'a', executor: 'b', type: 't', title: 'T1', description: '', priority: 'low',
    });

    expect(() => taskManager.updateProgress(task.id, { percent: 50 })).toThrow();
  });
});
