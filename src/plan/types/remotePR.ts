/**
 * @fileoverview Type definitions for remote PR service abstraction.
 * 
 * Supports GitHub, GitHub Enterprise, and Azure DevOps with a unified interface.
 * 
 * @module plan/types/remotePR
 */

/**
 * The type of remote git hosting provider.
 */
export type RemoteProviderType = 'github' | 'github-enterprise' | 'azure-devops';

/**
 * Information about a detected remote git hosting provider.
 * 
 * Parsed from the repository's origin URL and git config.
 */
export interface RemoteProviderInfo {
  /** Provider type (GitHub, GitHub Enterprise, Azure DevOps) */
  type: RemoteProviderType;
  
  /** Full remote URL (e.g., https://github.com/owner/repo.git) */
  remoteUrl: string;
  
  /** Custom hostname for GitHub Enterprise (e.g., github.company.com) */
  hostname?: string;
  
  /** Azure DevOps organization name */
  organization?: string;
  
  /** Azure DevOps project name */
  project?: string;
  
  /** Repository name without owner (e.g., 'vscode-copilot-orchestrator') */
  repoName: string;
  
  /** Repository owner or organization (e.g., 'microsoft') */
  owner: string;
}

/**
 * Credentials for authenticating with a remote provider.
 * 
 * Security: The `token` field must NEVER be logged.
 */
export interface RemoteCredentials {
  /** Authentication token (NEVER log this field) */
  token?: string;
  
  /** Source of the token for diagnostics (safe to log) */
  tokenSource: 'git-credential-cache' | 'environment' | 'gh-auth' | 'az-cli' | 'manual';
  
  /** Hostname for which the credentials are valid */
  hostname?: string;
}

/**
 * Options for creating a new pull request.
 */
export interface PRCreateOptions {
  /** Base branch (target) for the PR */
  baseBranch: string;
  
  /** Head branch (source) containing the changes */
  headBranch: string;
  
  /** PR title */
  title: string;
  
  /** PR body/description */
  body: string;
  
  /** Working directory of the release clone (.orchestrator/release/<branch>/) */
  cwd: string;
}

/**
 * Result of creating a pull request.
 */
export interface PRCreateResult {
  /** PR number assigned by the provider */
  prNumber: number;
  
  /** Full URL to the created PR */
  prUrl: string;
}

/**
 * A comment or review thread item on a pull request.
 */
export interface PRComment {
  /** Unique comment ID */
  id: string;
  
  /** Author username */
  author: string;
  
  /** Comment body text */
  body: string;
  
  /** File path if this is a review comment */
  path?: string;
  
  /** Line number if this is a review comment */
  line?: number;
  
  /** Whether the comment thread is resolved */
  isResolved: boolean;
  
  /** Source of the comment for categorization */
  source: 'human' | 'copilot' | 'codeql' | 'bot';
  
  /** Platform-specific thread ID for resolving/replying */
  threadId?: string;
}

/**
 * Status of a CI/CD check on a pull request.
 */
export interface PRCheck {
  /** Check name (e.g., 'CI / build', 'CodeQL') */
  name: string;
  
  /** Current status of the check */
  status: 'passing' | 'failing' | 'pending';
  
  /** URL to the check details page */
  url?: string;
}

/**
 * A security alert associated with a pull request or branch.
 */
export interface PRSecurityAlert {
  /** Unique alert ID */
  id: string;
  
  /** Severity level */
  severity: 'critical' | 'high' | 'medium' | 'low';
  
  /** Human-readable description */
  description: string;
  
  /** File path where the issue was detected */
  file?: string;
  
  /** Whether the alert has been resolved */
  resolved: boolean;
}
