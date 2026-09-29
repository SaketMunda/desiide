import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/node_modules/', '**/dist/', '**/coverage/', '**/.vscode-test/', 'editor/']),
  eslint.configs.recommended,
  tseslint.configs.strict,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportDeclaration[source.value='zod'] > :matches(ImportSpecifier[imported.name='z'], ImportDefaultSpecifier)",
          message: "Use `import * as z from 'zod'`: the named `z` defeats tree-shaking (~450 KB).",
        },
      ],
    },
  },
  {
    // Plain-JS build and test scripts run in Node.
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // The VS Code integration suite must be CommonJS (loaded by the extension host via require).
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  prettier,
);
