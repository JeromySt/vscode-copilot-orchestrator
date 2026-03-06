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
    <span class="pill" id="badge">0</span>
  </div>
  <div class="global-stats" id="globalStats" style="display: none;">
    <div class="stats-row">
      <span class="stat-item"><span class="stat-dot running"></span> <span id="runningJobs">0</span>/<span id="maxParallel">8</span> jobs</span>
      <span class="stat-item" id="queuedSection" style="display:none"><span class="stat-dot queued"></span> <span id="queuedJobs">0</span> queued</span>
    </div>
  </div>
  <div class="global-capacity-bar" id="globalCapacityBar" style="display: none;">
    <span class="capacity-label">Global:</span>
    <span class="capacity-jobs">
      <span id="globalRunningJobs">0</span>/<span id="globalMaxParallel">16</span>
    </span>
    <span class="capacity-instances" title="VS Code instances using orchestrator">
      <span id="activeInstances">1</span> inst
    </span>
  </div>
  <div class="bulk-actions" id="bulkActions" style="display: none;">
    <div class="bulk-header">
      <span class="selection-count" id="selectionCount">0 selected</span>
      <button class="bulk-dismiss" id="bulkDismiss" title="Deselect all">&times;</button>
    </div>
    <div class="bulk-buttons" id="bulkButtons">
      <button class="bulk-btn" data-action="resume" title="Resume">&#9654; Resume</button>
      <button class="bulk-btn" data-action="pause" title="Pause">&#10074;&#10074; Pause</button>
      <button class="bulk-btn" data-action="cancel" title="Cancel">&#9632; Cancel</button>
      <button class="bulk-btn" data-action="retry" title="Retry">&#8635; Retry</button>
      <button class="bulk-btn" data-action="finalize" title="Finalize">&#10003; Finalize</button>
      <button class="bulk-btn" data-action="archive" title="Archive">&#128230; Archive</button>
      <button class="bulk-btn" data-action="recover" title="Recover">&#128260; Recover</button>
      <button class="bulk-btn danger" data-action="delete" title="Delete">&#128465; Delete</button>
    </div>
  </div>
  <div id="plans" role="listbox" aria-multiselectable="true">
    <div class="welcome-state" id="welcomeState">
      <div class="welcome-icon">\u2728</div>
      <div class="welcome-title">No plans yet</div>
      <div class="welcome-subtitle">Ask Copilot to create a plan, or use the <code>create_copilot_plan</code> MCP tool to get started.</div>
    </div>
  </div>
  <div class="section-divider" id="archivedDivider" style="display: none;">
    <button class="collapse-toggle" id="archivedToggle" aria-expanded="false">
      <span class="codicon codicon-chevron-right"></span>
      <span>Archived</span>
      <span class="pill small" id="archivedCount">0</span>
    </button>
  </div>
  <div class="archived-plans" id="archivedPlans" style="display: none;"></div>
  <div class="section-divider" id="managedPRsDivider">
    <button class="collapse-toggle" id="managedPRsToggle" aria-expanded="false">
      <span class="codicon codicon-chevron-right" id="prsSectionChevron"></span>
      <span>Managed PRs</span>
      <span class="pill small" id="prsBadge">0</span>
    </button>
    <button class="section-action" id="adoptPRButton" title="Adopt an existing PR for release management">
      <span class="codicon codicon-git-pull-request-create"></span>
    </button>
  </div>
  <div class="managed-prs-content" id="managedPRsContent" style="display: none;">
    <div id="prs"><div class="empty-section">No managed PRs. Click + to adopt one.</div></div>
  </div>
  <div class="context-menu" id="contextMenu" style="display: none;">
    <div class="context-menu-item" data-action="resume">&#9654; Resume</div>
    <div class="context-menu-item" data-action="pause">&#10074;&#10074; Pause</div>
    <div class="context-menu-item" data-action="cancel">&#9632; Cancel</div>
    <div class="context-menu-item" data-action="retry">&#8635; Retry</div>
    <div class="context-menu-item" data-action="finalize">&#10003; Finalize</div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" data-action="archive">&#128230; Archive</div>
    <div class="context-menu-item" data-action="recover">&#128260; Recover</div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item danger" data-action="delete">&#128465; Delete</div>
  </div>`;
}
