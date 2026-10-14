/**
 * The guard handlers.ts works with, for tests that call the tool handlers.
 *
 * There is no setter for the getSafetyGuard() singleton, so each such test
 * file mocks safety/guard.js to return `slot.current` when it is set:
 *
 *   const testGuard = vi.hoisted(() => ({ current: null as SafetyGuard | null }));
 *   vi.mock('../src/safety/guard.js', async (importOriginal) => {
 *     const actual = await importOriginal<typeof import('../src/safety/guard.js')>();
 *     return { ...actual, getSafetyGuard: () => testGuard.current ?? actual.getSafetyGuard() };
 *   });
 *
 * (vi.mock is hoisted only within the test file itself, so it cannot live here.)
 */

import { DEFAULT_CONFIG, type LoadedSafetyConfig } from '../../src/safety/config.js';
import { SafetyGuard } from '../../src/safety/guard.js';

/** Where a test file's mock of safety/guard.js looks for the guard to hand out. */
export interface GuardSlot {
  current: SafetyGuard | null;
}

/**
 * A guard with the default policy, without the audit log unless `overrides`
 * turns it on, put in `slot` for the handlers; the guard.
 */
export function useGuard(slot: GuardSlot, overrides: Partial<LoadedSafetyConfig> = {}): SafetyGuard {
  const guard = new SafetyGuard({ ...DEFAULT_CONFIG, auditLog: false, ...overrides });
  slot.current = guard;

  return guard;
}
