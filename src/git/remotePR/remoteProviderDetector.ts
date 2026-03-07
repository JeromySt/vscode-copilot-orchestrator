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

  async acquireCredentials(provider: RemoteProviderInfo, repoPath?: string): Promise<RemoteCredentials> {
    log.debug('Acquiring credentials', { type: provider.type, hostname: provider.hostname });

    let credentials: RemoteCredentials | null = null;

    switch (provider.type) {
      case 'github':
        credentials = await this.acquireGitHubCredentials(provider, repoPath);
        break;
      case 'github-enterprise':
        credentials = await this.acquireGitHubEnterpriseCredentials(provider, repoPath);
        break;
      case 'azure-devops':
        credentials = await this.acquireAzureDevOpsCredentials(provider, repoPath);
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
      username: credentials.username,
    });

    return credentials;
  }

  async listAccounts(provider: RemoteProviderInfo): Promise<string[]> {
    log.debug('Listing accounts', { type: provider.type, hostname: provider.hostname });

    try {
      switch (provider.type) {
        case 'github':
          return await this.listGitHubAccounts();
        case 'github-enterprise':
          return await this.listGitHubEnterpriseAccounts(provider.hostname || '');
        case 'azure-devops':
          return await this.listAzureDevOpsAccounts();
        default:
          log.warn('listAccounts not implemented for provider type', { type: provider.type });
          return [];
      }
    } catch (err) {
      log.debug('Failed to list accounts', { error: (err as Error).message });
      return [];
    }
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

  private async acquireGitHubCredentials(provider: RemoteProviderInfo, repoPath?: string): Promise<RemoteCredentials> {
    const hostname = 'github.com';

    // Check for per-repo configured username
    const configuredUsername = repoPath ? await this.getConfiguredUsername(repoPath, hostname) : null;

    if (configuredUsername) {
      // Skip gh auth token (globally active account) and go straight to git credential fill
      log.debug('Using configured username for GitHub', { username: configuredUsername });
      const gitCred = await this.tryGitCredentialFill(hostname, configuredUsername);
      if (gitCred) {
        return {
          token: gitCred.token,
          tokenSource: 'git-credential-cache',
          hostname,
          username: gitCred.username,
        };
      }
    }

    // Strategy 1: gh auth token
    const ghToken = await this.tryGhAuthToken();
    if (ghToken) {
      return {
        token: ghToken,
        tokenSource: 'gh-auth',
        hostname,
      };
    }

    // Strategy 2: GH_TOKEN environment variable
    if (this.env.env.GH_TOKEN) {
      log.debug('Using GH_TOKEN from environment');
      return {
        token: this.env.env.GH_TOKEN,
        tokenSource: 'environment',
        hostname,
      };
    }

    // Strategy 3: GITHUB_TOKEN environment variable
    if (this.env.env.GITHUB_TOKEN) {
      log.debug('Using GITHUB_TOKEN from environment');
      return {
        token: this.env.env.GITHUB_TOKEN,
        tokenSource: 'environment',
        hostname,
      };
    }

    // Strategy 4: git credential fill (universal fallback)
    const gitCred = await this.tryGitCredentialFill(hostname);
    if (gitCred) {
      return {
        token: gitCred.token,
        tokenSource: 'git-credential-cache',
        hostname,
        username: gitCred.username,
      };
    }

    throw new Error('Failed to acquire GitHub credentials through any available method');
  }

  private async acquireGitHubEnterpriseCredentials(provider: RemoteProviderInfo, repoPath?: string): Promise<RemoteCredentials> {
    const hostname = provider.hostname || 'unknown';

    // Check for per-repo configured username
    const configuredUsername = repoPath ? await this.getConfiguredUsername(repoPath, hostname) : null;

    if (configuredUsername) {
      // Skip gh auth token (globally active account) and go straight to git credential fill
      log.debug('Using configured username for GHE', { hostname, username: configuredUsername });
      const gitCred = await this.tryGitCredentialFill(hostname, configuredUsername);
      if (gitCred) {
        return {
          token: gitCred.token,
          tokenSource: 'git-credential-cache',
          hostname,
          username: gitCred.username,
        };
      }
    }

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
        token: gitCred.token,
        tokenSource: 'git-credential-cache',
        hostname,
        username: gitCred.username,
      };
    }

    throw new Error(`Failed to acquire GitHub Enterprise credentials for ${hostname}`);
  }

  private async acquireAzureDevOpsCredentials(provider: RemoteProviderInfo, repoPath?: string): Promise<RemoteCredentials> {
    const hostname = 'dev.azure.com';
    const fullHostname = provider.organization 
      ? `dev.azure.com/${provider.organization}` 
      : hostname;

    // Check for per-repo configured username
    const configuredUsername = repoPath ? await this.getConfiguredUsername(repoPath, hostname) : null;

    if (configuredUsername) {
      // Skip az CLI (globally active account) and go straight to git credential fill
      log.debug('Using configured username for Azure DevOps', { username: configuredUsername });
      const gitCred = await this.tryGitCredentialFill(hostname, configuredUsername);
      if (gitCred) {
        return {
          token: gitCred.token,
          tokenSource: 'git-credential-cache',
          hostname: fullHostname,
          username: gitCred.username,
        };
      }
    }

    // Strategy 1: az account get-access-token
    const azToken = await this.tryAzAccessToken();
    if (azToken) {
      return {
        token: azToken,
        tokenSource: 'az-cli',
        hostname: fullHostname,
      };
    }

    // Strategy 2: AZURE_DEVOPS_EXT_PAT environment variable
    if (this.env.env.AZURE_DEVOPS_EXT_PAT) {
      log.debug('Using AZURE_DEVOPS_EXT_PAT from environment');
      return {
        token: this.env.env.AZURE_DEVOPS_EXT_PAT,
        tokenSource: 'environment',
        hostname: fullHostname,
      };
    }

    // Strategy 3: SYSTEM_ACCESSTOKEN environment variable (Azure Pipelines)
    if (this.env.env.SYSTEM_ACCESSTOKEN) {
      log.debug('Using SYSTEM_ACCESSTOKEN from environment');
      return {
        token: this.env.env.SYSTEM_ACCESSTOKEN,
        tokenSource: 'environment',
        hostname: fullHostname,
      };
    }

    // Strategy 4: git credential fill
    const gitCred = await this.tryGitCredentialFill(hostname);
    if (gitCred) {
      return {
        token: gitCred.token,
        tokenSource: 'git-credential-cache',
        hostname: fullHostname,
        username: gitCred.username,
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

  private async tryGitCredentialFill(hostname: string, username?: string): Promise<{ token: string; username: string } | null> {
    try {
      const proc = this.spawner.spawn('git', ['credential', 'fill'], { shell: false });

      let input = `protocol=https\nhost=${hostname}\n`;
      if (username) {
        input += `username=${username}\n`;
      }
      input += '\n';

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
        // Parse password=<token> and username=<username> from output
        const passwordMatch = stdout.match(/password=(.+)/);
        const usernameMatch = stdout.match(/username=(.+)/);
        
        if (passwordMatch && passwordMatch[1]) {
          const token = passwordMatch[1].trim();
          const resultUsername = usernameMatch ? usernameMatch[1].trim() : (username || '');
          
          log.debug('Successfully retrieved token via git credential fill', { 
            hostname, 
            username: resultUsername,
          });
          
          return { token, username: resultUsername };
        }
      }
    } catch (err) {
      log.debug('git credential fill failed', { error: (err as Error).message });
    }

    return null;
  }

  private async getConfiguredUsername(repoPath: string, hostname: string): Promise<string | null> {
    try {
      const key = `credential.https://${hostname}.username`;
      const proc = this.spawner.spawn('git', ['config', '--local', key], {
        cwd: repoPath,
        shell: false,
      });

      let stdout = '';
      if (proc.stdout) {
        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      }

      const exitCode = await new Promise<number>((resolve) => {
        proc.on('exit', (code) => resolve(code ?? 1));
        proc.on('error', () => resolve(1));
      });

      if (exitCode === 0 && stdout.trim()) {
        const username = stdout.trim();
        log.debug('Found configured username', { hostname, username });
        return username;
      }
    } catch (err) {
      log.debug('Failed to get configured username', { error: (err as Error).message });
    }

    return null;
  }

  private async listGitHubAccounts(): Promise<string[]> {
    try {
      const proc = this.spawner.spawn('git', ['credential-manager', 'github', 'list'], { shell: false });

      let stdout = '';
      if (proc.stdout) {
        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      }

      const exitCode = await new Promise<number>((resolve) => {
        proc.on('exit', (code) => resolve(code ?? 1));
        proc.on('error', () => resolve(1));
      });

      if (exitCode === 0 && stdout.trim()) {
        const accounts = stdout.trim().split('\n').map(line => line.trim()).filter(line => line);
        log.debug('Listed GitHub accounts', { count: accounts.length });
        return accounts;
      }
    } catch (err) {
      log.debug('git credential-manager github list failed', { error: (err as Error).message });
    }

    return [];
  }

  private async listGitHubEnterpriseAccounts(hostname: string): Promise<string[]> {
    // Try GCM github list and filter by hostname if possible
    const accounts = await this.listGitHubAccounts();
    if (accounts.length > 0) {
      return accounts;
    }

    // Fallback: try gh auth status to get the username
    try {
      const proc = this.spawner.spawn('gh', ['auth', 'status', '-h', hostname], { shell: false });

      let stdout = '';
      if (proc.stdout) {
        proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      }

      const exitCode = await new Promise<number>((resolve) => {
        proc.on('exit', (code) => resolve(code ?? 1));
        proc.on('error', () => resolve(1));
      });

      if (exitCode === 0 && stdout) {
        // Parse username from "Logged in to <hostname> as <username>"
        const match = stdout.match(/Logged in to .+ as (\S+)/);
        if (match && match[1]) {
          log.debug('Found GHE username via gh auth status', { hostname, username: match[1] });
          return [match[1]];
        }
      }
    } catch (err) {
      log.debug('gh auth status failed', { error: (err as Error).message });
    }

    return [];
  }

  private async listAzureDevOpsAccounts(): Promise<string[]> {
    try {
      const proc = this.spawner.spawn(
        'az',
        ['account', 'list', '--query', '[].user.name', '-o', 'tsv'],
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
        const accounts = stdout.trim().split('\n').map(line => line.trim()).filter(line => line);
        log.debug('Listed Azure DevOps accounts', { count: accounts.length });
        return accounts;
      }
    } catch (err) {
      log.debug('az account list failed', { error: (err as Error).message });
    }

    return [];
  }
}
