/**
 * @fileoverview Mermaid initialization and rendering for plan detail view.
 *
 * @module ui/templates/planDetail/scripts/mermaidInit
 */

import type { PlanScriptsData } from '../scriptsTemplate';

/**
 * Generate JavaScript for Mermaid initialization, rendering, and tooltip injection.
 *
 * @param data - Scripts input data.
 * @returns JavaScript code string.
 */
export function renderMermaidInit(data: PlanScriptsData): string {
  return `
    // ── Mermaid Initialization ──────────────────────────────────────────
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
            var len = textEl.textContent.length;
            nodeTextLengths[gId] = len;
            // Store as HTML attribute for client-side update code
            ng.setAttribute('data-max-text-len', String(len));
          }
        });
        // Capture rendered text lengths for cluster/subgraph labels
        element.querySelectorAll('.cluster').forEach(function(cg) {
          var textEl = cg.querySelector('.cluster-label .nodeLabel') || cg.querySelector('.cluster-label span') || cg.querySelector('.cluster-label text');
          if (textEl && textEl.textContent) {
            var gId = cg.getAttribute('id') || '';
            var len = textEl.textContent.length;
            nodeTextLengths[gId] = len;
            // Store as HTML attribute for client-side update code
            cg.setAttribute('data-max-text-len', String(len));
          }
        });

        // Strip duration from ALL nodes — initial render shows only "<icon> <title>"
        element.querySelectorAll('.node').forEach(function(ng) {
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

        // Strip duration from ALL cluster/subgraph labels — initial render shows only "<icon> <title>"
        element.querySelectorAll('.cluster').forEach(function(cg) {
          var textEls = cg.querySelectorAll('.cluster-label .nodeLabel, .cluster-label text, .cluster-label span');
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

        // Inject tooltips for all nodes with long names
        element.querySelectorAll('.node').forEach(function(ng) {
          var idMatch = (ng.getAttribute('id') || '').match(/flowchart-(\\w+)-/);
          if (!idMatch) return;
          var sanitizedId = idMatch[1];
          var tooltip = nodeTooltips[sanitizedId];
          if (tooltip) ng.setAttribute('title', tooltip);
        });

        // Attach click handlers to nodes
        element.querySelectorAll('.node').forEach(function(ng) {
          ng.style.cursor = 'pointer';
          ng.addEventListener('click', function() {
            var nodeId = ng.getAttribute('id');
            if (nodeId) {
              var sanitizedId = nodeId.split('-')[1];
              var data = nodeData[sanitizedId];
              if (data) {
                vscode.postMessage({ type: 'openNode', nodeId: data.nodeId, planId: data.planId });
              }
            }
          });
        });

        // Call the zoom fit function after render (defined in zoomPan)
        if (typeof zoomFit === 'function') zoomFit();
      } catch (err) {
        const element = document.querySelector('.mermaid');
        element.innerHTML = '<p style="color: red;">Failed to render diagram: ' + err.message + '</p>';
      }
    })();
  `;
}
