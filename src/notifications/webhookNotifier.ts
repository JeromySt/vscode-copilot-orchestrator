/**
 * @fileoverview Webhook notification service.
 * 
 * Handles sending HTTP notifications to configured webhook endpoints
 * when job events occur. Enforces localhost-only URLs for security.
 * 
 * @module notifications/webhookNotifier
 */

import * as http from 'http';
import * as https from 'https';
import { Job, WebhookEvent, WebhookConfig, WebhookPayload } from '../types';
import { IWebhookNotifier, WebhookResult } from '../interfaces/IWebhookNotifier';

/**
 * Default implementation of webhook notifications.
 * 
 * Security: Only allows localhost URLs to prevent XSS attacks.
 * Allowed hosts: localhost, 127.0.0.1, ::1, 127.x.x.x
 * 
 * @example
 * ```typescript
 * const notifier = new WebhookNotifier();
 * const result = await notifier.notify(job, 'job_complete');
 * if (!result.success) {
 *   console.error('Webhook failed:', result.error);
 * }
 * ```
 */
export class WebhookNotifier implements IWebhookNotifier {
  /** Logger function for webhook events */
  private logger?: (jobId: string, message: string) => void;
  
  /**
   * Create a new WebhookNotifier.
   * @param logger - Optional logger function for events
   */
  constructor(logger?: (jobId: string, message: string) => void) {
    this.logger = logger;
  }
  
  /**
   * Validate that a URL is a localhost URL.
   * 
   * @param urlString - URL to validate
   * @returns true if the URL is localhost
   */
  isValidUrl(urlString: string): boolean {
    try {
      const url = new URL(urlString);
      const hostname = url.hostname.toLowerCase();
      
      // Allow localhost variants
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
        return true;
      }
      
      // Allow loopback range 127.x.x.x
      if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
        return true;
      }
      
      // Block everything else (including 0.0.0.0 which could bind externally)
      return false;
    } catch {
      return false;
    }
  }
  
  /**
   * Send a webhook notification for a job event.
   * 
   * @param job - The job that triggered the event
   * @param event - The type of event
   * @param stage - The stage name (for 'stage_complete' events)
   * @returns Result of the notification attempt
   */
  async notify(job: Job, event: WebhookEvent, stage?: string): Promise<WebhookResult> {
    // Check if webhook is configured
    if (!job.webhook?.url) {
      return { success: true }; // No webhook = nothing to do
    }
    
    // Security: Validate localhost-only URL
    if (!this.isValidUrl(job.webhook.url)) {
      this.log(job.id, `[webhook] BLOCKED: Non-local URL not allowed (${job.webhook.url})`);
      return {
        success: false,
        error: 'Non-localhost URLs are not allowed for security'
      };
    }
    
    // Check if this event type is subscribed
    const subscribedEvents = job.webhook.events || ['stage_complete', 'job_complete', 'job_failed'];
    if (!subscribedEvents.includes(event)) {
      return { success: true }; // Event not subscribed = skip silently
    }
    
    // Build the payload
    const payload = this.buildPayload(job, event, stage);
    
    // Send the notification
    return this.sendRequest(job.webhook, payload, job.id, event);
  }
  
  /**
   * Build the webhook payload from job state.
   */
  private buildPayload(job: Job, event: WebhookEvent, stage?: string): WebhookPayload {
    return {
      event,
      timestamp: Date.now(),
      job: {
        id: job.id,
        name: job.name,
        status: job.status,
        currentStep: job.currentStep || null,
        stepStatuses: (job.stepStatuses || {}) as Record<string, string | undefined>,
        stage: stage || null,
        progress: this.calculateProgress(job),
        workSummary: job.workSummary || null,
        metrics: job.metrics || null,
        duration: job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : null
      }
    };
  }
  
  /**
   * Calculate job progress as a percentage.
   */
  private calculateProgress(job: Job): number {
    const phaseWeights: Record<string, number> = {
      'prechecks': 10, 
      'work': 70, 
      'postchecks': 85, 
      'mergeback': 95, 
      'cleanup': 100
    };
    
    if (job.status === 'succeeded') return 100;
    if (job.status === 'failed' || job.status === 'canceled') return -1;
    if (job.status === 'queued') return 0;
    
    const currentStep = job.currentStep;
    if (!currentStep) return 5;
    
    const stepStatuses = job.stepStatuses || {};
    const phases = ['prechecks', 'work', 'postchecks', 'mergeback', 'cleanup'];
    let progress = 0;
    
    for (const phase of phases) {
      const status = stepStatuses[phase as keyof typeof stepStatuses];
      if (status === 'success' || status === 'skipped') {
        progress = phaseWeights[phase];
      } else if (phase === currentStep) {
        const prevPhase = phases[phases.indexOf(phase) - 1];
        const prevProgress = prevPhase ? phaseWeights[prevPhase] : 0;
        progress = prevProgress + (phaseWeights[phase] - prevProgress) / 2;
        break;
      }
    }
    
    return Math.round(progress);
  }
  
  /**
   * Send HTTP request to the webhook endpoint.
   */
  private sendRequest(
    config: WebhookConfig, 
    payload: WebhookPayload, 
    jobId: string, 
    event: WebhookEvent
  ): Promise<WebhookResult> {
    return new Promise((resolve) => {
      try {
        const url = new URL(config.url);
        const client = url.protocol === 'https:' ? https : http;
        
        const options: http.RequestOptions = {
          method: 'POST',
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'copilot-orchestrator/0.4.0',
            'X-Webhook-Event': event,
            'X-Job-Id': jobId,
            ...(config.headers || {})
          }
        };
        
        const req = client.request(options, (res) => {
          this.log(jobId, `[webhook] ${event} notification sent to ${config.url} - HTTP ${res.statusCode}`);
          resolve({
            success: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300,
            statusCode: res.statusCode
          });
        });
        
        req.on('error', (err) => {
          this.log(jobId, `[webhook] Failed to send ${event} notification: ${err.message}`);
          resolve({
            success: false,
            error: err.message
          });
        });
        
        req.write(JSON.stringify(payload));
        req.end();
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.log(jobId, `[webhook] Error sending notification: ${errorMsg}`);
        resolve({
          success: false,
          error: errorMsg
        });
      }
    });
  }
  
  /**
   * Log a message if logger is configured.
   */
  private log(jobId: string, message: string): void {
    if (this.logger) {
      this.logger(jobId, message);
    }
  }
}
