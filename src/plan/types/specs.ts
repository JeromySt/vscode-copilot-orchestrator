/**
 * @fileoverview Work Specification Types
 *
 * Defines the types for specifying what work a job node should execute:
 * direct process spawning, shell commands, or AI agent delegation.
 *
 * @module plan/types/specs
 */

/**
 * Direct process spawn (no shell interpretation).
 * Arguments are passed directly - no quoting issues.
 */
export interface ProcessSpec {
  type: 'process';
  
  /** Executable to run (e.g., "node", "dotnet", "powershell.exe") */
  executable: string;
  
  /** Arguments as array - no shell quoting needed */
  args?: string[];
  
  /** Additional environment variables */
  env?: Record<string, string>;
  
  /** Override working directory (relative to worktree or absolute) */
  cwd?: string;
  
  /** Process timeout in milliseconds */
  timeout?: number;
}

/**
 * Shell command execution.
 * Command is interpreted by the shell.
 */
export interface ShellSpec {
  type: 'shell';
  
  /** Shell command string */
  command: string;
  
  /** 
   * Specific shell to use:
   * - 'cmd' - Windows cmd.exe
   * - 'powershell' - Windows PowerShell
   * - 'pwsh' - PowerShell Core (cross-platform)
   * - 'bash' - Bash shell
   * - 'sh' - Default POSIX shell
   * - undefined - Platform default (cmd on Windows, sh on Unix)
   */
  shell?: 'cmd' | 'powershell' | 'pwsh' | 'bash' | 'sh';
  
  /** Additional environment variables */
  env?: Record<string, string>;
  
  /** Override working directory */
  cwd?: string;
  
  /** Process timeout in milliseconds */
  timeout?: number;
}

/**
 * AI Agent delegation.
 * Work is performed by Copilot agent.
 * 
 * @example
 * ```typescript
 * const agentWork: AgentSpec = {
 *   type: 'agent',
 *   instructions: `# Task: Implement Feature X
 * 
 * ## Requirements
 * 1. Create new component in src/components/
 * 2. Add unit tests
 * 3. Update documentation
 * 
 * ## Notes
 * - Follow existing code patterns
 * - Use TypeScript strict mode`,
 *   contextFiles: ['src/components/', 'README.md']
 * };
 * ```
 */
export interface AgentSpec {
  type: 'agent';
  
  /**
   * Instructions for the agent (what to do).
   * 
   * **MUST be in Markdown format** for proper rendering in the UI.
   * 
   * Supports:
   * - `# Headers` (h1-h6)
   * - `1. Numbered lists`
   * - `- Bullet lists` (with nested items)
   * - `` `code` `` inline and ``` code blocks ```
   * - `**bold**` and `*italic*` text
   * - `[links](url)`
   * 
   * @example
   * ```markdown
   * # Main Task
   * 
   * ## Steps
   * 1. First step
   * 2. Second step
   *    - Sub-item A
   *    - Sub-item B
   * 
   * ## Notes
   * - Use `existingHelper()` function
   * - See [docs](./README.md) for details
   * ```
   */
  instructions: string;
  
  /** Optional model preference */
  model?: string;
  
  /** Files to include in agent context (relative to worktree) */
  contextFiles?: string[];
  
  /** Maximum agent turns/iterations */
  maxTurns?: number;
  
  /** Additional environment context to provide */
  context?: string;
  
  /** Resume existing Copilot session if available (default: true) */
  resumeSession?: boolean;

  /**
   * Whether to augment instructions with skill context before execution.
   * Defaults to `true`. Set to `false` to skip instruction augmentation.
   */
  augmentInstructions?: boolean;

  /**
   * Snapshot of the original instructions before augmentation.
   * Populated automatically by the instruction augmenter.
   */
  originalInstructions?: string;
  
  /**
   * Additional folder paths the agent is allowed to access beyond the worktree.
   * 
   * **Security Consideration**: By default, agents are sandboxed to only access files
   * within their assigned worktree folder. This prevents cross-job interference and
   * unintended modifications to shared repository areas.
   * 
   * Specify absolute paths here to grant agents access to shared resources
   * (e.g., shared libraries, config files, build tools). Each path becomes
   * an allowed access point passed to the Copilot CLI via `--allow-paths`.
   * 
   * **Principle of Least Privilege**: Only add folders that the agent truly needs.
   * 
   * @example
   * ```typescript
   * allowedFolders: [
   *   '/path/to/shared/libs',
   *   '/path/to/config',
   *   '/path/to/build-tools'
   * ]
   * ```
   */
  allowedFolders?: string[];
  
