/**
 * @fileoverview GitHub PR service implementation.
 * 
 * Implements IRemotePRService for GitHub and GitHub Enterprise using gh CLI.
 * All gh CLI calls use environment variables for authentication (never CLI arguments).
 * 
 * @module git/remotePR/githubPRService
 */

import type { IRemotePRService } from '../../interfaces/IRemotePRService';
import type { IProcessSpawner } from '../../interfaces/IProcessSpawner';
import type { IRemoteProviderDetector } from '../../interfaces/IRemoteProviderDetector';
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
} from '../../plan/types/remotePR';
import { Logger } from '../../core/logger';

const log = Logger.for('git');

/**
 * Cache entry for provider info and credentials per cwd.
 */
interface CacheEntry {
  provider: RemoteProviderInfo;
  credentials: RemoteCredentials;
}

/**
 * GitHub PR service implementation.
 * 
 * Uses gh CLI for all GitHub/GitHub Enterprise operations.
 * Caches provider info and credentials after first detection per cwd.
 */
export class GitHubPRService implements IRemotePRService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly spawner: IProcessSpawner,
    private readonly detector: IRemoteProviderDetector,
  ) {}

  /**
   * Detect the remote provider from a repository.
   */
  async detectProvider(repoPath: string): Promise<RemoteProviderInfo> {
    const cached = this.cache.get(repoPath);
    if (cached) {
      log.debug('Using cached provider info', { repoPath });
      return cached.provider;
    }

    log.debug('Detecting provider', { repoPath });
    const provider = await this.detector.detect(repoPath);
    
    // Initialize cache entry
    const credentials = await this.detector.acquireCredentials(provider, repoPath);
    this.cache.set(repoPath, { provider, credentials });
    
    log.info('Provider detected', { 
      type: provider.type, 
      owner: provider.owner, 
      repo: provider.repoName,
      hostname: provider.hostname 
    });
    
    return provider;
  }

  /**
   * Acquire credentials for the detected provider.
   */
  async acquireCredentials(provider: RemoteProviderInfo, repoPath?: string): Promise<RemoteCredentials> {
    // Check cache first by matching provider
    for (const entry of this.cache.values()) {
      if (entry.provider.remoteUrl === provider.remoteUrl) {
        log.debug('Using cached credentials', { tokenSource: entry.credentials.tokenSource });
        return entry.credentials;
      }
    }

    log.debug('Acquiring credentials', { type: provider.type, hostname: provider.hostname });
    const credentials = await this.detector.acquireCredentials(provider, repoPath);
    log.info('Credentials acquired', { tokenSource: credentials.tokenSource });
    
    return credentials;
  }

  /**
   * Create a new pull request.
   */
  async createPR(options: PRCreateOptions): Promise<PRCreateResult> {
    const provider = await this.detectProvider(options.cwd);
    const credentials = await this.acquireCredentials(provider);
    
    log.info('Creating PR', { 
      base: options.baseBranch, 
      head: options.headBranch, 
      title: options.title 
    });

    const env = this._buildEnv(provider, credentials);
    
    const args = [
      'pr', 'create',
      '--base', options.baseBranch,
      '--head', options.headBranch,
      '--title', options.title,
      '--body', options.body,
    ];
    
    if (options.draft) {
      args.push('--draft');
    }

    args.push('--json', 'number,url');

    const result = await this._execGh(args, options.cwd, env);
    
    try {
      const parsed = JSON.parse(result.trim());
      const prNumber = parsed.number;
      const prUrl = parsed.url;
      
      if (!prNumber) {
        throw new Error(`Could not extract PR number from output: ${result}`);
      }
      
      log.info('PR created', { prNumber, prUrl });
      return {
        prNumber,
        prUrl,
      };
    } catch (err) {
      log.error('Failed to parse PR create response', { error: String(err), output: result });
      throw new Error(`Failed to parse gh pr create output: ${err}`);
    }
  }

  /**
   * Get all CI/CD check statuses for a pull request.
   *
   * Uses the REST API (repos/{owner}/{repo}/commits/{ref}/check-runs) instead of
   * `gh pr checks --json` because older gh CLI versions don't support --json on
   * the `pr checks` subcommand.
   */
  async getPRChecks(prNumber: number, cwd: string): Promise<PRCheck[]> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);
    
    log.debug('Getting PR checks', { prNumber });

    const env = this._buildEnv(provider, credentials);
    const ownerRepo = `${provider.owner}/${provider.repoName}`;

    try {
      // First get the PR's head SHA
      const prEndpoint = `repos/${ownerRepo}/pulls/${prNumber}`;
      const prResult = await this._execGhApi(prEndpoint, cwd, env);
      const prData = JSON.parse(prResult);
      const headSha = prData?.head?.sha;

      if (!headSha) {
        log.warn('Could not determine PR head SHA', { prNumber });
        return [];
      }

      // Fetch check runs for the head commit via REST API
      const checksEndpoint = `repos/${ownerRepo}/commits/${headSha}/check-runs?per_page=100`;
      const checksResult = await this._execGhApi(checksEndpoint, cwd, env);
      const checksData = JSON.parse(checksResult);

      // Also fetch commit statuses (some CI systems use the status API, not checks)
      let statuses: Array<{ context: string; state: string; target_url: string }> = [];
      try {
        const statusEndpoint = `repos/${ownerRepo}/commits/${headSha}/statuses?per_page=100`;
        const statusResult = await this._execGhApi(statusEndpoint, cwd, env);
        statuses = JSON.parse(statusResult);
      } catch {
        // Status API may not be available, ignore
      }

      const checks: PRCheck[] = [];

      // Map check runs
      if (Array.isArray(checksData?.check_runs)) {
        for (const run of checksData.check_runs) {
          checks.push({
            name: run.name,
            status: this._mapCheckState(
              run.conclusion || run.status,
            ),
            url: run.html_url || run.details_url || '',
          });
        }
      }

      // Map commit statuses (deduplicate by context, keep latest)
      const statusByContext = new Map<string, typeof statuses[0]>();
      for (const s of statuses) {
        if (!statusByContext.has(s.context)) {
          statusByContext.set(s.context, s);
        }
      }
      for (const [, s] of statusByContext) {
        // Don't duplicate if a check run already exists with the same name
        if (!checks.some(c => c.name === s.context)) {
          checks.push({
            name: s.context,
            status: this._mapCheckState(s.state),
            url: s.target_url || '',
          });
        }
      }

      log.info('PR checks retrieved', { prNumber, count: checks.length });
      return checks;
    } catch (err) {
      log.warn('Failed to fetch PR checks, returning empty', { prNumber, error: String(err) });
      return [];
    }
  }

  /**
   * Get all comments for a pull request.
   */
  async getPRComments(prNumber: number, cwd: string): Promise<PRComment[]> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);
    
    log.debug('Getting PR comments', { prNumber });

    const env = this._buildEnv(provider, credentials);
    const ownerRepo = `${provider.owner}/${provider.repoName}`;

    // Fetch from three sources
    const [reviewComments, reviews, issueComments] = await Promise.all([
      this._getReviewComments(ownerRepo, prNumber, cwd, env),
      this._getReviews(ownerRepo, prNumber, cwd, env),
      this._getIssueComments(ownerRepo, prNumber, cwd, env),
    ]);

    // Merge and deduplicate by id
    const allComments = [...reviewComments, ...reviews, ...issueComments];
    const deduplicated = new Map<string, PRComment>();
    
    for (const comment of allComments) {
      deduplicated.set(comment.id, comment);
    }

    const result = Array.from(deduplicated.values());
    log.info('PR comments retrieved', { prNumber, count: result.length });
    
    return result;
  }

  /**
   * Get security alerts for a branch.
   */
  async getSecurityAlerts(branchName: string, cwd: string): Promise<PRSecurityAlert[]> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);
    
    log.debug('Getting security alerts', { branchName });

    const env = this._buildEnv(provider, credentials);
    const ownerRepo = `${provider.owner}/${provider.repoName}`;
    const endpoint = `repos/${ownerRepo}/code-scanning/alerts?ref=${branchName}&per_page=100`;

    try {
      const result = await this._execGhApi(endpoint, cwd, env);
      const parsed = JSON.parse(result);
      
      const alerts: PRSecurityAlert[] = parsed.map((alert: any) => ({
        id: String(alert.number),
        severity: this._mapSeverity(alert.rule?.severity),
        description: alert.rule?.description || alert.most_recent_instance?.message?.text || 'Unknown alert',
        file: alert.most_recent_instance?.location?.path,
        resolved: alert.state === 'dismissed' || alert.state === 'fixed',
      }));
      
      log.info('Security alerts retrieved', { branchName, count: alerts.length });
      return alerts;
    } catch (err) {
      // Graceful empty array on 404 (code scanning not enabled)
      const errMsg = String(err);
      if (errMsg.includes('404') || errMsg.includes('Not Found')) {
        log.debug('Code scanning not enabled or no alerts', { branchName });
        return [];
      }
      
      log.error('Failed to get security alerts', { error: errMsg, branchName });
      throw err;
    }
  }

  /**
   * Reply to a specific comment on a pull request.
   */
  async replyToComment(prNumber: number, commentId: string, body: string, cwd: string): Promise<void> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);
    
    log.info('Replying to comment', { prNumber, commentId });

    const env = this._buildEnv(provider, credentials);
    const ownerRepo = `${provider.owner}/${provider.repoName}`;
    const endpoint = `repos/${ownerRepo}/pulls/${prNumber}/comments`;
    
    const args = [
      'api', endpoint,
      '-X', 'POST',
      '-f', `body=${body}`,
      '-F', `in_reply_to=${commentId}`,
    ];

    await this._execGh(args, cwd, env);
    log.info('Reply posted', { prNumber, commentId });
  }

  /**
   * Resolve a review thread on a pull request.
   */
  async resolveThread(prNumber: number, threadId: string, cwd: string): Promise<void> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);
    
    log.info('Resolving thread', { prNumber, threadId });

    const env = this._buildEnv(provider, credentials);
    const query = `mutation { resolveReviewThread(input: {threadId: "${threadId}"}) { thread { id } } }`;
    
    const args = [
      'api', 'graphql',
      '-f', `query=${query}`,
    ];

    await this._execGh(args, cwd, env);
    log.info('Thread resolved', { prNumber, threadId });
  }

  /**
   * List pull requests filtered by author or assignee.
   */
  async listPRs(cwd: string, options?: PRListOptions): Promise<PRListItem[]> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);
    
    log.debug('Listing PRs', options);

    const env = this._buildEnv(provider, credentials);
    
    const args = [
      'pr', 'list',
      '--json', 'number,title,headRefName,baseRefName,state,isDraft,author,url',
    ];

    // Add filters
    if (options?.author) {
      args.push('--author', options.author);
    } else {
      // Default to current user
      args.push('--author', '@me');
    }

    if (options?.assignee) {
      args.push('--assignee', options.assignee);
    }

    if (options?.state) {
      args.push('--state', options.state);
    }

    if (options?.limit) {
      args.push('--limit', String(options.limit));
    }

    const result = await this._execGh(args, cwd, env);
    
    try {
      const parsed = JSON.parse(result);
      const prs: PRListItem[] = parsed.map((pr: any) => ({
        prNumber: pr.number,
        title: pr.title,
        headBranch: pr.headRefName,
        baseBranch: pr.baseRefName,
        state: this._mapPRState(pr.state),
        isDraft: pr.isDraft || false,
        author: pr.author?.login || 'unknown',
        url: pr.url,
      }));
      
      log.info('PRs listed', { count: prs.length });
      return prs;
    } catch (err) {
      log.error('Failed to parse PR list response', { error: String(err), output: result });
      throw new Error(`Failed to parse gh pr list output: ${err}`);
    }
  }

  /**
   * Get detailed information about a specific pull request.
   */
  async getPRDetails(prNumber: number, cwd: string): Promise<PRDetails> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);
    
    log.debug('Getting PR details', { prNumber });

    const env = this._buildEnv(provider, credentials);
    const args = [
      'pr', 'view', String(prNumber),
      '--json', 'number,title,headRefName,baseRefName,isDraft,state,author,url,body',
    ];

    const result = await this._execGh(args, cwd, env);
    
    try {
      const pr = JSON.parse(result);
      const details: PRDetails = {
        prNumber: pr.number,
        title: pr.title,
        headBranch: pr.headRefName,
        baseBranch: pr.baseRefName,
        isDraft: pr.isDraft || false,
        state: this._mapPRState(pr.state),
        author: pr.author?.login || 'unknown',
        url: pr.url,
        body: pr.body,
      };
      
      log.info('PR details retrieved', { prNumber });
      return details;
    } catch (err) {
      log.error('Failed to parse PR details response', { error: String(err), output: result });
      throw new Error(`Failed to parse gh pr view output: ${err}`);
    }
  }

  /**
   * Abandon (close) a pull request without merging.
   */
  async abandonPR(prNumber: number, cwd: string, comment?: string): Promise<void> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);
    
    log.info('Abandoning PR', { prNumber, hasComment: !!comment });

    const env = this._buildEnv(provider, credentials);
    const args = ['pr', 'close', String(prNumber)];

    if (comment) {
      args.push('--comment', comment);
    }

    await this._execGh(args, cwd, env);
    log.info('PR abandoned', { prNumber });
  }

  /**
   * Promote a draft pull request to ready-for-review.
   */
  async promotePR(prNumber: number, cwd: string): Promise<void> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);
    
    log.info('Promoting PR to ready', { prNumber });

    const env = this._buildEnv(provider, credentials);
    const args = ['pr', 'ready', String(prNumber)];

    await this._execGh(args, cwd, env);
    log.info('PR promoted to ready', { prNumber });
  }

  /**
   * Demote an active pull request to draft.
   */
  async demotePR(prNumber: number, cwd: string): Promise<void> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);
    
    log.info('Demoting PR to draft', { prNumber });

    const env = this._buildEnv(provider, credentials);
    
    // Step 1: Get the node ID of the PR
    const viewArgs = ['pr', 'view', String(prNumber), '--json', 'id'];
    const viewResult = await this._execGh(viewArgs, cwd, env);
    
    let nodeId: string;
    try {
      const parsed = JSON.parse(viewResult);
      nodeId = parsed.id;
    } catch (err) {
      log.error('Failed to get PR node ID', { error: String(err), prNumber });
      throw new Error(`Failed to get PR node ID: ${err}`);
    }

    // Step 2: Use GraphQL mutation to convert to draft
    const mutation = `mutation { convertPullRequestToDraft(input: {pullRequestId: "${nodeId}"}) { pullRequest { id isDraft } } }`;
    const mutationArgs = [
      'api', 'graphql',
      '-f', `query=${mutation}`,
    ];

    await this._execGh(mutationArgs, cwd, env);
    log.info('PR demoted to draft', { prNumber });
  }

  /**
   * Build environment variables for gh CLI calls.
   * 
   * Security: Token is passed via GH_TOKEN env var, NEVER as CLI argument.
   */
  private _buildEnv(provider: RemoteProviderInfo, credentials: RemoteCredentials): Record<string, string> {
    const env: Record<string, string> = {};
    
    // Copy process.env, filtering out undefined values
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    
    if (credentials.token) {
      env.GH_TOKEN = credentials.token;
    }
    
    // For GitHub Enterprise, set GH_HOST
    if (provider.type === 'github-enterprise' && provider.hostname) {
      env.GH_HOST = provider.hostname;
    }
    
    return env;
  }

  /**
   * Execute a gh CLI command.
   */
  private async _execGh(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = this.spawner.spawn('gh', args, {
        cwd,
        env,
        shell: false,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          log.error('gh command failed', { args, code, stderr });
          reject(new Error(`gh command failed with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        log.error('gh command error', { args, error: String(err) });
        reject(err);
      });
    });
  }

  /**
   * Execute a gh api command.
   */
  private async _execGhApi(endpoint: string, cwd: string, env: Record<string, string>): Promise<string> {
    const args = ['api', endpoint];
    return this._execGh(args, cwd, env);
  }

  /**
   * Get inline review comments from the pull request.
   */
  private async _getReviewComments(
    ownerRepo: string,
    prNumber: number,
    cwd: string,
    env: Record<string, string>,
  ): Promise<PRComment[]> {
    try {
      const endpoint = `repos/${ownerRepo}/pulls/${prNumber}/comments`;
      const result = await this._execGhApi(endpoint, cwd, env);
      const parsed = JSON.parse(result);
      
      return parsed.map((comment: any) => ({
        id: String(comment.id),
        author: comment.user?.login || 'unknown',
        body: comment.body,
        path: comment.path,
        line: comment.line || comment.original_line,
        isResolved: false, // Review comments don't have direct resolution status
        source: this._categorizeAuthor(comment.user?.login, comment.body),
        threadId: comment.pull_request_review_id ? String(comment.pull_request_review_id) : undefined,
      }));
    } catch (err) {
      log.warn('Failed to get review comments', { error: String(err) });
      return [];
    }
  }

  /**
   * Get review submissions from the pull request.
   */
  private async _getReviews(
    ownerRepo: string,
    prNumber: number,
    cwd: string,
    env: Record<string, string>,
  ): Promise<PRComment[]> {
    try {
      const endpoint = `repos/${ownerRepo}/pulls/${prNumber}/reviews`;
      const result = await this._execGhApi(endpoint, cwd, env);
      const parsed = JSON.parse(result);
      
      return parsed
        .filter((review: any) => review.body && review.body.trim().length > 0)
        .map((review: any) => ({
          id: String(review.id),
          author: review.user?.login || 'unknown',
          body: review.body,
          isResolved: false,
          source: this._categorizeAuthor(review.user?.login, review.body),
          threadId: String(review.id),
        }));
    } catch (err) {
      log.warn('Failed to get reviews', { error: String(err) });
      return [];
    }
  }

  /**
   * Get general issue comments from the pull request.
   */
  private async _getIssueComments(
    ownerRepo: string,
    prNumber: number,
    cwd: string,
    env: Record<string, string>,
  ): Promise<PRComment[]> {
    try {
      const endpoint = `repos/${ownerRepo}/issues/${prNumber}/comments`;
      const result = await this._execGhApi(endpoint, cwd, env);
      const parsed = JSON.parse(result);
      
      return parsed.map((comment: any) => ({
        id: String(comment.id),
        author: comment.user?.login || 'unknown',
        body: comment.body,
        isResolved: false,
        source: this._categorizeAuthor(comment.user?.login, comment.body),
      }));
    } catch (err) {
      log.warn('Failed to get issue comments', { error: String(err) });
      return [];
    }
  }

  /**
   * Map gh CLI check state to our normalized status.
   */
  private _mapCheckState(state: string): 'passing' | 'failing' | 'pending' {
    const upper = state.toUpperCase();
    
    if (upper === 'SUCCESS') {
      return 'passing';
    }
    
    if (upper === 'FAILURE' || upper === 'ERROR') {
      return 'failing';
    }
    
    return 'pending';
  }

  /**
   * Map gh CLI PR state to normalized state.
   */
  private _mapPRState(state: string): 'open' | 'closed' | 'merged' {
    const upper = state.toUpperCase();
    
    if (upper === 'MERGED') {
      return 'merged';
    }
    
    if (upper === 'CLOSED') {
      return 'closed';
    }
    
    return 'open';
  }

  /**
   * Map alert severity to our normalized levels.
   */
  private _mapSeverity(severity?: string): 'critical' | 'high' | 'medium' | 'low' {
    if (!severity) return 'low';
    
    const lower = severity.toLowerCase();
    
    if (lower === 'critical' || lower === 'error') {
      return 'critical';
    }
    
    if (lower === 'high') {
      return 'high';
    }
    
    if (lower === 'medium' || lower === 'warning') {
      return 'medium';
    }
    
    return 'low';
  }

  /**
   * Categorize comment author as human, bot, copilot, or codeql.
   */
  private _categorizeAuthor(author?: string, body?: string): 'human' | 'copilot' | 'codeql' | 'bot' {
    const authorLower = (author || '').toLowerCase();
    const bodyLower = (body || '').toLowerCase();
    
    // Bot patterns
    if (authorLower.includes('[bot]') || 
        authorLower === 'github-actions[bot]' || 
        authorLower === 'dependabot[bot]') {
      return 'bot';
    }
    
    // Copilot patterns
    if (authorLower.includes('copilot')) {
      return 'copilot';
    }
    
    // CodeQL patterns
    if (authorLower.includes('codeql') || bodyLower.includes('codeql')) {
      return 'codeql';
    }
    
    return 'human';
  }
}
