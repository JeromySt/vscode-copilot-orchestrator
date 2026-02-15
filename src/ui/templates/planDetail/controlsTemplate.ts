/**
 * @fileoverview Plan detail controls template.
 *
 * Renders the action buttons bar for the plan detail view.
 * Button visibility is driven by plan status.
 *
 * @module ui/templates/planDetail/controlsTemplate
 */

/**
 * Input data for rendering plan control buttons.
 */
export interface PlanControlsData {
  /** Computed plan status */
  status: string;
}

/**
 * Render the plan action buttons HTML fragment.
 *
 * Buttons rendered: Pause, Resume, Cancel, Refresh, View Work Summary, Delete.
 * Visibility is based on plan status — hidden buttons are rendered with
 * `style="display:none"` so the client-side incremental update can toggle them.
 *
 * @param data - Controls input data.
 * @returns HTML fragment string for the actions bar.
 */
export function renderPlanControls(data: PlanControlsData): string {
  const { status } = data;

  const isActive = status === 'running' || status === 'pending';
  const isPaused = status === 'paused';
  const canControl = isActive || isPaused;

  const pauseBtn = isActive
    ? '<button id="pauseBtn" class="action-btn secondary" onclick="pausePlan()">Pause</button>'
    : '<button id="pauseBtn" class="action-btn secondary" onclick="pausePlan()" style="display:none">Pause</button>';

  const resumeBtn = isPaused
    ? '<button id="resumeBtn" class="action-btn primary" onclick="resumePlan()">Resume</button>'
    : '<button id="resumeBtn" class="action-btn primary" onclick="resumePlan()" style="display:none">Resume</button>';

  const cancelBtn = canControl
    ? '<button id="cancelBtn" class="action-btn secondary" onclick="cancelPlan()">Cancel</button>'
    : '<button id="cancelBtn" class="action-btn secondary" onclick="cancelPlan()" style="display:none">Cancel</button>';

  const workSummaryBtn = status === 'succeeded'
    ? '<button id="workSummaryBtn" class="action-btn primary" onclick="showWorkSummary()">View Work Summary</button>'
    : '<button id="workSummaryBtn" class="action-btn primary" onclick="showWorkSummary()" style="display:none">View Work Summary</button>';

  return `
  <div class="plan-toolbar">
    <div class="actions">
      ${pauseBtn}
      ${resumeBtn}
      ${cancelBtn}
      <button class="action-btn secondary" onclick="refresh()">Refresh</button>
      ${workSummaryBtn}
      <button class="action-btn danger" onclick="deletePlan()">Delete</button>
    </div>
  </div>
  `;
}
