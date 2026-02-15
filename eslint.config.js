const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

// ═══════════════════════════════════════════════════════════════════
// Shared no-restricted-syntax selectors.
// Extracted into arrays so they can be composed per config block
// without duplication. In ESLint flat config the LAST matching
// config block wins for a given rule key, so every block that sets
// `no-restricted-syntax` must include the full set of selectors it
// needs (including inherited ones).
// ═══════════════════════════════════════════════════════════════════

// ── DI Enforcement ────────────────────────────────────────────────
// Prevent direct require() of low-level modules and direct construction
// of service classes that should be resolved from the DI container.
const diSelectors = [
  // -- require() restrictions --
  {
    selector: "CallExpression[callee.name='require'][arguments.0.value='child_process']",
    message: 'Use IProcessSpawner instead of require("child_process"). Only DefaultProcessSpawner in IProcessSpawner.ts may access child_process.',
  },
  {
    selector: "CallExpression[callee.name='require'][arguments.0.value='fs']",
    message: 'Consider using IFileSystem interface for testability. Direct fs require() should be in core utility modules only.',
  },
  // -- Process / Spawning --
  {
    selector: "NewExpression[callee.name='ProcessMonitor']",
    message: 'Use IProcessMonitor from DI container instead of new ProcessMonitor().',
  },
  {
    selector: "NewExpression[callee.name='DefaultProcessSpawner']",
    message: 'Use IProcessSpawner from DI container instead of new DefaultProcessSpawner().',
  },
  // -- Agent --
  {
    selector: "NewExpression[callee.name='CopilotCliRunner']",
    message: 'Use ICopilotRunner from DI container instead of new CopilotCliRunner().',
  },
  {
    selector: "NewExpression[callee.name='AgentDelegator']",
    message: 'Resolve AgentDelegator through DI instead of direct construction.',
  },
  // -- Plan --
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
  // -- Core --
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
  // -- MCP --
  {
    selector: "NewExpression[callee.name='McpHandler']",
    message: 'Use IMcpRequestRouter from DI container instead of new McpHandler().',
  },
  {
    selector: "NewExpression[callee.name='StdioMcpServerManager']",
    message: 'Use IMcpManager from DI container instead of new StdioMcpServerManager().',
  },
  // -- Environment --
  {
    selector: "NewExpression[callee.name='DefaultEnvironment']",
    message: 'Use IEnvironment from DI container instead of new DefaultEnvironment().',
  },
];

// ── UI Architecture Enforcement ───────────────────────────────────
// Require EventBus pub/sub for dynamic updates; ban timers & polling.
// Server-side (panels) should use IPulseEmitter from DI.
// Client-side (webview controls) should subscribe to EventBus topics.
const uiEventBusSelectors = [
  {
    selector: "CallExpression[callee.name='setInterval']",
    message: 'Use EventBus PULSE subscription (client-side) or IPulseEmitter (server-side) instead of setInterval(). See src/ui/webview/eventBus.ts.',
  },
  {
    selector: "NewExpression[callee.name='MutationObserver']",
    message: 'Use EventBus events instead of MutationObserver. Controls should extend SubscribableControl and react to named topics.',
  },
];

// ── Webview Creation Restrictions ─────────────────────────────────
// New webview panels / view providers must go through the existing
// panel infrastructure (PlanDetailPanel, NodeDetailPanel, PlansViewProvider).
// Ad-hoc createWebviewPanel or registerWebviewViewProvider calls are banned.
const webviewCreationSelectors = [
  {
    selector: "CallExpression[callee.property.name='createWebviewPanel']",
    message: 'Do not create ad-hoc webview panels. Extend the existing panel infrastructure in src/ui/panels/. All panels must use EventBus pub/sub for dynamic updates.',
  },
  {
    selector: "CallExpression[callee.property.name='registerWebviewViewProvider']",
    message: 'Do not register ad-hoc webview view providers. Use the existing PlansViewProvider pattern or coordinate with the team before adding a new provider.',
  },
];

