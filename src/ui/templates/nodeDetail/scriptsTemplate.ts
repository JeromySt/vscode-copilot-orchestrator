/**
 * @fileoverview Webview JavaScript template for node detail panel.
 *
 * Generates the `<script>` block content for the node detail webview.
 * All updates are event-driven: incoming postMessages are routed to an
 * EventBus, and SubscribableControl subclasses subscribe to relevant topics.
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
 * Generate the complete webview script block content.
 *
 * All updates are event-driven via an inline EventBus.
 * Incoming extension postMessages are routed to bus topics.
 * Controls (StatusBadgeControl, DurationCounterControl, LogViewerControl,
 * ProcessTreeControl, PhaseTabBarControl, AttemptListControl,
 * AiUsageStatsControl, WorkSummaryControl, ConfigDisplayControl)
 * extend SubscribableControl and subscribe to the bus.
 * No setInterval/setTimeout is used.
 *
 * @param config - Configuration parameters for script generation.
 * @returns The script block content as a string (without script tags).
 */
export function webviewScripts(config: ScriptsConfig): string {
  return `
    var vscode = acquireVsCodeApi();
    var PLAN_ID = ${JSON.stringify(config.planId)};
    var NODE_ID = ${JSON.stringify(config.nodeId)};
    var currentPhase = ${config.currentPhase ? JSON.stringify(config.currentPhase) : 'null'};
    var initialPhase = ${config.initialPhase ? JSON.stringify(config.initialPhase) : 'null'};

    // ── Inline EventBus ─────────────────────────────────────────────────
    var EventBus = (function() {
      function EB() { this._h = new Map(); }
      EB.prototype.on = function(topic, fn) {
        var set = this._h.get(topic);
        if (!set) { set = new Set(); this._h.set(topic, set); }
        set.add(fn);
        var active = true;
        var self = this;
        return { get isActive() { return active; }, topic: topic, unsubscribe: function() {
          if (!active) return; active = false;
          var s = self._h.get(topic); if (s) { s.delete(fn); if (s.size === 0) self._h.delete(topic); }
        }};
      };
      EB.prototype.emit = function(topic, data) {
        var set = this._h.get(topic);
        if (!set) return;
        var snapshot = Array.from(set);
        for (var i = 0; i < snapshot.length; i++) snapshot[i](data);
      };
      EB.prototype.clear = function(topic) {
        if (topic !== undefined) this._h.delete(topic); else this._h.clear();
      };
      return EB;
    })();

    // Well-known topics (mirrors Topics from ui/webview/topics)
    var T = {
      PULSE:            'extension:pulse',
      NODE_STATE:       'node:state',
      PROCESS_STATS:    'node:process-stats',
      LOG_UPDATE:       'node:log',
      LOG_PHASE_CHANGE: 'node:log-phase',
      AI_USAGE_UPDATE:  'node:ai-usage',
      WORK_SUMMARY:     'node:work-summary',
      ATTEMPT_UPDATE:   'node:attempt',
      CONFIG_UPDATE:    'node:config',
      controlUpdate: function(id) { return 'control:' + id + ':updated'; }
    };

    // Global bus instance
    var bus = new EventBus();

    // ── SubscribableControl base class ──────────────────────────────────
    var SubscribableControl = (function() {
      function SC(bus, controlId) {
        this.bus = bus;
        this.controlId = controlId;
        this._subs = [];
        this._disposed = false;
      }
      SC.prototype.subscribe = function(topic, handler) {
        var sub = this.bus.on(topic, handler);
        this._subs.push(sub);
        return sub;
      };
      SC.prototype.unsubscribeAll = function() {
        for (var i = 0; i < this._subs.length; i++) this._subs[i].unsubscribe();
        this._subs.length = 0;
      };
      SC.prototype.publishUpdate = function(data) {
        this.bus.emit(T.controlUpdate(this.controlId), data);
      };
      SC.prototype.getElement = function(id) {
        return document.getElementById(id);
      };
      SC.prototype.dispose = function() {
        if (this._disposed) return;
        this._disposed = true;
        this.unsubscribeAll();
      };
      SC.prototype.update = function() {};
      return SC;
    })();

    // ── Utility ─────────────────────────────────────────────────────────
    function escapeHtml(text) {
      return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function formatDuration(ms) {
      if (ms < 0) ms = 0;
      var sec = Math.floor(ms / 1000);
      if (sec < 60) return sec + 's';
      var min = Math.floor(sec / 60);
      var remSec = sec % 60;
      if (min < 60) return min + 'm ' + remSec + 's';
      var hr = Math.floor(min / 60);
      return hr + 'h ' + (min % 60) + 'm';
    }

    function formatTokenCount(n) {
      if (n === undefined || n === null) return '0';
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'm';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(n);
    }

    function formatDurationSeconds(seconds) {
      var h = Math.floor(seconds / 3600);
      var m = Math.floor((seconds % 3600) / 60);
      var s = Math.floor(seconds % 60);
      if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
      if (m > 0) return m + 'm ' + s + 's';
      return s + 's';
    }

    // ── Route postMessage → EventBus ────────────────────────────────────
    window.addEventListener('message', function(event) {
      var msg = event.data;
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
        case 'attemptUpdate':
          bus.emit(T.ATTEMPT_UPDATE, msg);
          break;
        case 'aiUsageUpdate':
          bus.emit(T.AI_USAGE_UPDATE, msg);
          break;
        case 'workSummary':
          bus.emit(T.WORK_SUMMARY, msg);
          break;
        case 'configUpdate':
          bus.emit(T.CONFIG_UPDATE, msg);
          break;
      }
    });

    // ── StatusBadgeControl ──────────────────────────────────────────────
    var StatusBadgeControl = (function() {
      var STATUS_CLASSES = ['pending','ready','scheduled','running','succeeded','failed','paused'];
      var STATUS_ICONS = { pending:'○', ready:'○', scheduled:'◉', running:'▶', succeeded:'✓', failed:'✗', paused:'⏸' };

      function SBC(bus, controlId, elementId) {
        SubscribableControl.call(this, bus, controlId);
        this._elementId = elementId;
        var self = this;
        this.subscribe(T.NODE_STATE, function(data) { self.update(data); });
      }
      SBC.prototype = Object.create(SubscribableControl.prototype);
      SBC.prototype.constructor = SBC;
      SBC.prototype.update = function(data) {
        if (!data || !data.status) return;
        var el = this.getElement(this._elementId);
        if (!el) return;
        for (var i = 0; i < STATUS_CLASSES.length; i++) el.classList.remove(STATUS_CLASSES[i]);
        el.classList.add(data.status);
        el.textContent = data.status.toUpperCase();
        // Update header phase indicator
        var phaseEl = document.getElementById('header-phase-indicator');
        if (phaseEl) {
          if (data.currentPhase && (data.status === 'running' || data.status === 'scheduled')) {
            var phaseName = data.currentPhase.replace(/-/g, ' ');
            phaseName = phaseName.charAt(0).toUpperCase() + phaseName.slice(1);
            phaseEl.textContent = phaseName;
            phaseEl.style.display = '';
          } else {
            phaseEl.style.display = 'none';
          }
        }
        // Toggle force-fail button visibility
        var ffBtn = document.getElementById('forceFailBtn');
        if (ffBtn) {
          ffBtn.style.display = (data.status === 'running') ? '' : 'none';
        }
        this.publishUpdate(data);
      };
      return SBC;
    })();

    // ── DurationCounterControl ──────────────────────────────────────────
    var DurationCounterControl = (function() {
      function DCC(bus, controlId, elementId) {
        SubscribableControl.call(this, bus, controlId);
        this._elementId = elementId;
        var self = this;
        this.subscribe(T.PULSE, function() { self._tick(); });
      }
      DCC.prototype = Object.create(SubscribableControl.prototype);
      DCC.prototype.constructor = DCC;
      DCC.prototype._tick = function() {
        var el = this.getElement(this._elementId);
        if (!el || !el.hasAttribute('data-started-at')) return;
        var startedAt = parseInt(el.getAttribute('data-started-at'), 10);
        if (!startedAt) { el.textContent = '--'; return; }
        el.textContent = formatDuration(Date.now() - startedAt);
        this.publishUpdate();
      };
      DCC.prototype.update = function(data) { this._tick(); };
      return DCC;
    })();

    // ── LogViewerControl (incremental append, auto-scroll) ──────────────
    var LogViewerControl = (function() {
      function LVC(bus, controlId, elementId) {
        SubscribableControl.call(this, bus, controlId);
        this._elementId = elementId;
        this._lastLogContent = '';
        this._keyboardBound = false;
        var self = this;
        this.subscribe(T.LOG_UPDATE, function(msg) { self.update(msg); });
      }
      LVC.prototype = Object.create(SubscribableControl.prototype);
      LVC.prototype.constructor = LVC;
      LVC.prototype.update = function(msg) {
        if (!msg || !msg.content) return;
        if (msg.phase !== undefined && msg.phase !== currentPhase) return;
        var viewer = this.getElement(this._elementId);
        if (!viewer) return;
        if (msg.content === this._lastLogContent) return;
        var selection = window.getSelection();
        if (selection && selection.toString().length > 0) return;
        var isAppend = msg.content.length > this._lastLogContent.length &&
                        msg.content.startsWith(this._lastLogContent);
        var wasAtBottom = viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 50;
        if (isAppend) {
          var newText = msg.content.slice(this._lastLogContent.length);
          var pre = viewer.querySelector('pre.log-content');
          if (pre) {
            var textNode = document.createTextNode(newText);
            pre.appendChild(textNode);
          } else {
            viewer.innerHTML = '<pre class="log-content" tabindex="0">' + escapeHtml(msg.content) + '</pre>';
          }
        } else {
          viewer.innerHTML = '<pre class="log-content" tabindex="0">' + escapeHtml(msg.content) + '</pre>';
        }
        this._lastLogContent = msg.content;
        if (wasAtBottom) { viewer.scrollTop = viewer.scrollHeight; }
        if (!this._keyboardBound) {
          this._keyboardBound = true;
          viewer.addEventListener('click', function() {
            var lc = viewer.querySelector('.log-content');
            if (lc) lc.focus();
          });
          viewer.addEventListener('keydown', function(e) {
            var lc = viewer.querySelector('.log-content');
            if (!lc) return;
            if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
              e.preventDefault(); e.stopPropagation();
              var sel = window.getSelection(); var range = document.createRange();
              range.selectNodeContents(lc); sel.removeAllRanges(); sel.addRange(range);
            }
            if (e.key === 'Escape') { e.preventDefault(); window.getSelection().removeAllRanges(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
              var t = window.getSelection().toString();
              if (t) { e.preventDefault(); vscode.postMessage({ type: 'copyToClipboard', text: t }); }
            }
          });
        }
        this.publishUpdate(msg);
      };
      return LVC;
    })();

    // ── ProcessTreeControl ──────────────────────────────────────────────
    var ProcessTreeControl = (function() {
      function countAndSum(proc) {
        var count = 1, cpu = proc.cpu || 0, memory = proc.memory || 0;
        if (proc.children) {
          for (var i = 0; i < proc.children.length; i++) {
            var s = countAndSum(proc.children[i]);
            count += s.count; cpu += s.cpu; memory += s.memory;
          }
        }
        return { count: count, cpu: cpu, memory: memory };
      }

      function renderNode(proc, depth) {
        var memMB = ((proc.memory || 0) / 1024 / 1024).toFixed(1);
        var cpuPct = (proc.cpu || 0).toFixed(0);
        var indent = depth * 16;
        var arrow = depth > 0 ? '↳ ' : '';
        var html = '<div class="process-node" style="margin-left: ' + indent + 'px;">';
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
          for (var i = 0; i < proc.children.length; i++) html += renderNode(proc.children[i], depth + 1);
        }
        return html;
      }

      function PTC(bus, controlId, treeElementId, titleElementId) {
        SubscribableControl.call(this, bus, controlId);
        this._treeElementId = treeElementId;
        this._titleElementId = titleElementId;
        this._lastKnownTree = [];
        var self = this;
        this.subscribe(T.PROCESS_STATS, function(stats) { self.update(stats); });
      }
      PTC.prototype = Object.create(SubscribableControl.prototype);
      PTC.prototype.constructor = PTC;
      PTC.prototype.update = function(stats) {
        var treeEl = this.getElement(this._treeElementId);
        var titleEl = this.getElement(this._titleElementId);
        if (!treeEl || !titleEl) return;

        if (stats.isAgentWork && !stats.pid && stats.running) {
          var duration = stats.duration ? formatDuration(stats.duration) : '';
          treeEl.innerHTML = '<div class="agent-work-indicator"><span class="agent-icon">🤖</span> Copilot Agent starting...' + (duration ? ' <span class="agent-duration">(' + duration + ')</span>' : '') + '</div>';
          titleEl.innerHTML = 'Agent Work <span style="opacity: 0.7; font-weight: normal;">(starting)</span>';
          this.publishUpdate(stats);
          return;
        }

        if (!stats.pid || !stats.running) {
          if (this._lastKnownTree.length === 0) {
            treeEl.innerHTML = '<div class="process-loading">No active process</div>';
            titleEl.textContent = 'Processes';
          }
          this.publishUpdate(stats);
          return;
        }

        var tree = stats.tree || [];
        this._lastKnownTree = tree;

        if (tree.length === 0) {
          var agentPrefix = stats.isAgentWork ? '🤖 ' : '';
          treeEl.innerHTML = '<div class="process-loading">' + agentPrefix + 'Process running (PID ' + stats.pid + ')</div>';
          titleEl.innerHTML = (stats.isAgentWork ? 'Copilot Agent' : 'Processes') + ' <span style="opacity: 0.7; font-weight: normal;">PID ' + stats.pid + '</span>';
          this.publishUpdate(stats);
          return;
        }

        var totals = tree.reduce(function(acc, proc) {
          var s = countAndSum(proc);
          return { count: acc.count + s.count, cpu: acc.cpu + s.cpu, memory: acc.memory + s.memory };
        }, { count: 0, cpu: 0, memory: 0 });

        var memMB = (totals.memory / 1024 / 1024).toFixed(1);
        var titleLabel = stats.isAgentWork ? 'Copilot Agent' : 'Processes';
        titleEl.innerHTML = titleLabel + ' <span style="opacity: 0.7; font-weight: normal;">(' + totals.count + ' • ' + totals.cpu.toFixed(0) + '% CPU • ' + memMB + ' MB)</span>';
        treeEl.innerHTML = tree.map(function(p) { return renderNode(p, 0); }).join('');
        this.publishUpdate(stats);
      };
      return PTC;
    })();

    // ── PhaseTabBarControl ──────────────────────────────────────────────
    var PhaseTabBarControl = (function() {
      function PTBC(bus, controlId) {
        SubscribableControl.call(this, bus, controlId);
        var self = this;
        this.subscribe(T.NODE_STATE, function(data) {
          if (data && data.phaseStatus) self._autoShowHideTabs(data.phaseStatus);
        });
      }
      PTBC.prototype = Object.create(SubscribableControl.prototype);
      PTBC.prototype.constructor = PTBC;
      PTBC.prototype.selectPhase = function(phase) {
        currentPhase = phase;
        var tabs = document.querySelectorAll('.phase-tab');
        for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('active');
        var tab = document.querySelector('[data-phase="' + phase + '"]');
        if (tab) tab.classList.add('active');
        var viewer = document.getElementById('logViewer');
        if (viewer) viewer.innerHTML = '<div class="log-loading">Loading logs...</div>';
        vscode.postMessage({ type: 'getLog', phase: phase });
        this.publishUpdate({ activePhase: phase });
      };
      PTBC.prototype._autoShowHideTabs = function(phaseStatus) {
        var tabs = document.querySelectorAll('.phase-tab');
        for (var i = 0; i < tabs.length; i++) {
          var phaseId = tabs[i].getAttribute('data-phase');
          if (phaseId && phaseStatus[phaseId]) {
            var status = phaseStatus[phaseId];
            tabs[i].className = 'phase-tab phase-' + status + (phaseId === currentPhase ? ' active' : '');
          }
        }
      };
      PTBC.prototype.update = function(data) {};
      return PTBC;
    })();

    // ── AttemptListControl ──────────────────────────────────────────────
    var AttemptListControl = (function() {
      function ALC(bus, controlId, containerSelector) {
        SubscribableControl.call(this, bus, controlId);
        this._containerSelector = containerSelector;
        this._knownAttempts = {};
        var self = this;
        this.subscribe(T.ATTEMPT_UPDATE, function(data) { self.update(data); });
      }
      ALC.prototype = Object.create(SubscribableControl.prototype);
      ALC.prototype.constructor = ALC;
      ALC.prototype.update = function(data) {
        if (!data || !data.attempts || !data.attempts.length) return;
        var container = document.querySelector(this._containerSelector);
        if (!container) return;

        for (var i = 0; i < data.attempts.length; i++) {
          var attempt = data.attempts[i];
          var num = attempt.attemptNumber;
          if (this._knownAttempts[num]) continue;
          this._knownAttempts[num] = true;
          var cardDiv = document.createElement('div');
          cardDiv.innerHTML = this._renderAttemptCard(attempt);
          if (cardDiv.firstChild) container.appendChild(cardDiv.firstChild);
        }
        this.publishUpdate(data);
      };
      ALC.prototype._renderAttemptCard = function(attempt) {
        var statusClass = 'status-' + (attempt.status || 'pending');
        var duration = attempt.endedAt && attempt.startedAt
          ? formatDuration(attempt.endedAt - attempt.startedAt) : '--';
        var triggerBadge = attempt.triggerType === 'auto-heal'
          ? '<span class="trigger-badge auto-heal">🔧 Auto-Heal</span>'
          : attempt.triggerType === 'retry'
            ? '<span class="trigger-badge retry">🔄 Retry</span>' : '';
        var errorHtml = attempt.error
          ? '<div class="attempt-error"><strong>Error:</strong> <span class="error-message">' + escapeHtml(attempt.error) + '</span></div>' : '';
        return '<div class="attempt-card" data-attempt="' + attempt.attemptNumber + '">'
          + '<div class="attempt-header" data-expanded="false">'
          + '<div class="attempt-header-left">'
          + '<span class="attempt-badge">#' + attempt.attemptNumber + '</span>'
          + triggerBadge
          + '<span class="attempt-duration">(' + duration + ')</span>'
          + '</div>'
          + '<span class="chevron">▶</span>'
          + '</div>'
          + '<div class="attempt-body" style="display: none;">'
          + '<div class="attempt-meta"><div class="attempt-meta-row"><strong>Status:</strong> <span class="' + statusClass + '">' + (attempt.status || 'pending') + '</span></div></div>'
          + errorHtml
          + '</div></div>';
      };
      return ALC;
    })();

    // ── AiUsageStatsControl ─────────────────────────────────────────────
    var AiUsageStatsControl = (function() {
      function AUSC(bus, controlId, elementId) {
        SubscribableControl.call(this, bus, controlId);
        this._elementId = elementId;
        var self = this;
        this.subscribe(T.AI_USAGE_UPDATE, function(data) { self.update(data); });
      }
      AUSC.prototype = Object.create(SubscribableControl.prototype);
      AUSC.prototype.constructor = AUSC;
      AUSC.prototype.update = function(data) {
        if (!data) return;
        var el = this.getElement(this._elementId);
        if (!el) return;

        var parts = [];
        if (data.premiumRequests !== undefined) {
          parts.push('<span class="metric-item">🎫 ' + data.premiumRequests + ' req</span>');
        }
        if (data.apiTimeSeconds !== undefined) {
          parts.push('<span class="metric-item">⏱ API: ' + formatDurationSeconds(data.apiTimeSeconds) + '</span>');
        }
        if (data.sessionTimeSeconds !== undefined) {
          parts.push('<span class="metric-item">🕐 Session: ' + formatDurationSeconds(data.sessionTimeSeconds) + '</span>');
        }

        var modelHtml = '';
        if (data.modelBreakdown && data.modelBreakdown.length > 0) {
          var rows = '';
          for (var i = 0; i < data.modelBreakdown.length; i++) {
            var m = data.modelBreakdown[i];
            var cached = m.cachedTokens ? ', ' + formatTokenCount(m.cachedTokens) + ' cached' : '';
            var reqs = m.premiumRequests !== undefined ? ' (' + m.premiumRequests + ' req)' : '';
            rows += '<div class="model-row"><span class="model-name">' + escapeHtml(m.model) + '</span> '
              + formatTokenCount(m.inputTokens) + ' in, ' + formatTokenCount(m.outputTokens) + ' out' + cached + reqs + '</div>';
          }
          modelHtml = '<div class="model-breakdown">' + rows + '</div>';
        }

        el.innerHTML = '<div class="metrics-stats-grid">' + parts.join('') + '</div>' + modelHtml;
        el.style.display = (parts.length > 0 || modelHtml) ? '' : 'none';
        this.publishUpdate(data);
      };
      return AUSC;
    })();

    // ── WorkSummaryControl ──────────────────────────────────────────────
    var WorkSummaryControl = (function() {
      function WSC(bus, controlId, elementId) {
        SubscribableControl.call(this, bus, controlId);
        this._elementId = elementId;
        var self = this;
        this.subscribe(T.WORK_SUMMARY, function(data) { self.update(data); });
      }
      WSC.prototype = Object.create(SubscribableControl.prototype);
      WSC.prototype.constructor = WSC;
      WSC.prototype.update = function(data) {
        if (!data) return;
        var el = this.getElement(this._elementId);
        if (!el) return;

        var hasChanges = (data.totalCommits > 0 || data.filesAdded > 0 ||
                          data.filesModified > 0 || data.filesDeleted > 0);
        if (!hasChanges) {
          el.style.display = 'none';
          this.publishUpdate(data);
          return;
        }

        el.style.display = '';
        el.innerHTML = '<div class="work-summary-grid">'
          + '<div class="work-stat"><div class="work-stat-value">' + data.totalCommits + '</div><div class="work-stat-label">Commits</div></div>'
          + '<div class="work-stat added"><div class="work-stat-value">+' + data.filesAdded + '</div><div class="work-stat-label">Added</div></div>'
          + '<div class="work-stat modified"><div class="work-stat-value">~' + data.filesModified + '</div><div class="work-stat-label">Modified</div></div>'
          + '<div class="work-stat deleted"><div class="work-stat-value">-' + data.filesDeleted + '</div><div class="work-stat-label">Deleted</div></div>'
          + '</div>';
        this.publishUpdate(data);
      };
      return WSC;
    })();

    // ── ConfigDisplayControl ────────────────────────────────────────────
    var ConfigDisplayControl = (function() {
      function CDC(bus, controlId, elementId) {
        SubscribableControl.call(this, bus, controlId);
        this._elementId = elementId;
        this._userOverrides = {};
        var self = this;
        this.subscribe(T.CONFIG_UPDATE, function(data) { self.update(data); });
      }
      CDC.prototype = Object.create(SubscribableControl.prototype);
      CDC.prototype.constructor = CDC;
      CDC.prototype.update = function(data) {
        if (!data || !data.data) return;
        var el = this.getElement(this._elementId);
        if (!el) return;
        var cfg = data.data;
        var phasesHtml = '';

        // Prechecks (collapsible, collapsed by default)
        if (cfg.prechecks) {
          var preType = cfg.prechecksType || { type: 'shell', label: 'Shell' };
          var preExpanded = this._userOverrides.prechecks !== undefined
            ? this._userOverrides.prechecks
            : (cfg.currentPhase === 'prechecks');
          phasesHtml += this._renderCollapsiblePhase('prechecks', 'Prechecks', preType, cfg.prechecks, preExpanded);
        }

        // Work (always expanded, not collapsible)
        if (cfg.work) {
          var workType = cfg.workType || { type: 'agent', label: 'Agent' };
          var augBadge = cfg.originalInstructions
            ? ' <span class="phase-type-badge agent" style="margin-left: 4px;">✨ Augmented</span>'
            : '';
          phasesHtml += '<div class="config-phase">'
            + '<div class="config-phase-header non-collapsible">'
            + '<span class="phase-label">Work</span>'
            + '<span class="phase-type-badge ' + (workType.type || '').toLowerCase() + '">' + escapeHtml(workType.label) + '</span>'
            + augBadge
            + '</div>'
            + '<div class="config-phase-body">' + cfg.work + '</div>'
            + '</div>';
        }

        // Postchecks (collapsible, collapsed by default)
        if (cfg.postchecks) {
          var postType = cfg.postchecksType || { type: 'shell', label: 'Shell' };
          var postExpanded = this._userOverrides.postchecks !== undefined
            ? this._userOverrides.postchecks
            : (cfg.currentPhase === 'postchecks');
          phasesHtml += this._renderCollapsiblePhase('postchecks', 'Postchecks', postType, cfg.postchecks, postExpanded);
        }

        // Wrap in matching server-side section structure
        var html = '<div class="section"><h3>Job Configuration</h3>'
          + '<div class="config-item"><div class="config-label">Task</div>'
          + '<div class="config-value">' + escapeHtml(cfg.task || '') + '</div></div>'
          + '<div class="config-phases">' + phasesHtml + '</div>';

        // Original instructions: augmented badge + collapsible View Original
        if (cfg.originalInstructions) {
          html += '<div class="config-phase">'
            + '<div class="config-phase-header collapsed config-collapsible-toggle" data-phase="original-instructions">'
            + '<span class="chevron">▶</span>'
            + '<span class="phase-label">View Original</span>'
            + '</div>'
            + '<div class="config-phase-body" style="display:none">'
            + '<div class="config-value">' + escapeHtml(cfg.originalInstructions) + '</div>'
            + '</div></div>';
        }

        html += '</div>';

        el.innerHTML = html;
        this._bindCollapsibleHandlers(el);
        this.publishUpdate(data);
      };
      CDC.prototype._renderCollapsiblePhase = function(phaseId, label, typeInfo, content, expanded) {
        var chevron = expanded ? '▼' : '▶';
        var display = expanded ? 'block' : 'none';
        var expandedClass = expanded ? '' : ' collapsed';
        return '<div class="config-phase">'
          + '<div class="config-phase-header' + expandedClass + ' config-collapsible-toggle" data-phase="' + phaseId + '">'
          + '<span class="chevron">' + chevron + '</span>'
          + '<span class="phase-label">' + escapeHtml(label) + '</span>'
          + '<span class="phase-type-badge ' + (typeInfo.type || '').toLowerCase() + '">' + escapeHtml(typeInfo.label || label) + '</span>'
          + '</div>'
          + '<div class="config-phase-body" style="display: ' + display + ';">' + content + '</div>'
          + '</div>';
      };
      CDC.prototype._bindCollapsibleHandlers = function(el) {
        var self = this;
        var toggles = el.querySelectorAll('.config-collapsible-toggle');
        for (var i = 0; i < toggles.length; i++) {
          (function(toggle) {
            if (toggle._boundHandler) return;
            toggle._boundHandler = true;
            toggle.addEventListener('click', function() {
              var phaseId = toggle.getAttribute('data-phase');
              var section = toggle.closest('.config-phase');
              var body = section ? section.querySelector('.config-phase-body') : null;
              var chevron = toggle.querySelector('.chevron');
              if (!body) return;
              var isVisible = body.style.display !== 'none';
              body.style.display = isVisible ? 'none' : 'block';
              if (chevron) chevron.textContent = isVisible ? '▶' : '▼';
              if (isVisible) {
                toggle.classList.add('collapsed');
              } else {
                toggle.classList.remove('collapsed');
              }
              self._userOverrides[phaseId] = !isVisible;
            });
          })(toggles[i]);
        }
      };
      return CDC;
    })();

    // ── Instantiate controls ────────────────────────────────────────────
    var statusBadge = new StatusBadgeControl(bus, 'nd-status-badge', 'node-status-badge');
    var durationCounter = new DurationCounterControl(bus, 'nd-duration', 'duration-timer');
    var logViewer = new LogViewerControl(bus, 'nd-log-viewer', 'logViewer');
    var processTree = new ProcessTreeControl(bus, 'nd-process-tree', 'processTree', 'processTreeTitle');
    var phaseTabBar = new PhaseTabBarControl(bus, 'nd-phase-tabs');
    var attemptList = new AttemptListControl(bus, 'nd-attempt-list', '.attempt-history-container');
    var aiUsageStats = new AiUsageStatsControl(bus, 'nd-ai-usage', 'aiUsageStatsContainer');
    var workSummaryCtrl = new WorkSummaryControl(bus, 'nd-work-summary', 'workSummaryContainer');
    var configDisplay = new ConfigDisplayControl(bus, 'nd-config-display', 'configDisplayContainer');

    // ── Global Ctrl+C handler ───────────────────────────────────────────
    document.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        var selectedText = window.getSelection().toString();
        if (selectedText) {
          e.preventDefault();
          vscode.postMessage({ type: 'copyToClipboard', text: selectedText });
        }
      }
    });

    // ── Navigation helpers (called from onclick in HTML) ────────────────
    function openPlan(planId) {
      vscode.postMessage({ type: 'openPlan', planId: planId });
    }

    function openWorktree() {
      vscode.postMessage({ type: 'openWorktree' });
    }

    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }

    // ── Phase tab selection (delegates to PhaseTabBarControl) ────────────
    function selectPhase(phase) {
      phaseTabBar.selectPhase(phase);
    }

    // ── Session ID copy handler ─────────────────────────────────────────
    document.body.addEventListener('click', function(e) {
      if (!(e.target instanceof Element)) return;
      var target = e.target.closest('.session-id');
      if (target) {
        var sessionId = target.getAttribute('data-session');
        vscode.postMessage({ type: 'copyToClipboard', text: sessionId });
      }
    });

    // ── Log file path click handler ─────────────────────────────────────
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

    // ── Retry / force-fail button handlers ──────────────────────────────
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

    // ── Attempt card toggle handlers ────────────────────────────────────
    document.body.addEventListener('click', function(e) {
      if (!(e.target instanceof Element)) return;
      var header = e.target.closest('.attempt-header');
      if (!header) return;

      var card = header.closest('.attempt-card');
      var body = card.querySelector('.attempt-body');
      var chevron = header.querySelector('.chevron');
      var isExpanded = header.getAttribute('data-expanded') === 'true';

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
      var tab = e.target.closest('.attempt-phase-tab');
      if (!tab) return;

      e.stopPropagation();
      var phase = tab.getAttribute('data-phase');
      var attemptNum = tab.getAttribute('data-attempt');
      var phasesContainer = tab.closest('.attempt-phases');

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

    // ── Initial phase selection (synchronous, no setTimeout) ────────────
    var phaseToSelect = currentPhase || initialPhase;
    if (phaseToSelect) {
      selectPhase(phaseToSelect);
    }

    // ── Request initial process stats from extension ────────────────────
    if (document.getElementById('processTreeSection')) {
      vscode.postMessage({ type: 'getProcessStats' });
    }
  `;
}
