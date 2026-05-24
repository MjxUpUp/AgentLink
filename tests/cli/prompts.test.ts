import { describe, it, expect } from 'vitest';
import { parseCapabilities, getAutoInitOptions } from '../../src/cli/prompts.js';

describe('prompts', () => {
  it('parseCapabilities splits and trims comma-separated string', () => {
    expect(parseCapabilities('code-review, testing ,deploy')).toEqual([
      'code-review', 'testing', 'deploy',
    ]);
  });

  it('parseCapabilities returns empty for empty string', () => {
    expect(parseCapabilities('')).toEqual([]);
    expect(parseCapabilities('  ')).toEqual([]);
  });

  it('getAutoInitOptions returns defaults with hostname', () => {
    const opts = getAutoInitOptions();
    expect(opts.name.length).toBeGreaterThan(0);
    expect(opts.type).toBe('agent');
    expect(opts.capabilities).toBe('');
  });
});
