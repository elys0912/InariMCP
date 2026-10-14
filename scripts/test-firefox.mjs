#!/usr/bin/env node
/**
 * Runs the tests that drive a real headless Firefox (the vitest projects
 * mcp-server-firefox and contract-firefox) and fails unless every one of
 * them ran: a launch failure fails instead of skipping (INARI_REQUIRE_FIREFOX,
 * tests/contract/helpers/real-firefox.ts), and a test that was skipped all the
 * same fails the run here.
 *
 *   npm run test:firefox
 *
 * `npm test` alone lets these tests be skipped where Firefox cannot be
 * launched (unless CI is set).
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FIREFOX_PROJECTS = ['mcp-server-firefox', 'contract-firefox'];
const RAN = new Set(['passed', 'failed']);

/**
 * Names of the tests in a vitest JSON report that did not run (skipped,
 * todo, pending), and whether the report has no test at all.
 *
 * @param {{ numTotalTests?: number, testResults?: { assertionResults?: { status: string, fullName: string }[] }[] }} report
 * @returns {{ empty: boolean, notRun: string[] }}
 */
export function testsNotRun(report) {
  const results = (report.testResults ?? []).flatMap((file) => file.assertionResults ?? []);
  return {
    empty: results.length === 0,
    notRun: results.filter((r) => !RAN.has(r.status)).map((r) => `${r.fullName} (${r.status})`),
  };
}

function main() {
  const vitest = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-test-firefox-'));
  const reportFile = path.join(reportDir, 'report.json');
  try {
    const run = spawnSync(
      process.execPath,
      [
        vitest,
        'run',
        ...FIREFOX_PROJECTS.map((name) => `--project=${name}`),
        '--reporter=default',
        '--reporter=json',
        `--outputFile.json=${reportFile}`,
      ],
      { stdio: 'inherit', env: { ...process.env, INARI_REQUIRE_FIREFOX: '1' } },
    );
    if (run.status !== 0) return run.status ?? 1;

    const { empty, notRun } = testsNotRun(JSON.parse(fs.readFileSync(reportFile, 'utf-8')));
    if (empty) {
      console.error(`test:firefox: no test ran in ${FIREFOX_PROJECTS.join(', ')}`);
      return 1;
    }
    if (notRun.length > 0) {
      console.error(`test:firefox: ${notRun.length} real-browser test(s) did not run:`);
      for (const name of notRun) console.error(`  ${name}`);
      return 1;
    }
    return 0;
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