module.exports = [
  // ── 1. Base rules for all source files ──────────────────────────
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
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: 'child_process',
            message: 'Use IProcessSpawner instead. Only src/interfaces/IProcessSpawner.ts (DefaultProcessSpawner) may import child_process directly.',
          },
        ],
        patterns: [
          {
            group: ['**/git/core/executor'],
            message: 'git/core/executor is internal to the git module. Use the public git API (import * as git from ../git) instead.',
          },
          {
            group: ['**/git', '**/git/index'],
            message: 'Use IGitOperations from DI container instead of importing the git module directly.',
          },
        ],
      }],
      'no-restricted-syntax': ['error',
        ...diSelectors,
        ...webviewCreationSelectors,
      ],
    },
  },

  // ── 2. UI files: EventBus + timer enforcement ───────────────────
  // All src/ui/** files get the full set: DI + webview creation +
  // EventBus/timer restrictions. This ensures new UI code uses the
  // pub/sub architecture exclusively.
  {
    files: ['src/ui/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        ...diSelectors,
        ...webviewCreationSelectors,
        ...uiEventBusSelectors,
      ],
    },
  },

  // ── 3. Approved webview panel files ─────────────────────────────
  // These specific files ARE the panel infrastructure and may call
  // createWebviewPanel. They still get DI + EventBus enforcement.
  {
    files: [
      'src/ui/panels/planDetailPanel.ts',
      'src/ui/panels/nodeDetailPanel.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error',
        ...diSelectors,
        ...uiEventBusSelectors,
        // Note: webviewCreationSelectors intentionally excluded —
        // these files own the panel lifecycle.
      ],
    },
  },

  // ── 3b. planInitialization: bootstrap/composition-adjacent code ──
  // This is bootstrap code equivalent to composition root. Allow direct
  // service construction since it's the initialization entry point.
  {
    files: ['src/core/planInitialization.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  // ── 4. IProcessSpawner.ts: only file that may import child_process ──
  {
    files: [
      'src/interfaces/IProcessSpawner.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  // ── 4a. Interface files: type-only imports allowed ───────────────
  {
    files: [
      'src/interfaces/IGitOperations.ts',
      'src/interfaces/IPhaseExecutor.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  // ── 4b. git internals: may import from git modules ───
  {
    files: [
      'src/git/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          // Allow child_process imports in git/core since it's the internal implementation
        ],
        // No patterns restriction — git files may import from git modules
      }],
    },
  },

  // ── 5. Composition root: may construct any service directly ─────
  {
    files: [
      'src/composition.ts',
      'src/compositionTest.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  // ── 6. Extension entry point: git imports allowed ──────────────
  // extension.ts is the entry point and may import git modules for initialization
  {
    files: [
      'src/extension.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: 'child_process',
            message: 'Use IProcessSpawner instead. Only src/interfaces/IProcessSpawner.ts may import child_process directly.',
          },
        ],
        // No patterns restriction — extension.ts may import git modules for initialization
      }],
      'no-restricted-syntax': ['warn',
        // Warnings for DI migration progress
      ],
    },
  },

  // ── 6b. TODO: Legacy files with temporary DI exemptions ─────────
  // These files currently violate DI rules but are exempted at warn
  // level. Each should be refactored to accept dependencies via
  // constructor injection. Track progress in the DI Migration plan.
  {
    files: [
      'src/core/logger.ts',
      'src/plan/logFileHelper.ts',
      'src/agent/agentDelegator.ts',
    ],
    rules: {
      'no-restricted-syntax': ['warn',
        // These are warnings (not errors) to track DI migration progress.
        // Once a file is refactored to use DI, remove it from this list
        // and it will get the full error-level enforcement.
      ],
    },
  },

  // ── 7. Test files: no restrictions ──────────────────────────────
  {
    files: ['src/test/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  // ── 8. Ignore patterns ─────────────────────────────────────────
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', '**/*.d.ts', '**/*.js', '!eslint.config.js'],
  },
];
