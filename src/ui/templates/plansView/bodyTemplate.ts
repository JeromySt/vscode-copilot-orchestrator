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
  return `<div class="sidebar-tabs">
    <button class="tab active" data-tab="plans" id="tabPlans">
      Plans <span class="tab-badge" id="tabBadgePlans">0</span>
    </button>
    <button class="tab" data-tab="releases" id="tabReleases">
      Releases <span class="tab-badge" id="tabBadgeReleases" style="display:none">0</span>
    </button>
    <button class="tab" data-tab="prs" id="tabPRs">
      PRs <span class="tab-badge" id="tabBadgePRs" style="display:none">0</span>
    </button>
  </div>
  <div class="tab-content active" id="tabContentPlans">
    <div class="global-stats" id="globalStats" style="display: none;">
      <div class="stats-row">
        <span class="stat-item"><span class="stat-dot running"></span> <span id="runningJobs">0</span>/<span id="maxParallel">8</span> jobs</span>
        <span class="stat-item" id="queuedSection" style="display:none"><span class="stat-dot queued"></span> <span id="queuedJobs">0</span> queued</span>
      </div>
    </div>
    <div class="global-capacity-bar" id="globalCapacityBar" style="display: none;">
      <span class="capacity-label">Global:</span>
      <span class="capacity-jobs"><span id="globalRunningJobs">0</span>/<span id="globalMaxParallel">16</span></span>
      <span class="capacity-instances" title="VS Code instances using orchestrator"><span id="activeInstances">1</span> inst</span>
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
        <button class="bulk-btn" data-action="assignToRelease" title="Assign to Release">&#127991; Assign</button>
        <button class="bulk-btn" data-action="createReleaseFromPlans" title="Create Release">&#128640; Release</button>
        <button class="bulk-btn danger" data-action="delete" title="Delete">&#128465; Delete</button>
      </div>
    </div>
    <div id="plans" role="listbox" aria-multiselectable="true">
      <div class="welcome-state" id="welcomeState">
        <div class="welcome-icon">&#10024;</div>
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
  </div>
  <div class="tab-content" id="tabContentReleases">
    <div class="tab-header">
      <button class="tab-action-btn" id="newReleaseButton" title="Create a new release">+ New Release</button>
      <button class="tab-action-btn secondary" id="releaseFromBranchButton" title="Create release from current branch">From Branch</button>
    </div>
    <div id="releases">
      <div class="welcome-state">
        <div class="welcome-icon">&#128640;</div>
        <div class="welcome-title">No releases yet</div>
        <div class="welcome-subtitle">Create a release to merge plans, create a PR, and monitor it automatically.</div>
      </div>
    </div>
  </div>
  <div class="tab-content" id="tabContentPRs">
    <div class="tab-header">
      <button class="tab-action-btn" id="adoptPRButton" title="Adopt an existing PR">+ Adopt PR</button>
    </div>
    <div id="prs">
      <div class="welcome-state">
        <div class="welcome-icon">&#128279;</div>
        <div class="welcome-title">No managed PRs</div>
        <div class="welcome-subtitle">Adopt an existing PR to monitor it and manage its lifecycle.</div>
      </div>
    </div>
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
    <div class="context-menu-item" data-action="assignToRelease">&#127991; Assign to Release...</div>
    <div class="context-menu-item" data-action="createReleaseFromPlans">&#128640; Create Release</div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item danger" data-action="delete">&#128465; Delete</div>
  </div>`;
}

