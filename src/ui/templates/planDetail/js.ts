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
 * @param jobDataMap - Map of sanitized job IDs to job data
 * @param subPlanDataMap - Map of sanitized sub-plan IDs to sub-plan data
 */
export function getPlanDetailJs(
  jobDataMap: Record<string, { jobId: string | null; nestedPlanId?: string | null }>,
  subPlanDataMap: Record<string, { subPlanId: string; childPlanId: string | null }>
): string {
  return `
    const vscode = acquireVsCodeApi();
    
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
    
    // Handle node clicks - need to handle clicks on text, rect, etc inside nodes
    // Note: MERGE nodes, branch nodes, and PENDING jobs are not clickable
    document.addEventListener('click', (e) => {
      // Walk up to find a node group element
      let el = e.target;
      while (el && el !== document.body) {
        // Check for node class or if it's inside a node group
        if (el.classList && (el.classList.contains('node') || el.classList.contains('nodeLabel'))) {
          // Find the parent node group
          let nodeGroup = el;
          while (nodeGroup && !nodeGroup.id?.startsWith('flowchart-')) {
            nodeGroup = nodeGroup.parentElement;
          }
          if (nodeGroup && nodeGroup.id) {
            const nodeId = nodeGroup.id;
            
            // Check for WORK_SUMMARY node click
            if (nodeId.includes('WORK_SUMMARY')) {
              e.preventDefault();
              e.stopPropagation();
              vscode.postMessage({ type: 'showWorkSummary' });
              break;
            }
            
            // Check for sub-plan node click (format: flowchart-subplan_xxx-N)
            const subPlanMatch = nodeId.match(/flowchart-(subplan_[^-]+)-/);
            if (subPlanMatch) {
              const sanitizedId = subPlanMatch[1];
              const subPlanData = window.subPlanDataMap && window.subPlanDataMap[sanitizedId];
              if (subPlanData && subPlanData.childPlanId) {
                e.preventDefault();
                e.stopPropagation();
                vscode.postMessage({ type: 'openNestedPlan', planId: subPlanData.childPlanId });
              }
              break;
            }
            
            // Only handle job nodes (not merge nodes, base nodes, or target nodes)
            // Extract sanitized job ID from node ID (format: flowchart-job_xxxx-N)
            const match = nodeId.match(/flowchart-(job_[^-]+)-/);
            if (match) {
              const sanitizedId = match[1];
              // Skip merge nodes
              if (sanitizedId.startsWith('merge_')) break;
              
              const jobData = window.jobDataMap && window.jobDataMap[sanitizedId];
              // Only allow clicking if job has been started (has a jobId) - not pending jobs
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
            break;
          }
        }
        el = el.parentElement;
      }
    });
    
    // Store job data for click handling (keyed by sanitized ID)
    window.jobDataMap = ${JSON.stringify(jobDataMap)};
    
    // Store sub-plan data for click handling (keyed by sanitized ID)
    window.subPlanDataMap = ${JSON.stringify(subPlanDataMap)};
    
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
