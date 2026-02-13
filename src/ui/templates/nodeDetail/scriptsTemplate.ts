/**
 * @fileoverview Webview JavaScript template for node detail panel.
 *
 * Generates the `<script>` block content for the node detail webview.
 * All updates are event-driven: incoming postMessages are routed to an
 * EventBus, and lightweight controls subscribe to the relevant topics.
 * No setInterval or setTimeout is used.
 *
 * @module ui/templates/nodeDetail/scriptsTemplate
 */

/**
 * Configuration parameters for the webview scripts.
 */
export interface ScriptsConfig {
  /** The Plan ID (JSON-safe string) */
  planId: string;
  /** The Node ID (JSON-safe string) */
  nodeId: string;
  /** Previously selected phase, or null */
  currentPhase: string | null;
  /** Phase to show on initial load */
  initialPhase: string | null;
  /** Current node status */
  nodeStatus: string;
}

/**
 * Generate the complete webview `<script>` block content.
 *
 * All updates are event-driven via an inline EventBus.
 * Incoming extension postMessages are routed to bus topics.
 * Controls (StatusBadge, DurationCounter, LogViewer, ProcessTree)
 * subscribe to the bus — no setInterval/setTimeout is used.
 *
 * @param config - Configuration parameters for script generation.
 * @returns The script block content as a string (without `<script>` tags).
 */
