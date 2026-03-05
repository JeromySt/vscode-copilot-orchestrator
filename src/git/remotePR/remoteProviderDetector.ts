/**
 * @fileoverview Default implementation of IRemoteProviderDetector interface.
 * 
 * Detects git remote provider type (GitHub, GitHub Enterprise, Azure DevOps)
 * from repository remote URLs and acquires credentials through provider-specific
 * credential chains with automatic fallback.
 * 
 * @module git/remotePR/remoteProviderDetector
 */

import type { IRemoteProviderDetector } from '../../interfaces/IRemoteProviderDetector';
import type { IProcessSpawner } from '../../interfaces/IProcessSpawner';
import type { IEnvironment } from '../../interfaces/IEnvironment';
import type { RemoteProviderInfo, RemoteCredentials } from '../../plan/types/remotePR';
import { Logger } from '../../core/logger';

const log = Logger.for('git');

/**
 * Default implementation of remote provider detection and credential acquisition.
 * 
 * Parses git remote URLs to identify GitHub, GitHub Enterprise, or Azure DevOps,
 * extracts repository metadata, and obtains credentials through provider-specific
 * credential chains (gh auth → az CLI → git credential → environment variables).
 */
export class DefaultRemoteProviderDetector implements IRemoteProviderDetector {
  constructor(
    private readonly spawner: IProcessSpawner,
    private readonly env: IEnvironment,
  ) {}

  async detect(repoPath: string): Promise<RemoteProviderInfo> {
    log.debug('Detecting remote provider', { repoPath });

    // Get remote URL from git
    const remoteUrl = await this.getRemoteUrl(repoPath);
    log.debug('Remote URL retrieved', { remoteUrl });

    // Parse URL to determine provider type and extract metadata
    const info = this.parseRemoteUrl(remoteUrl);
    log.info('Remote provider detected', { 
      type: info.type, 
      owner: info.owner, 
      repoName: info.repoName,
      hostname: info.hostname,
    });

    return info;
  }

  async acquireCredentials(provider: RemoteProviderInfo): Promise<RemoteCredentials> {
    log.debug('Acquiring credentials', { type: provider.type, hostname: provider.hostname });

    let credentials: RemoteCredentials | null = null;

    switch (provider.type) {
      case 'github':
        credentials = await this.acquireGitHubCredentials(provider);
        break;
      case 'github-enterprise':
        credentials = await this.acquireGitHubEnterpriseCredentials(provider);
        break;
      case 'azure-devops':
        credentials = await this.acquireAzureDevOpsCredentials(provider);
        break;
      default:
        throw new Error(`Unsupported provider type: ${provider.type}`);
    }

    if (!credentials || !credentials.token) {
      throw new Error(`Failed to acquire credentials for ${provider.type}`);
    }

    log.info('Credentials acquired', { 
      type: provider.type, 
      tokenSource: credentials.tokenSource,
      hostname: credentials.hostname,
    });

    return credentials;
  }

  private async getRemoteUrl(repoPath: string): Promise<string> {
    const proc = this.spawner.spawn('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    if (proc.stdout) {
      proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    }
    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    }

