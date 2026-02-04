/**
 * @fileoverview Plan Detail Panel JavaScript.
 * 
 * Client-side JavaScript for the plan detail visualization:
 * - Mermaid diagram initialization
 * - Node click handling (jobs, sub-plans)
 * - Action button handlers
 * - VS Code API communication
 * 
 * @module ui/templates/planDetail/js
 */

/**
 * Generate the JavaScript code for the plan detail panel.
 * 
 * @param jobDataMap - Map of sanitized job IDs to job data (jobId is the runner UUID)
 * @param subPlanDataMap - Map of sanitized sub-plan names to sub-plan data (childPlanId is the nested plan UUID)
 */
export function getPlanDetailJs(
  jobDataMap: Record<string, { jobId: string | null; nestedPlanId?: string | null }>,
  subPlanDataMap: Record<string, { subPlanName: string; childPlanId: string | null }>
): string {
  return `
    const vscode = acquireVsCodeApi();

    // Store node data for click handling (keyed by sanitized ID)
    window.jobDataMap = ${JSON.stringify(jobDataMap)};
    window.subPlanDataMap = ${JSON.stringify(subPlanDataMap)};

    function extractSanitizedKey(nodeId, kind) {
      if (!nodeId || typeof nodeId !== 'string') return null;
      const re = kind === 'subplan'
        ? /(subplan_[a-zA-Z0-9_]+)/
        : kind === 'job'
          ? /(job_[a-zA-Z0-9_]+)/
          : null;
      if (!re) return null;
      const m = nodeId.match(re);
      return m ? m[1] : null;
    }

    function wireMermaidNodeClicks() {
      const svg = document.querySelector('#mermaid-diagram svg');
      if (!svg) return false;

      const nodes = svg.querySelectorAll('g.node[id], g.cluster[id]');
      nodes.forEach((nodeGroup) => {
        const nodeId = nodeGroup.id || '';

        // Clear any previous metadata (diagram can be re-rendered)
        nodeGroup.classList.remove('clickable-node');
        if (nodeGroup.dataset) {
          delete nodeGroup.dataset.orchAction;
          delete nodeGroup.dataset.orchJobId;
          delete nodeGroup.dataset.orchPlanId;
        }

        // Work summary node
        if (nodeId.includes('WORK_SUMMARY')) {
          nodeGroup.classList.add('clickable-node');
          if (nodeGroup.dataset) {
            nodeGroup.dataset.orchAction = 'showWorkSummary';
          }
          if (nodeGroup.dataset) nodeGroup.dataset.orchWired = '1';
          return;
        }

        // Sub-plan node
        const subPlanKey = extractSanitizedKey(nodeId, 'subplan');
        if (subPlanKey) {
          const subPlanData = window.subPlanDataMap && window.subPlanDataMap[subPlanKey];
          if (subPlanData && subPlanData.childPlanId) {
            nodeGroup.classList.add('clickable-node');
            nodeGroup.setAttribute('role', 'button');
            nodeGroup.setAttribute('tabindex', '0');
            if (nodeGroup.dataset) {
              nodeGroup.dataset.orchAction = 'openNestedPlan';
              nodeGroup.dataset.orchPlanId = subPlanData.childPlanId;
            }
          }
          if (nodeGroup.dataset) nodeGroup.dataset.orchWired = '1';
          return;
        }

        // Job node
        const jobKey = extractSanitizedKey(nodeId, 'job');
        if (jobKey) {
          const jobData = window.jobDataMap && window.jobDataMap[jobKey];
          if (jobData && jobData.jobId) {
            nodeGroup.classList.add('clickable-node');
            nodeGroup.setAttribute('role', 'button');
            nodeGroup.setAttribute('tabindex', '0');
            if (nodeGroup.dataset) {
              if (jobData.nestedPlanId) {
                nodeGroup.dataset.orchAction = 'openNestedPlan';
                nodeGroup.dataset.orchPlanId = jobData.nestedPlanId;
              } else {
                nodeGroup.dataset.orchAction = 'openJob';
                nodeGroup.dataset.orchJobId = jobData.jobId;
              }
            }
          }
          if (nodeGroup.dataset) nodeGroup.dataset.orchWired = '1';
          return;
        }

        if (nodeGroup.dataset) nodeGroup.dataset.orchWired = '1';
      });

      return true;
    }

    // Mermaid renders async; retry wiring a few times and also observe changes.
    (function initMermaidWiring() {
      let attempts = 0;
      const maxAttempts = 25;
      const tryWire = () => {
        attempts++;
        const ok = wireMermaidNodeClicks();
        if (!ok && attempts < maxAttempts) {
          setTimeout(tryWire, 200);
        }
      };

      tryWire();

      const container = document.getElementById('mermaid-diagram');
      if (container && window.MutationObserver) {
        const obs = new MutationObserver(() => wireMermaidNodeClicks());
        obs.observe(container, { childList: true, subtree: true });
      }
    })();
    
    // Initialize Mermaid with dark theme and elk layout for better edge routing
    mermaid.initialize({
      startOnLoad: true,
      theme: 'dark',
      flowchart: {
        useMaxWidth: false,
        htmlLabels: true,
        curve: 'linear',
        rankSpacing: 50,
        nodeSpacing: 15,
        padding: 10
      },
      themeVariables: {
        primaryColor: '#2d2d2d',
        primaryTextColor: '#cccccc',
        primaryBorderColor: '#555555',
        lineColor: '#666666',
        secondaryColor: '#3c3c3c',
        tertiaryColor: '#252526'
      }
    });
    
    // Fallback click handler (covers clicks inside labels/shapes even if wiring didn't run)
    document.addEventListener('click', (e) => {
      const target = e.target;
      if (!target || !target.closest) return;
      const nodeGroup = target.closest('g.node[id], g.cluster[id]');
      if (!nodeGroup || !nodeGroup.id) return;

      // Preferred path: read the metadata embedded by wireMermaidNodeClicks()
      const ds = nodeGroup.dataset || {};
      if (ds.orchAction) {
        e.preventDefault();
        e.stopPropagation();
        switch (ds.orchAction) {
          case 'showWorkSummary':
            vscode.postMessage({ type: 'showWorkSummary' });
            return;
          case 'openNestedPlan':
            if (ds.orchPlanId) {
              vscode.postMessage({ type: 'openNestedPlan', planId: ds.orchPlanId });
            }
            return;
          case 'openJob':
            if (ds.orchJobId) {
              vscode.postMessage({ type: 'openJob', jobId: ds.orchJobId });
            }
            return;
        }
      }

      const nodeId = nodeGroup.id;

      if (nodeId.includes('WORK_SUMMARY')) {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: 'showWorkSummary' });
        return;
      }

      const subPlanKey = extractSanitizedKey(nodeId, 'subplan');
      if (subPlanKey) {
        const subPlanData = window.subPlanDataMap && window.subPlanDataMap[subPlanKey];
        if (subPlanData && subPlanData.childPlanId) {
          e.preventDefault();
          e.stopPropagation();
          vscode.postMessage({ type: 'openNestedPlan', planId: subPlanData.childPlanId });
        }
        return;
      }

      const jobKey = extractSanitizedKey(nodeId, 'job');
      if (jobKey) {
        const jobData = window.jobDataMap && window.jobDataMap[jobKey];
        if (jobData && jobData.jobId) {
          e.preventDefault();
          e.stopPropagation();
          if (jobData.nestedPlanId) {
            vscode.postMessage({ type: 'openNestedPlan', planId: jobData.nestedPlanId });
          } else {
            vscode.postMessage({ type: 'openJob', jobId: jobData.jobId });
          }
        }
      }
    });
    
    document.getElementById('cancelBtn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'cancelPlan' });
    });
    
    document.getElementById('retryBtn')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'retryPlan' });
    });
    
    document.getElementById('deleteBtn')?.addEventListener('click', (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '⏳ Deleting...';
      vscode.postMessage({ type: 'deletePlan' });
    });
    
    // Listen for messages from the extension
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'deleteReset') {
        // Reset the delete button if deletion was cancelled
        const btn = document.getElementById('deleteBtn');
        if (btn) {
          btn.disabled = false;
          btn.textContent = '🗑️ Delete Plan';
        }
      }
    });
  `;
}

/**
 * Generate JavaScript for work summary panel with expandable sections.
 */
export function getWorkSummaryJs(): string {
  return `
    // Handle expandable job sections
    document.querySelectorAll('.job-section.expandable').forEach(section => {
      section.querySelector('.job-header').addEventListener('click', () => {
        const jobIndex = section.dataset.job;
        const panel = section.querySelector('.commits-panel');
        
        if (section.classList.contains('expanded')) {
          section.classList.remove('expanded');
          if (panel) panel.style.display = 'none';
        } else {
          section.classList.add('expanded');
          if (panel) panel.style.display = 'block';
        }
      });
    });
  `;
}