export function webviewScripts(config: ScriptsConfig): string {
  return `
    const vscode = acquireVsCodeApi();
    const PLAN_ID = ${JSON.stringify(config.planId)};
    const NODE_ID = ${JSON.stringify(config.nodeId)};
    let currentPhase = ${config.currentPhase ? JSON.stringify(config.currentPhase) : 'null'};
    const initialPhase = ${config.initialPhase ? JSON.stringify(config.initialPhase) : 'null'};

    // ── Inline EventBus ─────────────────────────────────────────────────
    const _handlers = new Map();
    const bus = {
      on(topic, handler) {
        let set = _handlers.get(topic);
        if (!set) { set = new Set(); _handlers.set(topic, set); }
        set.add(handler);
        return { unsubscribe() { const s = _handlers.get(topic); if (s) { s.delete(handler); if (!s.size) _handlers.delete(topic); } } };
      },
      emit(topic, data) {
        const set = _handlers.get(topic);
        if (!set) return;
        for (const fn of [...set]) fn(data);
      }
    };

    // Well-known topics (mirrors Topics from ui/webview/topics)
    const T = {
      PULSE:            'extension:pulse',
      NODE_STATE:       'node:state',
      PROCESS_STATS:    'node:process-stats',
      LOG_UPDATE:       'node:log',
      LOG_PHASE_CHANGE: 'node:log-phase'
    };

    // ── Utility ─────────────────────────────────────────────────────────
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function formatDuration(ms) {
      if (ms < 0) ms = 0;
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return sec + 's';
      const min = Math.floor(sec / 60);
      const remSec = sec % 60;
      if (min < 60) return min + 'm ' + remSec + 's';
      const hr = Math.floor(min / 60);
      return hr + 'h ' + (min % 60) + 'm';
    }

    // ── Route postMessage → EventBus ────────────────────────────────────
    window.addEventListener('message', event => {
      const msg = event.data;
      switch (msg.type) {
        case 'logContent':
          bus.emit(T.LOG_UPDATE, msg);
          break;
        case 'processStats':
          bus.emit(T.PROCESS_STATS, msg);
          break;
        case 'pulse':
          bus.emit(T.PULSE, msg);
          break;
        case 'stateChange':
          bus.emit(T.NODE_STATE, msg);
          break;
      }
    });

    // ── StatusBadge control ─────────────────────────────────────────────
    (function initStatusBadge() {
      bus.on(T.NODE_STATE, function(data) {
        if (!data || !data.status) return;
        const el = document.getElementById('node-status-badge');
        if (!el) return;
        ['pending','ready','scheduled','running','succeeded','failed','paused'].forEach(c => el.classList.remove(c));
        el.classList.add(data.status);
        const icons = { pending:'○', ready:'○', scheduled:'◉', running:'▶', succeeded:'✓', failed:'✗', paused:'⏸' };
        el.textContent = (icons[data.status] || '') + ' ' + data.status;
      });
    })();

    // ── DurationCounter control ─────────────────────────────────────────
    (function initDurationCounter() {
      bus.on(T.PULSE, function() {
        const el = document.getElementById('duration-timer');
        if (!el || !el.hasAttribute('data-started-at')) return;
        const startedAt = parseInt(el.getAttribute('data-started-at'), 10);
        if (!startedAt) { el.textContent = '--'; return; }
        el.textContent = formatDuration(Date.now() - startedAt);
      });
    })();

    // ── LogViewer control (incremental append, auto-scroll) ─────────────
    (function initLogViewer() {
      let lastLogContent = '';
      let logKeyboardBound = false;

      bus.on(T.LOG_UPDATE, function(msg) {
        if (!msg || !msg.content) return;
        if (msg.phase !== undefined && msg.phase !== currentPhase) return;

        const viewer = document.getElementById('logViewer');
        if (!viewer) return;

        // Skip if content unchanged
        if (msg.content === lastLogContent) return;

        // Skip if user has selection
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) return;

        // Detect incremental append
        const isAppend = msg.content.length > lastLogContent.length &&
                         msg.content.startsWith(lastLogContent);
        const wasAtBottom = viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 50;

        if (isAppend) {
          const newText = msg.content.slice(lastLogContent.length);
          const pre = viewer.querySelector('pre.log-content');
          if (pre) {
            // Append only the new text
            const textNode = document.createTextNode(newText);
            pre.appendChild(textNode);
          } else {
            viewer.innerHTML = '<pre class="log-content" tabindex="0">' + escapeHtml(msg.content) + '</pre>';
          }
        } else {
          viewer.innerHTML = '<pre class="log-content" tabindex="0">' + escapeHtml(msg.content) + '</pre>';
        }

        lastLogContent = msg.content;

        // Auto-scroll if at bottom
        if (wasAtBottom) {
          viewer.scrollTop = viewer.scrollHeight;
        }

        // Bind keyboard shortcuts once
        if (!logKeyboardBound) {
          logKeyboardBound = true;
          viewer.addEventListener('click', function(ev) {
            const lc = viewer.querySelector('.log-content');
            if (lc) lc.focus();
          });
          viewer.addEventListener('keydown', function(e) {
            const lc = viewer.querySelector('.log-content');
            if (!lc) return;
            if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
              e.preventDefault(); e.stopPropagation();
              const sel = window.getSelection(); const range = document.createRange();
              range.selectNodeContents(lc); sel.removeAllRanges(); sel.addRange(range);
            }
            if (e.key === 'Escape') { e.preventDefault(); window.getSelection().removeAllRanges(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
              const t = window.getSelection().toString();
              if (t) { e.preventDefault(); vscode.postMessage({ type: 'copyToClipboard', text: t }); }
            }
          });
        }
      });
    })();

    // ── ProcessTree control ──────────────────────────────────────────────
    (function initProcessTree() {
      let lastKnownTree = [];

      function countAndSum(proc) {
        let count = 1, cpu = proc.cpu || 0, memory = proc.memory || 0;
        if (proc.children) {
          for (const child of proc.children) {
            const s = countAndSum(child);
            count += s.count; cpu += s.cpu; memory += s.memory;
          }
        }
        return { count, cpu, memory };
      }

      function renderNode(proc, depth) {
        const memMB = ((proc.memory || 0) / 1024 / 1024).toFixed(1);
        const cpuPct = (proc.cpu || 0).toFixed(0);
        const indent = depth * 16;
        const arrow = depth > 0 ? '↳ ' : '';
        let html = '<div class="process-node" style="margin-left: ' + indent + 'px;">';
        html += '<div class="process-node-header">';
        html += '<span class="process-node-icon">⚙️</span>';
        html += '<span class="process-node-name">' + arrow + escapeHtml(proc.name) + '</span>';
        html += '<span class="process-node-pid">PID ' + proc.pid + '</span>';
        html += '</div>';
        html += '<div class="process-node-stats">';
        html += '<span class="process-stat">CPU: ' + cpuPct + '%</span>';
        html += '<span class="process-stat">Mem: ' + memMB + ' MB</span>';
        html += '</div>';
        if (proc.commandLine) {
          html += '<div class="process-node-cmdline">' + escapeHtml(proc.commandLine) + '</div>';
        }
        html += '</div>';
        if (proc.children) {
          for (const child of proc.children) html += renderNode(child, depth + 1);
        }
        return html;
      }

      bus.on(T.PROCESS_STATS, function(stats) {
        const treeEl = document.getElementById('processTree');
        const titleEl = document.getElementById('processTreeTitle');
        if (!treeEl || !titleEl) return;

        if (stats.isAgentWork && !stats.pid && stats.running) {
          const duration = stats.duration ? formatDuration(stats.duration) : '';
          treeEl.innerHTML = '<div class="agent-work-indicator"><span class="agent-icon">🤖</span> Copilot Agent starting...' + (duration ? ' <span class="agent-duration">(' + duration + ')</span>' : '') + '</div>';
          titleEl.innerHTML = 'Agent Work <span style="opacity: 0.7; font-weight: normal;">(starting)</span>';
          return;
        }

        if (!stats.pid || !stats.running) {
          if (lastKnownTree.length === 0) {
            treeEl.innerHTML = '<div class="process-loading">No active process</div>';
            titleEl.textContent = 'Processes';
          }
          return;
        }

        const tree = stats.tree || [];
        lastKnownTree = tree;

        if (tree.length === 0) {
          const agentPrefix = stats.isAgentWork ? '🤖 ' : '';
          treeEl.innerHTML = '<div class="process-loading">' + agentPrefix + 'Process running (PID ' + stats.pid + ')</div>';
          titleEl.innerHTML = (stats.isAgentWork ? 'Copilot Agent' : 'Processes') + ' <span style="opacity: 0.7; font-weight: normal;">PID ' + stats.pid + '</span>';
          return;
        }

        const totals = tree.reduce(function(acc, proc) {
          const s = countAndSum(proc);
          return { count: acc.count + s.count, cpu: acc.cpu + s.cpu, memory: acc.memory + s.memory };
        }, { count: 0, cpu: 0, memory: 0 });

        const memMB = (totals.memory / 1024 / 1024).toFixed(1);
        const titleLabel = stats.isAgentWork ? 'Copilot Agent' : 'Processes';
        titleEl.innerHTML = titleLabel + ' <span style="opacity: 0.7; font-weight: normal;">(' + totals.count + ' • ' + totals.cpu.toFixed(0) + '% CPU • ' + memMB + ' MB)</span>';
        treeEl.innerHTML = tree.map(function(p) { return renderNode(p, 0); }).join('');
      });
    })();

    // ── Global Ctrl+C handler ───────────────────────────────────────────
    document.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        const selectedText = window.getSelection().toString();
        if (selectedText) {
          e.preventDefault();
          vscode.postMessage({ type: 'copyToClipboard', text: selectedText });
        }
      }
    });

    // ── Navigation helpers (called from onclick in HTML) ────────────────
    function openPlan(planId) {
      vscode.postMessage({ type: 'openPlan', planId });
    }

    function openWorktree() {
      vscode.postMessage({ type: 'openWorktree' });
    }

    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }

    // ── Session ID copy handler ─────────────────────────────────────────
    document.body.addEventListener('click', function(e) {
      if (!(e.target instanceof Element)) return;
      const target = e.target.closest('.session-id');
      if (target) {
        const sessionId = target.getAttribute('data-session');
        vscode.postMessage({ type: 'copyToClipboard', text: sessionId });
      }
    });

    // ── Log file path click handler ─────────────────────────────────────
    document.body.addEventListener('click', function(e) {
      if (!(e.target instanceof Element)) return;
      const target = e.target.closest('.log-file-path');
      if (target) {
        const path = target.getAttribute('data-path');
        if (path) {
          vscode.postMessage({ type: 'openLogFile', path });
        }
      }
    });

    // ── Retry / force-fail button handlers ──────────────────────────────
    document.body.addEventListener('click', function(e) {
      if (!(e.target instanceof Element)) return;
      const btn = e.target.closest('.retry-btn');
      if (!btn) return;

      const action = btn.getAttribute('data-action');
      const planId = PLAN_ID;
      const nodeId = NODE_ID;

      if (action === 'retry-node') {
        vscode.postMessage({ type: 'retryNode', planId, nodeId, resumeSession: true });
      } else if (action === 'retry-node-fresh') {
        vscode.postMessage({ type: 'retryNode', planId, nodeId, resumeSession: false });
      } else if (action === 'force-fail-node') {
        vscode.postMessage({ type: 'confirmForceFailNode', planId, nodeId });
      }
    });

    // ── Attempt card toggle handlers ────────────────────────────────────
    document.body.addEventListener('click', function(e) {
      if (!(e.target instanceof Element)) return;
      const header = e.target.closest('.attempt-header');
      if (!header) return;

      const card = header.closest('.attempt-card');
      const body = card.querySelector('.attempt-body');
      const chevron = header.querySelector('.chevron');
      const isExpanded = header.getAttribute('data-expanded') === 'true';

      if (isExpanded) {
        body.style.display = 'none';
        chevron.classList.remove('expanded');
        chevron.textContent = '▶';
        header.setAttribute('data-expanded', 'false');
      } else {
        body.style.display = 'block';
        chevron.classList.add('expanded');
        chevron.textContent = '▼';
        header.setAttribute('data-expanded', 'true');
      }
    });

    // ── Attempt phase tab click handlers ────────────────────────────────
    document.body.addEventListener('click', function(e) {
      const tab = e.target.closest('.attempt-phase-tab');
      if (!tab) return;

      e.stopPropagation();
      const phase = tab.getAttribute('data-phase');
      const attemptNum = tab.getAttribute('data-attempt');
      const phasesContainer = tab.closest('.attempt-phases');

      phasesContainer.querySelectorAll('.attempt-phase-tab').forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');

      const dataEl = phasesContainer.querySelector('.attempt-logs-data[data-attempt="' + attemptNum + '"]');
      if (dataEl) {
        try {
          const logsData = JSON.parse(dataEl.textContent);
          const viewer = phasesContainer.querySelector('.attempt-log-viewer[data-attempt="' + attemptNum + '"]');
          if (viewer && logsData[phase]) {
            viewer.textContent = logsData[phase];
          }
        } catch (err) {
          console.error('Failed to parse attempt logs data:', err);
        }
      }
    });

    // ── Phase tab selection (PhaseTabBar) ────────────────────────────────
    function selectPhase(phase) {
      currentPhase = phase;

      document.querySelectorAll('.phase-tab').forEach(function(t) { t.classList.remove('active'); });
      const tab = document.querySelector('[data-phase="' + phase + '"]');
      if (tab) tab.classList.add('active');

      document.getElementById('logViewer').innerHTML = '<div class="log-loading">Loading logs...</div>';
      vscode.postMessage({ type: 'getLog', phase });
    }

    // ── Initial phase selection (synchronous, no setTimeout) ────────────
    const phaseToSelect = currentPhase || initialPhase;
    if (phaseToSelect) {
      selectPhase(phaseToSelect);
    }

    // ── Request initial process stats from extension ────────────────────
    if (document.getElementById('processTreeSection')) {
      vscode.postMessage({ type: 'getProcessStats' });
    }
  `;
}
