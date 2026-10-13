import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat configuration for apps/api (ESLint 9).
 *
 * Ports the semantics of the legacy `.eslintrc.js` one-for-one:
 *
 *   - `extends: ['eslint:recommended']`            -> js.configs.recommended
 *   - `plugin:@typescript-eslint/recommended`     -> tseslint.configs.recommended
 *     (which carries `tseslint.configs.eslintRecommended` — the same core-rule
 *     switches-off-for-TypeScript that the legacy `eslint-recommended`
 *     extension applied; without them, core rules false-positive on TS)
 *   - `parser: '@typescript-eslint/parser'` +
 *     `parserOptions: { ecmaVersion: 2020, sourceType: 'module' }` -> same
 *     parser and language options (the legacy `project` option is dropped:
 *     no enabled rule is type-aware, and `tsconfig.eslint.json` excludes
 *     `test/**`, which must stay lintable)
 *   - `env: { node, jest }`                       -> globals.node + globals.jest
 *   - `ignorePatterns: ['dist','coverage','node_modules']` plus the verified
 *     generated Prisma client directory `src/generated` (the ONLY generated
 *     area: ~4,387 findings were artifacts of linting it)
 *   - the CMS/filters/main override (no-explicit-any off, `^_` unused-var
 *     pattern) is preserved verbatim below.
 *
 * The lint script is read-only: no `--fix` in the normal command.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      // Generated Prisma client output (verified: src/generated/{core,cms,...}-client).
      // Generated only — handwritten code and tests remain linted.
      'src/generated/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.eslintRecommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
  },
  {
    files: [
      'src/modules/cms/**/*.ts',
      'src/common/filters/**/*.ts',
      'src/main.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
