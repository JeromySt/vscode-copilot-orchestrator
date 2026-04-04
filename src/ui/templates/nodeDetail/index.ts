/**
 * @fileoverview Node detail template barrel exports.
 *
 * Re-exports all node detail template functions and types from
 * the individual template modules.
 *
 * @module ui/templates/nodeDetail
 */

export { breadcrumbHtml, headerRowHtml, executionStateHtml } from './headerTemplate';
export type { HeaderData } from './headerTemplate';

export { retryButtonsHtml, forceFailButtonHtml, bottomActionsHtml } from './actionButtonsTemplate';
export type { ActionButtonsData } from './actionButtonsTemplate';

export { processTreeSectionHtml } from './processTreeTemplate';
export type { ProcessTreeData } from './processTreeTemplate';

export { logViewerSectionHtml, truncateLogPath, getPhaseIcon, getMergeIcon } from './logViewerTemplate';
export type { LogViewerData } from './logViewerTemplate';

export { attemptCardHtml, attemptPhaseTabsHtml, attemptHistoryHtml } from './attemptsTemplate';
export type { AttemptCardData, AttemptHistoryData } from './attemptsTemplate';

export { configSectionHtml, dependenciesSectionHtml, gitInfoSectionHtml, renderSpecContent, getSpecTypeInfo } from './configTemplate';
export type { ConfigData } from './configTemplate';

export { attemptMetricsHtml } from './metricsTemplate';
export type { MetricsData, PhaseMetricsData, ModelBreakdownData, CodeChangesData } from './metricsTemplate';

export {
  executionCardHtml,
  phaseTabsHtml,
  metricsHtml as executionMetricsHtml,
  errorHtml as executionErrorHtml,
  contextHtml as executionContextHtml,
  splitAttemptLogs,
} from './executionCardTemplate';
export type { ExecutionCardData, ExecutionCardModelBreakdown } from './executionCardTemplate';

export { webviewScripts } from './scriptsTemplate';
export type { ScriptsConfig } from './scriptsTemplate';

export { renderNodeDetailStyles } from './stylesTemplate';
