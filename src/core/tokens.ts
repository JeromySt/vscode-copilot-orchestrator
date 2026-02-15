/**
 * @fileoverview Service tokens for dependency injection container.
 * 
 * Provides Symbol-based tokens for type-safe service registration and resolution
 * in the ServiceContainer. Each token corresponds to an interface in src/interfaces/.
 * 
 * @module core/tokens
 */

// ─── Existing Interface Tokens ─────────────────────────────────────────────

/**
 * Token for ILogger service.
 * Provides structured logging functionality.
 */
export const ILogger = Symbol('ILogger');

/**
 * Token for IGitOperations service.
 * Provides Git repository operations.
 */
export const IGitOperations = Symbol('IGitOperations');

/**
 * Token for IProcessMonitor service.
 * Provides process monitoring and lifecycle management.
 */
export const IProcessMonitor = Symbol('IProcessMonitor');

/**
 * Token for INodeRunner service.
 * Provides node execution capabilities.
 */
export const INodeRunner = Symbol('INodeRunner');

/**
 * Token for INodeExecutor service.
 * Provides node execution implementation.
 */
export const INodeExecutor = Symbol('INodeExecutor');

/**
 * Token for INodeStateMachine service.
 * Provides node state management.
 */
export const INodeStateMachine = Symbol('INodeStateMachine');

/**
 * Token for INodePersistence service.
 * Provides node data persistence.
 */
export const INodePersistence = Symbol('INodePersistence');

/**
 * Token for IEvidenceValidator service.
 * Provides evidence validation functionality.
 */
export const IEvidenceValidator = Symbol('IEvidenceValidator');

/**
 * Token for IMcpManager service.
 * Provides MCP (Model Context Protocol) management.
 */
export const IMcpManager = Symbol('IMcpManager');

/**
 * Token for IFileSystem service.
 * Provides file system operations abstraction.
 */
export const IFileSystem = Symbol('IFileSystem');

// ─── New Interface Tokens ──────────────────────────────────────────────────

/**
 * Token for IConfigProvider service.
 * Provides VS Code configuration access abstraction.
 */
export const IConfigProvider = Symbol('IConfigProvider');

/**
 * Token for IDialogService service.
 * Provides VS Code dialog operations abstraction.
 */
export const IDialogService = Symbol('IDialogService');

/**
 * Token for IClipboardService service.
 * Provides clipboard operations abstraction.
 */
export const IClipboardService = Symbol('IClipboardService');

/**
 * Token for IPulseEmitter service.
 * Provides a single-interval heartbeat for UI components.
 */
export const IPulseEmitter = Symbol('IPulseEmitter');

/**
 * Token for IProcessSpawner service.
 * Provides process spawning abstraction for testability.
 */
export const IProcessSpawner = Symbol('IProcessSpawner');

/**
 * Token for ICopilotRunner service.
 * Provides Copilot CLI execution capabilities.
 */
export const ICopilotRunner = Symbol('ICopilotRunner');

/**
 * Token for IAgentDelegator service.
 * Provides agent delegation and orchestration.
 */
export const IAgentDelegator = Symbol('IAgentDelegator');

/**
 * Token for IMcpRequestRouter service.
 * Provides MCP request routing and handling.
 */
export const IMcpRequestRouter = Symbol('IMcpRequestRouter');

/**
 * Token for IEnvironment service.
 * Provides environment variable and platform information.
 */
export const IEnvironment = Symbol('IEnvironment');

/**
 * Token for IGlobalCapacity service.
 * Provides global capacity management across extension instances.
 */
export const IGlobalCapacity = Symbol('IGlobalCapacity');

/**
 * Token for IPlanConfigManager service.
 * Provides plan configuration management.
 */
export const IPlanConfigManager = Symbol('IPlanConfigManager');