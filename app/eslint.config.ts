import js from '@eslint/js'
import solid from 'eslint-plugin-solid'
import tseslint from 'typescript-eslint'
import unocss from '@unocss/eslint-config/flat'

export default tseslint.config(
  // Without this, `eslint .` walks the generated BAML client and the build
  // output and reports ~14k errors in code nobody writes by hand — which is
  // why this config went unused. Keep it first; flat config applies globally
  // only when `ignores` is the sole key in the object.
  {
    ignores: [
      'baml_client/**',
      '.output/**',
      '.vinxi/**',
      'dist/**',
      'coverage/**',
      'node_modules/**',
      // Browser-e2e run output. Gitignored, which is NOT enough — eslint does
      // not read `.gitignore`, so a directory only git knows to skip is still
      // linted as source. Playwright's HTML reporter copies its own minified
      // trace-viewer bundles in here, and `pnpm lint` reported ~200 no-undef /
      // no-unused-expressions errors inside them. Repointing that reporter out
      // of `app/playwright-report/` (#280) moved the directory; it did not stop
      // eslint walking it, and the trace viewer is only copied once a run has a
      // FAILURE — so the break appears exactly when someone is already
      // debugging a red run.
      'e2e-browser/.runtime/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    ...solid.configs['flat/typescript'],
  },
  unocss,
  {
    files: [
      'src/**/*.ts',
      'src/**/*.tsx',
      'evals/**/*.ts',
      'e2e/**/*.ts',
      'e2e-browser/**/*.ts',
      'eslint.config.ts',
    ],
    rules: {
      'prefer-const': 'warn',
      'no-constant-binary-expression': 'error',
      // Zero-width spaces are load-bearing inside JSDoc: they keep a literal
      // `*/` in prose from closing the comment block. Only flag them in code.
      'no-irregular-whitespace': ['error', { skipComments: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          varsIgnorePattern: '^_|^T$',
          argsIgnorePattern: '^_',
        },
      ],
      // Warn, not error: `any` is load-bearing at the BAML/MCP boundaries where
      // payloads are genuinely untyped until parsed. Flagging it is useful;
      // blocking a merge on it is not.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Tests reach into internals and build partial fixtures on purpose. The
    // e2e suites do the same, and additionally have to describe a generated
    // client's untyped options field (e2e/lib/baml-route.ts).
    files: ['src/__tests__/**/*.{ts,tsx}', 'e2e/**/*.ts', 'e2e-browser/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
