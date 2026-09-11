// Single eslint entry for trunk and for `eslint .` inside apps/api and packages/db.
// apps/mobile keeps its own eslint.config.js because `expo lint` requires one in the app root;
// this file extends it so trunk lints the app with the same rules.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

import mobile from './apps/mobile/eslint.config.js';

export default defineConfig([
  { ignores: ['packages/db/drizzle/**'] },
  {
    files: ['apps/mobile/**'],
    extends: [mobile],
    // The Expo config resolves `@/*` through the tsconfig in the cwd; from the root, name it.
    settings: { 'import/resolver': { typescript: { project: 'apps/mobile/tsconfig.json' } } },
  },
  {
    files: ['apps/api/**', 'packages/**'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  { files: ['*.mjs'], extends: [js.configs.recommended] },
  {
    files: ['.trunk/configs/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: 'commonjs' },
  },
]);
