// web-ext reads this file from the current working directory, so run web-ext
// from the repository root (see docs/release.md).
export default {
  sourceDir: 'packages/extension',
  artifactsDir: 'web-ext-artifacts',
  // Paths are relative to sourceDir. Ship only what manifest.json loads.
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
