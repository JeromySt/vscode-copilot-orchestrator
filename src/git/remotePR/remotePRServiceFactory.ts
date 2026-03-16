/**
 * @fileoverview Remote PR service factory implementation.
 * 
 * Auto-detects repository remote provider type and instantiates the appropriate
 * IRemotePRService implementation (GitHubPRService or AdoPRService) with caching
 * per repository path.
 * 
 * @module git/remotePR/remotePRServiceFactory
 */

import type { IRemotePRServiceFactory } from '../../interfaces/IRemotePRServiceFactory';
import type { IRemotePRService } from '../../interfaces/IRemotePRService';
import type { IProcessSpawner } from '../../interfaces/IProcessSpawner';
import type { IRemoteProviderDetector } from '../../interfaces/IRemoteProviderDetector';
import { Logger } from '../../core/logger';

const log = Logger.for('git');

/** Factory signature shared by all provider-specific PR service creators. */
export type PRServiceCreator = (
  spawner: IProcessSpawner,
  detector: IRemoteProviderDetector,
) => IRemotePRService;

/**
 * Factory for creating provider-specific PR service instances.
 * 
 * Detects remote provider type from repository URL and returns the correct
 * service implementation:
 * - GitHub / GitHub Enterprise → githubPRServiceCreator
 * - Azure DevOps → adoPRServiceCreator
 * 
 * Caches services per repository path to prevent redundant detection.
 * Provider-specific service creators are injected at construction time so
 * concrete service instantiation remains in composition.ts.
 */
export class RemotePRServiceFactory implements IRemotePRServiceFactory {
  private readonly cache = new Map<string, IRemotePRService>();

  constructor(
    private readonly spawner: IProcessSpawner,
    private readonly detector: IRemoteProviderDetector,
    private readonly githubPRServiceCreator: PRServiceCreator,
    private readonly adoPRServiceCreator: PRServiceCreator,
  ) {}

  /**
   * Get the appropriate PR service for a repository.
   * 
   * Detection flow:
   * 1. Check cache for existing service instance
   * 2. If not cached, detect provider type via detector
   * 3. Instantiate GitHubPRService (github/github-enterprise) or AdoPRService (azure-devops)
   * 4. Cache the service instance
   * 5. Return the service
   * 
   * @param repoPath - Absolute path to the git repository
   * @returns Provider-specific PR service implementation
   * @throws If provider detection fails or provider type is unsupported
   */
  async getServiceForRepo(repoPath: string): Promise<IRemotePRService> {
    // Check cache first
    const cached = this.cache.get(repoPath);
    if (cached) {
      log.debug('Using cached PR service', { repoPath });
      return cached;
    }

    // Detect provider type
    log.debug('Detecting remote provider for PR service', { repoPath });
    const provider = await this.detector.detect(repoPath);

    // Instantiate the appropriate service based on provider type
    let service: IRemotePRService;

    switch (provider.type) {
      case 'github':
      case 'github-enterprise':
        log.info('Creating GitHub PR service', { 
          type: provider.type, 
          owner: provider.owner, 
          repo: provider.repoName,
          hostname: provider.hostname,
        });
        service = this.githubPRServiceCreator(this.spawner, this.detector);
        break;

      case 'azure-devops':
        log.info('Creating Azure DevOps PR service', { 
          organization: provider.organization, 
          project: provider.project,
          repo: provider.repoName,
        });
        service = this.adoPRServiceCreator(this.spawner, this.detector);
        break;

      default:
        throw new Error(`Unsupported remote provider type: ${provider.type}`);
    }

    // Cache and return
    this.cache.set(repoPath, service);
    log.debug('PR service cached', { repoPath, type: provider.type });

    return service;
  }
}
