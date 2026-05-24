/**
 * Centralized port allocator to avoid collisions across integration tests.
 *
 * Uses random ports in a high-but-safe range so that parallel test files
 * (via vitest fileParallelism) don't collide.
 */

const MIN_PORT = 32000;
const MAX_PORT = 49000;
const RANGE = MAX_PORT - MIN_PORT;

let counter = 0;

export function nextPort(): number {
  counter++;
  const base = MIN_PORT + (Math.floor(Math.random() * RANGE) + counter * 377) % RANGE;
  return base;
}

export function resetPortCounter(): void {
  counter = 0;
}
