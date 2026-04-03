/**
 * @fileoverview Azure DevOps PR service implementation.
 * 
 * Implements IRemotePRService for Azure DevOps using REST API directly.
 * Does NOT require Azure CLI installation - uses direct HTTP calls.
 * 
 * @module git/remotePR/adoPRService
 */

import * as https from 'https';
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
const API_REQUEST_TIMEOUT_MS = 30000;

/**
 * Azure DevOps PR service implementation.
 * 
 * Uses ADO REST API v7.0 directly (no az CLI dependency).
 * 
 * Authentication:
 * - PAT tokens: Basic auth with base64(':' + token)
 * - Bearer tokens: Bearer header
 * 
 * Supported ADO URL patterns:
 * - https://dev.azure.com/{org}/{project}/_git/{repo}
 * - https://{org}.visualstudio.com/{project}/_git/{repo}
 * - {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
 */
export class AdoPRService implements IRemotePRService {
  constructor(
    _spawner: IProcessSpawner,
    private readonly detector: IRemoteProviderDetector,
  ) {}

  /**
   * Detect the remote provider from repository.
   * Delegates to the detector.
   */
  async detectProvider(repoPath: string): Promise<RemoteProviderInfo> {
    return this.detector.detect(repoPath);
  }

  /**
   * Acquire credentials for the provider.
   * Delegates to the detector.
   */
  async acquireCredentials(provider: RemoteProviderInfo, repoPath?: string): Promise<RemoteCredentials> {
    return this.detector.acquireCredentials(provider, repoPath);
  }

  /**
   * Create a pull request in Azure DevOps.
   * 
   * POST {org}/{project}/_apis/git/repositories/{repo}/pullrequests?api-version=7.0
   */
  async createPR(options: PRCreateOptions): Promise<PRCreateResult> {
    const provider = await this.detectProvider(options.cwd);
    const credentials = await this.acquireCredentials(provider);

    if (!provider.organization || !provider.project) {
      throw new Error('Azure DevOps organization and project are required');
    }

    const apiUrl = this._buildApiUrl(provider, `git/repositories/${provider.repoName}/pullrequests`);
    
    const body = {
      sourceRefName: `refs/heads/${options.headBranch}`,
      targetRefName: `refs/heads/${options.baseBranch}`,
      title: options.title,
      description: options.body,
    };

    log.info('Creating Azure DevOps PR', {
      org: provider.organization,
      project: provider.project,
      repo: provider.repoName,
      source: options.headBranch,
      target: options.baseBranch,
    });

    try {
      const response = await this._apiRequest('POST', apiUrl, credentials, body);
      
      const prNumber = response.pullRequestId;
      const prUrl = response.url || this._buildPRUrl(provider, prNumber);

      log.info('Azure DevOps PR created', { prNumber, prUrl });
      
      return { prNumber, prUrl };
    } catch (error: any) {
      log.error('Failed to create Azure DevOps PR', {
        error: error.message,
        org: provider.organization,
        project: provider.project,
      });
      throw new Error(`Failed to create ADO PR: ${error.message}`);
    }
  }

