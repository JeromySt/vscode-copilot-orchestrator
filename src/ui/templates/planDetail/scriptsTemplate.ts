/**
 * @fileoverview Plan detail webview scripts template.
 *
 * Generates the `<script>` block for the plan detail webview.
 * Contains Mermaid initialisation, zoom/pan interactions, duration timers,
 * incremental status updates, process tree rendering, and message handling.
 *
 * @module ui/templates/planDetail/scriptsTemplate
 */

/**
 * Input data for rendering the webview script block.
 */
export interface PlanScriptsData {
  /** JSON-serialisable node data (sanitizedId → node info) */
  nodeData: Record<string, { nodeId: string; planId: string; type: string; name: string; startedAt?: number; endedAt?: number; status: string; version: number }>;
  /** Tooltip map (sanitizedId → full name) for truncated labels */
  nodeTooltips: Record<string, string>;
  /** Raw Mermaid diagram definition */
  mermaidDef: string;
  /** Edge data for incremental edge coloring */
  edgeData: Array<{ index: number; from: string; to: string; isLeafToTarget?: boolean }>;
  /** Global capacity stats (may be null) */
  globalCapacityStats: { thisInstanceJobs: number; totalGlobalJobs: number; globalMaxParallel: number; activeInstances: number } | null;
}

/**
 * Render the webview `<script>` block for the plan detail view.
 *
 * The generated JavaScript handles:
 * - Mermaid diagram rendering with error fallback
 * - Node click handling and tooltip injection
 * - Zoom / pan controls (mouse wheel, drag, buttons)
 * - Live duration counters for plan and running nodes
 * - Incremental status updates (node colours, progress, buttons)
 * - Process stats polling and rendering
 *
 * @param data - Scripts input data.
 * @returns HTML `<script>…</script>` string.
 */
