// ESLint config (flat config), run from the repo root by `npm run lint`.
// It lives in tools/lint with its own node_modules: typescript-eslint needs the
// TypeScript 6 API, while the root builds and type checks with TypeScript 7.
//
// The type-aware rules apply only to the files of the tsconfigs below. A file
// outside every tsconfig would stop the whole run, so those rules are scoped
// with `files`, not by ignoring the files that fall outside.
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Files covered by packages/*\/tsconfig.json or tsconfig.test.json */
const TYPED_FILES = ['packages/*/src/**/*.ts', 'packages/*/tests/**/*.ts', 'tests/**/*.ts'];

const TEST_FILES = ['packages/*/tests/**/*.ts', 'tests/**/*.ts'];

export default tseslint.config(
  {
    basePath: ROOT,
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'coverage/**',
      'web-ext-artifacts/**',
      '.local/**',
      'tools/lint/**',
    ],
  },
  { basePath: ROOT, ...js.configs.recommended },
  ...tseslint.configs.recommended.map((config) => ({ basePath: ROOT, ...config })),
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    basePath: ROOT,
    ...config,
    files: TYPED_FILES,
  })),
  {
    basePath: ROOT,
    files: TYPED_FILES,
    languageOptions: {
      parserOptions: {
        project: ['./packages/*/tsconfig.json', './tsconfig.test.json'],
        tsconfigRootDir: ROOT,
      },
    },
  },
  {
    // scripts/*.mjs and the config files run on Node
    basePath: ROOT,
    files: ['**/*.{js,mjs,cjs,mts}'],
    languageOptions: { globals: globals.node },
  },
  {
    // Code complexity. Warnings only, so they show the hot spots without
    // failing CI.
    basePath: ROOT,
    rules: {
      complexity: ['warn', 10],
      'max-depth': ['warn', 4],
      'max-nested-callbacks': ['warn', 3],
      'max-params': ['warn', 4],
      'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // describe / it nest callbacks and grow long by design
    basePath: ROOT,
    files: TEST_FILES,
    rules: {
      'max-nested-callbacks': 'off',
      'max-lines-per-function': 'off',
    },
  },
);
