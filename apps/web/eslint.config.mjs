import nextConfig from 'eslint-config-next/core-web-vitals';

/**
 * Flat configuration for apps/web (ESLint 9).
 *
 * Replaces the legacy `.eslintrc.js`, which cannot load `next/core-web-vitals`
 * under eslint-config-next@16 — that export is a flat-config array, and the
 * legacy loader crashes on it ("Converting circular structure to JSON"). The
 * intent of the old file is preserved exactly:
 *
 *   - `extends: ['next/core-web-vitals']`  -> spread of the package's flat export;
 *   - `rules: { '@next/next/no-html-link-for-pages': 'off' }` -> same rule, same
 *     severity, carried over verbatim.
 *
 * Ignores cover only generated/build output — application source is not
 * excluded. No rule is disabled beyond what the repository already disabled.
 */
export default [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'out/**',
      'next-env.d.ts',
      '*.tsbuildinfo',
    ],
  },
  ...nextConfig,
  {
    rules: {
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
  {
    // This config file itself: Flat Config REQUIRES an anonymous `export
    // default [...]`, so the import rule that forbids anonymous default
    // exports cannot apply here. Last on purpose: later blocks win in Flat
    // Config, and the Next.js preset sets this rule for source files.
    // Scoped to this file only — application linting is untouched.
    files: ['eslint.config.mjs'],
    rules: {
      'import/no-anonymous-default-export': 'off',
    },
  },
];
