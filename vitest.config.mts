import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Test layout
 *
 *   packages/<pkg>/tests/**\/*.test.ts  unit tests of one workspace
 *   tests/contract/**\/*.test.ts        contracts spanning several packages
 *   tests/scripts/**\/*.test.ts         scripts/*.mjs (install / uninstall)
 *
 * Tests live outside `src/`, so each package's tsconfig (`include: ["src"]`,
 * `rootDir: "src"`) never compiles them into `dist/`. Vitest transpiles them
 * on the fly; they are not type-checked by `npm run build`.
 *
 * packages/extension is not a project here: its sources are classic scripts
 * (no import/export, browser globals, loaded in order by manifest.json), so
 * background.ts / content.ts cannot be imported by a test. Extension-side
 * contracts are checked from tests/contract instead, by loading the
 * dependency-free action-map.ts or by reading the extension sources.
 */

/** Resolve the shared package to its sources, so tests do not need a build. */
const sharedSrc = fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url));
const sharedNodeSrc = fileURLToPath(new URL('./packages/shared/src/node/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@kitsune-mcp\/shared\/node$/, replacement: sharedNodeSrc },
      { find: /^@kitsune-mcp\/shared$/, replacement: sharedSrc },
    ],
  },
  test: {
    // forks, not threads: tests/setup/isolate-home.ts changes HOME/USERPROFILE
    // for os.homedir(), which worker threads would not see.
    pool: 'forks',
    setupFiles: ['./tests/setup/isolate-home.ts'],
    globalSetup: ['./tests/setup/real-home-watch.ts'],
    env: {
      // Keep the Native Host logger away from ~/.kitsune-mcp/logs.
      FOX_NATIVE_HOST_LOG: 'off',
    },
    projects: [
      { extends: true, test: { name: 'shared', include: ['packages/shared/tests/**/*.test.ts'] } },
      { extends: true, test: { name: 'mcp-server', include: ['packages/mcp-server/tests/**/*.test.ts'] } },
      { extends: true, test: { name: 'native-host', include: ['packages/native-host/tests/**/*.test.ts'] } },
      { extends: true, test: { name: 'contract', include: ['tests/contract/**/*.test.ts'] } },
      { extends: true, test: { name: 'scripts', include: ['tests/scripts/**/*.test.ts'] } },
      // Real processes and a real (headless) Firefox; `npm run test:e2e`.
      // Excluded from `npm test` by its --project filter.
      { extends: true, test: { name: 'e2e', include: ['tests/e2e/**/*.e2e.test.ts'] } },
    ],
  },
});
