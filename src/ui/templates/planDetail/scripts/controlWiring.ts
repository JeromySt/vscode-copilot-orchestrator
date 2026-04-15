/**
 * @fileoverview Control wiring, postMessage routing, and process trees for plan detail view.
 *
 * @module ui/templates/planDetail/scripts/controlWiring
 */

import type { PlanScriptsData } from '../scriptsTemplate';

/**
 * Generate JavaScript for control instantiation, postMessage routing, and process trees.
 *
 * @param data - Scripts input data.
 * @returns JavaScript code string.
 */
export function renderControlWiring(data: PlanScriptsData): string {
  return `
    // ── Process stats pulse counter ──────────────────────────────────────
    var _processStatsPulseCount = 0;

    // Initialize capacity info
    if (initialGlobalCapacity && (initialGlobalCapacity.totalGlobalJobs > 0 || initialGlobalCapacity.activeInstances > 1)) {
      const capacityInfoEl = document.getElementById('capacityInfo');
      capacityInfoEl.style.display = 'flex';
      document.getElementById('instanceCount').textContent = initialGlobalCapacity.activeInstances;
      document.getElementById('globalJobs').textContent = initialGlobalCapacity.totalGlobalJobs;
      document.getElementById('globalMax').textContent = initialGlobalCapacity.globalMaxParallel;
    }
    
    // Token count formatter for client-side model breakdown rendering
    function formatTk(n) {
      if (n === undefined || n === null) return '0';
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'm';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(n);
    }
    
    // HTML escape for user-provided values in innerHTML
    function escHtml(s) {
      var d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }
    
    // Live duration counter
    function formatDurationLive(ms) {
      if (ms < 1000) return '< 1s';
      const secs = Math.floor(ms / 1000);
      if (secs < 60) return secs + 's';
      const mins = Math.floor(secs / 60);
      const remSecs = secs % 60;
      if (mins < 60) return mins + 'm ' + remSecs + 's';
      const hours = Math.floor(mins / 60);
      const remMins = mins % 60;
      return hours + 'h ' + remMins + 'm';
    }
    
    function updateDurationCounter() {
      const el = document.getElementById('planDuration');
      if (!el) return;
      
      const started = parseInt(el.dataset.started) || 0;
      const ended = parseInt(el.dataset.ended) || 0;
      const status = el.dataset.status;
      
      if (!started) {
        el.textContent = '--';
        return;
      }
      
      if (status === 'running' || status === 'pending') {
        const duration = Date.now() - started;
        el.textContent = formatDurationLive(duration);
      } else if (ended) {
        const duration = ended - started;
        el.textContent = formatDurationLive(duration);
      }
    }
    
    // Initial duration update
    updateDurationCounter();
    
    // Update node durations in SVG for running nodes
    function updateNodeDurations() {
      const svgElement = document.querySelector('.mermaid svg');
      if (!svgElement) return;
      
      for (const [sanitizedId, data] of Object.entries(nodeData)) {
        if (!data.startedAt) continue;
        
        // Only update running/scheduled nodes/groups (not completed ones)
        const isRunning = data.status === 'running' || data.status === 'scheduled';
        if (!isRunning) continue;
        
        const duration = Date.now() - data.startedAt;
        const durationStr = formatDurationLive(duration);
        
        // Find the element - either a node or a cluster (group)
        let targetGroup = svgElement.querySelector('g[id*="' + sanitizedId + '"]');
        let textEls;
        
        // Check if this is a cluster/subgraph
        if (data.type === 'group') {
          // Try cluster selectors
          let cluster = svgElement.querySelector('g.cluster[id*="' + sanitizedId + '"], g[id*="' + sanitizedId + '"].cluster');
          if (!cluster) {
            const allClusters = svgElement.querySelectorAll('g.cluster');
            for (const c of allClusters) {
              const clusterId = c.getAttribute('id') || '';
              if (clusterId.includes(sanitizedId)) {
                cluster = c;
                break;
              }
            }
          }
          if (cluster) {
            const labelText = cluster.querySelector('.cluster-label .nodeLabel, .cluster-label text, .nodeLabel, text');
            if (labelText) {
              const currentText = labelText.textContent || '';
              let updatedText = currentText;
              const pipeIdx = currentText.lastIndexOf(' | ');
              if (pipeIdx > 0) {
                updatedText = currentText.substring(0, pipeIdx) + ' | ' + durationStr;
              } else {
                updatedText = currentText + ' | ' + durationStr;
              }
              const clusterId = cluster.getAttribute('id') || '';
              const maxLen = parseInt(cluster.getAttribute('data-max-text-len') || '') || nodeTextLengths[clusterId];
              labelText.textContent = maxLen ? clampText(updatedText, maxLen) : updatedText;
            }
          }
        } else {
          // Handle regular nodes
          const nodeGroup = svgElement.querySelector('g[id^="flowchart-' + sanitizedId + '-"]');
          if (nodeGroup) {
            const nodeEl = nodeGroup.querySelector('.node') || nodeGroup;
            const foreignObject = nodeEl.querySelector('foreignObject');
            const textSpan = foreignObject ? foreignObject.querySelector('span') : nodeEl.querySelector('text tspan, text');
            if (textSpan) {
              const currentText = textSpan.textContent || '';
              let updatedText = currentText;
              const pipeIdx = currentText.lastIndexOf(' | ');
              if (pipeIdx > 0) {
                updatedText = currentText.substring(0, pipeIdx) + ' | ' + durationStr;
              } else {
                updatedText = currentText + ' | ' + durationStr;
              }
              const nodeElId = nodeEl.getAttribute('id') || '';
              const maxLen = parseInt(nodeEl.getAttribute('data-max-text-len') || '') || nodeTextLengths[nodeElId];
              textSpan.textContent = maxLen ? clampText(updatedText, maxLen) : updatedText;
            }
          }
        }
      }
    }
    
    // Update counters every second via pulse
    bus.on(Topics.PULSE, function() {
      updateDurationCounter();
      updateNodeDurations();
    });
    
    // Route postMessage from extension into EventBus topics
    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (msg.type === 'allProcessStats') {
        bus.emit(Topics.PROCESS_STATS, msg);
      } else if (msg.type === 'statusUpdate') {
        handleStatusUpdate(msg);
      } else if (msg.type === 'pulse') {
        bus.emit(Topics.PULSE);
      } else if (msg.type === 'subscriptionData') {
        handleSubscriptionData(msg);
      }
    });

    // Subscribe to PROCESS_STATS topic
    bus.on(Topics.PROCESS_STATS, function(msg) {
      renderAllProcesses(msg.rootJobs);
    });
    
    // ── Shared colour maps ────────────────────────────────────────────────
    var statusColors = {
      pending: { fill: '#3c3c3c', stroke: '#858585' },
      ready: { fill: '#2d4a6e', stroke: '#3794ff' },
      running: { fill: '#2d4a6e', stroke: '#3794ff' },
      scheduled: { fill: '#2d4a6e', stroke: '#3794ff' },
      succeeded: { fill: '#1e4d40', stroke: '#4ec9b0' },
      failed: { fill: '#4d2929', stroke: '#f48771' },
      blocked: { fill: '#3c3c3c', stroke: '#858585' },
      canceled: { fill: '#3c3c3c', stroke: '#858585' }
    };
    var groupColors = {
      pending: { fill: '#1a1a2e', stroke: '#6a6a8a' },
      ready: { fill: '#1a2a4e', stroke: '#3794ff' },
      running: { fill: '#1a2a4e', stroke: '#3794ff' },
      succeeded: { fill: '#1a3a2e', stroke: '#4ec9b0' },
      failed: { fill: '#3a1a1e', stroke: '#f48771' },
      blocked: { fill: '#3a1a1e', stroke: '#f48771' },
      canceled: { fill: '#1a1a2e', stroke: '#6a6a8a' }
    };
    var nodeIcons = { succeeded: '✓', failed: '✗', running: '▶', blocked: '⊘', pending: '○', ready: '○', scheduled: '▶', canceled: '⊘' };

    // ── SVG health check (extracted from handleStatusUpdate) ──────────────
    function checkSvgUpdateHealth(changed) {
      // no-op: retained for call-site compatibility
    }

    // ── Simplified handleStatusUpdate ─────────────────────────────────────
    function handleStatusUpdate(msg) {
      try {
        var changed = {};
        for (var id in (msg.nodeStatuses || {})) {
          var existing = nodeData[id], incoming = msg.nodeStatuses[id];
          if (!existing || existing.version !== incoming.version) {
            // Merge incoming into existing, preserving existing values for undefined incoming fields
            if (existing) {
              for (var k in incoming) {
                if (incoming[k] !== undefined) { existing[k] = incoming[k]; }
              }
            } else {
              nodeData[id] = incoming;
            }
            changed[id] = nodeData[id];
          }
        }
        bus.emit(Topics.STATUS_UPDATE, Object.assign({}, msg, { nodeStatuses: changed }));
        checkSvgUpdateHealth(changed);
      } catch (err) {
        console.error('handleStatusUpdate error:', err);
      }
    }

    // ── Handle subscriptionData from WebViewSubscriptionManager ───────────
    // Translates planState and nodeState subscription payloads into the
    // existing STATUS_UPDATE event format so all existing controls work
    // without modification.
    var _subDataCount = 0;
    var _refreshRequestCount = 0;
    function handleSubscriptionData(msg) {
      _subDataCount++;
      var content = msg.content;
      if (!content) { return; }
      // Topology change: request full page refresh so Mermaid DAG is rebuilt
      // with new nodes from context pressure reshape or plan modification.
      // Only act on DELTA deliveries (msg.full === false), not initial readFull.
      if (msg.tag === 'planTopology' && content.changed && !msg.full) {
        _refreshRequestCount++;
        console.warn('[PlanDetail-WV] planTopology changed → requesting refresh #' + _refreshRequestCount);
        vscode.postMessage({ type: 'refresh' });
        return;
      }
      if (msg.tag === 'planState') {
        // Plan was deleted — close this panel via the extension host
        if (content.status === 'deleted') {
          vscode.postMessage({ type: 'close' });
          return;
        }
        // PlanStateContent → statusUpdate-compatible shape
        var counts = content.counts || {};
        var total = 0;
        for (var k in counts) { total += counts[k] || 0; }
        var completed = (counts.succeeded || 0) + (counts.failed || 0) + (counts.blocked || 0) + (counts.canceled || 0);
        handleStatusUpdate({
          planStatus: content.status,
          counts: counts,
          progress: content.progress,
          total: total,
          completed: completed,
          startedAt: content.startedAt,
          endedAt: content.endedAt,
          planEndedAt: content.endedAt,
        });
      } else {
        // NodeExecutionState → single-node nodeStatuses entry
        var entry = {
          status: content.status,
          version: content.version || 0,
          startedAt: content.startedAt,
          endedAt: content.endedAt,
        };
        if (content.scheduledAt) { entry.scheduledAt = content.scheduledAt; }
        if (content.stepStatuses) {
          entry.stepStatuses = content.stepStatuses;
          for (var phase in content.stepStatuses) {
            if (content.stepStatuses[phase] === 'running') {
              entry.currentPhase = phase;
              break;
            }
          }
        }
        if (content.attemptHistory && content.attemptHistory.length > 0) {
          entry.attempts = content.attemptHistory.map(function(a) {
            return {
              attemptNumber: a.attemptNumber,
              status: a.status,
              startedAt: a.startedAt,
              endedAt: a.endedAt,
              failedPhase: a.failedPhase,
              triggerType: a.triggerType || 'initial',
              stepStatuses: a.stepStatuses || {},
              phaseDurations: a.phaseMetrics ? Object.entries(a.phaseMetrics).map(function(kv) {
                return {
                  phase: kv[0],
                  durationMs: (kv[1] || {}).durationMs || 0,
                  status: (a.stepStatuses || {})[kv[0]] || 'succeeded',
                };
              }).filter(function(pd) { return pd.durationMs > 0; }) : [],
              phaseTiming: a.phaseTiming || [],
            };
          });
        }
        var ns = {};
        ns[msg.tag] = entry;
        handleStatusUpdate({ nodeStatuses: ns });
      }
    }

    // ── Controls ──────────────────────────────────────────────────────────

    // (a) CapacityInfoControl
    var capacityInfoCtrl = new SubscribableControl(bus, 'capacity-info');
    capacityInfoCtrl.update = function(msg) {
      var gc = msg.globalCapacity;
      if (!gc) return;
      var el = document.getElementById('capacityInfo');
      if (!el) return;
      if (gc.totalGlobalJobs > 0 || gc.activeInstances > 1) {
        el.style.display = 'flex';
        document.getElementById('instanceCount').textContent = gc.activeInstances;
        document.getElementById('globalJobs').textContent = gc.totalGlobalJobs;
        document.getElementById('globalMax').textContent = gc.globalMaxParallel;
      } else {
        el.style.display = 'none';
      }
    };
    capacityInfoCtrl.subscribe(Topics.STATUS_UPDATE, function(msg) { capacityInfoCtrl.update(msg); });

    // (b) PlanStatusControl
    var planStatusCtrl = new SubscribableControl(bus, 'plan-status');
    planStatusCtrl.update = function(msg) {
      var planStatus = msg.planStatus;
      if (!planStatus) { return; }
      var statusBadge = document.getElementById('statusBadge');
      if (statusBadge) {
        statusBadge.className = 'status-badge ' + planStatus;
      }
      // Update phase indicator
      var phaseEl = document.getElementById('currentPhaseIndicator');
      if (phaseEl) {
        var label = planStatus.charAt(0).toUpperCase() + planStatus.slice(1);
        if (planStatus === 'running' || planStatus === 'pending') {
          // Compute phases from all nodeStatuses (changed + existing)
          var phases = {};
          for (var id in nodeData) {
            var nd = nodeData[id];
            if (nd.status === 'running' && nd.currentPhase) {
              phases[nd.currentPhase] = (phases[nd.currentPhase] || 0) + 1;
            }
          }
          var phaseKeys = Object.keys(phases);
          if (phaseKeys.length > 0) {
            var parts = phaseKeys.map(function(p) {
              var name = p.charAt(0).toUpperCase() + p.slice(1);
              return phases[p] > 1 ? name + ' (' + phases[p] + ')' : name;
            });
            label = label + ' - ' + parts.join(', ');
          }
        }
        phaseEl.textContent = label;
      }
      // Update action buttons visibility
      var actionsDiv = document.querySelector('.actions');
      if (actionsDiv) {
        var pauseBtn = document.getElementById('pauseBtn');
        var startBtn = document.getElementById('startBtn');
        var resumeBtn = document.getElementById('resumeBtn');
        var cancelBtn = document.getElementById('cancelBtn');
        var workSummaryBtn = document.getElementById('workSummaryBtn');
        var isActive = (planStatus === 'running' || planStatus === 'pending' || planStatus === 'resumed');
        var isPaused = (planStatus === 'paused');
        var isPausing = (planStatus === 'pausing');
        var isPendingStart = (planStatus === 'pending-start');
        var canControl = isActive || isPaused || isPausing || isPendingStart;
        if (pauseBtn) pauseBtn.style.display = isActive ? '' : 'none';
        if (startBtn) startBtn.style.display = isPendingStart ? '' : 'none';
        if (resumeBtn) resumeBtn.style.display = (isPaused || isPausing) ? '' : 'none';
        if (cancelBtn) cancelBtn.style.display = canControl ? '' : 'none';
        if (workSummaryBtn) workSummaryBtn.style.display = planStatus === 'succeeded' ? '' : 'none';
      }
      // Show/hide processes section based on plan status.
      // Keep visible while pausing (running jobs still completing).
      var procSection = document.getElementById('processesSection');
      if (procSection) {
        var hasRunningNodes = msg.counts && ((msg.counts.running || 0) + (msg.counts.scheduled || 0)) > 0;
        var showProc = (planStatus === 'running' || planStatus === 'pending' || planStatus === 'resumed') || ((planStatus === 'paused' || planStatus === 'pausing') && hasRunningNodes);
        procSection.style.display = showProc ? '' : 'none';
      }
      // Update plan duration element with current status and endedAt
      var durEl = document.getElementById('planDuration');
      if (durEl) {
        durEl.dataset.status = planStatus;
        if (msg.endedAt) { durEl.dataset.ended = String(msg.endedAt); }
        updateDurationCounter();
      }
      this.publishUpdate(msg);
    };
    planStatusCtrl.subscribe(Topics.STATUS_UPDATE, function(msg) { planStatusCtrl.update(msg); });

    // (c) ProgressControl
    var progressCtrl = new SubscribableControl(bus, 'progress');
    progressCtrl.update = function(msg) {
      if (msg.progress === undefined) { return; }
      var progressFill = document.querySelector('.progress-fill');
      var progressText = document.querySelector('.progress-text');
      if (progressFill) progressFill.style.width = msg.progress + '%';
      if (progressText) progressText.textContent = msg.completed + ' / ' + msg.total + ' (' + msg.progress + '%)';
    };
    progressCtrl.subscribe(Topics.STATUS_UPDATE, function(msg) { progressCtrl.update(msg); });

    // (d) StatsControl
    var statsCtrl = new SubscribableControl(bus, 'stats');
    statsCtrl.update = function(msg) {
      var counts = msg.counts;
      if (!counts) { return; }
      var total = msg.total;
      var statsContainer = document.querySelector('.stats');
      if (!statsContainer) return;
      var statItems = statsContainer.querySelectorAll('.stat');
      statItems.forEach(function(stat) {
        var label = stat.querySelector('.stat-label');
        var value = stat.querySelector('.stat-value');
        if (!label || !value) return;
        var labelText = label.textContent.trim();
        if (labelText === 'Total Jobs') value.textContent = total;
        else if (labelText === 'Succeeded') value.textContent = counts.succeeded || 0;
        else if (labelText === 'Failed') value.textContent = counts.failed || 0;
        else if (labelText === 'Running') value.textContent = (counts.running || 0) + (counts.scheduled || 0);
        else if (labelText === 'Pending') value.textContent = (counts.pending || 0) + (counts.ready || 0);
      });
    };
    statsCtrl.subscribe(Topics.STATUS_UPDATE, function(msg) { statsCtrl.update(msg); });

    // (e) MetricsBarControl
    var metricsBarCtrl = new SubscribableControl(bus, 'metrics-bar');
    metricsBarCtrl.update = function(msg) {
      var pm = msg.planMetrics;
      if (!pm) return;
      var metricsBar = document.getElementById('planMetricsBar');
      if (!metricsBar) return;
      var items = [];
      if (pm.premiumRequests) items.push('<span class="metric-item">🎫 <span class="metric-value">' + pm.premiumRequests + '</span></span>');
      if (pm.apiTime) items.push('<span class="metric-item">⏱ API: <span class="metric-value">' + pm.apiTime + '</span></span>');
      if (pm.sessionTime) items.push('<span class="metric-item">🕐 Session: <span class="metric-value">' + pm.sessionTime + '</span></span>');
      if (pm.codeChanges) items.push('<span class="metric-item">📝 <span class="metric-value">' + pm.codeChanges + '</span></span>');
      var modelsHtml = '';
      if (pm.modelBreakdown && pm.modelBreakdown.length > 0) {
        var rows = pm.modelBreakdown.map(function(m) {
          var cached = m.cachedTokens ? ', ' + formatTk(m.cachedTokens) + ' cached' : '';
          var reqs = m.premiumRequests !== undefined ? ' (' + m.premiumRequests + ' req)' : '';
          return '<div class="model-row"><span class="model-name">' + escHtml(m.model) + '</span><span class="model-tokens">' + formatTk(m.inputTokens) + ' in, ' + formatTk(m.outputTokens) + ' out' + cached + reqs + '</span></div>';
        }).join('');
        modelsHtml = '<div class="model-breakdown"><div class="model-breakdown-label">Model Breakdown:</div><div class="model-breakdown-list">' + rows + '</div></div>';
      }
      metricsBar.innerHTML = '<span class="metrics-label">⚡ AI Usage:</span> ' + items.join(' ') + modelsHtml;
      metricsBar.style.display = '';
    };
    metricsBarCtrl.subscribe(Topics.STATUS_UPDATE, function(msg) { metricsBarCtrl.update(msg); });

    // (f) LegendControl
    var legendCtrl = new SubscribableControl(bus, 'legend');
    legendCtrl.update = function(msg) {
      var counts = msg.counts;
      if (!counts) { return; }
      var legendItems = document.querySelectorAll('.legend-item');
      legendItems.forEach(function(item) {
        var icon = item.querySelector('.legend-icon');
        if (!icon) return;
        var statusClass = Array.from(icon.classList).find(function(c) { return c !== 'legend-icon'; });
        if (statusClass && counts[statusClass] !== undefined) {
          var span = item.querySelector('span:last-child');
          if (span) span.textContent = statusClass.charAt(0).toUpperCase() + statusClass.slice(1) + ' (' + counts[statusClass] + ')';
        }
      });
    };
    legendCtrl.subscribe(Topics.STATUS_UPDATE, function(msg) { legendCtrl.update(msg); });

    // (g) MermaidNodeStyleControl
    var mermaidNodeStyleCtrl = new SubscribableControl(bus, 'mermaid-node-style');
    mermaidNodeStyleCtrl._lastUpdated = 0;
    mermaidNodeStyleCtrl.update = function(msg) {
      var svgElement = document.querySelector('.mermaid svg');
      if (!svgElement || !msg.nodeStatuses) { this._lastUpdated = 0; return; }
      var ns = msg.nodeStatuses;
      var updated = 0;
      for (var sanitizedId in ns) {
        var data = ns[sanitizedId];
        var nodeGroup = svgElement.querySelector('g[id^="flowchart-' + sanitizedId + '-"]');
        if (!nodeGroup) continue;
        updated++;
        var nodeEl = nodeGroup.querySelector('.node') || nodeGroup;
        if (!nodeEl || !nodeEl.classList) continue;
        nodeEl.classList.remove('pending', 'ready', 'running', 'succeeded', 'failed', 'blocked', 'canceled', 'scheduled');
        nodeEl.classList.add(data.status);
        var rect = nodeEl.querySelector('rect');
        if (rect && statusColors[data.status]) {
          rect.style.fill = statusColors[data.status].fill;
          rect.style.stroke = statusColors[data.status].stroke;
          rect.style.strokeWidth = data.status === 'running' ? '2px' : '';
        }
        var foreignObject = nodeEl.querySelector('foreignObject');
        var textSpan = foreignObject ? foreignObject.querySelector('span') : nodeEl.querySelector('text tspan, text');
        if (textSpan) {
          var newIcon = nodeIcons[data.status] || '○';
          var currentText = textSpan.textContent || '';
          var iconChars = ['✓', '✗', '▶', '⊘', '○'];
          var hasIcon = currentText.length > 0 && iconChars.indexOf(currentText[0]) !== -1;
          // Also handle multi-char prefixes like "∧ ○" or "⑃ ○" (checkpointed/fan-in prefix)
          var textAfterIcon = currentText;
          if (hasIcon) {
            textAfterIcon = currentText.substring(1);
          } else {
            // Check for 2-char prefix patterns like "∧ " or "⇉ " or "⑃ "
            var prefixMatch = currentText.match(/^([∧⇉⑃⇒]\s*)/);
            if (prefixMatch) {
              var prefix = prefixMatch[1];
              var afterPrefix = currentText.substring(prefix.length);
              if (afterPrefix.length > 0 && iconChars.indexOf(afterPrefix[0]) !== -1) {
                textAfterIcon = afterPrefix.substring(1);
                newIcon = prefix + newIcon;
              }
            }
          }
          var updatedText = hasIcon ? newIcon + textAfterIcon : currentText;
          // Strip or set duration based on status and whether the node actually ran
          var hasStarted = !!data.startedAt;
          var isTerminalWithDuration = hasStarted && (data.status === 'succeeded' || data.status === 'failed');
          var isActive = data.status === 'running' || data.status === 'scheduled';
          if (!isTerminalWithDuration && !isActive) {
            // Strip duration: pending, ready, blocked (never ran), canceled (never ran)
            var pipeIdx = updatedText.lastIndexOf(' | ');
            if (pipeIdx > 0) {
              updatedText = updatedText.substring(0, pipeIdx);
            }
          }
          // For terminal nodes that actually ran, set final duration
          if (isTerminalWithDuration) {
            var endTime = data.endedAt || Date.now();
            var dur = endTime - data.startedAt;
            var durStr = formatDurationLive(dur);
            var pi = updatedText.lastIndexOf(' | ');
            if (pi > 0) {
              updatedText = updatedText.substring(0, pi) + ' | ' + durStr;
            } else {
              updatedText = updatedText + ' | ' + durStr;
            }
          }
          var nodeElId = nodeEl.getAttribute('id') || '';
          var maxLen = parseInt(nodeEl.getAttribute('data-max-text-len') || '') || nodeTextLengths[nodeElId];
          textSpan.textContent = maxLen ? clampText(updatedText, maxLen) : updatedText;
        }
      }
      this._lastUpdated = updated;
      this.publishUpdate(msg);
    };
    mermaidNodeStyleCtrl.subscribe(Topics.STATUS_UPDATE, function(msg) { mermaidNodeStyleCtrl.update(msg); });

    // (h) MermaidEdgeStyleControl
    var mermaidEdgeStyleCtrl = new SubscribableControl(bus, 'mermaid-edge-style');
    mermaidEdgeStyleCtrl.update = function(msg) {
      var svgElement = document.querySelector('.mermaid svg');
      if (!svgElement || !edgeData || edgeData.length === 0) return;
      var edgePaths = svgElement.querySelectorAll('.edgePaths > *');
      var edgeColors = {
        succeeded: '#4ec9b0',
        failed: '#f48771',
        running: '#3794ff',
        scheduled: '#3794ff'
      };
      var defaultEdgeColor = '#858585';
      for (var i = 0; i < edgeData.length; i++) {
        var edge = edgeData[i];
        var edgeEl = edgePaths[edge.index];
        if (!edgeEl) continue;
        var pathEl = edgeEl.querySelector('path') || edgeEl;
        var sourceStatus = null;
        if (edge.from === 'TARGET_SOURCE') {
          sourceStatus = 'succeeded';
        } else {
          var sourceData = nodeData[edge.from];
          if (sourceData) sourceStatus = sourceData.status;
        }
        var color = (sourceStatus && edgeColors[sourceStatus]) || defaultEdgeColor;
        pathEl.style.stroke = color;
        pathEl.style.strokeWidth = (sourceStatus === 'succeeded' || sourceStatus === 'failed') ? '2px' : '';
        if (sourceStatus && sourceStatus !== 'pending' && sourceStatus !== 'ready') {
          pathEl.style.strokeDasharray = 'none';
        } else {
          pathEl.style.strokeDasharray = '';
        }
        var marker = edgeEl.querySelector('defs marker path, marker path');
        if (marker) {
          marker.style.fill = color;
          marker.style.stroke = color;
        }
      }
    };
    mermaidEdgeStyleCtrl.subscribe(Topics.STATUS_UPDATE, function(msg) { mermaidEdgeStyleCtrl.update(msg); });

    // (i) MermaidGroupStyleControl
    // Mermaid generates cluster <g> IDs as subGraph0, subGraph1 etc. — they
    // do NOT contain the sanitized group UUID. So we match clusters to group
    // data by finding the group name inside each cluster's label text.
    var mermaidGroupStyleCtrl = new SubscribableControl(bus, 'mermaid-group-style');
    mermaidGroupStyleCtrl._lastUpdated = 0;
    mermaidGroupStyleCtrl.update = function(msg) {
      var svgElement = document.querySelector('.mermaid svg');
      if (!svgElement || !msg.nodeStatuses) { this._lastUpdated = 0; return; }
      var ns = msg.nodeStatuses;

      // Build name → data map from group entries in nodeStatuses
      var groupsByName = {};
      for (var sid in ns) {
        var d = ns[sid];
        if (d.type === 'group' && d.name) {
          groupsByName[d.name] = d;
        }
      }
      if (Object.keys(groupsByName).length === 0) { return; }

      var updated = 0;
      var allClusters = svgElement.querySelectorAll('g');
      for (var ci = 0; ci < allClusters.length; ci++) {
        var cluster = allClusters[ci];
        var clsAttr = cluster.getAttribute('class') || '';
        if (clsAttr.indexOf('cluster') === -1) continue;

        // Get all text content within the cluster label area
        var labelEl = null;
        var candidates = cluster.querySelectorAll('.cluster-label .nodeLabel, .cluster-label span, .cluster-label div, .cluster-label text, foreignObject span, foreignObject div');
        for (var li = 0; li < candidates.length; li++) {
          if (candidates[li].textContent && candidates[li].textContent.trim().length > 0) {
            labelEl = candidates[li];
            break;
          }
        }
        if (!labelEl) continue;
        var labelText = labelEl.textContent.trim();

        // Match by finding a group name within the label text
        var matchedData = null;
        for (var gname in groupsByName) {
          if (labelText.indexOf(gname) !== -1) {
            matchedData = groupsByName[gname];
            break;
          }
        }
        if (!matchedData) continue;
        updated++;

        // Apply fill/stroke colors to the cluster rect
        var clusterRect = cluster.querySelector('rect');
        if (clusterRect && groupColors[matchedData.status]) {
          clusterRect.style.fill = groupColors[matchedData.status].fill;
          clusterRect.style.stroke = groupColors[matchedData.status].stroke;
        }

        // Update status icon in label text
        var newIcon = nodeIcons[matchedData.status] || '\u25CB';
        var currentText = labelEl.textContent || '';
        if (currentText.length > 0) {
          var iconChars = ['\u2713', '\u2717', '\u25B6', '\u2298', '\u25CB'];
          var firstChar = currentText[0];
          var updatedText = currentText;
          if (iconChars.indexOf(firstChar) !== -1) {
            updatedText = newIcon + currentText.substring(1);
          } else {
            // Check for multi-char prefix like "∧ ○" or "⑃ ○"
            var prefixMatch = currentText.match(/^([\u2229\u21D2\u2443\u2283]\s*)/);
            if (prefixMatch) {
              var prefix = prefixMatch[1];
              var afterPrefix = currentText.substring(prefix.length);
              if (afterPrefix.length > 0 && iconChars.indexOf(afterPrefix[0]) !== -1) {
                updatedText = prefix + newIcon + afterPrefix.substring(1);
              }
            }
          }
          // Duration handling
          var hasStarted = !!matchedData.startedAt;
          var isTerminalWithDuration = hasStarted && (matchedData.status === 'succeeded' || matchedData.status === 'failed');
          var isActive = matchedData.status === 'running' || matchedData.status === 'scheduled';
          if (!isTerminalWithDuration && !isActive) {
            var pipeIdx = updatedText.lastIndexOf(' | ');
            if (pipeIdx > 0) {
              updatedText = updatedText.substring(0, pipeIdx);
            }
          }
          if (isTerminalWithDuration) {
            var endTime = matchedData.endedAt || Date.now();
            var dur = endTime - matchedData.startedAt;
            var durStr = formatDurationLive(dur);
            var pi = updatedText.lastIndexOf(' | ');
            if (pi > 0) {
              updatedText = updatedText.substring(0, pi) + ' | ' + durStr;
            } else {
              updatedText = updatedText + ' | ' + durStr;
            }
          }
          var clusterElId = cluster.getAttribute('id') || '';
          var maxLen = parseInt(cluster.getAttribute('data-max-text-len') || '') || nodeTextLengths[clusterElId];
          labelEl.textContent = maxLen ? clampText(updatedText, maxLen) : updatedText;
        }
      }
      this._lastUpdated = updated;
      this.publishUpdate(msg);
    };
    mermaidGroupStyleCtrl.subscribe(Topics.STATUS_UPDATE, function(msg) { mermaidGroupStyleCtrl.update(msg); });

    // (j) LayoutManager
    var layoutMgr = new SubscribableControl(bus, 'layout-manager');
    layoutMgr.update = function() {
      // Save viewport state before re-render
      var scrollParent = document.getElementById('mermaid-diagram');
      var savedScrollTop = scrollParent ? scrollParent.scrollTop : 0;
      var savedScrollLeft = scrollParent ? scrollParent.scrollLeft : 0;
      var savedZoom = currentZoom;

      requestAnimationFrame(function() {
        const element = document.querySelector('.mermaid');
        if (!element) return;

        // Re-render mermaid
        mermaid.render('mermaid-graph', mermaidDef).then(function(result) {
          element.innerHTML = result.svg;
          // Expand foreignObject for nodes (same fix as clusters)
          element.querySelectorAll('.node .nodeLabel, .node span, .node div').forEach(function(label) {
            var parent = label;
            while (parent && parent.tagName !== 'foreignObject') { parent = parent.parentElement; }
            if (parent && parent.tagName === 'foreignObject') {
              var textWidth = label.scrollWidth || label.offsetWidth || 200;
              var curWidth = parseFloat(parent.getAttribute('width')) || 0;
              if (textWidth + 20 > curWidth) { parent.setAttribute('width', String(textWidth + 30)); }
            }
          });
          // Expand foreignObject for clusters
          element.querySelectorAll('.cluster-label').forEach(function(label) {
            var parent = label.parentElement;
            while (parent && parent.tagName !== 'foreignObject') { parent = parent.parentElement; }
            if (parent && parent.tagName === 'foreignObject') {
              var textEl = label.querySelector('.nodeLabel, span, div');
              if (textEl) {
                var textWidth = textEl.scrollWidth || textEl.offsetWidth || 200;
                var curWidth = parseFloat(parent.getAttribute('width')) || 0;
                if (textWidth + 20 > curWidth) { parent.setAttribute('width', String(textWidth + 30)); }
              }
            }
            label.style.overflow = 'visible';
            label.style.width = 'auto';
          });
          // Re-capture and store node text lengths as data attributes (same as initial render)
          element.querySelectorAll('.node').forEach(function(ng) {
            var textEl = ng.querySelector('foreignObject span, foreignObject div, text tspan, text');
            if (textEl && textEl.textContent) {
              var gId = ng.getAttribute('id') || '';
              var len = textEl.textContent.length;
              nodeTextLengths[gId] = len;
              // Store as HTML attribute for client-side update code
              ng.setAttribute('data-max-text-len', String(len));
            }
          });
          // Re-capture cluster text lengths
          element.querySelectorAll('g.cluster').forEach(function(cg) {
            var textEl = cg.querySelector('.cluster-label .nodeLabel, .cluster-label span, .cluster-label div, text tspan, text');
            if (textEl && textEl.textContent) {
              var gId = cg.getAttribute('id') || '';
              var len = textEl.textContent.length;
              nodeTextLengths[gId] = len;
              // Store as HTML attribute for client-side update code
              cg.setAttribute('data-max-text-len', String(len));
            }
          });
          // Strip sizing template duration from pending/ready nodes after re-render.
          // Running nodes get duration re-added by the pulse timer.
          // Terminal nodes (succeeded, failed, canceled, blocked) keep their server-rendered duration.
          for (var sid in nodeData) {
            var data = nodeData[sid];
            var keepDuration = data.startedAt && (data.status === 'running' || data.status === 'scheduled' ||
              data.status === 'succeeded' || data.status === 'failed');
            if (keepDuration) continue;
            
            if (data.type === 'group') {
              // Handle clusters
              var cluster = element.querySelector('g.cluster[id*="' + sid + '"], g[id*="' + sid + '"].cluster');
              if (!cluster) {
                var allClusters = element.querySelectorAll('g.cluster');
                for (var ci = 0; ci < allClusters.length; ci++) {
                  var clusterId = allClusters[ci].getAttribute('id') || '';
                  if (clusterId.includes(sid)) { cluster = allClusters[ci]; break; }
                }
              }
              if (cluster) {
                var labelText = cluster.querySelector('.cluster-label .nodeLabel, .cluster-label text, .nodeLabel, text');
                if (labelText) {
                  var currentText = labelText.textContent || '';
                  var pipeIdx = currentText.lastIndexOf(' | ');
                  if (pipeIdx > 0) {
                    var strippedText = currentText.substring(0, pipeIdx);
                    var maxLen = parseInt(cluster.getAttribute('data-max-text-len') || '') || nodeTextLengths[cluster.getAttribute('id') || ''];
                    labelText.textContent = maxLen ? clampText(strippedText, maxLen) : strippedText;
                  }
                }
              }
            } else {
              // Handle regular nodes
              var nodeGroup = element.querySelector('g[id^="flowchart-' + sid + '-"]');
              if (nodeGroup) {
                var nodeEl = nodeGroup.querySelector('.node') || nodeGroup;
                var foreignObject = nodeEl.querySelector('foreignObject');
                var textSpan = foreignObject ? foreignObject.querySelector('span') : nodeEl.querySelector('text tspan, text');
                if (textSpan) {
                  var currentText = textSpan.textContent || '';
                  var pipeIdx = currentText.lastIndexOf(' | ');
                  if (pipeIdx > 0) {
                    var strippedText = currentText.substring(0, pipeIdx);
                    var maxLen = parseInt(nodeEl.getAttribute('data-max-text-len') || '') || nodeTextLengths[nodeEl.getAttribute('id') || ''];
                    textSpan.textContent = maxLen ? clampText(strippedText, maxLen) : strippedText;
                  }
                }
              }
            }
          }
          // Restore viewport state: zoom THEN scroll (updateZoom changes
          // container dimensions which can reset scrollParent scroll position)
          currentZoom = savedZoom;
          updateZoom();
          // Defer scroll restoration to after the browser reflows from updateZoom
          requestAnimationFrame(function() {
            if (scrollParent) {
              scrollParent.scrollTop = savedScrollTop;
              scrollParent.scrollLeft = savedScrollLeft;
            }
          });
          // Re-apply node colours
          var replayMsg = { nodeStatuses: {}, counts: {}, planStatus: '', progress: 0, total: 0, completed: 0 };
          for (var sid in nodeData) { replayMsg.nodeStatuses[sid] = nodeData[sid]; }
          mermaidNodeStyleCtrl.update(replayMsg);
          mermaidGroupStyleCtrl.update(replayMsg);
          mermaidEdgeStyleCtrl.update(replayMsg);
          updateNodeDurations();
          bus.emit(Topics.LAYOUT_CHANGE + ':complete');
        }).catch(function(err) {
          console.error('LayoutManager re-render error:', err);
        });
      });
    };
    layoutMgr.subscribe(Topics.LAYOUT_CHANGE, function() { layoutMgr.update(); });
    
    function formatMemory(bytes) {
      const mb = bytes / 1024 / 1024;
      if (mb >= 1024) {
        return (mb / 1024).toFixed(2) + ' GB';
      }
      return mb.toFixed(1) + ' MB';
    }

    function sumAllProcessStats(rootJobs) {
      let totalCount = 0;
      let totalCpu = 0;
      let totalMemory = 0;

      function sumProc(proc) {
        totalCount++;
        totalCpu += proc.cpu || 0;
        totalMemory += proc.memory || 0;
        if (proc.children) {
          for (const child of proc.children) {
            sumProc(child);
          }
        }
      }

      function sumJob(job) {
        for (const proc of (job.tree || [])) {
          sumProc(proc);
        }
      }

      for (const job of (rootJobs || [])) {
        sumJob(job);
      }

      return { totalCount, totalCpu, totalMemory };
    }

    function renderAllProcesses(rootJobs) {
      const container = document.getElementById('processesContainer');
      if (!container) return;
      
      const hasRootJobs = rootJobs && rootJobs.length > 0;
      
      if (!hasRootJobs) {
        container.innerHTML = '<div class="processes-loading">No active processes</div>';
        return;
      }
      
      // Preserve collapsed state of each job node before re-render
      var collapsedJobs = {};
      var existingNodes = container.querySelectorAll('.node-processes');
      for (var i = 0; i < existingNodes.length; i++) {
        var nameEl = existingNodes[i].querySelector('.node-name');
        if (nameEl && existingNodes[i].classList.contains('collapsed')) {
          collapsedJobs[nameEl.textContent] = true;
        }
      }
      
      // Aggregation summary
      const agg = sumAllProcessStats(rootJobs);
      let html = '<div class="processes-summary">';
      html += '<span class="processes-summary-label">Total</span>';
      html += '<span class="processes-summary-stat">' + agg.totalCount + ' processes</span>';
      html += '<span class="processes-summary-stat">' + agg.totalCpu.toFixed(0) + '% CPU</span>';
      html += '<span class="processes-summary-stat">' + formatMemory(agg.totalMemory) + '</span>';
      html += '</div>';
      
      // Render all jobs
      for (const job of (rootJobs || [])) {
        html += renderJobNode(job, 0, collapsedJobs);
      }
      
      container.innerHTML = html;
      
      // Mark process trees that overflow as scrollable (shows fade indicator)
      var trees = container.querySelectorAll('.node-processes-tree');
      for (var i = 0; i < trees.length; i++) {
        if (trees[i].scrollHeight > trees[i].clientHeight) {
          trees[i].classList.add('has-overflow');
        } else {
          trees[i].classList.remove('has-overflow');
        }
      }
    }
    
    // Render a job node with its process tree
    function renderJobNode(job, depth, collapsedJobs) {
      const indent = depth * 16;
      const tree = job.tree || [];
      
      // Calculate totals for this job
      function countAndSum(proc) {
        let count = 1;
        let cpu = proc.cpu || 0;
        let memory = proc.memory || 0;
        if (proc.children) {
          for (const child of proc.children) {
            const childStats = countAndSum(child);
            count += childStats.count;
            cpu += childStats.cpu;
            memory += childStats.memory;
          }
        }
        return { count, cpu, memory };
      }
      
      const totals = tree.reduce((acc, proc) => {
        const s = countAndSum(proc);
        return { count: acc.count + s.count, cpu: acc.cpu + s.cpu, memory: acc.memory + s.memory };
      }, { count: 0, cpu: 0, memory: 0 });
      
      const memMB = (totals.memory / 1024 / 1024).toFixed(1);
      const statusClass = 'job-' + job.status;
      const hasProcesses = tree.length > 0;
      const isCollapsed = collapsedJobs && collapsedJobs[job.nodeName];
      
      let html = '<div class="node-processes ' + statusClass + (isCollapsed ? ' collapsed' : '') + '" style="margin-left: ' + indent + 'px;">';
      html += '<div class="node-processes-header" onclick="this.parentElement.classList.toggle(\\'collapsed\\')">';
      html += '<span class="node-chevron">' + (isCollapsed ? '▶' : '▼') + '</span>';
      html += '<span class="node-icon">⚡</span>';
      html += '<span class="node-name">' + escapeHtml(job.nodeName) + '</span>';
      
      if (hasProcesses) {
        html += '<span class="node-stats">(' + totals.count + ' proc • ' + totals.cpu.toFixed(0) + '% CPU • ' + memMB + ' MB)</span>';
      } else if (job.status === 'scheduled') {
        html += '<span class="node-stats job-scheduled">(scheduled)</span>';
      } else {
        html += '<span class="node-stats job-starting">(starting...)</span>';
      }
      html += '</div>';
      html += '<div class="node-processes-tree">';
      
      // Render process tree
      for (const proc of tree) {
        html += renderProc(proc, 0);
      }

      html += '</div></div>';
      return html;
    }

    function renderProc(proc, depth) {
      const memMB = ((proc.memory || 0) / 1024 / 1024).toFixed(1);
      const cpuPct = (proc.cpu || 0).toFixed(0);
      const indent = depth * 16;
      const arrow = depth > 0 ? '↳ ' : '';

      let h = '<div class="process-item" style="margin-left: ' + indent + 'px;">';
      h += '<span class="proc-icon">⚙️</span>';
      h += '<span class="proc-name">' + arrow + escapeHtml(proc.name) + '</span>';
      h += '<span class="proc-pid">PID ' + proc.pid + '</span>';
      h += '<span class="proc-stats">' + cpuPct + '% • ' + memMB + ' MB</span>';
      h += '</div>';

      if (proc.children) {
        for (const child of proc.children) {
          h += renderProc(child, depth + 1);
        }
      }
      return h;
    }

    function escapeHtml(text) {
      return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── Timeline Wiring ──────────────────────────────────────────────────
    // Initialize timeline chart (always visible below DAG)
    const { TimelineChart } = window.Orca;
    var timelineChart = new TimelineChart(bus, 'timeline-chart', 'timeline-chart');

    // Render timeline immediately
    timelineChart.update(timelineData);

    // Timeline node clicks: open node detail at specific attempt
    timelineChart.bus.on('timeline:nodeClick', function(d) {
      if (d && d.nodeId) {
        var nd = nodeData[Object.keys(nodeData).find(function(k) {
          return nodeData[k].nodeId === d.nodeId;
        })];
        if (nd) vscode.postMessage({ type: 'openNode', planId: nd.planId, nodeId: nd.nodeId, attemptNumber: d.attemptNumber || undefined });
      }
    });

    // Update timeline data on status updates
    bus.on(Topics.STATUS_UPDATE, function(msg) {
      if (msg.nodeStatuses) {
        for (var key in msg.nodeStatuses) {
          var ns = msg.nodeStatuses[key];
          var nd = nodeData[key];
          if (nd) {
            // Find matching timeline node and update ALL fields
            var tn = timelineData.nodes.find(function(n) { return n.nodeId === nd.nodeId; });
            if (tn) {
              tn.status = ns.status;
              if (ns.startedAt) tn.startedAt = ns.startedAt;
              if (ns.endedAt) tn.endedAt = ns.endedAt;
              if (ns.scheduledAt) tn.scheduledAt = ns.scheduledAt;
              // Copy stepStatuses to node level for synthetic attempt rendering
              if (ns.stepStatuses) tn.stepStatuses = ns.stepStatuses;
              // Update attempt data with stepStatuses + phaseDurations + phaseTiming
              if (ns.attempts) {
                tn.attempts = ns.attempts;
              }
              // For running nodes without full attempt data, update stepStatuses on current attempt
              if (ns.stepStatuses && tn.attempts && tn.attempts.length > 0) {
                var lastAttempt = tn.attempts[tn.attempts.length - 1];
                lastAttempt.stepStatuses = ns.stepStatuses;
                lastAttempt.status = ns.status;
                if (ns.startedAt && !lastAttempt.startedAt) lastAttempt.startedAt = ns.startedAt;
                if (ns.endedAt) lastAttempt.endedAt = ns.endedAt;
              }
            }
          }
        }
        if (msg.planEndedAt) timelineData.planEndedAt = msg.planEndedAt;
        // Clear planEndedAt if any node is still running — prevents timeline from
        // freezing when the plan status briefly computes as failed/succeeded while
        // concurrent nodes are still executing.
        if (!msg.planEndedAt || msg.planStatus === 'running') {
          var anyRunning = timelineData.nodes.some(function(n) {
            return n.status === 'running' || n.status === 'scheduled';
          });
          if (anyRunning) timelineData.planEndedAt = undefined;
        }
        if (msg.startedAt && !timelineData.planStartedAt) timelineData.planStartedAt = msg.startedAt;
        // Differential timeline update: update individual node rows in-place.
        // Only fall back to full re-render if a node doesn't have a rendered row yet
        // (new node appeared from topology change, or first time a node gets a bar).
        var timelineSection = document.getElementById('timeline-section');
        if (timelineSection && timelineSection.style.display !== 'none') {
          var needsFullPaint = false;
          for (var key2 in msg.nodeStatuses) {
            var nd2 = nodeData[key2];
            if (nd2) {
              var applied = timelineChart.updateNodeInPlace(nd2.nodeId, msg.nodeStatuses[key2]);
              if (!applied) { needsFullPaint = true; }
            }
          }
          // Full paint only when differential update couldn't handle it (new nodes)
          if (needsFullPaint) {
            timelineChart.update(timelineData);
          }
        }
      }
    });

    // Poll for process stats via PULSE (every 2nd pulse ≈ 2s)
    // processesSection always exists in DOM (hidden when paused/completed).
    // The PlanStatusControl shows it when the plan transitions to running.
    const processesSection = document.getElementById('processesSection');
    if (processesSection) {
      // Only start polling if visible (running), otherwise wait for status change
      if (processesSection.style.display !== 'none') {
        vscode.postMessage({ type: 'getAllProcessStats' });
      }
      bus.on(Topics.PULSE, function() {
        if (processesSection.style.display === 'none') return;
        _processStatsPulseCount++;
        if (_processStatsPulseCount % 2 === 0) {
          vscode.postMessage({ type: 'getAllProcessStats' });
        }
      });
    }

    // Plan Configuration toggle
    var planConfigHeader = document.getElementById('plan-config-header');
    var planConfigBody = document.getElementById('plan-config-body');
    var planConfigChevron = planConfigHeader ? planConfigHeader.querySelector('.plan-config-chevron') : null;
    if (planConfigHeader && planConfigBody) {
      planConfigHeader.addEventListener('click', function() {
        var isHidden = planConfigBody.style.display === 'none';
        planConfigBody.style.display = isHidden ? 'block' : 'none';
        if (planConfigChevron) planConfigChevron.textContent = isHidden ? '▼' : '▶';
      });
    }

    // ── Scroll Position Persistence ────────────────────────────────────────
    // Save scroll position so DOM changes don't teleport the user back to the top.
    var _scrollSaveTimer = null;
    var _lastUserScrollY = 0;
    var _lastUserScrollX = 0;
    var _scrollGuardActive = false;
    var diagramScrollEl = document.getElementById('mermaid-diagram');

    function saveScrollPosition() {
      if (_scrollSaveTimer) return; // debounce
      _scrollSaveTimer = setTimeout(function() {
        _scrollSaveTimer = null;
        var bodyX = document.documentElement.scrollLeft || document.body.scrollLeft;
        var bodyY = document.documentElement.scrollTop || document.body.scrollTop;
        _lastUserScrollX = bodyX;
        _lastUserScrollY = bodyY;
        var diagX = diagramScrollEl ? diagramScrollEl.scrollLeft : 0;
        var diagY = diagramScrollEl ? diagramScrollEl.scrollTop : 0;
        vscode.setState({ scrollX: bodyX, scrollY: bodyY, diagScrollX: diagX, diagScrollY: diagY });
      }, 100);
    }
    window.addEventListener('scroll', function() {
      // Only save user-initiated scroll (not programmatic restores)
      if (!_scrollGuardActive) { saveScrollPosition(); }
    }, true);
    if (diagramScrollEl) diagramScrollEl.addEventListener('scroll', saveScrollPosition);

    // Scroll guard: detect and revert unexpected scroll resets from DOM mutations.
    // When DOM changes cause the browser to reset scroll to 0, this restores it.
    var _scrollGuardTimer = null;
    function enableScrollGuard() {
      if (_scrollGuardTimer) return;
      _scrollGuardActive = true;
      _scrollGuardTimer = setTimeout(function() {
        _scrollGuardTimer = null;
        _scrollGuardActive = false;
      }, 200);
      requestAnimationFrame(function() {
        var currentY = window.scrollY || document.documentElement.scrollTop;
        // If scroll jumped to 0 but user was scrolled, restore
        if (currentY === 0 && _lastUserScrollY > 50) {
          window.scrollTo(_lastUserScrollX, _lastUserScrollY);
        }
        _scrollGuardActive = false;
      });
    }

    // Hook into status updates that modify DOM — guard scroll around them
    bus.on(Topics.STATUS_UPDATE, function() { enableScrollGuard(); });

    // ── Initial group/node color application ─────────────────────────
    // Mermaid renders asynchronously. After the SVG appears, replay all
    // nodeData through the style controllers to apply correct colors.
    // Retry up to 20 times (2 seconds) until clusters are found.
    var _initialColorRetries = 0;
    function _applyInitialColors() {
      _initialColorRetries++;
      var svg = document.querySelector('.mermaid svg');
      if (!svg) {
        if (_initialColorRetries < 20) setTimeout(_applyInitialColors, 100);
        return;
      }
      var replay = { nodeStatuses: {} };
      for (var s in nodeData) { replay.nodeStatuses[s] = nodeData[s]; }
      mermaidNodeStyleCtrl.update(replay);
      mermaidGroupStyleCtrl.update(replay);
      mermaidEdgeStyleCtrl.update(replay);
      // If group controller found 0 clusters, SVG might not be fully parsed yet
      if (mermaidGroupStyleCtrl._lastUpdated === 0 && _initialColorRetries < 20) {
        setTimeout(_applyInitialColors, 100);
      }
    }
    setTimeout(_applyInitialColors, 150);

    // Restore on load
    var savedState = vscode.getState();
    if (savedState) {
      if (savedState.scrollY) {
        _lastUserScrollY = savedState.scrollY;
        _lastUserScrollX = savedState.scrollX || 0;
        requestAnimationFrame(function() {
          window.scrollTo(savedState.scrollX || 0, savedState.scrollY || 0);
          if (diagramScrollEl && savedState.diagScrollX) diagramScrollEl.scrollLeft = savedState.diagScrollX;
          if (diagramScrollEl && savedState.diagScrollY) diagramScrollEl.scrollTop = savedState.diagScrollY;
        });
      }
    }
  `;
}
