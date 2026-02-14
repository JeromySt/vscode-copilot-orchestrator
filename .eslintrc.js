module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
  ],
  rules: {
    '@typescript-eslint/naming-convention': 'off',
    'semi': ['error', 'always'],
    'curly': 'warn',
    'eqeqeq': 'warn',
    'no-throw-literal': 'warn',
    'no-unused-vars': 'off',
    // Enforce DI patterns: prevent direct use of child_process and fs
    // outside of approved abstraction layers. Use IProcessSpawner, IFileSystem,
    // or the git/core module instead.
    'no-restricted-imports': ['error', {
      paths: [
        {
          name: 'child_process',
          message: 'Use IProcessSpawner (src/interfaces/IProcessSpawner.ts) instead of importing child_process directly. Only src/interfaces/IProcessSpawner.ts and src/git/core/executor.ts may import child_process.'
        },
      ],
    }],
  },
  overrides: [
    // Files allowed to import child_process directly
    {
      files: [
        'src/interfaces/IProcessSpawner.ts',
        'src/git/core/executor.ts',
        'src/process/processHelpers.ts',
      ],
      rules: {
        'no-restricted-imports': 'off',
      },
    },
    // Test files can import anything
    {
      files: ['src/test/**'],
      rules: {
        'no-restricted-imports': 'off',
      },
    },
  ],
  ignorePatterns: ['out/**', 'dist/**', 'node_modules/**', '**/*.d.ts'],
  env: {
    node: true,
    es2022: true,
  },
};
