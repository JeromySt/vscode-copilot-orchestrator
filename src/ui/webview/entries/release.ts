/**
 * @fileoverview Release management webview entry point.
 *
 * This bundle exports the release management view controls and utilities to the
 * global `Orca` namespace for use in the release management webview panel.
 *
 * @module ui/webview/entries/release
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';
import { formatDurationMs, escapeHtml } from '../../templates/helpers';
import { initReleasePanel } from '../releasePanel';

const api = {
  EventBus,
  SubscribableControl,
  Topics,
  formatDurationMs,
  escapeHtml,
  initReleasePanel,
};

(globalThis as any).Orca = api;

export type OrcaReleaseWebviewAPI = typeof api;
