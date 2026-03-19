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
  
  /** Username/account name associated with these credentials */
  username?: string;
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
  
  /** Create as draft PR */
  draft?: boolean;
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
 *
 * When returned from `getPRComments()`, each entry represents **one thread**
 * (not an individual comment).  The root comment's data populates the top-level
 * fields, and any follow-up replies are in `replies[]`.
 */
export interface PRComment {
  /** Unique comment ID (root comment of the thread) */
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

  /** URL to view this comment on the hosting platform */
  url?: string;

  /** GraphQL node ID for mutations (e.g., minimizeComment) — GitHub only */
  nodeId?: string;

  /** ID of the parent review that spawned this thread (links inline threads to the review summary) */
  parentReviewId?: string;

  /** Follow-up replies within this thread (newest last) */
  replies?: PRCommentReply[];
}

/**
 * A reply within a comment thread.
 */
export interface PRCommentReply {
  /** Unique comment ID */
  id: string;
  /** Author username */
  author: string;
  /** Reply body text */
  body: string;
  /** URL to view this reply */
  url?: string;
}

/**
 * Status of a CI/CD check on a pull request.
 */
export interface PRCheck {
  /** Check name (e.g., 'CI / build', 'CodeQL') */
  name: string;
  
  /** Current status of the check */
  status: 'passing' | 'failing' | 'pending' | 'skipped';
  
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

/**
 * Options for listing pull requests.
 */
export interface PRListOptions {
  /** Filter by author username (default: current user / @me) */
  author?: string;
  
  /** Filter by assignee username */
  assignee?: string;
  
  /** PR state filter */
  state?: 'open' | 'closed' | 'all';
  
  /** Maximum number of results to return */
  limit?: number;
}

/**
 * Summary information about a pull request.
 */
export interface PRListItem {
  /** PR number */
  prNumber: number;
  
  /** PR title */
  title: string;
  
  /** Head branch (source) */
  headBranch: string;
  
  /** Base branch (target) */
  baseBranch: string;
  
  /** PR state */
  state: 'open' | 'closed' | 'merged';
  
  /** Whether the PR is a draft */
  isDraft: boolean;
  
  /** PR author username */
  author: string;
  
  /** PR URL */
  url: string;
}

/**
 * Options for merging a pull request.
 */
export interface PRMergeOptions {
  /** Merge method to use */
  method: 'squash' | 'merge' | 'rebase';

  /** Whether to bypass branch protection rules */
  admin?: boolean;

  /** Whether to delete the source branch after merging */
  deleteSourceBranch?: boolean;

  /** Commit title for squash/merge commits */
  title?: string;
}

/**
 * Result of merging a pull request.
 */
export interface PRMergeResult {
  /** SHA of the merge commit */
  commitSha: string;
}

/**
 * Detailed information about a pull request.
 */
export interface PRDetails {
  /** PR number */
  prNumber: number;
  
  /** PR title */
  title: string;
  
  /** Head branch (source) */
  headBranch: string;
  
  /** Base branch (target) */
  baseBranch: string;
  
  /** Whether the PR is a draft */
  isDraft: boolean;
  
  /** PR state/status */
  state: 'open' | 'closed' | 'merged';
  
  /** PR author username */
  author: string;
  
  /** PR URL */
  url: string;
  
  /** PR description/body */
  body?: string;
}