export function renderPlanScripts(data: PlanScriptsData): string {
  return `<script>
    const vscode = acquireVsCodeApi();
    const nodeData = ${JSON.stringify(data.nodeData)};
    const nodeTooltips = ${JSON.stringify(data.nodeTooltips)};
    const mermaidDef = ${JSON.stringify(data.mermaidDef)};
    const edgeData = ${JSON.stringify(data.edgeData)};
    const initialGlobalCapacity = ${JSON.stringify(data.globalCapacityStats)};

    // ── Inline EventBus ──────────────────────────────────────────────────
    const EventBus = (function() {
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

    // Well-known topics
    var Topics = {
      PULSE: 'extension:pulse',
      NODE_STATE_CHANGE: 'node:state',
      PLAN_STATE_CHANGE: 'plan:state',
      PROCESS_STATS: 'node:process-stats',
      STATUS_UPDATE: 'extension:statusUpdate',
      LAYOUT_CHANGE: 'layout:change',
      CONTROL_PREFIX: 'control:',
      controlUpdate: function(id) { return 'control:' + id + ':updated'; }
    };

    // Global bus instance
    var bus = new EventBus();

    // ── Inline SubscribableControl ────────────────────────────────────────
    var SubscribableControl = (function() {
      var enqueue = typeof queueMicrotask === 'function'
        ? queueMicrotask
        : function(cb) { Promise.resolve().then(cb); };

      function SC(bus, controlId) {
        this.bus = bus;
        this.controlId = controlId;
        this._subs = [];
        this._disposed = false;
        this._pendingMicrotask = false;
        this._pendingChildHandler = null;
      }

      SC.prototype.subscribe = function(topic, handler) {
        var sub = this.bus.on(topic, handler);
        this._subs.push(sub);
        return sub;
      };

      SC.prototype.subscribeToChild = function(childId, handler) {
        var self = this;
        self._pendingChildHandler = handler;
        var sub = self.bus.on(Topics.controlUpdate(childId), function() {
          if (self._disposed) return;
          if (!self._pendingMicrotask) {
            self._pendingMicrotask = true;
            enqueue(function() {
              self._pendingMicrotask = false;
              if (!self._disposed && self._pendingChildHandler) {
                self._pendingChildHandler();
              }
            });
          }
        });
        self._subs.push(sub);
        return sub;
      };

      SC.prototype.publishUpdate = function(data) {
        this.bus.emit(Topics.controlUpdate(this.controlId), data);
      };

      SC.prototype.unsubscribeAll = function() {
        for (var i = 0; i < this._subs.length; i++) {
          this._subs[i].unsubscribe();
        }
        this._subs.length = 0;
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
    
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        curve: 'basis',
        padding: 16,
        nodeSpacing: 30,
        rankSpacing: 50
      }
    });

    // ── Node label sizing ─────────────────────────────────────────────
    // Server renders ALL nodes with ' | 00m 00s' (or actual duration) so
    // Mermaid allocates consistent rect widths. After render, client strips
    // the duration suffix from non-started nodes.

    // Store original rendered text character counts per node group id.
    // Mermaid sizes node boxes based on the initial text; every subsequent
    // update must stay within this length to avoid overflow.
    var nodeTextLengths = {};

    function clampText(text, maxLen) {
      if (!maxLen || text.length <= maxLen) return text;
      var pipeIdx = text.lastIndexOf(' | ');
      if (pipeIdx > 0) {
        var prefix = text.substring(0, pipeIdx);
        var suffix = text.substring(pipeIdx);
        var available = maxLen - suffix.length - 3;
        if (available > 3) {
          var iconEnd = 2;
          return prefix.substring(0, iconEnd) + prefix.substring(iconEnd, iconEnd + available - iconEnd) + '...' + suffix;
        }
      }
      return text.substring(0, maxLen - 3) + '...';
    }

    // Render mermaid with error handling
    (async () => {
      try {
        const element = document.querySelector('.mermaid');
        const { svg } = await mermaid.render('mermaid-graph', mermaidDef);
        element.innerHTML = svg;

        // Capture rendered text lengths for nodes
        element.querySelectorAll('.node').forEach(function(ng) {
          var textEl = ng.querySelector('.nodeLabel') || ng.querySelector('span');
          if (textEl && textEl.textContent) {
            var gId = ng.getAttribute('id') || '';
            nodeTextLengths[gId] = textEl.textContent.length;
          }
        });
        // Capture rendered text lengths for cluster/subgraph labels
        element.querySelectorAll('.cluster').forEach(function(cg) {
          var textEl = cg.querySelector('.cluster-label .nodeLabel') || cg.querySelector('.cluster-label span') || cg.querySelector('.cluster-label text');
          if (textEl && textEl.textContent) {
            var gId = cg.getAttribute('id') || '';
            nodeTextLengths[gId] = textEl.textContent.length;
          }
        });

        // Strip duration from non-started nodes (they were sized with a template)
        element.querySelectorAll('.node').forEach(function(ng) {
          // Find which nodeData entry this is
          var gId = ng.getAttribute('id') || '';
          var matchedId = null;
          for (var sid in nodeData) {
            if (gId.includes(sid)) { matchedId = sid; break; }
          }
          if (!matchedId) return;
          var nd = nodeData[matchedId];
          // Only strip from nodes that haven't started
          if (nd && nd.startedAt) return;
          // Find the text element and strip ' | 00m 00s'
          var textEls = ng.querySelectorAll('foreignObject *, text, tspan, .nodeLabel, .label');
          for (var i = 0; i < textEls.length; i++) {
            var el = textEls[i];
            if (!el.childNodes.length || el.children.length > 0) continue;
            var t = el.textContent || '';
            var pipeIdx = t.lastIndexOf(' | ');
            if (pipeIdx > 0) {
              el.textContent = t.substring(0, pipeIdx);
            }
            break;
          }
        });
        
        // Fix label clipping for cluster/subgraph labels only.
        // Node labels use CSS overflow:hidden + text-overflow:ellipsis instead.
        element.querySelectorAll('.cluster-label').forEach(label => {
          let parent = label.parentElement;
          while (parent && parent.tagName !== 'foreignObject') {
            parent = parent.parentElement;
          }
          if (parent && parent.tagName === 'foreignObject') {
            const textEl = label.querySelector('.nodeLabel, span, div');
            if (textEl) {
              const textWidth = textEl.scrollWidth || textEl.offsetWidth || 200;
              const currentWidth = parseFloat(parent.getAttribute('width')) || 0;
              if (textWidth + 20 > currentWidth) {
                parent.setAttribute('width', String(textWidth + 30));
              }
            }
          }
          label.style.overflow = 'visible';
          label.style.width = 'auto';
        });

        // Mermaid natively sizes everything — no post-render rect adjustments needed.
        // CSS overflow:visible handles any minor sizing differences.
        
        // Add tooltips for truncated node labels
        for (const [id, fullName] of Object.entries(nodeTooltips)) {
          // Regular nodes: Mermaid renders them as g[id*="id"]
          const nodeEl = element.querySelector('g[id*="' + id + '"]');
          if (nodeEl) {
            const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
            titleEl.textContent = fullName;
            nodeEl.prepend(titleEl);
          }
          // Subgraph clusters
          const clusterEl = element.querySelector('g[id*="' + id + '"] .cluster-label');
          if (clusterEl) {
            const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
            titleEl.textContent = fullName;
            clusterEl.prepend(titleEl);
          }
        }
        // Immediately update durations for running nodes after render
        setTimeout(updateNodeDurations, 100);
        // Set initial container size based on rendered SVG
        setTimeout(updateZoom, 150);
      } catch (err) {
        console.error('Mermaid error:', err);
        console.log('Mermaid definition:', mermaidDef);
        const element = document.querySelector('.mermaid');
        element.innerHTML = '<div style="color: #f48771; padding: 16px;"><strong>Mermaid Parse Error:</strong><br><pre style="white-space: pre-wrap; font-size: 11px; margin-top: 8px; background: #2d2d2d; padding: 8px; border-radius: 4px;">' + err.message + '</pre><br><strong>Definition:</strong><pre style="white-space: pre-wrap; font-size: 10px; margin-top: 8px; background: #2d2d2d; padding: 8px; border-radius: 4px; max-height: 200px; overflow: auto;">' + mermaidDef.replace(/</g, '&lt;') + '</pre></div>';
      }
    })();
    
    // Handle node clicks
    document.addEventListener('click', (e) => {
      let el = e.target;
      
      while (el && el !== document.body) {
        // Check for node click
        if (el.classList && el.classList.contains('node')) {
          const nodeGroup = el.closest('g[id]');
          if (nodeGroup) {
            const match = nodeGroup.id.match(/flowchart-([^-]+)-/);
            if (match) {
              const sanitizedId = match[1];
              const data = nodeData[sanitizedId];
              if (data) {
                vscode.postMessage({ type: 'openNode', nodeId: data.nodeId, planId: data.planId });
              }
            }
          }
          break;
        }
        el = el.parentElement;
      }
    });
    
    // Handle job summary clicks
    document.querySelectorAll('.job-summary').forEach(el => {
      el.addEventListener('click', () => {
        const nodeId = el.dataset.nodeId;
        if (nodeId) {
          vscode.postMessage({ type: 'openNode', nodeId });
        }
      });
    });
    
    function cancelPlan() {
      vscode.postMessage({ type: 'cancel' });
    }
    
    function pausePlan() {
      vscode.postMessage({ type: 'pause' });
    }
    
    function resumePlan() {
      vscode.postMessage({ type: 'resume' });
    }
    
    function deletePlan() {
      vscode.postMessage({ type: 'delete' });
    }
    
    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }
    
    function showWorkSummary() {
      vscode.postMessage({ type: 'showWorkSummary' });
    }
    
    // Zoom functionality
    let currentZoom = 1;
    const zoomStep = 0.1;
    const minZoom = 0.25;
    const maxZoom = 3;
    
    function updateZoom() {
      const container = document.getElementById('mermaidContainer');
      const zoomLabel = document.getElementById('zoomLevel');
      if (container) {
        container.style.transform = 'scale(' + currentZoom + ')';
        
        // Adjust container size to match scaled content (prevents empty space when zoomed out)
        const svg = container.querySelector('svg');
        if (svg) {
          const naturalWidth = svg.getBBox().width + 20;
          const naturalHeight = svg.getBBox().height + 20;
          container.style.width = (naturalWidth * currentZoom) + 'px';
          container.style.height = (naturalHeight * currentZoom) + 'px';
        }
      }
      if (zoomLabel) {
        zoomLabel.textContent = Math.round(currentZoom * 100) + '%';
      }
    }
    
    function zoomIn() {
      currentZoom = Math.min(maxZoom, currentZoom + zoomStep);
      updateZoom();
    }
    
    function zoomOut() {
      currentZoom = Math.max(minZoom, currentZoom - zoomStep);
      updateZoom();
    }
    
    function zoomReset() {
      currentZoom = 1;
      updateZoom();
    }
    
    function zoomFit() {
      const diagram = document.getElementById('mermaid-diagram');
      const container = document.getElementById('mermaidContainer');
      if (!diagram || !container) return;
      
      const svg = container.querySelector('svg');
      if (!svg) return;
      
      // Reset to 1 to measure natural size
      currentZoom = 1;
      container.style.transform = 'scale(1)';
      
      const diagramWidth = diagram.clientWidth - 32; // Account for padding
      const svgWidth = svg.getBoundingClientRect().width;
      
      if (svgWidth > diagramWidth) {
        currentZoom = diagramWidth / svgWidth;
      }
      updateZoom();
    }
    
    // Mouse wheel zoom (no modifier needed when over diagram)
    const diagramEl = document.getElementById('mermaid-diagram');
    diagramEl?.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        zoomIn();
      } else {
        zoomOut();
      }
    }, { passive: false });
    
    // Mouse drag to pan
    let isPanning = false;
    let didPan = false;
    let panStartX = 0;
    let panStartY = 0;
    let scrollStartX = 0;
    let scrollStartY = 0;
    
    diagramEl?.addEventListener('mousedown', (e) => {
      // Only pan on left mouse button, and not on interactive elements
      if (e.button !== 0) return;
      const target = e.target;
      if (target.closest('.zoom-controls, .legend, button, a')) return;
      
      isPanning = true;
      didPan = false;
      panStartX = e.clientX;
      panStartY = e.clientY;
      scrollStartX = diagramEl.scrollLeft;
      scrollStartY = diagramEl.scrollTop;
      diagramEl.classList.add('panning');
      e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!isPanning || !diagramEl) return;
      
      const dx = e.clientX - panStartX;
      const dy = e.clientY - panStartY;
      
      // Mark as panned if moved more than 5px (distinguish from click)
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        didPan = true;
      }
      
      diagramEl.scrollLeft = scrollStartX - dx;
      diagramEl.scrollTop = scrollStartY - dy;
    });
    
    document.addEventListener('mouseup', () => {
      if (isPanning && diagramEl) {
        isPanning = false;
        diagramEl.classList.remove('panning');
      }
    });
    
    // Suppress click after pan
    document.addEventListener('click', (e) => {
      if (didPan) {
        e.stopPropagation();
        e.preventDefault();
        didPan = false;
      }
    }, true); // Use capture phase to intercept before other handlers
    
    // Also stop panning if mouse leaves the window
    document.addEventListener('mouseleave', () => {
      if (isPanning && diagramEl) {
        isPanning = false;
        diagramEl.classList.remove('panning');
      }
    });
    
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
            targetGroup = cluster;
            textEls = cluster.querySelectorAll('.cluster-label .nodeLabel, .cluster-label text, .nodeLabel, text');
          }
        } else {
          // Regular node
          if (targetGroup) {
            textEls = targetGroup.querySelectorAll('foreignObject *, text, tspan, .nodeLabel, .label');
          }
        }
        
        if (!targetGroup || !textEls) continue;
        
        var gId = targetGroup.getAttribute('id') || '';
        var maxLen = nodeTextLengths[gId];
        for (const textEl of textEls) {
          if (!textEl.childNodes.length || textEl.children.length > 0) continue;
          
          const text = textEl.textContent || '';
          var newText;
          const pipeIndex = text.lastIndexOf(' | ');
          if (pipeIndex > 0) {
            // Update existing duration after the pipe
            newText = text.substring(0, pipeIndex) + ' | ' + durationStr;
          } else if (text.length > 0) {
            // No pipe yet — node was stripped on initial render, now add duration
            newText = text + ' | ' + durationStr;
          } else {
            continue;
          }
          textEl.textContent = maxLen ? clampText(newText, maxLen) : newText;
          break;
        }
      }
    }
    
    // Subscribe to PULSE for duration updates (replaces setInterval)
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
      var changedCount = Object.keys(changed).length;
      if (changedCount > 0) {
        var totalFound = (mermaidNodeStyleCtrl._lastUpdated || 0) + (mermaidGroupStyleCtrl._lastUpdated || 0);
        if (totalFound === 0) {
          console.warn('SVG node update failed: updated 0 of ' + changedCount + ' nodes, requesting full refresh');
          vscode.postMessage({ type: 'refresh' });
        }
      }
    }

    // ── Simplified handleStatusUpdate ─────────────────────────────────────
    function handleStatusUpdate(msg) {
      try {
        var changed = {};
        for (var id in (msg.nodeStatuses || {})) {
          var existing = nodeData[id], incoming = msg.nodeStatuses[id];
          if (!existing || existing.version !== incoming.version) {
            nodeData[id] = Object.assign(existing || {}, incoming);
            changed[id] = incoming;
          }
        }
        bus.emit(Topics.STATUS_UPDATE, Object.assign({}, msg, { nodeStatuses: changed }));
        checkSvgUpdateHealth(changed);
      } catch (err) {
        console.error('handleStatusUpdate error:', err);
        vscode.postMessage({ type: 'refresh' });
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
        var resumeBtn = document.getElementById('resumeBtn');
        var cancelBtn = document.getElementById('cancelBtn');
        var workSummaryBtn = document.getElementById('workSummaryBtn');
        var isActive = (planStatus === 'running' || planStatus === 'pending');
        var isPaused = (planStatus === 'paused');
        var canControl = isActive || isPaused;
        if (pauseBtn) pauseBtn.style.display = isActive ? '' : 'none';
        if (resumeBtn) resumeBtn.style.display = isPaused ? '' : 'none';
        if (cancelBtn) cancelBtn.style.display = canControl ? '' : 'none';
        if (workSummaryBtn) workSummaryBtn.style.display = planStatus === 'succeeded' ? '' : 'none';
      }
      // Show/hide processes section based on plan status
      var procSection = document.getElementById('processesSection');
      if (procSection) {
        procSection.style.display = (planStatus === 'running' || planStatus === 'pending') ? '' : 'none';
      }
      this.publishUpdate(msg);
    };
    planStatusCtrl.subscribe(Topics.STATUS_UPDATE, function(msg) { planStatusCtrl.update(msg); });

    // (c) ProgressControl
    var progressCtrl = new SubscribableControl(bus, 'progress');
    progressCtrl.update = function(msg) {
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
      var total = msg.total;
      var statsContainer = document.querySelector('.stats');
      if (!statsContainer) return;
      var statItems = statsContainer.querySelectorAll('.stat');
      statItems.forEach(function(stat) {
        var label = stat.querySelector('.stat-label');
        var value = stat.querySelector('.stat-value');
        if (!label || !value) return;
        var labelText = label.textContent.trim();
        if (labelText === 'Total Nodes') value.textContent = total;
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
          if (currentText.length > 0 && ['✓', '✗', '▶', '⊘', '○'].includes(currentText[0])) {
            var updatedText = newIcon + currentText.substring(1);
            var nodeElId = nodeEl.getAttribute('id') || '';
            var maxLen = nodeTextLengths[nodeElId];
            textSpan.textContent = maxLen ? clampText(updatedText, maxLen) : updatedText;
          }
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
    var mermaidGroupStyleCtrl = new SubscribableControl(bus, 'mermaid-group-style');
    mermaidGroupStyleCtrl._lastUpdated = 0;
    mermaidGroupStyleCtrl.update = function(msg) {
      var svgElement = document.querySelector('.mermaid svg');
      if (!svgElement || !msg.nodeStatuses) { this._lastUpdated = 0; return; }
      var ns = msg.nodeStatuses;
      var updated = 0;
      for (var sanitizedId in ns) {
        var data = ns[sanitizedId];
        // Skip if already handled as a regular node
        if (svgElement.querySelector('g[id^="flowchart-' + sanitizedId + '-"]')) continue;
        var cluster = svgElement.querySelector('g.cluster[id*="' + sanitizedId + '"], g[id*="' + sanitizedId + '"].cluster');
        if (!cluster) {
          var allClusters = svgElement.querySelectorAll('g.cluster');
          for (var ci = 0; ci < allClusters.length; ci++) {
            var clusterId = allClusters[ci].getAttribute('id') || '';
            if (clusterId.includes(sanitizedId)) { cluster = allClusters[ci]; break; }
          }
        }
        if (!cluster) continue;
        updated++;
        var clusterRect = cluster.querySelector('rect');
        if (clusterRect && groupColors[data.status]) {
          clusterRect.style.fill = groupColors[data.status].fill;
          clusterRect.style.stroke = groupColors[data.status].stroke;
        }
        var labelText = cluster.querySelector('.cluster-label .nodeLabel, .cluster-label text, .nodeLabel, text');
        if (labelText) {
          var newIcon = nodeIcons[data.status] || '○';
          var currentText = labelText.textContent || '';
          if (currentText.length > 0) {
            var firstChar = currentText[0];
            if (['✓', '✗', '▶', '⊘', '○', '📦'].includes(firstChar)) {
              var updatedText = newIcon + currentText.substring(1);
              var clusterGId = cluster.getAttribute('id') || '';
              var maxLen = nodeTextLengths[clusterGId];
              labelText.textContent = maxLen ? clampText(updatedText, maxLen) : updatedText;
            }
          }
        }
      }
      this._lastUpdated = updated;
      this.publishUpdate(msg);
    };
    mermaidGroupStyleCtrl.subscribe(Topics.STATUS_UPDATE, function(msg) { mermaidGroupStyleCtrl.update(msg); });

    // (j) DurationCounterControl
    var durationCounterCtrl = new SubscribableControl(bus, 'duration-counter');
    durationCounterCtrl.update = function(msg) {
      var durationEl = document.getElementById('planDuration');
      if (!durationEl) return;
      durationEl.dataset.status = msg.planStatus;
      if (msg.startedAt) durationEl.dataset.started = msg.startedAt.toString();
      if (msg.endedAt) durationEl.dataset.ended = msg.endedAt.toString();
      updateDurationCounter();
    };
    durationCounterCtrl.subscribe(Topics.STATUS_UPDATE, function(msg) { durationCounterCtrl.update(msg); });

    // (k) NodeDurationControl
    var nodeDurationCtrl = new SubscribableControl(bus, 'node-duration');
    nodeDurationCtrl.update = function() {
      updateNodeDurations();
    };
    nodeDurationCtrl.subscribe(Topics.STATUS_UPDATE, function() { nodeDurationCtrl.update(); });

    // (l) ProcessStatsControl
    var processStatsCtrl = new SubscribableControl(bus, 'process-stats');
    processStatsCtrl.update = function(msg) {
      renderAllProcesses(msg.rootJobs);
    };
    processStatsCtrl.subscribe(Topics.PROCESS_STATS, function(msg) { processStatsCtrl.update(msg); });

    // (Step 6) Wire inner-out: group recalculates when node children update
    mermaidGroupStyleCtrl.subscribeToChild('mermaid-node-style', function() {
      // When node styles update, re-aggregate group statuses from nodeData
      var svgElement = document.querySelector('.mermaid svg');
      if (!svgElement) return;
      var allClusters = svgElement.querySelectorAll('g.cluster');
      for (var ci = 0; ci < allClusters.length; ci++) {
        var cluster = allClusters[ci];
        var clusterId = cluster.getAttribute('id') || '';
        // Find matching nodeData entry for this cluster
        for (var sid in nodeData) {
          if (clusterId.includes(sid) && nodeData[sid].type === 'group') {
            var clusterRect = cluster.querySelector('rect');
            if (clusterRect && groupColors[nodeData[sid].status]) {
              clusterRect.style.fill = groupColors[nodeData[sid].status].fill;
              clusterRect.style.stroke = groupColors[nodeData[sid].status].stroke;
            }
            break;
          }
        }
      }
    });

    // ── LayoutManager ─────────────────────────────────────────────────────
    var layoutMgr = new SubscribableControl(bus, 'layout-manager');
    layoutMgr._rafId = null;
    layoutMgr.update = function() {
      var self = this;
      if (self._rafId) return;
      self._rafId = requestAnimationFrame(function() {
        self._rafId = null;
        var container = document.getElementById('mermaidContainer');
        var element = document.querySelector('.mermaid');
        if (!container || !element) return;
        // Save viewport state
        var savedZoom = currentZoom;
        var scrollParent = container.parentElement;
        var savedScrollTop = scrollParent ? scrollParent.scrollTop : 0;
        var savedScrollLeft = scrollParent ? scrollParent.scrollLeft : 0;
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
          // Restore viewport state
          currentZoom = savedZoom;
          updateZoom();
          if (scrollParent) {
            scrollParent.scrollTop = savedScrollTop;
            scrollParent.scrollLeft = savedScrollLeft;
          }
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
  </script>`;
}
