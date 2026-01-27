/**
 * @fileoverview Interface for webhook notifications.
 * 
 * Abstracts webhook delivery for testability and
 * potential future enhancements (retry logic, queuing, etc.).
 * 
 * @module interfaces/IWebhookNotifier
 */

import { Job, WebhookConfig, WebhookEvent } from '../types';

/**
 * Result of a webhook notification attempt.
 */
export interface WebhookResult {
  /** Whether the notification was sent successfully */
  success: boolean;
  /** HTTP status code from the webhook endpoint */
  statusCode?: number;
  /** Error message if the notification failed */
  error?: string;
}

/**
 * Interface for sending webhook notifications.
 * 
 * Implementations must enforce localhost-only URLs for security.
 * 
 * @example
 * ```typescript
 * await notifier.notify(job, 'job_complete');
 * // Sends POST to job.webhook.url with job status
 * ```
 */
export interface IWebhookNotifier {
  /**
   * Send a webhook notification for a job event.
   * 
   * @param job - The job that triggered the event
   * @param event - The type of event
   * @param stage - The stage name (for 'stage_complete' events)
   * @returns Result of the notification attempt
   * 
   * @security Will reject non-localhost URLs
   */
  notify(job: Job, event: WebhookEvent, stage?: string): Promise<WebhookResult>;
  
  /**
   * Validate that a webhook URL is allowed.
   * Only localhost URLs are permitted for security.
   * 
   * @param url - URL to validate
   * @returns true if the URL is a valid localhost URL
   */
  isValidUrl(url: string): boolean;
}
