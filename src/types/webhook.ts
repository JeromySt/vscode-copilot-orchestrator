/**
 * @fileoverview Webhook configuration and event types.
 * 
 * Webhooks allow external systems to receive notifications when
 * job stages complete or jobs finish. For security, webhooks are
 * restricted to localhost URLs only.
 * 
 * @module types/webhook
 */

/**
 * Events that can trigger webhook notifications.
 */
export type WebhookEvent = 'stage_complete' | 'job_complete' | 'job_failed';

/**
 * Configuration for webhook notifications.
 * 
 * @security Webhook URLs are restricted to localhost only (127.0.0.1, ::1, localhost)
 * to prevent cross-site scripting attacks.
 * 
 * @example
 * ```typescript
 * const webhook: WebhookConfig = {
 *   url: 'http://localhost:8080/callback',
 *   events: ['job_complete', 'job_failed'],
 *   headers: { 'Authorization': 'Bearer token123' }
 * };
 * ```
 */
export interface WebhookConfig {
  /** 
   * Localhost URL to POST notifications to.
   * Must be localhost, 127.0.0.1, ::1, or 127.x.x.x.
   */
  url: string;
  
  /** 
   * Events to subscribe to.
   * If not specified, all events are sent.
   */
  events?: WebhookEvent[];
  
  /** 
   * Additional HTTP headers to send with webhook requests.
   * Useful for authentication (e.g., Authorization header).
   */
  headers?: Record<string, string>;
}

/**
 * Payload sent to webhook endpoints.
 */
export interface WebhookPayload {
  /** The event type that triggered this notification */
  event: WebhookEvent;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Job information at the time of the event */
  job: {
    id: string;
    name: string;
    status: string;
    currentStep: string | null;
    stepStatuses: Record<string, string | undefined>;
    /** The stage that completed (for stage_complete events) */
    stage: string | null;
    /** Progress percentage (0-100, or -1 if failed) */
    progress: number;
    workSummary: object | null;
    metrics: object | null;
    /** Duration in seconds since job started */
    duration: number | null;
  };
}
