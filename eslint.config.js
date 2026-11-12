import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'openapi/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Architectural boundary: domain/application code may not reach into
    // provider implementations or provider SDKs.
    files: ['src/contracts/**/*.ts', 'src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/providers/**', '../providers/*', '../../providers/*'],
              message:
                'Layering violation: core/ and contracts/ must not import provider implementations. Depend on the ProviderAdapter port instead.',
            },
            {
              group: ['openai', '@anthropic-ai/**', '@google/**', 'cohere-ai'],
              message:
                'Layering violation: provider SDKs may only be imported inside src/providers/*.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
