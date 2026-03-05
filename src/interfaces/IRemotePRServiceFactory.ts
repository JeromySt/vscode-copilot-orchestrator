/**
 * @fileoverview Interface for remote PR service factory.
 * 
 * Provides auto-detection and instantiation of the correct PR service implementation
 * based on repository remote provider type.
 * 
 * @module interfaces/IRemotePRServiceFactory
 */

import type { IRemotePRService } from './IRemotePRService';

/**
 * Factory interface for creating provider-specific PR service instances.
 * 
 * Detects the remote provider type from a repository and returns the appropriate
 * IRemotePRService implementation (GitHubPRService for GitHub/GHE, AdoPRService for Azure DevOps).
 * 
 * Caches detection results per repository path to avoid redundant git operations.
 * 
 * @example
 * ```typescript
 * const factory = container.resolve<IRemotePRServiceFactory>(Tokens.IRemotePRServiceFactory);
 * 
 * // Auto-detects provider and returns correct service
 * const prService = await factory.getServiceForRepo('/path/to/repo');
 * 
 * // prService is either GitHubPRService or AdoPRService based on remote URL
 * const result = await prService.createPR({
 *   baseBranch: 'main',
 *   headBranch: 'feature/my-change',
 *   title: 'Add new feature',
 *   body: 'Description...',
 *   cwd: '/path/to/repo',
 * });
 * ```
 */
export interface IRemotePRServiceFactory {
  /**
   * Get the appropriate PR service implementation for a repository.
   * 
   * Detects the remote provider type (github, github-enterprise, azure-devops)
   * from the repository's origin URL and returns the corresponding service.
   * 
   * Results are cached per repoPath - subsequent calls for the same repo
   * return the cached service without re-detecting.
   * 
   * @param repoPath - Absolute path to the git repository
   * @returns The appropriate IRemotePRService implementation (GitHubPRService or AdoPRService)
   * @throws If the remote provider cannot be detected or is unsupported
   * 
   * @example
   * ```typescript
   * // GitHub repository
   * const ghService = await factory.getServiceForRepo('/path/to/github/repo');
   * // Returns GitHubPRService instance
   * 
   * // Azure DevOps repository
   * const adoService = await factory.getServiceForRepo('/path/to/ado/repo');
   * // Returns AdoPRService instance
   * ```
   */
  getServiceForRepo(repoPath: string): Promise<IRemotePRService>;
}
