// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'dist/**', 'generated/**', 'src/generated/**', 'coverage/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
      // Tenancy invariant: raw Prisma client never leaves src/infra/db.
      // All data access goes through getTenantDb()/platformDb/runInTenant.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/generated/prisma', '**/generated/prisma/**'],
              message:
                'Import the Prisma client only inside src/infra/db — use getTenantDb()/platformDb elsewhere (RLS tenancy invariant).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/infra/db/**/*.ts', 'scripts/**/*.ts', 'prisma/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
);