  /**
   * URLs or URL patterns the agent is allowed to access.
   *
   * **Security Consideration**: By default, agents cannot access any remote URLs.
   * This prevents data exfiltration and unauthorized network access during job execution.
   *
   * Specify URLs or domains here to grant network access. Each entry becomes
   * an allowed endpoint passed to the Copilot CLI via `--allow-url`.
   *
   * **Supported Formats**:
   * - Full URL: `https://api.example.com/v1/`
   * - Domain only: `api.example.com` (allows all paths on that domain)
   * - With wildcards: `*.example.com` (allows all subdomains)
   *
   * **Principle of Least Privilege**: Only add URLs that the agent truly needs.
   *
   * @example
   * ```typescript
   * allowedUrls: [
   *   'https://api.github.com',
   *   'https://registry.npmjs.org',
   *   'internal-api.company.com'
   * ]
   * ```
   */
  allowedUrls?: string[];
}

/**
 * Token usage metrics from an AI model invocation.
 * @deprecated Use {@link ModelUsageBreakdown} and {@link CopilotUsageMetrics} instead.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  estimatedCostUsd?: number;
}

/**
 * Execution metrics captured during agent delegation.
 * @deprecated Use {@link CopilotUsageMetrics} instead.
 */
export interface AgentExecutionMetrics {
  tokenUsage?: TokenUsage;
  durationMs: number;
  turns?: number;
  toolCalls?: number;
}

/**
 * Per-model token usage breakdown from a Copilot CLI invocation.
 */
export interface ModelUsageBreakdown {
  /** Model name (e.g. 'claude-opus-4.6', 'gpt-4.1') */
  model: string;
  /** Input tokens */
  inputTokens: number;
  /** Output tokens */
  outputTokens: number;
  /** Cached tokens (if reported) */
  cachedTokens?: number;
  /** Estimated premium requests for this model */
  premiumRequests?: number;
}

/**
 * Code change statistics from a Copilot CLI invocation.
 */
export interface CodeChangeStats {
  /** Lines added */
  linesAdded: number;
  /** Lines removed */
  linesRemoved: number;
}

/**
 * Rich execution metrics captured from Copilot CLI output.
 * Replaces the old TokenUsage / AgentExecutionMetrics.
 */
export interface CopilotUsageMetrics {
  /** Total estimated premium requests */
  premiumRequests?: number;
  /** API time in seconds */
  apiTimeSeconds?: number;
  /** Total session time in seconds */
  sessionTimeSeconds?: number;
  /** Code change stats (+N -M) */
  codeChanges?: CodeChangeStats;
  /** Per-model usage breakdown */
  modelBreakdown?: ModelUsageBreakdown[];
  /** Wall-clock duration in milliseconds (measured by orchestrator) */
  durationMs: number;
  /** Number of agent turns/iterations */
  turns?: number;
  /** Number of tool calls */
  toolCalls?: number;
  /**
   * Legacy token usage (backward compatibility).
   * @deprecated Use {@link modelBreakdown} instead.
   */
  tokenUsage?: TokenUsage;
}

/**
 * Work specification - what to execute.
 * Can be:
 * - string: Legacy format, interpreted as shell command or "@agent ..." 
 * - ProcessSpec: Direct process spawn
 * - ShellSpec: Shell command with explicit shell choice
 * - AgentSpec: AI agent delegation
 */
export type WorkSpec = string | ProcessSpec | ShellSpec | AgentSpec;

/**
 * Normalize a {@link WorkSpec} to its structured form.
 *
 * Handles backwards compatibility with the legacy string format:
 * - Strings starting with `@agent` become an {@link AgentSpec}.
 * - Other strings become a {@link ShellSpec}.
 * - Structured specs pass through unchanged.
 *
 * @param spec - The work spec to normalize, or `undefined`.
 * @returns The structured spec, or `undefined` if input was `undefined`.
 *
 * @example
 * ```typescript
 * normalizeWorkSpec('npm test');           // → { type: 'shell', command: 'npm test' }
 * normalizeWorkSpec('@agent fix the bug'); // → { type: 'agent', instructions: 'fix the bug' }
 * normalizeWorkSpec(undefined);            // → undefined
 * ```
 */
export function normalizeWorkSpec(spec: WorkSpec | undefined): ProcessSpec | ShellSpec | AgentSpec | undefined {
  if (spec === undefined) {
    return undefined;
  }
  
  if (typeof spec === 'string') {
    // Legacy string format
    if (spec.startsWith('@agent')) {
      const instructions = spec.replace(/^@agent\s*/i, '').trim();
      return {
        type: 'agent',
        instructions: instructions || 'Complete the task as specified',
      };
    }
    // Default to shell command
    return {
      type: 'shell',
      command: spec,
    };
  }
  
  return spec;
}
