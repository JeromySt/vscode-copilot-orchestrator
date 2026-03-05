/**
 * @fileoverview Plans view body template.
 *
 * Generates the HTML body content for the plans sidebar webview.
 *
 * @module ui/templates/plansView/bodyTemplate
 */

/**
 * Render the HTML body for the plans view.
 *
 * @returns HTML body string.
 */
export function renderPlansViewBody(): string {
  return `<div class="header">
    <h3>Plans</h3>
    <div class="header-actions">
      <button id="adoptPRButton" class="action-button" title="Adopt an existing PR">
        <span class="codicon codicon-add"></span>
        Adopt PR
      </button>
      <span class="pill" id="badge">0 total</span>
    </div>
  </div>
  <div class="global-capacity-bar" id="globalCapacityBar" style="display: none;">
    <span class="capacity-label">Global Capacity:</span>
    <span class="capacity-jobs">
      <span id="globalRunningJobs">0</span>/<span id="globalMaxParallel">16</span> jobs
    </span>
    <span class="capacity-instances" title="VS Code instances using orchestrator">
      <span id="activeInstances">1</span> instance(s)
    </span>
  </div>
  <div class="global-stats" id="globalStats" style="display: none; margin-bottom: 10px; padding: 6px 8px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; font-size: 11px;">
    <span>Jobs: <span id="runningJobs">0</span>/<span id="maxParallel">8</span></span>
    <span style="margin-left: 8px;" id="queuedSection">Queued: <span id="queuedJobs">0</span></span>
  </div>
  <div class="bulk-actions" id="bulkActions" style="display: none;">
    <span class="selection-count" id="selectionCount">0 selected</span>
    <div class="bulk-buttons">
      <button class="bulk-btn" data-action="resume" title="Resume selected plans">Resume</button>
      <button class="bulk-btn" data-action="pause" title="Pause selected plans">Pause</button>
      <button class="bulk-btn" data-action="cancel" title="Cancel selected plans">Cancel</button>
      <button class="bulk-btn" data-action="retry" title="Retry selected plans">Retry</button>
      <button class="bulk-btn" data-action="finalize" title="Finalize selected plans">Finalize</button>
      <button class="bulk-btn danger" data-action="delete" title="Delete selected plans">Delete</button>
    </div>
  </div>
  <div class="section managed-prs-section">
    <div class="section-header" id="managedPRsHeader">
      <span class="section-title">
        <span class="codicon codicon-chevron-down section-chevron" id="prsSectionChevron"></span>
        Managed PRs
        <span class="pill" id="prsBadge">0</span>
      </span>
    </div>
    <div class="section-content" id="managedPRsContent">
      <div id="prs"><div class="empty">No managed PRs.</div></div>
    </div>
  </div>
  <div class="section releases-section">
    <div class="section-header" id="releasesHeader">
      <span class="section-title">
        <span class="codicon codicon-chevron-down section-chevron" id="releasesSectionChevron"></span>
        Releases
        <span class="pill" id="releasesBadge">0</span>
      </span>
      <div class="section-actions">
        <button id="newReleaseButton" class="section-action-btn" title="Create a new release">
          <span class="codicon codicon-add"></span>
          New Release
        </button>
        <button id="releaseFromBranchButton" class="section-action-btn" title="Create release from current branch">
          <span class="codicon codicon-git-branch"></span>
          From Current Branch
        </button>
      </div>
    </div>
    <div class="section-content" id="releasesContent">
      <div id="releases"><div class="empty">🚀 No releases yet.</div></div>
    </div>
  </div>
  <div id="plans" role="listbox" aria-multiselectable="true"><div class="empty">No plans yet. Use <code>create_copilot_plan</code> MCP tool.</div></div>
  <div class="section-divider" id="archivedDivider" style="display: none;">
    <button class="collapse-toggle" id="archivedToggle" aria-expanded="false">
      <span class="codicon codicon-chevron-right"></span>
      <span>Archived</span>
      <span class="pill" id="archivedCount">0</span>
    </button>
  </div>
  <div class="tab-content active" id="tabContentPlans">
    <div class="header">
      <div class="header-actions">
        <span class="pill" id="badge">0 total</span>
      </div>
    </div>
    <div class="global-capacity-bar" id="globalCapacityBar" style="display: none;">
      <span class="capacity-label">Global Capacity:</span>
      <span class="capacity-jobs">
        <span id="globalRunningJobs">0</span>/<span id="globalMaxParallel">16</span> jobs
      </span>
      <span class="capacity-instances" title="VS Code instances using orchestrator">
        <span id="activeInstances">1</span> instance(s)
      </span>
    </div>
    <div class="global-stats" id="globalStats" style="display: none; margin-bottom: 10px; padding: 6px 8px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; font-size: 11px;">
      <span>Jobs: <span id="runningJobs">0</span>/<span id="maxParallel">8</span></span>
      <span style="margin-left: 8px;" id="queuedSection">Queued: <span id="queuedJobs">0</span></span>
    </div>
    <div class="bulk-actions" id="bulkActions" style="display: none;">
      <span class="selection-count" id="selectionCount">0 selected</span>
      <div class="bulk-buttons">
        <button class="bulk-btn" data-action="resume" title="Resume selected plans">Resume</button>
        <button class="bulk-btn" data-action="pause" title="Pause selected plans">Pause</button>
        <button class="bulk-btn" data-action="cancel" title="Cancel selected plans">Cancel</button>
        <button class="bulk-btn" data-action="retry" title="Retry selected plans">Retry</button>
        <button class="bulk-btn" data-action="finalize" title="Finalize selected plans">Finalize</button>
        <button class="bulk-btn danger" data-action="delete" title="Delete selected plans">Delete</button>
      </div>
    </div>
    <div id="plans" role="listbox" aria-multiselectable="true"><div class="empty">No plans yet. Use <code>create_copilot_plan</code> MCP tool.</div></div>
    <div class="section-divider" id="archivedDivider" style="display: none;">
      <button class="collapse-toggle" id="archivedToggle" aria-expanded="false">
        <span class="codicon codicon-chevron-right"></span>
        <span>Archived</span>
        <span class="pill" id="archivedCount">0</span>
      </button>
    </div>
    <div class="archived-plans" id="archivedPlans" style="display: none;"></div>
  </div>
  <div class="tab-content" id="tabContentReleases">
    <div class="empty">No releases yet.</div>
  </div>
  <div class="tab-content" id="tabContentPRs">
    <div class="header">
      <div class="header-actions">
        <button id="adoptPRButton" class="action-button" title="Adopt an existing PR">
          <span class="codicon codicon-add"></span>
          Adopt PR
        </button>
      </div>
    </div>
    <div class="section managed-prs-section">
      <div class="section-header" id="managedPRsHeader">
        <span class="section-title">
          <span class="codicon codicon-chevron-down section-chevron" id="prsSectionChevron"></span>
          Managed PRs
          <span class="pill" id="prsBadge">0</span>
        </span>
      </div>
      <div class="section-content" id="managedPRsContent">
        <div id="prs"><div class="empty">No managed PRs.</div></div>
      </div>
    </div>
  </div>
  <div class="context-menu" id="contextMenu" style="display: none;">
    <div class="context-menu-item" data-action="resume">Resume</div>
    <div class="context-menu-item" data-action="pause">Pause</div>
    <div class="context-menu-item" data-action="cancel">Cancel</div>
    <div class="context-menu-item" data-action="retry">Retry</div>
    <div class="context-menu-item" data-action="finalize">Finalize</div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item danger" data-action="delete">Delete</div>
  </div>`;
}
