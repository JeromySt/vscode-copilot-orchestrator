/**
 * @fileoverview Interface for remote provider detection and credential acquisition.
 * 
 * Provides low-level capabilities for detecting git remote provider type and
 * acquiring credentials through provider-specific mechanisms.
 * 
 * @module interfaces/IRemoteProviderDetector
 */

import type { RemoteProviderInfo, RemoteCredentials } from '../plan/types/remotePR';

/**
 * Interface for detecting remote provider type and acquiring credentials.
 * 
 * This service handles the low-level tasks of parsing git remote URLs to identify
 * the hosting provider (GitHub, GitHub Enterprise, Azure DevOps) and obtaining
 * authentication credentials through provider-specific credential chains.
 * 
 * Implementations should support multiple credential acquisition strategies with
 * automatic fallback (e.g., gh auth → git credential cache → environment variables).
 * 
 * @example
 * ```typescript
 * const detector = container.resolve<IRemoteProviderDetector>(Tokens.IRemoteProviderDetector);
 * 
 * // Detect provider from repository
 * const provider = await detector.detect('/path/to/repo');
 * // => { type: 'github', owner: 'microsoft', repoName: 'vscode', ... }
 * 
 * // Acquire credentials for the provider
 * const creds = await detector.acquireCredentials(provider);
 * // => { token: '...', tokenSource: 'gh-auth', hostname: 'github.com' }
 * ```
 */
export interface IRemoteProviderDetector {
  /**
   * Detect the remote provider type from a repository's origin URL.
   * 
   * Parses the git remote URL (from `git config --get remote.origin.url`) and
   * identifies the provider type, hostname, owner, and repository name.
   * 
   * Supported URL formats:
   * - GitHub: https://github.com/owner/repo.git, git@github.com:owner/repo.git
   * - GitHub Enterprise: https://github.company.com/owner/repo.git
   * - Azure DevOps: https://dev.azure.com/org/project/_git/repo
   * 
   * @param repoPath - Absolute path to the git repository
   * @returns Provider information including type, owner, repo name, and provider-specific fields
   * @throws If the remote URL cannot be parsed or the provider is unsupported
   * 
   * @example
   * ```typescript
   * const provider = await detector.detect('/path/to/repo');
   * if (provider.type === 'github-enterprise') {
   *   console.log(`GHE hostname: ${provider.hostname}`);
   * }
   * ```
   */
  detect(repoPath: string): Promise<RemoteProviderInfo>;

  /**
   * Acquire credentials for the specified provider.
   * 
   * Attempts to obtain an authentication token through provider-specific credential
   * chains with automatic fallback. The credential acquisition order varies by provider:
   * 
   * GitHub / GitHub Enterprise:
   * 1. `gh auth token` (if gh CLI is authenticated)
   * 2. `git credential fill` (git credential cache/manager)
   * 3. `GITHUB_TOKEN` environment variable
   * 
   * Azure DevOps:
   * 1. `az account get-access-token` (if az CLI is authenticated)
   * 2. `git credential fill`
   * 3. `AZURE_DEVOPS_TOKEN` environment variable
   * 
   * @param provider - Provider information from detect()
   * @param repoPath - Optional absolute path to the git repository (enables per-repo username config)
   * @returns Credentials with token, source, and hostname
   * @throws If no credentials can be obtained through any available method
   * 
   * @example
   * ```typescript
   * const creds = await detector.acquireCredentials(provider);
   * console.log(`Using token from: ${creds.tokenSource}`);
   * // Note: NEVER log creds.token itself
   * ```
   */
  acquireCredentials(provider: RemoteProviderInfo, repoPath?: string): Promise<RemoteCredentials>;

  /**
   * List known accounts for a provider.
   * Uses GCM for GitHub (git credential-manager github list),
   * az CLI for ADO (az account list), gh auth for GHE.
   * @returns Array of account usernames/identifiers
   */
  listAccounts(provider: RemoteProviderInfo): Promise<string[]>;
}