  /**
   * Get CI/CD check statuses for a pull request.
   * 
   * GET {org}/{project}/_apis/build/builds?reasonFilter=pullRequest&$top=50&api-version=7.0
   */
  async getPRChecks(prNumber: number, cwd: string): Promise<PRCheck[]> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);

    const apiUrl = this._buildApiUrl(provider, `build/builds`, {
      reasonFilter: 'pullRequest',
      $top: '50',
    });

    log.debug('Fetching Azure DevOps PR checks', { prNumber });

    try {
      const response = await this._apiRequest('GET', apiUrl, credentials);
      const builds = response.value || [];

      // Filter builds that are associated with this PR
      const prBuilds = builds.filter((build: any) => {
        // ADO builds associated with PRs have triggerInfo with pr.number
        return build.triggerInfo?.['pr.number'] === prNumber.toString() ||
               build.triggerInfo?.['pr.number'] === prNumber;
      });

      const checks: PRCheck[] = prBuilds.map((build: any) => {
        const status = this._mapBuildStatus(build.result, build.status);
        return {
          name: build.definition?.name || 'Build',
          status,
          url: build._links?.web?.href,
        };
      });

      // Attach the head SHA from the most recent build's sourceVersion
      const latestSha = prBuilds[0]?.sourceVersion;
      if (latestSha && checks.length > 0) checks[0].headSha = latestSha;

      log.debug('Fetched Azure DevOps PR checks', { prNumber, count: checks.length });
      return checks;
    } catch (error: any) {
      log.error('Failed to fetch Azure DevOps PR checks', {
        error: error.message,
        prNumber,
      });
      throw new Error(`Failed to get ADO PR checks: ${error.message}`);
    }
  }

  /**
   * Get all comments and review threads for a pull request.
   * 
   * GET {org}/{project}/_apis/git/repositories/{repo}/pullRequests/{prId}/threads?api-version=7.0
   */
  async getPRComments(prNumber: number, cwd: string): Promise<PRComment[]> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);

    const apiUrl = this._buildApiUrl(
      provider,
      `git/repositories/${provider.repoName}/pullRequests/${prNumber}/threads`
    );

    log.debug('Fetching Azure DevOps PR comments', { prNumber });

    try {
      const response = await this._apiRequest('GET', apiUrl, credentials);
      const threads = response.value || [];

      const comments: PRComment[] = [];
      
      for (const thread of threads) {
        const threadId = thread.id?.toString();
        const isResolved = thread.status === 'fixed' || thread.status === 'closed';
        
        // Each thread can have multiple comments — first is root, rest are replies
        const threadComments = thread.comments || [];
        if (threadComments.length === 0) continue;

        const root = threadComments[0];
        const rootAuthor = root.author?.displayName || 'Unknown';
        const rootSource = this._categorizeCommentSource(rootAuthor, root);

        const replies = threadComments.slice(1).map((r: any) => ({
          id: r.id?.toString(),
          author: r.author?.displayName || 'Unknown',
          body: r.content || '',
          url: r._links?.self?.href,
        }));

        comments.push({
          id: root.id?.toString(),
          author: rootAuthor,
          body: root.content || '',
          path: thread.threadContext?.filePath,
          line: thread.threadContext?.rightFileStart?.line,
          isResolved,
          source: rootSource,
          threadId,
          url: root._links?.self?.href,
          replies: replies.length > 0 ? replies : undefined,
        });
      }

      log.debug('Fetched Azure DevOps PR comments', { prNumber, count: comments.length });
      return comments;
    } catch (error: any) {
      log.error('Failed to fetch Azure DevOps PR comments', {
        error: error.message,
        prNumber,
      });
      throw new Error(`Failed to get ADO PR comments: ${error.message}`);
    }
  }

  /**
   * Get security alerts for a branch.
   * 
   * GET {org}/{project}/_apis/alert/repositories/{repo}/alerts?criteria.ref=refs/heads/<branch>&api-version=7.2-preview.1
   * 
   * Gracefully handles 404/403 if Advanced Security is not enabled.
   */
  async getSecurityAlerts(branchName: string, cwd: string): Promise<PRSecurityAlert[]> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);

    const apiUrl = this._buildApiUrl(
      provider,
      `alert/repositories/${provider.repoName}/alerts`,
      { 'criteria.ref': `refs/heads/${branchName}` },
      '7.2-preview.1'
    );

    log.debug('Fetching Azure DevOps security alerts', { branchName });

    try {
      const response = await this._apiRequest('GET', apiUrl, credentials);
      const alerts = response.value || [];

      const securityAlerts: PRSecurityAlert[] = alerts.map((alert: any) => ({
        id: alert.alertId?.toString() || alert.id?.toString(),
        severity: this._mapAlertSeverity(alert.severity),
        description: alert.title || alert.alertType || 'Security Alert',
        file: alert.physicalLocation?.artifactLocation?.uri,
        resolved: alert.state === 'dismissed' || alert.state === 'fixed',
      }));

      log.debug('Fetched Azure DevOps security alerts', { branchName, count: securityAlerts.length });
      return securityAlerts;
    } catch (error: any) {
      // Advanced Security might not be enabled - return empty array
      if (error.statusCode === 404 || error.statusCode === 403) {
        log.debug('Azure DevOps Advanced Security not available', { branchName });
        return [];
      }

      log.error('Failed to fetch Azure DevOps security alerts', {
        error: error.message,
        branchName,
      });
      throw new Error(`Failed to get ADO security alerts: ${error.message}`);
    }
  }

  /**
   * Reply to a comment on a pull request.
   * 
   * POST {org}/{project}/_apis/git/repositories/{repo}/pullRequests/{prId}/threads/{threadId}/comments?api-version=7.0
   */
  async replyToComment(prNumber: number, commentId: string, body: string, cwd: string): Promise<void> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);

    // In ADO, we need the threadId to reply (passed as commentId for compatibility)
    const threadId = commentId;

    const apiUrl = this._buildApiUrl(
      provider,
      `git/repositories/${provider.repoName}/pullRequests/${prNumber}/threads/${threadId}/comments`
    );

    const requestBody = {
      content: body,
      commentType: 1, // Text comment
    };

    log.debug('Replying to Azure DevOps PR comment', { prNumber, threadId });

    try {
      await this._apiRequest('POST', apiUrl, credentials, requestBody);
      log.info('Replied to Azure DevOps PR comment', { prNumber, threadId });
    } catch (error: any) {
      log.error('Failed to reply to Azure DevOps PR comment', {
        error: error.message,
        prNumber,
        threadId,
      });
      throw new Error(`Failed to reply to ADO PR comment: ${error.message}`);
    }
  }

  /**
   * Add a general comment to a pull request.
   * Creates a new thread with a single comment (ADO equivalent of issue comment).
   */
  async addIssueComment(prNumber: number, body: string, cwd: string): Promise<void> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);

    const apiUrl = this._buildApiUrl(
      provider,
      `git/repositories/${provider.repoName}/pullRequests/${prNumber}/threads`
    );

    const requestBody = {
      comments: [{ content: body, commentType: 1 }],
      status: 1, // Active
    };

    log.debug('Adding general comment to Azure DevOps PR', { prNumber });

    try {
      await this._apiRequest('POST', apiUrl, credentials, requestBody);
      log.info('General comment added to Azure DevOps PR', { prNumber });
    } catch (error: any) {
      log.error('Failed to add general comment to Azure DevOps PR', {
        error: error.message,
        prNumber,
      });
      throw new Error(`Failed to add general comment to ADO PR: ${error.message}`);
    }
  }

  /**
   * Resolve a review thread on a pull request.
   * 
   * PATCH {org}/{project}/_apis/git/repositories/{repo}/pullRequests/{prId}/threads/{threadId}?api-version=7.0
   */
  async resolveThread(prNumber: number, threadId: string, cwd: string): Promise<void> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);

    const apiUrl = this._buildApiUrl(
      provider,
      `git/repositories/${provider.repoName}/pullRequests/${prNumber}/threads/${threadId}`
    );

    const body = {
      status: 'fixed',
    };

    log.debug('Resolving Azure DevOps PR thread', { prNumber, threadId });

    try {
      await this._apiRequest('PATCH', apiUrl, credentials, body);
      log.info('Resolved Azure DevOps PR thread', { prNumber, threadId });
    } catch (error: any) {
      log.error('Failed to resolve Azure DevOps PR thread', {
        error: error.message,
        prNumber,
        threadId,
      });
      throw new Error(`Failed to resolve ADO PR thread: ${error.message}`);
    }
  }

  /**
   * List pull requests filtered by author or assignee.
   * 
   * GET {org}/{project}/_apis/git/repositories/{repo}/pullrequests?api-version=7.0
   */
  async listPRs(cwd: string, options?: PRListOptions): Promise<PRListItem[]> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);

    const queryParams: Record<string, string> = {};

    // Map options to ADO query parameters
    if (options?.state) {
      if (options.state === 'open') {
        queryParams['searchCriteria.status'] = 'active';
      } else if (options.state === 'closed') {
        queryParams['searchCriteria.status'] = 'completed';
      } else {
        queryParams['searchCriteria.status'] = 'all';
      }
    }

    if (options?.author) {
      queryParams['searchCriteria.creatorId'] = options.author;
    }

    if (options?.limit) {
      queryParams['$top'] = String(options.limit);
    }

    const apiUrl = this._buildApiUrl(
      provider,
      `git/repositories/${provider.repoName}/pullrequests`,
      queryParams
    );

    log.debug('Listing Azure DevOps PRs', options);

    try {
      const response = await this._apiRequest('GET', apiUrl, credentials);
      const prs = response.value || [];

      const listItems: PRListItem[] = prs.map((pr: any) => {
        const headBranch = this._extractBranchName(pr.sourceRefName);
        const baseBranch = this._extractBranchName(pr.targetRefName);
        const state = this._mapADOPRStatus(pr.status);

        return {
          prNumber: pr.pullRequestId,
          title: pr.title,
          headBranch,
          baseBranch,
          state,
          isDraft: pr.isDraft || false,
          author: pr.createdBy?.displayName || pr.createdBy?.uniqueName || 'unknown',
          url: this._buildPRUrl(provider, pr.pullRequestId),
        };
      });

      log.info('Azure DevOps PRs listed', { count: listItems.length });
      return listItems;
    } catch (error: any) {
      log.error('Failed to list Azure DevOps PRs', { error: error.message });
      throw new Error(`Failed to list ADO PRs: ${error.message}`);
    }
  }

  /**
   * Get detailed information about a specific pull request.
   * 
   * GET {org}/{project}/_apis/git/repositories/{repo}/pullRequests/{prId}?api-version=7.0
   */
  async getPRDetails(prNumber: number, cwd: string): Promise<PRDetails> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);

    const apiUrl = this._buildApiUrl(
      provider,
      `git/repositories/${provider.repoName}/pullRequests/${prNumber}`
    );

    log.debug('Getting Azure DevOps PR details', { prNumber });

    try {
      const pr = await this._apiRequest('GET', apiUrl, credentials);

      const headBranch = this._extractBranchName(pr.sourceRefName);
      const baseBranch = this._extractBranchName(pr.targetRefName);
      const state = this._mapADOPRStatus(pr.status);

      const details: PRDetails = {
        prNumber: pr.pullRequestId,
        title: pr.title,
        headBranch,
        baseBranch,
        isDraft: pr.isDraft || false,
        state,
        author: pr.createdBy?.displayName || pr.createdBy?.uniqueName || 'unknown',
        url: this._buildPRUrl(provider, pr.pullRequestId),
        body: pr.description,
      };

      log.info('Azure DevOps PR details retrieved', { prNumber });
      return details;
    } catch (error: any) {
      log.error('Failed to get Azure DevOps PR details', {
        error: error.message,
        prNumber,
      });
      throw new Error(`Failed to get ADO PR details: ${error.message}`);
    }
  }

  /**
   * Abandon (close) a pull request without merging.
   * 
   * PATCH {org}/{project}/_apis/git/repositories/{repo}/pullRequests/{prId}?api-version=7.0
   */
  async mergePR(prNumber: number, cwd: string, options?: {
    method?: 'squash' | 'merge' | 'rebase';
    admin?: boolean;
    deleteSourceBranch?: boolean;
    title?: string;
    body?: string;
  }): Promise<{ commitSha: string }> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);

    log.info('Merging Azure DevOps PR', { prNumber, method: options?.method });

    const apiUrl = this._buildApiUrl(
      provider,
      `git/repositories/${provider.repoName}/pullRequests/${prNumber}`
    );

    let response: any;
    try {
      response = await this._apiRequest('PATCH', apiUrl, credentials, {
        status: 'completed',
        lastMergeSourceCommit: { commitId: '' },
        completionOptions: {
          deleteSourceBranch: options?.deleteSourceBranch !== false,
          mergeStrategy: options?.method === 'rebase' ? 'rebaseMerge' : (options?.method === 'squash' ? 'squash' : 'noFastForward'),
          bypassPolicy: options?.admin || false,
          ...(options?.title ? { mergeCommitMessage: options.title } : {}),
        },
      });
    } catch (err: any) {
      throw new Error(`Failed to merge ADO PR: ${err.message}`);
    }

    const commitSha = response?.lastMergeCommit?.commitId || '';
    log.info('Azure DevOps PR merged', { prNumber, commitSha });
    return { commitSha };
  }

  async abandonPR(prNumber: number, cwd: string, comment?: string): Promise<void> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);

    log.info('Abandoning Azure DevOps PR', { prNumber, hasComment: !!comment });

    // Step 1: Add comment if provided
    if (comment) {
      try {
        const threadsUrl = this._buildApiUrl(
          provider,
          `git/repositories/${provider.repoName}/pullRequests/${prNumber}/threads`
        );

        const threadBody = {
          comments: [
            {
              content: comment,
              commentType: 1,
            },
          ],
          status: 'active',
        };

        await this._apiRequest('POST', threadsUrl, credentials, threadBody);
      } catch (error: any) {
        log.warn('Failed to add closing comment', { error: error.message, prNumber });
        // Continue with abandonment even if comment fails
      }
    }

    // Step 2: Set PR status to abandoned
    const apiUrl = this._buildApiUrl(
      provider,
      `git/repositories/${provider.repoName}/pullRequests/${prNumber}`
    );

    const body = {
      status: 'abandoned',
    };

    try {
      await this._apiRequest('PATCH', apiUrl, credentials, body);
      log.info('Azure DevOps PR abandoned', { prNumber });
    } catch (error: any) {
      log.error('Failed to abandon Azure DevOps PR', {
        error: error.message,
        prNumber,
      });
      throw new Error(`Failed to abandon ADO PR: ${error.message}`);
    }
  }

  /**
   * Promote a draft pull request to ready-for-review.
   * 
   * PATCH {org}/{project}/_apis/git/repositories/{repo}/pullRequests/{prId}?api-version=7.0
   */
  async promotePR(prNumber: number, cwd: string): Promise<void> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);

    log.info('Promoting Azure DevOps PR to ready', { prNumber });

    const apiUrl = this._buildApiUrl(
      provider,
      `git/repositories/${provider.repoName}/pullRequests/${prNumber}`
    );

    const body = {
      isDraft: false,
    };

    try {
      await this._apiRequest('PATCH', apiUrl, credentials, body);
      log.info('Azure DevOps PR promoted to ready', { prNumber });
    } catch (error: any) {
      log.error('Failed to promote Azure DevOps PR', {
        error: error.message,
        prNumber,
      });
      throw new Error(`Failed to promote ADO PR: ${error.message}`);
    }
  }

  /**
   * Demote an active pull request to draft.
   * 
   * PATCH {org}/{project}/_apis/git/repositories/{repo}/pullRequests/{prId}?api-version=7.0
   */
  async demotePR(prNumber: number, cwd: string): Promise<void> {
    const provider = await this.detectProvider(cwd);
    const credentials = await this.acquireCredentials(provider);

    log.info('Demoting Azure DevOps PR to draft', { prNumber });

    const apiUrl = this._buildApiUrl(
      provider,
      `git/repositories/${provider.repoName}/pullRequests/${prNumber}`
    );

    const body = {
      isDraft: true,
    };

    try {
      await this._apiRequest('PATCH', apiUrl, credentials, body);
      log.info('Azure DevOps PR demoted to draft', { prNumber });
    } catch (error: any) {
      log.error('Failed to demote Azure DevOps PR', {
        error: error.message,
        prNumber,
      });
      throw new Error(`Failed to demote ADO PR: ${error.message}`);
    }
  }

  /**
   * Build the full API URL for an Azure DevOps endpoint.
   */
  private _buildApiUrl(
    provider: RemoteProviderInfo,
    endpoint: string,
    queryParams?: Record<string, string>,
    apiVersion: string = '7.0'
  ): string {
    const baseUrl = `https://dev.azure.com/${provider.organization}/${provider.project}/_apis/`;
    let url = `${baseUrl}${endpoint}`;
    
    const params = new URLSearchParams(queryParams || {});
    params.set('api-version', apiVersion);
    
    return `${url}?${params.toString()}`;
  }

  /**
   * Build the web URL for a pull request.
   */
  private _buildPRUrl(provider: RemoteProviderInfo, prNumber: number): string {
    return `https://dev.azure.com/${provider.organization}/${provider.project}/_git/${provider.repoName}/pullrequest/${prNumber}`;
  }

  /**
   * Build authentication headers for Azure DevOps API requests.
   * 
   * Security: Token is NEVER logged, only passed in Authorization header.
   */
  private _buildAuthHeaders(credentials: RemoteCredentials): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (credentials.token) {
      // Check if it's a Bearer token (from az CLI) or PAT
      if (credentials.tokenSource === 'az-cli') {
        headers['Authorization'] = `Bearer ${credentials.token}`;
      } else {
        // PAT token - use Basic auth with base64(':' + token)
        const encodedToken = Buffer.from(':' + credentials.token).toString('base64');
        headers['Authorization'] = `Basic ${encodedToken}`;
      }
    }

    return headers;
  }

  /**
   * Make an HTTP request to the Azure DevOps API.
   * 
   * Handles JSON serialization, auth headers, and error handling.
   */
  private async _apiRequest(
    method: string,
    url: string,
    credentials: RemoteCredentials,
    body?: object
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const headers = this._buildAuthHeaders(credentials);

      const options: https.RequestOptions = {
        method,
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        headers,
      };

      const bodyStr = body ? JSON.stringify(body) : undefined;
      if (bodyStr) {
        headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();
      }

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          const statusCode = res.statusCode || 0;
          
          if (statusCode >= 200 && statusCode < 300) {
            try {
              const parsed = data ? JSON.parse(data) : {};
              resolve(parsed);
            } catch (error: any) {
              reject(new Error(`Failed to parse response: ${error.message}`));
            }
          } else {
            let errorMessage = `HTTP ${statusCode}`;
            try {
              const errorBody = JSON.parse(data);
              errorMessage = errorBody.message || errorMessage;
            } catch {
              // Ignore parse errors for error body
            }
            
            const error: any = new Error(errorMessage);
            error.statusCode = statusCode;
            reject(error);
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.setTimeout(API_REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error(`Azure DevOps API request timed out after ${API_REQUEST_TIMEOUT_MS}ms`));
      });

      if (bodyStr) {
        req.write(bodyStr);
      }

      req.end();
    });
  }

  /**
   * Map Azure DevOps build status to PR check status.
   */
  private _mapBuildStatus(result: string, status: string): 'passing' | 'failing' | 'pending' {
    // If build is not completed, it's pending
    if (status === 'inProgress' || status === 'notStarted') {
      return 'pending';
    }

    // Map result to status
    switch (result) {
      case 'succeeded':
        return 'passing';
      case 'failed':
      case 'canceled':
        return 'failing';
      default:
        return 'pending';
    }
  }

  /**
   * Map Azure DevOps alert severity to standardized severity.
   */
  private _mapAlertSeverity(severity: string): 'critical' | 'high' | 'medium' | 'low' {
    const severityLower = (severity || '').toLowerCase();
    
    if (severityLower.includes('critical')) return 'critical';
    if (severityLower.includes('high')) return 'high';
    if (severityLower.includes('medium') || severityLower.includes('moderate')) return 'medium';
    return 'low';
  }

  /**
   * Categorize comment source based on author name patterns.
   */
  private _categorizeCommentSource(
    author: string,
    comment: any
  ): 'human' | 'copilot' | 'codeql' | 'bot' {
    const authorLower = author.toLowerCase();
    
    if (authorLower.includes('copilot')) {
      return 'copilot';
    }
    
    if (authorLower.includes('codeql') || authorLower.includes('security')) {
      return 'codeql';
    }
    
    // ADO system comments or bots
    if (comment.author?.isContainer || authorLower.includes('bot') || authorLower.includes('system')) {
      return 'bot';
    }
    
    return 'human';
  }

  /**
   * Extract branch name from ADO ref format (refs/heads/branch-name).
   */
  private _extractBranchName(refName: string): string {
    if (!refName) {
      return '';
    }
    
    const prefix = 'refs/heads/';
    if (refName.startsWith(prefix)) {
      return refName.substring(prefix.length);
    }
    
    return refName;
  }

  /**
   * Map Azure DevOps PR status to normalized state.
   */
  private _mapADOPRStatus(status: string): 'open' | 'closed' | 'merged' {
    const statusLower = (status || '').toLowerCase();
    
    if (statusLower === 'active') {
      return 'open';
    }
    
    if (statusLower === 'completed') {
      return 'merged';
    }
    
    if (statusLower === 'abandoned') {
      return 'closed';
    }
    
    return 'open';
  }
}
