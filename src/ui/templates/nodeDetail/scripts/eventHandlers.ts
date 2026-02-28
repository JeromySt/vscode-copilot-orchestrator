/**
 * @fileoverview Event handlers for node detail webview.
 * Click delegation, keyboard handlers, and navigation functions.
 * 
 * @module ui/templates/nodeDetail/scripts/eventHandlers
 */

import type { ScriptsConfig } from '../scriptsTemplate';

/**
 * Render event handler code including click delegation and keyboard shortcuts.
 * 
 * @param config - Configuration parameters
 * @returns JavaScript code as a string
 */
export function renderEventHandlers(config: ScriptsConfig): string {
  return `
    // Navigation helpers (called from onclick in HTML)
    function openPlan(planId) {
      vscode.postMessage({ type: 'openPlan', planId: planId });
    }

    function openWorktree() {
      vscode.postMessage({ type: 'openWorktree' });
    }

    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }

    // Phase tab selection (delegates to PhaseTabBar control)
    function selectPhase(phase) {
      phaseTabBar.setActivePhase(phase);
      vscode.postMessage({ type: 'getLog', phase: phase });
    }

    // Execution phase tab click handler
    document.body.addEventListener('click', function(e) {
      if (!(e.target instanceof Element)) return;
      var tab = e.target.closest('.phase-tab');
      if (!tab) return;
      // Ignore attempt-phase-tabs (handled separately)
      if (tab.classList.contains('attempt-phase-tab')) return;
      var phase = tab.getAttribute('data-phase');
      if (phase) { selectPhase(phase); }
    });

    // Global Ctrl+C handler for copy to clipboard
    document.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        var selectedText = window.getSelection().toString();
        if (selectedText) {
          e.preventDefault();
          vscode.postMessage({ type: 'copyToClipboard', text: selectedText });
        }
      }
    });

    // Session ID copy handler
    document.body.addEventListener('click', function(e) {
      if (!(e.target instanceof Element)) return;
      var target = e.target.closest('.session-id');
      if (target) {
        var sessionId = target.getAttribute('data-session');
        vscode.postMessage({ type: 'copyToClipboard', text: sessionId });
      }
    });

    // Log file path click handler
    document.body.addEventListener('click', function(e) {
      if (!(e.target instanceof Element)) return;
      var target = e.target.closest('.log-file-path');
      if (target) {
        var path = target.getAttribute('data-path');
        if (path) {
          vscode.postMessage({ type: 'openLogFile', path: path });
        }
      }
    });

    // Retry / force-fail button handlers
    document.body.addEventListener('click', function(e) {
      if (!(e.target instanceof Element)) return;
      var btn = e.target.closest('.retry-btn') || e.target.closest('.force-fail-btn');
      if (!btn) return;

      var action = btn.getAttribute('data-action');
      var planId = PLAN_ID;
      var nodeId = NODE_ID;

      if (action === 'retry-node') {
        vscode.postMessage({ type: 'retryNode', planId: planId, nodeId: nodeId, resumeSession: true });
      } else if (action === 'retry-node-fresh') {
        vscode.postMessage({ type: 'retryNode', planId: planId, nodeId: nodeId, resumeSession: false });
      } else if (action === 'force-fail-node') {
        vscode.postMessage({ type: 'confirmForceFailNode', planId: planId, nodeId: nodeId });
      }
    });

    // Config phase header toggle (expand/collapse prechecks/postchecks)
    document.body.addEventListener('click', function(e) {
      if (!(e.target instanceof Element)) return;
      var header = e.target.closest('.config-phase-header.collapsed, .config-phase-header.expanded');
      if (!header) return;
      // Skip non-collapsible headers
      if (header.classList.contains('non-collapsible')) return;
      var body = header.nextElementSibling;
      if (!body) return;
      var isCollapsed = header.classList.contains('collapsed');
      if (isCollapsed) {
        body.style.display = 'block';
        header.classList.replace('collapsed', 'expanded');
        var chev = header.querySelector('.chevron');
        if (chev) chev.textContent = '\u25BC';
      } else {
        body.style.display = 'none';
        header.classList.replace('expanded', 'collapsed');
        var chev = header.querySelector('.chevron');
        if (chev) chev.textContent = '\u25B6';
      }
    });

    // Attempt card toggle handler (chevron expand/collapse)
    document.body.addEventListener('click', function(e) {
      if (!(e.target instanceof Element)) return;
      var header = e.target.closest('.attempt-header');
      if (!header) return;

      var body = header.nextElementSibling;
      if (body) {
        var isHidden = body.style.display === 'none' || body.style.display === '';
        body.style.display = isHidden ? 'block' : 'none';
        header.setAttribute('data-expanded', isHidden ? 'true' : 'false');
      }
    });

    // Attempt phase tab handler
    document.body.addEventListener('click', function(e) {
      if (!(e.target instanceof Element)) return;
      var tab = e.target.closest('.attempt-phase-tab');
      if (!tab) return;

      var attemptNum = tab.getAttribute('data-attempt');
      var phase = tab.getAttribute('data-phase');
      var phasesContainer = tab.closest('.attempt-phases');
      if (!phasesContainer) return;

      phasesContainer.querySelectorAll('.attempt-phase-tab').forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');

      var dataEl = phasesContainer.querySelector('.attempt-logs-data[data-attempt="' + attemptNum + '"]');
      if (dataEl) {
        try {
          var logsData = JSON.parse(dataEl.textContent);
          var viewer = phasesContainer.querySelector('.attempt-log-viewer[data-attempt="' + attemptNum + '"]');
          if (viewer && logsData[phase]) {
            viewer.textContent = logsData[phase];
          }
        } catch (err) {
          console.error('Failed to parse attempt logs data:', err);
        }
      }
    });

    // Initial phase selection (synchronous, no setTimeout)
    var phaseToSelect = currentPhase || initialPhase;
    if (phaseToSelect) {
      selectPhase(phaseToSelect);
    }

    // Request initial process stats from extension
    if (document.getElementById('processTreeSection')) {
      vscode.postMessage({ type: 'getProcessStats' });
    }
  `;
}
