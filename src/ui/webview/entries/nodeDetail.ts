/**
 * @fileoverview Node detail webview entry point.
 *
 * This bundle exports the node detail view controls and utilities to the
 * global `Orca` namespace for use in the node detail webview panel.
 *
 * @module ui/webview/entries/nodeDetail
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';
import { DurationCounter } from '../controls/durationCounter';
import { StatusBadge } from '../controls/statusBadge';
import { LogViewer } from '../controls/logViewer';
import { ProcessTree } from '../controls/processTree';
import { PhaseTabBar } from '../controls/phaseTabBar';
import { AttemptCard } from '../controls/attemptCard';
import { AiUsageStats } from '../controls/aiUsageStats';
import { WorkSummary } from '../controls/workSummary';
import { ConfigDisplay } from '../controls/configDisplay';
import { formatDurationMs, escapeHtml } from '../../templates/helpers';

const api = {
  EventBus,
  SubscribableControl,
  Topics,
  DurationCounter,
  StatusBadge,
  LogViewer,
  ProcessTree,
  PhaseTabBar,
  AttemptCard,
  AiUsageStats,
  WorkSummary,
  ConfigDisplay,
  formatDurationMs,
  escapeHtml,
};

(globalThis as any).Orca = api;

export type OrcaWebviewAPI = typeof api;
