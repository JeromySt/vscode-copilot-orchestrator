/**
 * @fileoverview Plan detail templates barrel export.
 *
 * Re-exports all plan detail template functions and their input interfaces.
 *
 * @module ui/templates/planDetail
 */

export { renderPlanHeader, formatPlanDuration } from './headerTemplate';
export type { PlanHeaderData } from './headerTemplate';

export { renderPlanControls } from './controlsTemplate';
export type { PlanControlsData } from './controlsTemplate';

export { renderPlanDag } from './dagTemplate';
export type { PlanDagData } from './dagTemplate';

export { renderPlanNodeCard } from './nodeCardTemplate';
export type { PlanNodeCardData } from './nodeCardTemplate';

export { renderPlanSummary, renderMetricsBar } from './summaryTemplate';
export type { PlanSummaryData, PlanMetricsBarData, JobSummaryItem, ModelBreakdownItem } from './summaryTemplate';

export { renderPlanScripts } from './scriptsTemplate';
export type { PlanScriptsData } from './scriptsTemplate';
