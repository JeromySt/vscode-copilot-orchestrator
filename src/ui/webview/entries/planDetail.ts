/**
 * @fileoverview Plan detail webview entry point.
 *
 * This bundle exports the plan detail view controls and utilities to the
 * global `Orca` namespace for use in the plan detail webview panel.
 *
 * @module ui/webview/entries/planDetail
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';
import { DurationCounter } from '../controls/durationCounter';
import { MermaidNodeStyle } from '../controls/mermaidNodeStyle';
import { LayoutManager } from '../controls/layoutManager';
import { ProcessTree } from '../controls/processTree';
import { StatusBadge } from '../controls/statusBadge';
import { ProgressBar } from '../controls/progressBar';
import { NodeCard } from '../controls/nodeCard';
import { GroupContainer } from '../controls/groupContainer';
import { AiUsageStats } from '../controls/aiUsageStats';
import { WorkSummary } from '../controls/workSummary';
import { TimelineChart } from '../controls/timelineChart';
import { ViewTabBar } from '../controls/viewTabBar';
import { formatDurationMs, escapeHtml } from '../../templates/helpers';

const api = {
  EventBus,
  SubscribableControl,
  Topics,
  DurationCounter,
  MermaidNodeStyle,
  LayoutManager,
  ProcessTree,
  StatusBadge,
  ProgressBar,
  NodeCard,
  GroupContainer,
  AiUsageStats,
  WorkSummary,
  TimelineChart,
  ViewTabBar,
  formatDurationMs,
  escapeHtml,
};

(globalThis as any).Orca = api;

export type OrcaWebviewAPI = typeof api;
