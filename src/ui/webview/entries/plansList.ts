/**
 * @fileoverview Plans list webview entry point.
 *
 * This bundle exports the plans list (sidebar) controls and utilities to the
 * global `Orca` namespace for use in the plans sidebar webview.
 *
 * @module ui/webview/entries/plansList
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';
import { PlanListCard } from '../controls/planListCard';
import { ProgressBar } from '../controls/progressBar';
import { DurationCounter } from '../controls/durationCounter';
import { formatDurationMs, escapeHtml } from '../../templates/helpers';

const api = {
  EventBus,
  SubscribableControl,
  Topics,
  PlanListCard,
  ProgressBar,
  DurationCounter,
  formatDurationMs,
  escapeHtml,
};

(globalThis as any).Orca = api;

export type OrcaWebviewAPI = typeof api;
