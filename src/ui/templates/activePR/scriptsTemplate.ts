/**
 * @fileoverview Active PR panel scripts template.
 *
 * Renders the script tag for the active PR panel webview.
 *
 * @module ui/templates/activePR/scriptsTemplate
 */

/**
 * Renders the script tag for the active PR panel.
 *
 * @param scriptUri - URI to the bundled webview script.
 * @param nonce - CSP nonce for script execution.
 * @returns HTML script tag.
 */
export function renderActivePRScripts(scriptUri: string, nonce: string): string {
  return `
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  
  // Action button handlers
  function monitor() {
    vscode.postMessage({ type: 'monitor' });
  }
  
  function pause() {
    vscode.postMessage({ type: 'pause' });
  }
  
  function promote() {
    vscode.postMessage({ type: 'promote' });
  }
  
  function demote() {
    vscode.postMessage({ type: 'demote' });
  }
  
  function abandon() {
    vscode.postMessage({ type: 'abandon' });
  }
  
  function remove() {
    vscode.postMessage({ type: 'remove' });
  }
  
  function refresh() {
    vscode.postMessage({ type: 'refresh' });
  }
  
  // Timer update for monitoring duration
  function updateTimer() {
    const timerEl = document.getElementById('monitoring-duration');
    if (!timerEl) return;
    
    const startedAt = parseInt(timerEl.getAttribute('data-started') || '0', 10);
    if (startedAt === 0) return;
    
    const now = Date.now();
    const elapsed = now - startedAt;
    timerEl.textContent = formatDuration(elapsed);
  }
  
  function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return days + 'd ' + (hours % 24) + 'h ' + (minutes % 60) + 'm';
    } else if (hours > 0) {
      return hours + 'h ' + (minutes % 60) + 'm';
    } else if (minutes > 0) {
      return minutes + 'm ' + (seconds % 60) + 's';
    } else {
      return seconds + 's';
    }
  }
  
  // Update timer every second
  setInterval(updateTimer, 1000);
  updateTimer();
  
  // Handle messages from extension
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') { return; }
    switch (message.type) {
      case 'pulse':
        updateTimer();
        break;
      case 'update':
        // Handle incremental updates if needed
        break;
    }
  });
</script>
<script nonce="${nonce}" src="${scriptUri}"></script>
`;
}
