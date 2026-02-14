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
        // Enforce DI: prevent direct construction of service classes that should be resolved from the DI container.
        // These classes have interfaces (IProcessMonitor, IProcessSpawner, etc.) and should be injected, not constructed.
        {
          selector: "NewExpression[callee.name='ProcessMonitor']",
          message: 'Use IProcessMonitor from DI container instead of new ProcessMonitor(). Direct construction prevents mocking in tests.',
        },
        {
          selector: "NewExpression[callee.name='DefaultProcessSpawner']",
          message: 'Use IProcessSpawner from DI container instead of new DefaultProcessSpawner(). Direct construction prevents mocking in tests.',
        },
        {
          selector: "NewExpression[callee.name='CopilotCliRunner']",
          message: 'Use ICopilotRunner from DI container instead of new CopilotCliRunner(). Direct construction prevents mocking in tests.',
        },
        {
          selector: "NewExpression[callee.name='PlanPersistence']",
          message: 'Use INodePersistence from DI container instead of new PlanPersistence(). Direct construction prevents mocking in tests.',
        },
        {
          selector: "NewExpression[callee.name='Logger'][parent.type!=\"ExportNamedDeclaration\"]",
          message: 'Use ILogger from DI container instead of new Logger(). Use Logger.for() or DI-resolved ILogger.',
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
  // Composition root + class definition files may construct services directly
  {
    files: [
      'src/composition.ts',
      'src/compositionTest.ts',
      'src/extension.ts',
      'src/core/planInitialization.ts',
      'src/plan/runner.ts',
      'src/process/processMonitor.ts',
      'src/plan/persistence.ts',
      'src/core/logger.ts',
      'src/agent/copilotCliRunner.ts',
    ],
    rules: {
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
