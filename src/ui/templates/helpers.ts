/**
 * @fileoverview Shared UI helper functions for webview templates.
 *
 * Reusable utility functions used across multiple panel templates.
 *
 * @module ui/templates/helpers
 */

/**
 * Escape HTML special characters to prevent XSS in webview content.
 *
 * @param str - The raw string to escape.
 * @returns The escaped string with `&`, `<`, `>`, and `"` replaced by HTML entities.
 *
 * @example
 * ```ts
 * escapeHtml('<script>alert("xss")</script>');
 * // '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
 * ```
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Format a duration in seconds to a human-readable string.
 *
 * @param seconds - The duration in whole seconds.
 * @returns A string like `"1h 5m 30s"`, `"5m"`, or `"0s"`.
 *
 * @example
 * ```ts
 * formatDuration(3661); // '1h 1m 1s'
 * formatDuration(0);    // '0s'
 * ```
 */
export function formatDuration(seconds: number): string {
  if (seconds < 0) {return '0s';}
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: string[] = [];
  if (hours > 0) {parts.push(`${hours}h`);}
  if (minutes > 0) {parts.push(`${minutes}m`);}
  if (secs > 0 || parts.length === 0) {parts.push(`${secs}s`);}
  return parts.join(' ');
}

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * Values under 1 second are displayed as `"< 1s"`.
 *
 * @param ms - The duration in milliseconds.
 * @returns A string like `"2h 30m"`, `"45s"`, or `"< 1s"`.
 */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) {return '< 1s';}
  const secs = Math.floor(ms / 1000);
  if (secs < 60) {return secs + 's';}
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) {return mins + 'm ' + remSecs + 's';}
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return hours + 'h ' + remMins + 'm';
}

/**
 * Generate a simple error page HTML document.
 *
 * Renders a styled error heading and message using VS Code theme colors.
 * Uses a strict Content Security Policy (no scripts, inline styles only).
 *
 * @param message - The error description to display.
 * @returns A complete HTML document string.
 */
export function errorPageHtml(message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
</head>
<body style="padding: 20px; color: var(--vscode-errorForeground);">
  <h2>Error</h2>
  <p>${message}</p>
</body>
</html>`;
}

/**
 * Generate a loading spinner page HTML document.
 *
 * Renders a centered CSS-animated spinner with a customizable text label.
 * Uses a strict Content Security Policy (no scripts, inline styles only).
 *
 * @param text - The loading message to display below the spinner.
 *   Defaults to `'Loading...'`.
 * @returns A complete HTML document string.
 */
export function loadingPageHtml(text: string = 'Loading...'): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .loading-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 60px 20px;
    }
    .loading-spinner {
      width: 40px;
      height: 40px;
      border: 3px solid var(--vscode-panel-border);
      border-top-color: var(--vscode-progressBar-background);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-text { margin-top: 16px; font-size: 14px; opacity: 0.8; }
  </style>
</head>
<body>
  <div class="loading-container">
    <div class="loading-spinner"></div>
    <div class="loading-text">${escapeHtml(text)}</div>
  </div>
</body>
</html>`;
}
