/**
 * @fileoverview Interface for remote PR service abstraction.
 * 
 * Provides a unified interface for pull request operations across GitHub,
 * GitHub Enterprise, and Azure DevOps platforms.
 * 
 * @module interfaces/IRemotePRService
 */

import type {
  RemoteProviderInfo,
  RemoteCredentials,
  PRCreateOptions,
  PRCreateResult,
  PRComment,
  PRCheck,
  PRSecurityAlert,
  PRListOptions,
  PRListItem,
  PRDetails,
} from '../plan/types/remotePR';

/**
 * Unified interface for PR operations across all supported remote providers.
 * 
 * This service abstracts platform-specific PR operations (GitHub, GitHub Enterprise,
 * Azure DevOps) behind a common interface. All methods delegate to provider-specific
 * implementations based on the detected RemoteProviderInfo.
 * 
 * @example
 * ```typescript
 * const prService = container.resolve<IRemotePRService>(Tokens.IRemotePRService);
 * const provider = await prService.detectProvider('/path/to/repo');
 * const credentials = await prService.acquireCredentials(provider);
 * const result = await prService.createPR({
 *   baseBranch: 'main',
 *   headBranch: 'feature/my-change',
 *   title: 'Add new feature',
 *   body: 'This PR adds...',
 *   cwd: '/path/to/release/clone',
 * });
 * ```
 */
export interface IRemotePRService {
  /**
   * Detect the remote provider type and configuration from a repository.
   * 
   * Parses the git remote URL and configuration to determine the hosting provider
   * (GitHub, GitHub Enterprise, or Azure DevOps) and extract relevant metadata.
   * 
   * @param repoPath - Absolute path to the git repository
   * @returns Provider information including type, owner, repo name, and provider-specific fields
   * @throws If the remote URL is invalid or the provider cannot be determined
   */
  detectProvider(repoPath: string): Promise<RemoteProviderInfo>;

  /**
   * Acquire credentials for the detected provider.
   * 
   * Attempts to obtain authentication credentials via provider-specific credential
   * chains (e.g., gh auth for GitHub, az cli for Azure DevOps, git credential cache).
   * 
   * @param provider - Provider information from detectProvider()
   * @param repoPath - Optional absolute path to the git repository (enables per-repo username config)
   * @returns Credentials with token and source metadata
   * @throws If credentials cannot be obtained through any available method
   */
  acquireCredentials(provider: RemoteProviderInfo, repoPath?: string): Promise<RemoteCredentials>;

  /**
   * Create a new pull request.
   * 
   * Creates a PR on the remote provider using the specified base and head branches.
   * The implementation handles provider-specific PR creation APIs.
   * 
   * @param options - PR creation parameters (branches, title, body, working directory)
   * @returns PR number and URL
   * @throws If PR creation fails (e.g., no changes, API error, auth failure)
   */
  createPR(options: PRCreateOptions): Promise<PRCreateResult>;

  /**
   * Get all CI/CD check statuses for a pull request.
   * 
   * Retrieves the current status of all checks (builds, tests, linters, CodeQL, etc.)
   * associated with the PR.
   * 
   * @param prNumber - PR number to query
   * @param cwd - Working directory of the release clone
   * @returns Array of check statuses
   * @throws If the PR does not exist or checks cannot be retrieved
   */
  getPRChecks(prNumber: number, cwd: string): Promise<PRCheck[]>;

  /**
   * Get all comments (review threads, general comments) for a pull request.
   * 
   * Retrieves all human and automated comments associated with the PR, including
   * inline review comments and general PR conversation.
   * 
   * @param prNumber - PR number to query
   * @param cwd - Working directory of the release clone
   * @returns Array of comments with metadata (author, source, thread ID, resolved status)
   * @throws If the PR does not exist or comments cannot be retrieved
   */
  getPRComments(prNumber: number, cwd: string): Promise<PRComment[]>;

