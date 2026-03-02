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
  /** True if the plan is paused because it's waiting on another plan to finish */
  isChainedPause?: boolean;
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

  const isActive = status === 'running' || status === 'pending' || status === 'resumed';
  const isPaused = status === 'paused';
  const isPausing = status === 'pausing';
  const isPendingStart = status === 'pending-start';
  const canControl = isActive || isPaused || isPausing || isPendingStart;
  const isScaffolding = status === 'scaffolding';

  const pauseBtn = isActive
    ? '<button id="pauseBtn" class="action-btn secondary" onclick="pausePlan()">Pause</button>'
    : '<button id="pauseBtn" class="action-btn secondary" onclick="pausePlan()" style="display:none">Pause</button>';

  // "Start" button for pending-start plans that have never run
  const startBtn = isPendingStart
    ? '<button id="startBtn" class="action-btn primary" onclick="resumePlan()">Start</button>'
    : '<button id="startBtn" class="action-btn primary" onclick="resumePlan()" style="display:none">Start</button>';

  const resumeBtn = isPaused && !data.isChainedPause
    ? '<button id="resumeBtn" class="action-btn primary" onclick="resumePlan()">Resume</button>'
    : '<button id="resumeBtn" class="action-btn primary" onclick="resumePlan()" style="display:none">Resume</button>';

  const cancelBtn = canControl && !isScaffolding
    ? '<button id="cancelBtn" class="action-btn secondary" onclick="cancelPlan()">Cancel</button>'
    : '<button id="cancelBtn" class="action-btn secondary" onclick="cancelPlan()" style="display:none">Cancel</button>';

  const workSummaryBtn = status === 'succeeded'
    ? '<button id="workSummaryBtn" class="action-btn primary" onclick="showWorkSummary()">View Work Summary</button>'
    : '<button id="workSummaryBtn" class="action-btn primary" onclick="showWorkSummary()" style="display:none">View Work Summary</button>';

  return `
  <div class="plan-toolbar">
    <div class="actions">
      ${isScaffolding ? '' : pauseBtn}
      ${isScaffolding ? '' : startBtn}
      ${isScaffolding ? '' : resumeBtn}
      ${isScaffolding ? '' : cancelBtn}
      <button class="action-btn secondary" onclick="refresh()">Refresh</button>
      ${isScaffolding ? '' : workSummaryBtn}
      <button class="action-btn danger" onclick="deletePlan()">Delete</button>
    </div>
  </div>
  `;
}
