/**
 * A-KM-07: the real-browser tests were skipped whenever Firefox could not be
 * launched, on CI as well, so `npm test` passed without running them.
 */

import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIREFOX_PROJECTS, testsNotRun } from '../../scripts/test-firefox.mjs';
import { REQUIRE_FIREFOX_ENV, isCi, requiresFirefox, skipOrFailWithoutFirefox } from './helpers/real-firefox.js';

describe('real-browser tests without Firefox', () => {
  it('CI is set unless empty, 0 or false (any case)', () => {
    expect(isCi({ CI: 'true' })).toBe(true);
    expect(isCi({ CI: '1' })).toBe(true);
    for (const value of [undefined, '', ' ', '0', 'false', 'FALSE']) {
      expect(isCi({ CI: value }), String(value)).toBe(false);
    }
  });

  it('fails on CI with the launch error, and lets the tests be skipped elsewhere', () => {
    const launchError = new Error('Executable does not exist');
    expect(() => skipOrFailWithoutFirefox(launchError, { CI: 'true' })).toThrow(/CI is set.*Executable does not exist/);
    expect(() => skipOrFailWithoutFirefox(launchError, {})).not.toThrow();
  });

  // D-KM-04: without a CI that sets `CI`, nothing made the tests run.
  it('KITSUNE_REQUIRE_FIREFOX makes them required without CI, by the same rule as CI', () => {
    expect(REQUIRE_FIREFOX_ENV).toBe('KITSUNE_REQUIRE_FIREFOX');
    expect(requiresFirefox({ KITSUNE_REQUIRE_FIREFOX: '1' })).toBe(true);
    expect(requiresFirefox({ CI: 'true' })).toBe(true);
    for (const value of [undefined, '', '0', 'false']) {
      expect(requiresFirefox({ KITSUNE_REQUIRE_FIREFOX: value }), String(value)).toBe(false);
    }
    const launchError = new Error('Executable does not exist');
    expect(() => skipOrFailWithoutFirefox(launchError, { KITSUNE_REQUIRE_FIREFOX: '1' }))
      .toThrow(/KITSUNE_REQUIRE_FIREFOX is set.*Executable does not exist/);
  });

  it('npm run test:firefox sets KITSUNE_REQUIRE_FIREFOX for the real-browser projects', () => {
    const scripts = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')).scripts;
    expect(scripts['test:firefox']).toBe('node scripts/test-firefox.mjs');
    const config = fs.readFileSync(new URL('../../vitest.config.mts', import.meta.url), 'utf-8');
    for (const name of FIREFOX_PROJECTS) expect(config).toContain(`name: '${name}'`);
    const script = fs.readFileSync(new URL('../../scripts/test-firefox.mjs', import.meta.url), 'utf-8');
    expect(script).toContain(`${REQUIRE_FIREFOX_ENV}: '1'`);
  });

  it('test:firefox fails when a real-browser test did not run, or none ran', () => {
    const file = (...statuses: string[]) => ({
      assertionResults: statuses.map((status, i) => ({ status, fullName: `t${i}` })),
    });
    expect(testsNotRun({ testResults: [file('passed', 'failed')] })).toEqual({ empty: false, notRun: [] });
    expect(testsNotRun({ testResults: [file('passed'), file('skipped', 'todo', 'pending')] })).toEqual({
      empty: false,
      notRun: ['t0 (skipped)', 't1 (todo)', 't2 (pending)'],
    });
    expect(testsNotRun({ testResults: [] })).toEqual({ empty: true, notRun: [] });
  });
});
