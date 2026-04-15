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
          bus.emit(Topics.NODE_STATE_CHANGE, msg);
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
        case 'subscriptionData':
          bus.emit(Topics.SUBSCRIPTION_DATA, msg);
          if (msg.tag === 'planState' && msg.content && msg.content.status === 'deleted') {
            vscode.postMessage({ type: 'close' });
          } else if (msg.tag === 'nodeState' && msg.content) {
            bus.emit(Topics.NODE_STATE_CHANGE, msg.content);
          } else if (msg.tag === 'processStats' && msg.content) {
            bus.emit(Topics.PROCESS_STATS, msg.content);
          } else if (msg.tag === 'aiUsage' && msg.content) {
            bus.emit(Topics.AI_USAGE_UPDATE, msg.content);
          } else if (msg.tag === 'contextPressure' && msg.content) {
            bus.emit(Topics.CONTEXT_PRESSURE_UPDATE, msg.content);
          } else if (msg.tag && msg.tag.indexOf('cpSubJob:') === 0 && msg.content) {
            // Checkpoint sub-job status update — update the badge in the checkpoint section
            var subNodeId = msg.tag.substring(9); // strip 'cpSubJob:'
            var badge = document.querySelector('.cp-subjob-link[data-node-id="' + subNodeId + '"]');
            if (badge) {
              var iconEl = badge.previousElementSibling;
              if (iconEl && iconEl.classList.contains('step-icon')) {
                var st = msg.content.status || 'pending';
                iconEl.className = 'step-icon ' + (st === 'succeeded' ? 'success' : st === 'failed' ? 'failed' : st === 'running' ? 'running' : 'pending');
                iconEl.textContent = st === 'succeeded' ? '\\u2713' : st === 'failed' ? '\\u2717' : st === 'running' ? '\\u27F3' : '\\u25CB';
              }
            }
          } else if (msg.tag === 'depsStatus' && msg.content && msg.content.dependencies) {
            var depsList = document.querySelector('.deps-list');
            if (depsList) {
              depsList.innerHTML = msg.content.dependencies.map(function(dep) {
                var name = dep.name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                return '<span class="dep-badge ' + (dep.status || 'pending') + '">' + name + '</span>';
              }).join('');
            }
          }
          break;
        case 'subscriptionEnd':
          bus.emit(Topics.SUBSCRIPTION_END, msg);
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
        case 'depsUpdate':
          // Update dependency badge statuses in-place
          if (msg.dependencies) {
            var depsList = document.querySelector('.deps-list');
            if (depsList) {
              depsList.innerHTML = msg.dependencies.map(function(dep) {
                var name = dep.name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                return '<span class="dep-badge ' + (dep.status || 'pending') + '">' + name + '</span>';
              }).join('');
            }
          }
          break;
      }
    });
  `;
}
