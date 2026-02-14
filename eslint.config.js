const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        NodeJS: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      'semi': ['error', 'always'],
      'curly': 'warn',
      'eqeqeq': 'warn',
      'no-throw-literal': 'warn',
      'no-unused-vars': 'off',
      // Enforce DI: prevent direct child_process imports outside approved files
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: 'child_process',
            message: 'Use IProcessSpawner instead. Only src/interfaces/IProcessSpawner.ts (DefaultProcessSpawner) may import child_process directly.',
          },
        ],
      }],
      // Also catch require('child_process') and require('fs') calls
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.name='require'][arguments.0.value='child_process']",
          message: 'Use IProcessSpawner instead of require("child_process"). Only DefaultProcessSpawner in IProcessSpawner.ts may access child_process.',
        },
        {
          selector: "CallExpression[callee.name='require'][arguments.0.value='fs']",
          message: 'Consider using IFileSystem interface for testability. Direct fs require() should be in core utility modules only.',
        },
      ],
    },
  },
  // Only IProcessSpawner.ts may import child_process (it contains DefaultProcessSpawner)
  {
    files: [
      'src/interfaces/IProcessSpawner.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  // Test files can import anything
  {
    files: ['src/test/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  // Ignore patterns
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', '**/*.d.ts', '**/*.js', '!eslint.config.js'],
  },
];
