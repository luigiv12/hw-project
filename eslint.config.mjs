import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import next from '@next/eslint-plugin-next';

/**
 * One flat config for the workspace, so every package is held to the same rules
 * and there is a single place to change them.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/drizzle/**',
      '**/*.js',
      '**/*.mjs',
      // Config files sit outside every tsconfig include, so the type-aware
      // rules have no project to resolve them against.
      '**/*.config.ts',
      '**/*.config.mts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      /**
       * An unawaited promise in this codebase is usually a transaction nobody
       * waits for, so these are errors rather than warnings.
       */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Domain values cross the wire as strings and arrive as unknown; casting
      // them is the normal case here, not a smell.
      '@typescript-eslint/no-explicit-any': 'off',
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // NestJS decorators legitimately reference types only used as metadata.
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, '@next/next': next },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...next.configs.recommended.rules,
    },
  },

  // Tests assert on loosely typed response bodies and mock freely.
  {
    files: [
      '**/*.test.{ts,tsx}',
      '**/*.spec.ts',
      '**/*.e2e-spec.ts',
      '**/test/**',
    ],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);
