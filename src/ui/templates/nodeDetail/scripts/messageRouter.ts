/**
 * @fileoverview Message routing for node detail webview.
 * Maps postMessage types to EventBus emissions.
 * 
 * @module ui/templates/nodeDetail/scripts/messageRouter
 */

/**
 * Render message router that maps VS Code postMessages to EventBus topics.
 * 
 * @returns JavaScript code as a string
 */
export function renderMessageRouter(): string {
  return `
    // Route postMessage → EventBus
    window.addEventListener('message', function(event) {
      var msg = event.data;
      switch (msg.type) {
        case 'logContent':
          bus.emit(Topics.LOG_UPDATE, msg);
          break;
        case 'processStats':
          bus.emit(Topics.PROCESS_STATS, msg);
          break;
        case 'pulse':
          bus.emit(Topics.PULSE, msg);
          break;
        case 'stateChange':
          bus.emit(Topics.NODE_STATE, msg);
          break;
        case 'attemptUpdate':
          bus.emit(Topics.ATTEMPT_UPDATE, msg);
          break;
        case 'aiUsageUpdate':
          bus.emit(Topics.AI_USAGE_UPDATE, msg);
          break;
        case 'workSummary':
          bus.emit(Topics.WORK_SUMMARY, msg);
          break;
        case 'configUpdate':
          bus.emit(Topics.CONFIG_UPDATE, msg.data || msg);
          break;
        case 'focusAttempt':
          // Expand and scroll to a specific attempt card
          if (msg.attemptNumber) {
            var card = document.querySelector('.attempt-card[data-attempt="' + msg.attemptNumber + '"]');
            if (card) {
              var body = card.querySelector('.attempt-body');
              var header = card.querySelector('.attempt-header');
              if (body) body.style.display = 'block';
              if (header) header.setAttribute('data-expanded', 'true');
              card.scrollIntoView({ behavior: 'smooth', block: 'center' });
              // Brief highlight effect
              card.style.outline = '2px solid var(--vscode-focusBorder)';
              setTimeout(function() { card.style.outline = ''; }, 2000);
            }
          }
          break;
      }
    });
  `;
}
