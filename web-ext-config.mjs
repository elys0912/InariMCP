// web-ext reads this file from the current working directory, so run web-ext
// from the repository root.
export default {
  sourceDir: 'packages/extension',
  artifactsDir: 'web-ext-artifacts',
  // Paths are relative to sourceDir. Ship only what manifest.json loads, and
  // dist/LICENSE (scripts/build-extension.mjs copies it there).
  ignoreFiles: [
    'src',
    'package.json',
    'tsconfig.json',
    '*.tsbuildinfo',
    '**/*.map',
    '**/*.d.ts',
    'icons/.gitkeep',
  ],
};
