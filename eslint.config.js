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
        // These classes have interfaces and should be injected, not constructed directly.
        // == Process / Spawning ==
        {
          selector: "NewExpression[callee.name='ProcessMonitor']",
          message: 'Use IProcessMonitor from DI container instead of new ProcessMonitor().',
        },
        {
          selector: "NewExpression[callee.name='DefaultProcessSpawner']",
          message: 'Use IProcessSpawner from DI container instead of new DefaultProcessSpawner().',
        },
        // == Agent ==
        {
          selector: "NewExpression[callee.name='CopilotCliRunner']",
          message: 'Use ICopilotRunner from DI container instead of new CopilotCliRunner().',
        },
        {
          selector: "NewExpression[callee.name='AgentDelegator']",
          message: 'Resolve AgentDelegator through DI instead of direct construction.',
        },
        // == Plan ==
        {
          selector: "NewExpression[callee.name='PlanPersistence']",
          message: 'Use INodePersistence from DI container instead of new PlanPersistence().',
        },
        {
          selector: "NewExpression[callee.name='DefaultJobExecutor']",
          message: 'Use INodeExecutor/JobExecutor from DI container instead of new DefaultJobExecutor().',
        },
        {
          selector: "NewExpression[callee.name='PlanStateMachine']",
          message: 'Use INodeStateMachine from DI container instead of new PlanStateMachine().',
        },
        {
          selector: "NewExpression[callee.name='DefaultEvidenceValidator']",
          message: 'Use IEvidenceValidator from DI container instead of new DefaultEvidenceValidator().',
        },
        // == Core ==
        {
          selector: "NewExpression[callee.name='Logger']",
          message: 'Use ILogger from DI container instead of new Logger(). Use Logger.for() or DI-resolved ILogger.',
        },
        {
          selector: "NewExpression[callee.name='GlobalCapacityManager']",
          message: 'Resolve GlobalCapacityManager through DI instead of direct construction.',
        },
        {
          selector: "NewExpression[callee.name='PulseEmitter']",
          message: 'Use IPulseEmitter from DI container instead of new PulseEmitter().',
        },
        {
          selector: "NewExpression[callee.name='PlanConfigManager']",
          message: 'Resolve PlanConfigManager through DI instead of direct construction.',
        },
        // == MCP ==
        {
          selector: "NewExpression[callee.name='McpHandler']",
          message: 'Use IMcpRequestRouter from DI container instead of new McpHandler().',
        },
        {
          selector: "NewExpression[callee.name='StdioMcpServerManager']",
          message: 'Use IMcpManager from DI container instead of new StdioMcpServerManager().',
        },
        // == Environment ==
        {
          selector: "NewExpression[callee.name='DefaultEnvironment']",
          message: 'Use IEnvironment from DI container instead of new DefaultEnvironment().',
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
  // ONLY the composition root may construct service classes directly.
  // Class definition files should NOT construct other services — they receive
  // dependencies through their constructors (DI pattern).
  {
    files: [
      'src/composition.ts',
      'src/compositionTest.ts',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  // TODO: These files currently violate DI but are exempted temporarily.
  // Each should be refactored to accept dependencies via constructor injection.
  // Track progress in the "Eliminate All Code Duplication" plan.
  {
    files: [
      'src/extension.ts',
      'src/core/planInitialization.ts',
      'src/core/logger.ts',
      'src/core/globalCapacity.ts',
      'src/core/pulse.ts',
      'src/core/powerManager.ts',
      'src/plan/runner.ts',
      'src/plan/executor.ts',
      'src/plan/persistence.ts',
      'src/plan/stateMachine.ts',
      'src/plan/evidenceValidator.ts',
      'src/plan/configManager.ts',
      'src/plan/planLifecycle.ts',
      'src/plan/executionEngine.ts',
      'src/plan/executionPump.ts',
      'src/plan/nodeManager.ts',
      'src/plan/logFileHelper.ts',
      'src/agent/copilotCliRunner.ts',
      'src/agent/agentDelegator.ts',
      'src/process/processMonitor.ts',
      'src/mcp/handler.ts',
      'src/mcp/mcpServerManager.ts',
      'src/interfaces/IEnvironment.ts',
    ],
    rules: {
      'no-restricted-syntax': ['warn',
        // These are warnings (not errors) to track DI migration progress.
        // Once a file is refactored to use DI, remove it from this list
        // and it will get the full error-level enforcement.
      ],
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
