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
        padding: 10,
        nodeSpacing: 30,
        rankSpacing: 50
      }
    });
    
    // Render mermaid with error handling
    (async () => {
      try {
        const element = document.querySelector('.mermaid');
        const { svg } = await mermaid.render('mermaid-graph', mermaidDef);
        element.innerHTML = svg;
        
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
    
    // Update duration every second if running
    updateDurationCounter();
    
    // Clear any existing timers to prevent duplicates
    if (window.durationTimer) {
      clearInterval(window.durationTimer);
    }
    if (window.nodeTimer) {
      clearInterval(window.nodeTimer);
    }
    
    // Set up persistent timers
    window.durationTimer = setInterval(updateDurationCounter, 1000);
    
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
        
        for (const textEl of textEls) {
          if (!textEl.childNodes.length || textEl.children.length > 0) continue;
          
          const text = textEl.textContent || '';
          if (text.includes('|')) {
            // Update existing duration — pad back to original character count
            // so the text never exceeds the pre-sized foreignObject width.
            const pipeIndex = text.lastIndexOf('|');
            if (pipeIndex > 0) {
              var origLen = text.length;
              var core = text.substring(0, pipeIndex + 1) + ' ' + durationStr;
              var padN = Math.max(0, origLen - core.length);
              textEl.textContent = core + '\\u2003'.repeat(padN);
            }
            break;
          } else if (text.length > 0) {
            // No duration yet — strip trailing padding, then add duration
            var trimmed = text.replace(/[\\u2003\\u00A0]+$/, '');
            textEl.textContent = trimmed + ' | ' + durationStr;
            break;
          }
        }
      }
    }
    
    // Update node durations every second
    window.nodeTimer = setInterval(updateNodeDurations, 1000);
    
    // Handle messages from extension (incremental updates, process stats)
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'allProcessStats') {
        renderAllProcesses(msg.rootJobs);
      } else if (msg.type === 'statusUpdate') {
        handleStatusUpdate(msg);
      }
    });
    
    // Handle incremental status updates without full re-render (preserves zoom/scroll)
    function handleStatusUpdate(msg) {
      try {
        const { planStatus, nodeStatuses, counts, progress, total, completed, startedAt, endedAt, planMetrics, globalCapacity } = msg;
        
        // Update global capacity info
        if (globalCapacity) {
          const capacityInfoEl = document.getElementById('capacityInfo');
          if (globalCapacity.totalGlobalJobs > 0 || globalCapacity.activeInstances > 1) {
            capacityInfoEl.style.display = 'flex';
            document.getElementById('instanceCount').textContent = globalCapacity.activeInstances;
            document.getElementById('globalJobs').textContent = globalCapacity.totalGlobalJobs;
            document.getElementById('globalMax').textContent = globalCapacity.globalMaxParallel;
          } else {
            capacityInfoEl.style.display = 'none';
          }
        }
        
        // Update plan status badge
        const statusBadge = document.querySelector('.status-badge');
        if (statusBadge) {
          statusBadge.className = 'status-badge ' + planStatus;
          statusBadge.textContent = planStatus.charAt(0).toUpperCase() + planStatus.slice(1);
        }
        
        // Update progress bar
        const progressFill = document.querySelector('.progress-fill');
        const progressText = document.querySelector('.progress-text');
        if (progressFill) {
          progressFill.style.width = progress + '%';
        }
        if (progressText) {
          progressText.textContent = completed + ' / ' + total + ' (' + progress + '%)';
        }
        
        // Update stats section
        const statsContainer = document.querySelector('.stats');
        if (statsContainer) {
          const statItems = statsContainer.querySelectorAll('.stat');
          statItems.forEach(stat => {
            const label = stat.querySelector('.stat-label');
            const value = stat.querySelector('.stat-value');
            if (!label || !value) return;
            const labelText = label.textContent.trim();
            if (labelText === 'Total Nodes') {
              value.textContent = total;
            } else if (labelText === 'Succeeded') {
              value.textContent = counts.succeeded || 0;
            } else if (labelText === 'Failed') {
              value.textContent = counts.failed || 0;
            } else if (labelText === 'Running') {
              value.textContent = (counts.running || 0) + (counts.scheduled || 0);
            } else if (labelText === 'Pending') {
              value.textContent = (counts.pending || 0) + (counts.ready || 0);
            }
          });
        }
        
        // Update metrics bar
        if (planMetrics) {
          const metricsBar = document.getElementById('planMetricsBar');
          if (metricsBar) {
            const items = [];
            if (planMetrics.premiumRequests) {
              items.push('<span class="metric-item">🎫 <span class="metric-value">' + planMetrics.premiumRequests + '</span></span>');
            }
            if (planMetrics.apiTime) {
              items.push('<span class="metric-item">⏱ API: <span class="metric-value">' + planMetrics.apiTime + '</span></span>');
            }
            if (planMetrics.sessionTime) {
              items.push('<span class="metric-item">🕐 Session: <span class="metric-value">' + planMetrics.sessionTime + '</span></span>');
            }
            if (planMetrics.codeChanges) {
              items.push('<span class="metric-item">📝 <span class="metric-value">' + planMetrics.codeChanges + '</span></span>');
            }
            var modelsHtml = '';
            if (planMetrics.modelBreakdown && planMetrics.modelBreakdown.length > 0) {
              var rows = planMetrics.modelBreakdown.map(function(m) {
                var cached = m.cachedTokens ? ', ' + formatTk(m.cachedTokens) + ' cached' : '';
                var reqs = m.premiumRequests !== undefined ? ' (' + m.premiumRequests + ' req)' : '';
                return '<div class="model-row"><span class="model-name">' + escHtml(m.model) + '</span><span class="model-tokens">' + formatTk(m.inputTokens) + ' in, ' + formatTk(m.outputTokens) + ' out' + cached + reqs + '</span></div>';
              }).join('');
              modelsHtml = '<div class="model-breakdown"><div class="model-breakdown-label">Model Breakdown:</div><div class="model-breakdown-list">' + rows + '</div></div>';
            }
            metricsBar.innerHTML = '<span class="metrics-label">⚡ AI Usage:</span> ' + items.join(' ') + modelsHtml;
            metricsBar.style.display = '';
          }
        }
        
        // Update legend counts
        const legendItems = document.querySelectorAll('.legend-item');
        legendItems.forEach(item => {
          const icon = item.querySelector('.legend-icon');
          if (!icon) return;
          const statusClass = Array.from(icon.classList).find(c => c !== 'legend-icon');
          if (statusClass && counts[statusClass] !== undefined) {
            const span = item.querySelector('span:last-child');
            if (span) {
              span.textContent = statusClass.charAt(0).toUpperCase() + statusClass.slice(1) + ' (' + counts[statusClass] + ')';
            }
          }
        });
        
        // Status color map (must match classDef in buildMermaidDiagram)
        const statusColors = {
          pending: { fill: '#3c3c3c', stroke: '#858585' },
          ready: { fill: '#2d4a6e', stroke: '#3794ff' },
          running: { fill: '#2d4a6e', stroke: '#3794ff' },
          scheduled: { fill: '#2d4a6e', stroke: '#3794ff' },
          succeeded: { fill: '#1e4d40', stroke: '#4ec9b0' },
          failed: { fill: '#4d2929', stroke: '#f48771' },
          blocked: { fill: '#3c3c3c', stroke: '#858585' },
          canceled: { fill: '#3c3c3c', stroke: '#858585' }
        };
        
        // Update Mermaid node colors in SVG directly (Mermaid uses inline styles)
        const svgElement = document.querySelector('.mermaid svg');
        let nodesUpdated = 0;
        const totalNodes = Object.keys(nodeStatuses).length;
        
        if (!svgElement) {
          console.warn('SVG element not found in handleStatusUpdate');
        }
        
        if (svgElement) {
          for (const [sanitizedId, data] of Object.entries(nodeStatuses)) {
            // Skip if version hasn't changed (efficient update)
            const existingData = nodeData[sanitizedId];
            if (existingData && existingData.version === data.version) {
              nodesUpdated++; // Count as success (already up to date)
              continue;
            }
            
            // Status colors for groups/subgraphs (dimmer than nodes)
            const groupColors = {
              pending: { fill: '#1a1a2e', stroke: '#6a6a8a' },
              ready: { fill: '#1a2a4e', stroke: '#3794ff' },
              running: { fill: '#1a2a4e', stroke: '#3794ff' },
              succeeded: { fill: '#1a3a2e', stroke: '#4ec9b0' },
              failed: { fill: '#3a1a1e', stroke: '#f48771' },
              blocked: { fill: '#3a1a1e', stroke: '#f48771' },
              canceled: { fill: '#1a1a2e', stroke: '#6a6a8a' },
            };
            
            // Try to find as a node first
            // Mermaid generates IDs like "flowchart-nabc123...-0" where nabc123... is our sanitizedId
            const nodeGroup = svgElement.querySelector('g[id^="flowchart-' + sanitizedId + '-"]');
            
            if (nodeGroup) {
              nodesUpdated++;
              const nodeEl = nodeGroup.querySelector('.node') || nodeGroup;
              
              // Update CSS class for additional styling
              nodeEl.classList.remove('pending', 'ready', 'running', 'succeeded', 'failed', 'blocked', 'canceled', 'scheduled');
              nodeEl.classList.add(data.status);
              
              // Update inline styles on the rect (Mermaid uses inline styles from classDef)
              const rect = nodeEl.querySelector('rect');
              if (rect && statusColors[data.status]) {
                rect.style.fill = statusColors[data.status].fill;
                rect.style.stroke = statusColors[data.status].stroke;
                // Add animation for running nodes
                if (data.status === 'running') {
                  rect.style.strokeWidth = '2px';
                } else {
                  rect.style.strokeWidth = '';
                }
              }
              
              // Update icon in node label
              const foreignObject = nodeEl.querySelector('foreignObject');
              const textSpan = foreignObject ? foreignObject.querySelector('span') : nodeEl.querySelector('text tspan, text');
              if (textSpan) {
                const icons = { succeeded: '✓', failed: '✗', running: '▶', blocked: '⊘', pending: '○', ready: '○', scheduled: '▶', canceled: '⊘' };
                const newIcon = icons[data.status] || '○';
                const currentText = textSpan.textContent || '';
                // Replace first character (icon) with new icon
                if (currentText.length > 0 && ['✓', '✗', '▶', '⊘', '○'].includes(currentText[0])) {
                  textSpan.textContent = newIcon + currentText.substring(1);
                }
              }
            } else {
              // Try to find as a subgraph (group)
              // Mermaid generates subgraph clusters with ID patterns we can match
              let cluster = svgElement.querySelector('g.cluster[id*="' + sanitizedId + '"], g[id*="' + sanitizedId + '"].cluster');
              
              // Fallback: iterate all clusters and check their IDs
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
              
              // Update the cluster if found
              if (cluster) {
                const clusterRect = cluster.querySelector('rect');
                if (clusterRect && groupColors[data.status]) {
                  clusterRect.style.fill = groupColors[data.status].fill;
                  clusterRect.style.stroke = groupColors[data.status].stroke;
                }
                // Update icon in subgraph label - Mermaid uses various label selectors
                const labelText = cluster.querySelector('.cluster-label .nodeLabel, .cluster-label text, .nodeLabel, text');
                if (labelText) {
                  const icons = { succeeded: '✓', failed: '✗', running: '▶', blocked: '⊘', pending: '○', ready: '○', scheduled: '▶', canceled: '⊘' };
                  const newIcon = icons[data.status] || '○';
                  const currentText = labelText.textContent || '';
                  // Check for status icon at start or package icon
                  if (currentText.length > 0) {
                    const firstChar = currentText[0];
                    if (['✓', '✗', '▶', '⊘', '○', '📦'].includes(firstChar)) {
                      labelText.textContent = newIcon + currentText.substring(1);
                    }
                  }
                }
                nodesUpdated++;
              }
            }
            
            // Update nodeData for duration tracking (and version for next comparison)
            if (nodeData[sanitizedId]) {
              nodeData[sanitizedId].status = data.status;
              nodeData[sanitizedId].version = data.version;
              nodeData[sanitizedId].startedAt = data.startedAt;
              nodeData[sanitizedId].endedAt = data.endedAt;
            }
          }
        }
        
        // If we couldn't update any nodes and there are nodes to update, force full refresh
        if (totalNodes > 0 && nodesUpdated === 0) {
          console.warn('SVG node update failed: updated 0 of ' + totalNodes + ' nodes, requesting full refresh');
          vscode.postMessage({ type: 'refresh' });
          return;
        }
        
        // Update edge colors based on source node status
        // Mermaid renders edges as <path> elements inside .edgePaths children,
        // in the same order as our edgeIndex tracking.
        if (svgElement && edgeData && edgeData.length > 0) {
          var edgePaths = svgElement.querySelectorAll('.edgePaths > *');
          var edgeColors = {
            succeeded: '#4ec9b0',
            failed: '#f48771',
            running: '#3794ff',
            scheduled: '#3794ff',
          };
          var defaultEdgeColor = '#858585';
          
          for (var i = 0; i < edgeData.length; i++) {
            var edge = edgeData[i];
            var edgeEl = edgePaths[edge.index];
            if (!edgeEl) continue;
            
            var pathEl = edgeEl.querySelector('path') || edgeEl;
            
            // Determine color from source node status
            var sourceStatus = null;
            if (edge.from === 'TARGET_SOURCE') {
              // Base branch edge — always green
              sourceStatus = 'succeeded';
            } else {
              // Find source node's current status from nodeData
              var sourceData = nodeData[edge.from];
              if (sourceData) sourceStatus = sourceData.status;
            }
            
            // For leaf-to-target edges, color based on the leaf (source) status
            var color = (sourceStatus && edgeColors[sourceStatus]) || defaultEdgeColor;
            pathEl.style.stroke = color;
            pathEl.style.strokeWidth = (sourceStatus === 'succeeded' || sourceStatus === 'failed') ? '2px' : '';
            
            // Switch dashed→solid once the source node leaves pending/ready
            if (sourceStatus && sourceStatus !== 'pending' && sourceStatus !== 'ready') {
              pathEl.style.strokeDasharray = 'none';
            } else {
              pathEl.style.strokeDasharray = ''; // restore Mermaid default (dashed)
            }
            
            // Also color the marker/arrowhead if present
            var marker = edgeEl.querySelector('defs marker path, marker path');
            if (marker) {
              marker.style.fill = color;
              marker.style.stroke = color;
            }
          }
        }
        
        // Update plan duration counter data attributes
        const durationEl = document.getElementById('planDuration');
        if (durationEl) {
          durationEl.dataset.status = planStatus;
          if (startedAt) durationEl.dataset.started = startedAt.toString();
          if (endedAt) durationEl.dataset.ended = endedAt.toString();
        }
        
        // Update action buttons visibility based on new status
        const actionsDiv = document.querySelector('.actions');
        if (actionsDiv) {
          const pauseBtn = document.getElementById('pauseBtn');
          const resumeBtn = document.getElementById('resumeBtn');
          const cancelBtn = document.getElementById('cancelBtn');
          const workSummaryBtn = document.getElementById('workSummaryBtn');
          
          const isActive = (planStatus === 'running' || planStatus === 'pending');
          const isPaused = (planStatus === 'paused');
          const canControl = isActive || isPaused;
          
          if (pauseBtn) {
            pauseBtn.style.display = isActive ? '' : 'none';
          }
          if (resumeBtn) {
            resumeBtn.style.display = isPaused ? '' : 'none';
          }
          if (cancelBtn) {
            cancelBtn.style.display = canControl ? '' : 'none';
          }
          if (workSummaryBtn) {
            workSummaryBtn.style.display = planStatus === 'succeeded' ? '' : 'none';
          }
        }
        
        // Trigger duration updates to ensure timers are working
        updateDurationCounter();
        updateNodeDurations();
        
        // Ensure timers are active (restart if needed)
        if (!window.durationTimer) {
          window.durationTimer = setInterval(updateDurationCounter, 1000);
        }
        if (!window.nodeTimer) {
          window.nodeTimer = setInterval(updateNodeDurations, 1000);
        }
      } catch (err) {
        console.error('handleStatusUpdate error:', err);
        // On error, request a full refresh
        vscode.postMessage({ type: 'refresh' });
      }
    }
    
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
        html += renderJobNode(job, 0);
      }
      
      container.innerHTML = html;
    }
    
    // Render a job node with its process tree
    function renderJobNode(job, depth) {
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
      
      let html = '<div class="node-processes ' + statusClass + '" style="margin-left: ' + indent + 'px;">';
      html += '<div class="node-processes-header" onclick="this.parentElement.classList.toggle(\\'collapsed\\')">';
      html += '<span class="node-chevron">▼</span>';
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
      const div = document.createElement('div');
      div.textContent = text || '';
      return div.innerHTML;
    }
    
    // Poll for process stats if running
    const processesSection = document.getElementById('processesSection');
    if (processesSection) {
      vscode.postMessage({ type: 'getAllProcessStats' });
      setInterval(() => {
        vscode.postMessage({ type: 'getAllProcessStats' });
      }, 2000);
    }
  </script>`;
}