    await new Promise<void>((resolve, reject) => {
      proc.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`git remote get-url failed: ${stderr.trim()}`));
        }
      });
      proc.on('error', reject);
    });

    const url = stdout.trim();
    if (!url) {
      throw new Error('No remote URL found for origin');
    }

    return url;
  }

  private parseRemoteUrl(remoteUrl: string): RemoteProviderInfo {
    // Normalize SSH URLs to HTTPS-style for easier parsing
    let normalizedUrl = remoteUrl;

    // SSH GitHub: git@github.com:owner/repo.git
    if (remoteUrl.startsWith('git@github.com:')) {
      normalizedUrl = remoteUrl.replace('git@github.com:', 'https://github.com/');
    }
    // SSH GitHub Enterprise: git@github.company.com:owner/repo.git
    else if (remoteUrl.match(/^git@[^:]+github[^:]*:/)) {
      const match = remoteUrl.match(/^git@([^:]+):(.+)$/);
      if (match) {
        normalizedUrl = `https://${match[1]}/${match[2]}`;
      }
    }
    // SSH Azure DevOps: org@vs-ssh.visualstudio.com:v3/org/project/repo
    else if (remoteUrl.includes('@vs-ssh.visualstudio.com:')) {
      const match = remoteUrl.match(/^[^@]+@vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/(.+)$/);
      if (match) {
        normalizedUrl = `https://dev.azure.com/${match[1]}/${match[2]}/_git/${match[3]}`;
      }
    }

    log.debug('Normalized URL', { original: remoteUrl, normalized: normalizedUrl });

    // Parse GitHub
    const githubMatch = normalizedUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/);
    if (githubMatch) {
      return {
        type: 'github',
        remoteUrl,
        owner: githubMatch[1],
        repoName: githubMatch[2].replace(/\.git$/, ''),
      };
    }

    // Parse GitHub Enterprise (any *.github.* hostname that's not github.com)
    const gheMatch = normalizedUrl.match(/^https?:\/\/([^/]+github[^/]*)\/([^/]+)\/([^/]+?)(\.git)?$/);
    if (gheMatch && gheMatch[1] !== 'github.com') {
      return {
        type: 'github-enterprise',
        remoteUrl,
        hostname: gheMatch[1],
        owner: gheMatch[2],
        repoName: gheMatch[3].replace(/\.git$/, ''),
      };
    }

    // Parse Azure DevOps (dev.azure.com)
    const adoDevMatch = normalizedUrl.match(/^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/(.+?)(\.git)?$/);
    if (adoDevMatch) {
      return {
        type: 'azure-devops',
        remoteUrl,
        organization: adoDevMatch[1],
        project: adoDevMatch[2],
        repoName: adoDevMatch[3].replace(/\.git$/, ''),
        owner: adoDevMatch[1], // For ADO, owner is the organization
      };
    }

    // Parse Azure DevOps (*.visualstudio.com)
    const adoVsoMatch = normalizedUrl.match(/^https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/(.+?)(\.git)?$/);
    if (adoVsoMatch) {
      return {
        type: 'azure-devops',
        remoteUrl,
        organization: adoVsoMatch[1],
        project: adoVsoMatch[2],
        repoName: adoVsoMatch[3].replace(/\.git$/, ''),
        owner: adoVsoMatch[1], // For ADO, owner is the organization
      };
    }

    throw new Error(`Unsupported or unrecognized remote URL format: ${remoteUrl}`);
  }

  private async acquireGitHubCredentials(provider: RemoteProviderInfo): Promise<RemoteCredentials> {
    // Strategy 1: gh auth token
    const ghToken = await this.tryGhAuthToken();
    if (ghToken) {
      return {
        token: ghToken,
        tokenSource: 'gh-auth',
        hostname: 'github.com',
      };
    }

    // Strategy 2: GH_TOKEN environment variable
    if (this.env.env.GH_TOKEN) {
      log.debug('Using GH_TOKEN from environment');
      return {
        token: this.env.env.GH_TOKEN,
        tokenSource: 'environment',
        hostname: 'github.com',
      };
    }

    // Strategy 3: GITHUB_TOKEN environment variable
    if (this.env.env.GITHUB_TOKEN) {
      log.debug('Using GITHUB_TOKEN from environment');
      return {
        token: this.env.env.GITHUB_TOKEN,
        tokenSource: 'environment',
        hostname: 'github.com',
      };
    }

    // Strategy 4: git credential fill (universal fallback)
    const gitCred = await this.tryGitCredentialFill('github.com');
    if (gitCred) {
      return {
        token: gitCred,
        tokenSource: 'git-credential-cache',
        hostname: 'github.com',
      };
    }

    throw new Error('Failed to acquire GitHub credentials through any available method');
  }

  private async acquireGitHubEnterpriseCredentials(provider: RemoteProviderInfo): Promise<RemoteCredentials> {
    const hostname = provider.hostname || 'unknown';

    // Strategy 1: gh auth token -h <hostname>
    const ghToken = await this.tryGhAuthToken(hostname);
    if (ghToken) {
      return {
        token: ghToken,
        tokenSource: 'gh-auth',
        hostname,
      };
    }

    // Strategy 2: GH_ENTERPRISE_TOKEN environment variable
    if (this.env.env.GH_ENTERPRISE_TOKEN) {
      log.debug('Using GH_ENTERPRISE_TOKEN from environment');
      return {
        token: this.env.env.GH_ENTERPRISE_TOKEN,
        tokenSource: 'environment',
        hostname,
      };
    }

    // Strategy 3: git credential fill with GHE hostname
    const gitCred = await this.tryGitCredentialFill(hostname);
    if (gitCred) {
      return {
        token: gitCred,
        tokenSource: 'git-credential-cache',
        hostname,
      };
    }

    throw new Error(`Failed to acquire GitHub Enterprise credentials for ${hostname}`);
  }

  private async acquireAzureDevOpsCredentials(provider: RemoteProviderInfo): Promise<RemoteCredentials> {
    const hostname = provider.organization 
      ? `dev.azure.com/${provider.organization}` 
      : 'dev.azure.com';

    // Strategy 1: az account get-access-token
    const azToken = await this.tryAzAccessToken();
    if (azToken) {
      return {
        token: azToken,
        tokenSource: 'az-cli',
        hostname,
      };
    }

    // Strategy 2: AZURE_DEVOPS_EXT_PAT environment variable
    if (this.env.env.AZURE_DEVOPS_EXT_PAT) {
      log.debug('Using AZURE_DEVOPS_EXT_PAT from environment');
      return {
        token: this.env.env.AZURE_DEVOPS_EXT_PAT,
        tokenSource: 'environment',
        hostname,
      };
    }

    // Strategy 3: SYSTEM_ACCESSTOKEN environment variable (Azure Pipelines)
    if (this.env.env.SYSTEM_ACCESSTOKEN) {
      log.debug('Using SYSTEM_ACCESSTOKEN from environment');
      return {
        token: this.env.env.SYSTEM_ACCESSTOKEN,
        tokenSource: 'environment',
        hostname,
      };
    }

    // Strategy 4: git credential fill
    const gitCred = await this.tryGitCredentialFill('dev.azure.com');
    if (gitCred) {
      return {
        token: gitCred,
        tokenSource: 'git-credential-cache',
        hostname,
      };
    }

    throw new Error('Failed to acquire Azure DevOps credentials through any available method');
  }

  private async tryGhAuthToken(hostname?: string): Promise<string | null> {
    try {
      const args = hostname ? ['auth', 'token', '-h', hostname] : ['auth', 'token'];
      const proc = this.spawner.spawn('gh', args, { shell: false });

      let stdout = '';
      if (proc.stdout) {
        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      }

      const exitCode = await new Promise<number>((resolve) => {
        proc.on('exit', (code) => resolve(code ?? 1));
        proc.on('error', () => resolve(1));
      });

      if (exitCode === 0 && stdout.trim()) {
        log.debug('Successfully retrieved token via gh auth', { hostname: hostname || 'github.com' });
        return stdout.trim();
      }
    } catch (err) {
      log.debug('gh auth token failed', { error: (err as Error).message });
    }

    return null;
  }

  private async tryAzAccessToken(): Promise<string | null> {
    try {
      const proc = this.spawner.spawn(
        'az',
        [
          'account',
          'get-access-token',
          '--resource',
          '499b84ac-1321-427f-aa17-267ca6975798',
          '--query',
          'accessToken',
          '-o',
          'tsv',
        ],
        { shell: false },
      );

      let stdout = '';
      if (proc.stdout) {
        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      }

      const exitCode = await new Promise<number>((resolve) => {
        proc.on('exit', (code) => resolve(code ?? 1));
        proc.on('error', () => resolve(1));
      });

      if (exitCode === 0 && stdout.trim()) {
        log.debug('Successfully retrieved token via az CLI');
        return stdout.trim();
      }
    } catch (err) {
      log.debug('az account get-access-token failed', { error: (err as Error).message });
    }

    return null;
  }

  private async tryGitCredentialFill(hostname: string): Promise<string | null> {
    try {
      const proc = this.spawner.spawn('git', ['credential', 'fill'], { shell: false });

      const input = `protocol=https\nhost=${hostname}\n\n`;

      // Cast to any to access stdin (not in ChildProcessLike interface)
      const procAny = proc as any;
      if (procAny.stdin) {
        procAny.stdin.write(input);
        procAny.stdin.end();
      }

      let stdout = '';
      if (proc.stdout) {
        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      }

      const exitCode = await new Promise<number>((resolve) => {
        proc.on('exit', (code) => resolve(code ?? 1));
        proc.on('error', () => resolve(1));
      });

      if (exitCode === 0 && stdout) {
        // Parse password=<token> from output
        const match = stdout.match(/password=(.+)/);
        if (match && match[1]) {
          log.debug('Successfully retrieved token via git credential fill', { hostname });
          return match[1].trim();
        }
      }
    } catch (err) {
      log.debug('git credential fill failed', { error: (err as Error).message });
    }

    return null;
  }
}