  /**
   * Get security alerts (CodeQL, Dependabot, etc.) for a branch.
   * 
   * Retrieves security alerts that would be triggered or are associated with
   * the specified branch. Used to detect security issues before merging.
   * 
   * @param branchName - Branch name to query
   * @param cwd - Working directory of the release clone
   * @returns Array of security alerts with severity and resolution status
   * @throws If alerts cannot be retrieved (may return empty array if none exist)
   */
  getSecurityAlerts(branchName: string, cwd: string): Promise<PRSecurityAlert[]>;

  /**
   * Reply to a specific comment on a pull request.
   * 
   * Posts a reply to an existing comment, continuing the thread.
   * 
   * @param prNumber - PR number
   * @param commentId - ID of the comment to reply to
   * @param body - Reply text
   * @param cwd - Working directory of the release clone
   * @throws If the comment does not exist or the reply cannot be posted
   */
  replyToComment(prNumber: number, commentId: string, body: string, cwd: string): Promise<void>;

  /**
   * Add a general comment to a pull request (issue comment, not inline review reply).
   *
   * Use this for top-level review responses and general PR discussion.
   * Unlike replyToComment, this does NOT require an existing review comment to reply to.
   *
   * @param prNumber - PR number
   * @param body - Comment text
   * @param cwd - Working directory of the release clone
   */
  addIssueComment(prNumber: number, body: string, cwd: string): Promise<void>;

  /**
   * Resolve a review thread on a pull request.
   * 
   * Marks a review comment thread as resolved, indicating the feedback has been addressed.
   * 
   * @param prNumber - PR number
   * @param threadId - Platform-specific thread ID from PRComment.threadId
   * @param cwd - Working directory of the release clone
   * @throws If the thread does not exist or cannot be resolved
   */
  resolveThread(prNumber: number, threadId: string, cwd: string): Promise<void>;

  /**
   * Minimize (hide) a comment with a reason classifier.
   *
   * On GitHub uses the `minimizeComment` GraphQL mutation to collapse a comment.
   * On platforms without this feature this is a no-op.
   *
   * @param nodeId - GraphQL node ID of the comment (from PRComment.nodeId)
   * @param reason - Classifier: 'RESOLVED' | 'OFF_TOPIC' | 'OUTDATED' | 'ABUSE'
   * @param cwd - Working directory of the repository
   */
  minimizeComment?(nodeId: string, reason: string, cwd: string): Promise<void>;

  /**
   * List pull requests filtered by author or assignee.
   * 
   * Returns a summary list of PRs matching the filter criteria.
   * 
   * @param cwd - Working directory of the repository
   * @param options - Filter options (author, assignee, state, limit)
   * @returns Array of PR summary items
   * @throws If the repository cannot be accessed or the query fails
   */
  listPRs(cwd: string, options?: PRListOptions): Promise<PRListItem[]>;

  /**
   * Get detailed information about a specific pull request.
   * 
   * Retrieves full PR metadata including title, branches, draft status, state, and author.
   * 
   * @param prNumber - PR number to query
   * @param cwd - Working directory of the repository
   * @returns Detailed PR information
   * @throws If the PR does not exist or cannot be accessed
   */
  getPRDetails(prNumber: number, cwd: string): Promise<PRDetails>;

  /**
   * Abandon (close) a pull request without merging.
   * 
   * Closes the PR and optionally adds a closing comment.
   * 
   * @param prNumber - PR number to abandon
   * @param cwd - Working directory of the repository
   * @param comment - Optional closing comment
   * @throws If the PR does not exist or cannot be closed
   */
  abandonPR(prNumber: number, cwd: string, comment?: string): Promise<void>;

  /**
   * Promote a draft pull request to ready-for-review.
   * 
   * Marks a draft PR as ready for review, making it visible to reviewers.
   * 
   * @param prNumber - PR number to promote
   * @param cwd - Working directory of the repository
   * @throws If the PR does not exist, is not a draft, or cannot be promoted
   */
  promotePR(prNumber: number, cwd: string): Promise<void>;

  /**
   * Demote an active pull request to draft.
   * 
   * Marks a ready-for-review PR as a draft, hiding it from review queues.
   * 
   * @param prNumber - PR number to demote
   * @param cwd - Working directory of the repository
   * @throws If the PR does not exist, is already a draft, or cannot be demoted
   */
  demotePR(prNumber: number, cwd: string): Promise<void>;
}
