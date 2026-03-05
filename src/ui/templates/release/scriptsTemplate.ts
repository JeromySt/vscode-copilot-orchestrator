/**
 * @fileoverview Release management webview scripts template.
 *
 * Orchestrates bundled webview controls and wires view-specific logic
 * for the release management wizard.
 *
 * @module ui/templates/release/scriptsTemplate
 */

import type { ReleaseDefinition } from '../../../plan/types/release';

/**
 * Render the webview `<script>` block for the release management view.
 *
 * @param release - Release definition data.
 * @returns HTML `<script>…</script>` string.
 */
export function renderReleaseScripts(release: ReleaseDefinition): string {
  return `<script>
    // ── Data Injection ──────────────────────────────────────────────────
    const vscode = acquireVsCodeApi();
    const releaseData = ${JSON.stringify(release)};

    // ── Destructure from Bundle ─────────────────────────────────────────
    const { EventBus, SubscribableControl, Topics } = window.Orca || {};

    // Global bus instance
    const bus = EventBus ? new EventBus() : null;

    // ── Message Handlers ────────────────────────────────────────────────
    
    function startRelease() {
      vscode.postMessage({ type: 'startRelease' });
    }
    
    function cancelRelease() {
      if (confirm('Are you sure you want to cancel this release?')) {
        vscode.postMessage({ type: 'cancelRelease' });
      }
    }
    
    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }
    
    function goBack() {
      // Navigation handled by re-rendering the panel
      vscode.postMessage({ type: 'refresh' });
    }

    // ── Plan Selection Control ──────────────────────────────────────────
    
    class PlanSelectorControl {
      constructor() {
        this.selectedPlans = new Set(releaseData.planIds || []);
        this.render();
      }
      
      render() {
        const container = document.getElementById('plan-list');
        if (!container) return;
        
        // Mock plan data - in real implementation, this would come from the extension
        const availablePlans = [
          { id: 'plan-1', name: 'Feature A', status: 'succeeded', jobCount: 5 },
          { id: 'plan-2', name: 'Feature B', status: 'succeeded', jobCount: 3 },
          { id: 'plan-3', name: 'Bug Fix', status: 'running', jobCount: 2 },
        ];
        
        container.innerHTML = availablePlans.map(plan => {
          const isSelected = this.selectedPlans.has(plan.id);
          const statusClass = plan.status === 'succeeded' ? 'succeeded' : 'running';
          
          return \`
            <div class="plan-item \${isSelected ? 'selected' : ''}" onclick="planSelector.toggle('\${plan.id}')">
              <input type="checkbox" class="plan-checkbox" \${isSelected ? 'checked' : ''} onclick="event.stopPropagation()">
              <div class="plan-info">
                <div class="plan-name">\${plan.name}</div>
                <div class="plan-details">\${plan.jobCount} jobs</div>
              </div>
              <span class="plan-status-badge \${statusClass}">\${plan.status}</span>
            </div>
          \`;
        }).join('');
      }
      
      toggle(planId) {
        if (this.selectedPlans.has(planId)) {
          this.selectedPlans.delete(planId);
          vscode.postMessage({ type: 'removePlan', planId });
        } else {
          this.selectedPlans.add(planId);
          vscode.postMessage({ type: 'addPlan', planId });
        }
        this.render();
      }
    }
    
    // ── Merge Progress Control ──────────────────────────────────────────
    
    class MergeProgressControl {
      constructor() {
        this.mergeResults = [];
        this.render();
      }
      
      update(results) {
        this.mergeResults = results || [];
        this.render();
      }
      
      render() {
        const container = document.getElementById('merge-list');
        if (!container) return;
        
        if (this.mergeResults.length === 0) {
          // Show plan list being prepared
          container.innerHTML = releaseData.planIds.map((planId, idx) => \`
            <div class="merge-item">
              <div class="merge-status-icon pending">⏳</div>
              <div class="merge-info">
                <div class="merge-plan-name">Plan \${idx + 1}</div>
                <div class="merge-status-text">Waiting to merge...</div>
              </div>
            </div>
          \`).join('');
          return;
        }
        
        container.innerHTML = this.mergeResults.map(result => {
          const icon = result.success ? '✓' : (result.error ? '✗' : '⏳');
          const iconClass = result.success ? 'success' : (result.error ? 'failed' : 'merging');
          const statusText = result.success ? 'Merged successfully' : 
                           (result.error ? result.error : 'Merging...');
          
          return \`
            <div class="merge-item">
              <div class="merge-status-icon \${iconClass}">\${icon}</div>
              <div class="merge-info">
                <div class="merge-plan-name">\${result.planName || result.planId}</div>
                <div class="merge-status-text">\${statusText}</div>
              </div>
            </div>
          \`;
        }).join('');
        
        // Update overall progress
        const completed = this.mergeResults.filter(r => r.success).length;
        const total = this.mergeResults.length;
        const percentage = total > 0 ? (completed / total) * 100 : 0;
        
        const progressBar = document.getElementById('overall-merge-progress');
        if (progressBar) {
          progressBar.style.width = percentage + '%';
          if (percentage === 100) {
            progressBar.classList.add('completed');
          }
        }
      }
    }
    
    // ── PR Monitor Control ──────────────────────────────────────────────
    
    class PRMonitorControl {
      constructor() {
        this.stats = {
          checksPass: 0,
          checksFail: 0,
          unresolvedComments: 0,
          unresolvedAlerts: 0
        };
        this.render();
      }
      
      update(data) {
        if (data) {
          this.stats = data;
          this.render();
        }
      }
      
      render() {
        const updateStat = (id, value) => {
          const el = document.getElementById(id);
          if (el) el.textContent = value;
        };
        
        updateStat('checks-passing', this.stats.checksPass);
        updateStat('checks-failing', this.stats.checksFail);
        updateStat('comments-unresolved', this.stats.unresolvedComments);
        updateStat('alerts-unresolved', this.stats.unresolvedAlerts);
      }
    }
    
    // ── Action Log Control ──────────────────────────────────────────────
    
    class ActionLogControl {
      constructor() {
        this.actions = [];
        this.render();
      }
      
      addAction(action) {
        this.actions.unshift(action); // Add to beginning
        this.render();
      }
      
      render() {
        const container = document.getElementById('action-log-entries');
        if (!container) return;
        
        if (this.actions.length === 0) {
          container.innerHTML = \`
            <div style="padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 11px;">
              No actions taken yet. The system will autonomously address feedback as it arrives.
            </div>
          \`;
          return;
        }
        
        container.innerHTML = this.actions.map(action => {
          const typeLabel = action.type.replace(/-/g, ' ').replace(/\\b\\w/g, l => l.toUpperCase());
          const statusClass = action.success ? 'success' : 'failed';
          const statusText = action.success ? '✓ Success' : '✗ Failed';
          const timestamp = new Date(action.timestamp || Date.now()).toLocaleTimeString();
          
          return \`
            <div class="action-entry \${action.type}">
              <div class="action-timestamp">\${timestamp}</div>
              <div class="action-content">
                <div class="action-type">
                  \${typeLabel}
                  <span class="action-status \${statusClass}">\${statusText}</span>
                </div>
                <div class="action-description">\${action.description}</div>
              </div>
            </div>
          \`;
        }).join('');
      }
    }

    // ── Initialize Controls ─────────────────────────────────────────────
    
    let planSelector, mergeProgress, prMonitor, actionLog;
    
    if (releaseData.status === 'drafting') {
      planSelector = new PlanSelectorControl();
    } else if (releaseData.status === 'merging') {
      mergeProgress = new MergeProgressControl();
    } else if (releaseData.status === 'monitoring' || releaseData.status === 'addressing') {
      prMonitor = new PRMonitorControl();
      actionLog = new ActionLogControl();
    }

    // ── Listen for Messages from Extension ──────────────────────────────
    
    window.addEventListener('message', event => {
      const message = event.data;
      
      switch (message.type) {
        case 'pulse':
          // Update any time-based displays
          break;
          
        case 'mergeProgress':
          if (mergeProgress) {
            mergeProgress.update(message.results);
          }
          break;
          
        case 'prUpdate':
          if (prMonitor) {
            prMonitor.update(message.stats);
          }
          break;
          
        case 'actionTaken':
          if (actionLog) {
            actionLog.addAction(message.action);
          }
          break;
      }
    });
  </script>`;
}
