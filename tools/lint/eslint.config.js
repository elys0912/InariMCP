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
  {
    // Tests poke at loosely typed fixtures and mocks on purpose; the type-aware
    // rules below are kept for src, which is what the store review reads.
    basePath: ROOT,
    files: TEST_FILES,
    rules: {
      // JSON.parse results and mock call arguments are read without a schema
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // mock.calls[0][0].field and parsed messages are read field by field
      '@typescript-eslint/no-unsafe-member-access': 'off',
      // parsed fixtures go straight into expect() and the code under test
      '@typescript-eslint/no-unsafe-argument': 'off',
      // stub implementations hand back loosely typed fixtures
      '@typescript-eslint/no-unsafe-return': 'off',
      // functions pulled out of mocks and fixtures are called as is
      '@typescript-eslint/no-unsafe-call': 'off',
      // async stubs stand in for async APIs without awaiting anything
      '@typescript-eslint/require-await': 'off',
      // expect(obj.method) refers to a mocked method without calling it
      '@typescript-eslint/unbound-method': 'off',
      // stubs throw plain objects to mimic what browser APIs reject with
      '@typescript-eslint/only-throw-error': 'off',
      // TS 6 (lint) and TS 7 (build) can disagree here; src keeps the rule
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
);
