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
  },
  ignorePatterns: ['out/**', 'dist/**', 'node_modules/**', '**/*.d.ts'],
  env: {
    node: true,
    es2022: true,
  },
};
