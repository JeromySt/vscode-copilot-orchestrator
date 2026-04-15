/**
 * @fileoverview Attempt card control — manages attempt history card list.
 *
 * Subscribes to {@link Topics.ATTEMPT_UPDATE} and rebuilds the attempt card
 * list with current status, duration, metrics, and expand/collapse state.
 *
 * @module ui/webview/controls/attemptCard
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';

// VS Code webview API global (injected by the webview host)
declare const vscode: { postMessage(msg: unknown): void };

/** Sub-job info for context pressure checkpoint display. */
export interface SubJobInfo {
  producerId: string;
  nodeId: string;
  name: string;
  status: string;
}

/** Context pressure checkpoint data for post-split view. */
export interface CheckpointData {
  pressure: number;
  tokensConsumed?: number;
  maxTokens?: number;
  subJobCount: number;
  subJobs: SubJobInfo[];
  fanInJobId: string;
  manifestJson?: string;
  planId: string;
}

/** Single attempt data from the backend. */
export interface AttemptCardData {
  attemptNumber: number;
  status: string;
  triggerType?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  failedPhase?: string;
  exitCode?: number;
  copilotSessionId?: string;
  stepStatuses?: Record<string, string>;
  worktreePath?: string;
  baseCommit?: string;
  logFilePath?: string;
  workUsedHtml?: string;
  prechecksUsedHtml?: string;
  postchecksUsedHtml?: string;
  logs?: string;
  metricsHtml?: string;
  expanded?: boolean;
  contextPressureCheckpoint?: CheckpointData;
  contextPressureSnapshot?: {
    level: string;
    currentInputTokens: number;
    maxPromptTokens?: number;
    compactionDetected: boolean;
    modelBreakdown?: Array<{ model: string; inputTokens: number; outputTokens: number; cachedTokens: number; turns: number }>;
    totalTurns?: number;
    turnsPerSecond?: number;
  };
}

/** Batch update payload from the backend. */
interface AttemptUpdatePayload {
  attempts: AttemptCardData[];
  planEnvHtml?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncateLogPath(filePath: string): string {
  if (!filePath) { return ''; }
  const separator = filePath.includes('\\') ? '\\' : '/';
  const parts = filePath.split(separator);
  const filename = parts[parts.length - 1];
  const prefix = parts[0] + separator;

  let truncatedFilename = filename;
  const logMatch = filename.match(/^([a-f0-9]{8})-[a-f0-9-]+_[a-f0-9-]+-([a-f0-9]{12})_(\d+\.log)$/i);
  if (logMatch) {
    truncatedFilename = logMatch[1] + '....' + logMatch[2] + '_' + logMatch[3];
  }

  if (filePath.length <= 50) { return filePath; }
  return prefix + '....' + separator + truncatedFilename;
}

function formatDuration(sec: number): string {
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return m + 'm ' + s + 's';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

function stepIconHtml(status?: string): string {
  const icon = status === 'success' || status === 'succeeded' ? '\u2713'  // ✓
    : status === 'failed' ? '\u2717'   // ✗
    : status === 'running' ? '\u27F3'  // ⟳
    : status === 'skipped' ? '\u2298'  // ⊘
    : '\u2022';                        // • (pending — matches executionCardTemplate)
  const cls = status === 'success' || status === 'succeeded' ? 'success'
    : status === 'failed' ? 'failed'
    : status === 'running' ? 'running'
    : status === 'skipped' ? 'skipped'
    : 'pending';
  return '<span class="step-icon ' + cls + '">' + icon + '</span>';
}

/**
 * Attempt card list control — manages the entire attempt history container.
 */
export class AttemptCard extends SubscribableControl {
  private selector: string;
  private expandedAttempts = new Set<number>();
  private activePhase = 'all';
  private userSelectedPhase = false;
  /** Per-attempt log buffers — key is the tag (e.g., 'log-attempt-3') */
  private logBuffers = new Map<string, string>();
  /** Track which phase the log stream is currently in (based on markers seen) */
  private currentStreamPhase = 'unknown';
  /** Plan-level env vars HTML (set once from first attemptUpdate). */
  private planEnvHtml = '';
  /** Structure key to skip no-op rebuilds. */
  private _lastStructureKey = '';
  /** Track which attempts have been rendered to DOM (attemptNumber → last status). */
  private _renderedAttempts = new Map<number, string>();
  /** Cache of last attempt data for differential updates. */
  private _lastAttemptData = new Map<number, AttemptCardData>();

  constructor(bus: EventBus, controlId: string, selector: string) {
    super(bus, controlId);
    this.selector = selector;
    this.subscribe(Topics.ATTEMPT_UPDATE, (data?: AttemptUpdatePayload) => {
      if (data?.planEnvHtml !== undefined) this.planEnvHtml = data.planEnvHtml;
      if (data?.attempts) this.rebuild(data.attempts);
    });
    // Tick running attempt durations every pulse (1s)
    this.subscribe(Topics.PULSE, () => this.tickDurations());
    // Handle subscription data (log deltas/full from extension host)
    this.subscribe(Topics.SUBSCRIPTION_DATA, (msg?: { tag?: string; full?: boolean; content?: string }) => {
      if (msg?.tag && typeof msg.content === 'string') {
        this.handleSubscriptionData(msg.tag, msg.content, !!msg.full);
      }
    });
    // Legacy: also handle LOG_UPDATE for backward compat during transition
    this.subscribe(Topics.LOG_UPDATE, (data?: { phase?: string; content?: string; append?: boolean }) => {
      if (data?.content) {
        // Route to the first log buffer (latest attempt)
        const latestTag = this.getLatestLogTag();
        if (latestTag) {
          this.handleSubscriptionData(latestTag, data.content, !data.append);
        }
      }
    });
    // Update phase tab styling when step statuses change
    this.subscribe(Topics.NODE_STATE_CHANGE, (data?: { phaseStatus?: Record<string, string> }) => {
      if (data?.phaseStatus) this.updatePhaseTabs(data.phaseStatus);
    });
  }

  /** Get the tag for the latest (highest numbered) attempt's log buffer. */
  private getLatestLogTag(): string | undefined {
    let best: string | undefined;
    let bestNum = -1;
    for (const tag of this.logBuffers.keys()) {
      const m = tag.match(/log-attempt-(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > bestNum) { bestNum = n; best = tag; }
      }
    }
    return best;
  }

  /** Check if user has an active text selection inside the log viewer. */
  private hasActiveLogSelection(): boolean {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const container = document.querySelector(this.selector);
    if (!container) return false;
    const logEl = container.querySelector('.attempt-live-log');
    if (!logEl) return false;
    return logEl.contains(sel.anchorNode);
  }

  /** Handle subscription data — update per-attempt log buffer and render. */
  private handleSubscriptionData(tag: string, content: string, full: boolean): void {
    if (full) {
      this.logBuffers.set(tag, content);
      // Detect current phase from full content
      this.currentStreamPhase = this.detectCurrentPhase(content);
    } else {
      const existing = this.logBuffers.get(tag) || '';
      this.logBuffers.set(tag, existing + content);
      // Update current phase from delta content (check for section markers)
      this.currentStreamPhase = this.detectCurrentPhase(content) || this.currentStreamPhase;
    }

    // Find the log viewer element for this tag
    const container = document.querySelector(this.selector) as HTMLElement | null;
    if (!container) return;
    const viewer = container.querySelector('[data-log-tag="' + tag + '"]') as HTMLPreElement | null;
    if (!viewer) return;

    // appendChild(textNode) preserves existing Selection ranges, so we always append.
    // Only suppress auto-scroll when user has an active selection or has scrolled up.
    const hasSelection = this.hasActiveLogSelection();
    const wasAtBottom = !hasSelection && viewer.scrollTop + viewer.clientHeight >= viewer.scrollHeight - 20;

    if (full) {
      // Full load — set content (initial load or phase switch)
      if (this.activePhase === 'all') {
        viewer.textContent = content;
      } else {
        viewer.textContent = this.extractPhaseFromText(content, this.activePhase) || '(no logs for this phase yet)';
      }
    } else {
      // Delta append — logs only roll forward, never replace
      if (this.activePhase === 'all') {
        // Show everything — just append
        viewer.appendChild(document.createTextNode(content));
      } else {
        // A delta may span multiple phases. Re-extract the active phase from the full buffer
        // rather than appending the raw delta which could contain other phases' content.
        const fullText = this.logBuffers.get(tag) || '';
        const filtered = this.extractPhaseFromText(fullText, this.activePhase);
        const newText = filtered || '(no logs for this phase yet)';
        if (viewer.textContent !== newText) {
          viewer.textContent = newText;
        }
      }
    }

    if (wasAtBottom) {
      viewer.scrollTop = viewer.scrollHeight;
    }
  }

  /** Update phase tab CSS classes and auto-advance to running phase. */
  private updatePhaseTabs(phaseStatus: Record<string, string>): void {
    const container = document.querySelector(this.selector) as HTMLElement | null;
    if (!container) return;
    let runningPhase: string | null = null;
    container.querySelectorAll('.attempt-phase-tab').forEach(tab => {
      const phase = tab.getAttribute('data-phase');
      if (!phase || phase === 'all') return;
      const status = phaseStatus[phase] || '';
      tab.classList.remove('success', 'failed', 'skipped', 'running');
      if (status === 'success' || status === 'succeeded') tab.classList.add('success');
      else if (status === 'failed') tab.classList.add('failed');
      else if (status === 'skipped') tab.classList.add('skipped');
      else if (status === 'running') { tab.classList.add('running'); runningPhase = phase; }
    });

    // Auto-advance to the running phase if the user hasn't manually selected a tab,
    // doesn't have an active text selection, and isn't actively scrolling (not at bottom)
    if (runningPhase && !this.userSelectedPhase && !this.hasActiveLogSelection() && this.activePhase !== runningPhase) {
      const viewer = container.querySelector('.attempt-live-log') as HTMLElement | null;
      const isAtBottom = !viewer || (viewer.scrollTop + viewer.clientHeight >= viewer.scrollHeight - 20);
      if (!isAtBottom) return; // User scrolled up — don't disrupt them

      this.activePhase = runningPhase;
      // Update active tab styling
      container.querySelectorAll('.attempt-phase-tab').forEach(t => t.classList.remove('active'));
      const activeTab = container.querySelector('.attempt-phase-tab[data-phase="' + runningPhase + '"]');
      if (activeTab) activeTab.classList.add('active');
      // Filter log to new phase — since we're switching, we need the full filtered content
      if (viewer) {
        const tag = viewer.getAttribute('data-log-tag') || '';
        const logText = this.logBuffers.get(tag) || '';
        viewer.textContent = this.extractPhaseFromText(logText, runningPhase) || '(no logs for this phase yet)';
      }
    }
  }

  /** Extract log lines for a specific phase from the full log text. */
  private extractPhaseFromText(text: string, phase: string): string {
    const markers: Record<string, [string, string]> = {
      'merge-fi': ['FORWARD INTEGRATION', 'FORWARD INTEGRATION'],
      'prechecks': ['PRECHECKS SECTION START', 'PRECHECKS SECTION END'],
      'work': ['WORK SECTION START', 'WORK SECTION END'],
      'commit': ['COMMIT SECTION START', 'COMMIT SECTION END'],
      'postchecks': ['POSTCHECKS SECTION START', 'POSTCHECKS SECTION END'],
      'merge-ri': ['REVERSE INTEGRATION', 'REVERSE INTEGRATION'],
    };
    const m = markers[phase];
    if (!m) return '';
    const startIdx = text.indexOf(m[0]);
    if (startIdx < 0) return '';
    const afterStart = text.indexOf('\n', startIdx);
    const endIdx = text.indexOf(m[1], afterStart > 0 ? afterStart : startIdx + m[0].length);
    if (endIdx > afterStart) {
      return text.substring(afterStart + 1, endIdx).trim();
    }
    return text.substring(afterStart > 0 ? afterStart + 1 : startIdx + m[0].length).trim();
  }

  /** Detect which phase the log content is currently in based on section markers. */
  private detectCurrentPhase(text: string): string {
    const phaseMarkers: Array<[string, string]> = [
      ['merge-fi', 'FORWARD INTEGRATION'],
      ['prechecks', 'PRECHECKS SECTION START'],
      ['work', 'WORK SECTION START'],
      ['commit', 'COMMIT SECTION START'],
      ['postchecks', 'POSTCHECKS SECTION START'],
      ['merge-ri', 'REVERSE INTEGRATION MERGE START'],
    ];
    const endMarkers: Array<[string, string]> = [
      ['prechecks', 'PRECHECKS SECTION END'],
      ['work', 'WORK SECTION END'],
      ['commit', 'COMMIT SECTION END'],
      ['postchecks', 'POSTCHECKS SECTION END'],
      ['merge-ri', 'REVERSE INTEGRATION MERGE END'],
    ];
    let latestPhase = '';
    let latestIdx = -1;
    for (const [phase, marker] of phaseMarkers) {
      const idx = text.lastIndexOf(marker);
      if (idx > latestIdx) {
        const endEntry = endMarkers.find(e => e[0] === phase);
        const endIdx = endEntry ? text.lastIndexOf(endEntry[1]) : -1;
        if (endIdx > idx) continue; // Phase ended
        latestIdx = idx;
        latestPhase = phase;
      }
    }
    return latestPhase;
  }

  /** Update duration text for running attempts. */
  private tickDurations(): void {
    const container = document.querySelector(this.selector) as HTMLElement | null;
    if (!container) return;
    container.querySelectorAll('.attempt-duration[data-started]').forEach(el => {
      const started = parseInt(el.getAttribute('data-started') || '0', 10);
      if (started) {
        const secs = Math.round((Date.now() - started) / 1000);
        (el as HTMLElement).textContent = formatDuration(secs) + '\u2026';
      }
    });
  }

  /** Rebuild the entire attempt card list from fresh data. */
  private rebuild(attempts: AttemptCardData[]): void {
    const container = document.querySelector(this.selector) as HTMLElement | null;
    if (!container) return;

    // Determine if we need a full rebuild or can do differential updates
    const sorted = attempts.slice().sort((a, b) => b.attemptNumber - a.attemptNumber);
    const currentAttemptNums = new Set(sorted.map(a => a.attemptNumber));
    const needsFullRebuild = sorted.some(a => !this._renderedAttempts.has(a.attemptNumber));

    if (needsFullRebuild) {
      // Save page scroll before full innerHTML replacement
      const savedY = window.scrollY || document.documentElement.scrollTop;
      const savedX = window.scrollX || document.documentElement.scrollLeft;
      this._fullRebuild(container, sorted);
      // Restore page scroll after DOM replacement
      requestAnimationFrame(() => { window.scrollTo(savedX, savedY); });
    } else {
      // All attempts already rendered — do differential updates only
      for (const att of sorted) {
        this._differentialUpdate(att);
      }
    }

    // Cache latest data
    for (const att of sorted) {
      this._lastAttemptData.set(att.attemptNumber, att);
    }
  }

  /** Full rebuild — only called when new attempts appear. */
  private _fullRebuild(container: HTMLElement, sorted: AttemptCardData[]): void {

    // Preserve expanded state
    container.querySelectorAll('.attempt-card[data-expanded="true"]').forEach(el => {
      const num = parseInt(el.getAttribute('data-attempt') || '0', 10);
      if (num) this.expandedAttempts.add(num);
    });

    // Auto-expand the latest attempt if nothing else is expanded
    if (this.expandedAttempts.size === 0 && sorted.length > 0) {
      this.expandedAttempts.add(sorted[0].attemptNumber);
    }
    const html = sorted.map(att => this.renderCard(att)).join('');
    container.innerHTML = '<div class="section"><h3>Attempt History (' + sorted.length + ')</h3>' + html + '</div>';

    // Track rendered attempts
    this._renderedAttempts.clear();
    for (const att of sorted) {
      this._renderedAttempts.set(att.attemptNumber, att.status);
    }

    // Wire up click handlers for expand/collapse
    container.querySelectorAll('.attempt-header').forEach(header => {
      // Mark as controlled by this webview control so the delegated
      // handler in eventHandlers.ts skips it (prevents double-toggle)
      (header as any).__attemptControlled = true;
      header.addEventListener('click', (e) => {
        e.stopPropagation();  // Prevent delegated handler double-toggle
        const card = header.closest('.attempt-card') as HTMLElement | null;
        if (!card) return;
        const num = parseInt(card.getAttribute('data-attempt') || '0', 10);
        const body = card.querySelector('.attempt-body') as HTMLElement | null;
        const isExpanded = header.getAttribute('data-expanded') === 'true';
        if (body) body.style.display = isExpanded ? 'none' : 'block';
        header.setAttribute('data-expanded', isExpanded ? 'false' : 'true');
        card.setAttribute('data-expanded', isExpanded ? 'false' : 'true');
        const tag = 'log-attempt-' + num;
        if (isExpanded) {
          // Collapsing — unsubscribe from log updates, free buffer
          this.expandedAttempts.delete(num);
          this.logBuffers.delete(tag);
          vscode.postMessage({ type: 'unsubscribeLog', tag: tag });
        } else {
          // Expanding — subscribe to log updates
          this.expandedAttempts.add(num);
          vscode.postMessage({ type: 'subscribeLog', attemptNumber: num, tag: tag });
        }
      });
    });

    // Wire up attempt phase tab clicks — purely client-side filtering, no re-render
    container.querySelectorAll('.attempt-phase-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent bubbling that could trigger other handlers
        e.preventDefault();
        const btn = e.currentTarget as HTMLElement;
        const phase = btn.getAttribute('data-phase');
        if (!phase) return;
        // Update active tab styling
        const tabBar = btn.closest('.attempt-phase-tabs');
        if (tabBar) tabBar.querySelectorAll('.attempt-phase-tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        // Track active phase for live filtering on appends
        this.activePhase = phase;
        this.userSelectedPhase = (phase !== 'all');
        // Find the log viewer in this attempt card
        const card = btn.closest('.attempt-card');
        if (!card) return;
        const viewer = card.querySelector('.attempt-live-log') as HTMLElement | null;
        if (!viewer) return;
        const tag = viewer.getAttribute('data-log-tag') || '';
        // Use per-attempt log buffer — purely client-side, no extension host calls
        const logText = this.logBuffers.get(tag) || viewer.textContent || '';
        if (phase === 'all') {
          viewer.textContent = logText;
        } else {
          viewer.textContent = this.extractPhaseFromText(logText, phase) || '(no logs for this phase yet)';
        }
      });
    });

    // Wire up Ctrl-A on log viewers to select only log content, not entire page
    // Also wire scroll listener to resume auto-advance when user scrolls back to bottom
    container.querySelectorAll('.attempt-live-log').forEach(logEl => {
      logEl.setAttribute('tabindex', '0'); // Make focusable
      logEl.addEventListener('keydown', (e: Event) => {
        const ke = e as KeyboardEvent;
        if ((ke.ctrlKey || ke.metaKey) && ke.key === 'a') {
          ke.preventDefault();
          ke.stopPropagation();
          const range = document.createRange();
          range.selectNodeContents(logEl);
          const sel = window.getSelection();
          if (sel) {
            sel.removeAllRanges();
            sel.addRange(range);
          }
        }
      });
      // When user scrolls back to bottom with no selection, resume auto-advance
      logEl.addEventListener('scroll', () => {
        const el = logEl as HTMLElement;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
        const sel = window.getSelection();
        const hasSelection = sel && !sel.isCollapsed && logEl.contains(sel.anchorNode);
        if (atBottom && !hasSelection && this.userSelectedPhase) {
          // User returned to bottom — resume auto-advance
          this.userSelectedPhase = false;
        }
      });
    });

    // Wire up checkpoint sub-job link clicks — navigate to sub-job node detail
    container.querySelectorAll('.cp-subjob-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const el = e.currentTarget as HTMLElement;
        const nodeId = el.getAttribute('data-node-id');
        const planId = el.getAttribute('data-plan-id');
        if (nodeId && planId) {
          vscode.postMessage({ type: 'openNode', planId, nodeId });
        }
      });
    });

    // Wire up manifest expand/collapse toggles
    container.querySelectorAll('.cp-manifest-toggle').forEach(toggle => {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const el = e.currentTarget as HTMLElement;
        const targetId = el.getAttribute('data-target');
        if (!targetId) return;
        const content = document.getElementById(targetId);
        if (!content) return;
        const isHidden = content.style.display === 'none';
        content.style.display = isHidden ? 'block' : 'none';
        el.textContent = isHidden ? '\uD83D\uDCCB Manifest \u25BE' : '\uD83D\uDCCB Manifest \u25B8';
      });
    });

    // Re-subscribe and restore content for all expanded attempts.
    // Always re-subscribe even if buffer exists — the DOM was just replaced,
    // so the extension host needs to know we still want data.
    for (const attemptNumber of this.expandedAttempts) {
      const tag = 'log-attempt-' + attemptNumber;
      vscode.postMessage({ type: 'subscribeLog', attemptNumber: attemptNumber, tag: tag });
      // Restore log viewer content from buffer if we have cached data
      const buffered = this.logBuffers.get(tag);
      if (buffered) {
        const viewer = container.querySelector('[data-log-tag="' + tag + '"]') as HTMLPreElement | null;
        if (viewer) {
          if (this.activePhase === 'all') {
            viewer.textContent = buffered;
          } else {
            viewer.textContent = this.extractPhaseFromText(buffered, this.activePhase) || '(no logs for this phase yet)';
          }
        }
      }
    }
  }

  /**
   * Differential update — update individual DOM elements within an existing attempt card
   * without rebuilding the entire HTML. This preserves live controls (context pressure,
   * log viewers, checkpoint sub-job badges) and prevents DOM destruction.
   */
  private _differentialUpdate(att: AttemptCardData): void {
    const card = document.querySelector('.attempt-card[data-attempt="' + att.attemptNumber + '"]') as HTMLElement | null;
    if (!card) return;

    const prev = this._lastAttemptData.get(att.attemptNumber);

    // ── Header: status icon + color ──
    if (!prev || prev.status !== att.status) {
      const statusColor = att.status === 'succeeded' ? '#4ec9b0'
        : att.status === 'failed' ? '#f48771'
        : att.status === 'running' ? '#3794ff' : '#858585';
      const statusIcon = att.status === 'succeeded' ? '\u2713'
        : att.status === 'failed' ? '\u2717'
        : att.status === 'running' ? '\u25B6' : '\u2298';
      card.style.borderLeftColor = statusColor;
      const iconEl = card.querySelector('.attempt-status-icon') as HTMLElement;
      if (iconEl) { iconEl.style.color = statusColor; iconEl.textContent = statusIcon; }
      this._renderedAttempts.set(att.attemptNumber, att.status);
    }

    // ── Header: duration ──
    const durEl = card.querySelector('.attempt-duration') as HTMLElement;
    if (durEl && att.startedAt) {
      if (att.status === 'running') {
        durEl.textContent = formatDuration(Math.round((Date.now() - att.startedAt) / 1000)) + '\u2026';
        if (!durEl.dataset.started) { durEl.dataset.started = String(att.startedAt); }
      } else if (att.endedAt) {
        durEl.textContent = formatDuration(Math.round((att.endedAt - att.startedAt) / 1000));
        durEl.removeAttribute('data-started');
      }
    }

    // ── Header: step status indicators ──
    if (att.stepStatuses) {
      const indicators = card.querySelector('.step-indicators');
      if (indicators) {
        const phases = ['merge-fi', 'prechecks', 'work', 'commit', 'postchecks', 'merge-ri'];
        const icons = indicators.querySelectorAll('.step-icon');
        phases.forEach((p, i) => {
          if (icons[i]) {
            const s = att.stepStatuses![p];
            const icon = s === 'success' || s === 'succeeded' ? '\u2713'
              : s === 'failed' ? '\u2717'
              : s === 'running' ? '\u27F3'
              : s === 'skipped' ? '\u2298' : '\u2022';
            const cls = s === 'success' || s === 'succeeded' ? 'success'
              : s === 'failed' ? 'failed'
              : s === 'running' ? 'running'
              : s === 'skipped' ? 'skipped' : 'pending';
            icons[i].className = 'step-icon ' + cls;
            icons[i].textContent = icon;
          }
        });
      }
    }

    // ── Phase tabs: update status classes ──
    if (att.stepStatuses) {
      const tabContainer = card.querySelector('.attempt-phase-tabs');
      if (tabContainer) {
        tabContainer.querySelectorAll('.attempt-phase-tab').forEach(tab => {
          const phase = tab.getAttribute('data-phase');
          if (!phase || phase === 'all') return;
          const pStatus = att.stepStatuses![phase] || '';
          tab.classList.remove('success', 'failed', 'skipped', 'running');
          if (pStatus === 'success' || pStatus === 'succeeded') tab.classList.add('success');
          else if (pStatus === 'failed') tab.classList.add('failed');
          else if (pStatus === 'skipped') tab.classList.add('skipped');
          else if (pStatus === 'running') tab.classList.add('running');
        });
      }
    }

    // ── Error section: insert if error appeared ──
    if (att.error && (!prev || !prev.error)) {
      const body = card.querySelector('.attempt-body') as HTMLElement;
      if (body) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'attempt-section attempt-error-section';
        errorDiv.innerHTML = '<div class="attempt-section-title">\u274C Error</div>'
          + '<div class="attempt-error-body">'
          + '<div class="attempt-error-msg">' + escapeHtml(att.error) + '</div>'
          + (att.failedPhase ? '<div class="attempt-error-detail">Failed in phase: <strong>' + escapeHtml(att.failedPhase) + '</strong></div>' : '')
          + (att.exitCode !== undefined ? '<div class="attempt-error-detail">Exit code: <strong>' + att.exitCode + '</strong></div>' : '')
          + '</div>';
        body.insertBefore(errorDiv, body.firstChild);
      }
    }

    // ── Metrics section: update if metrics arrived ──
    if (att.metricsHtml && (!prev || !prev.metricsHtml)) {
      let metricsSection = card.querySelector('.attempt-section .attempt-section-title');
      // Find existing metrics section or create one
      let found = false;
      card.querySelectorAll('.attempt-section-title').forEach(t => {
        if (t.textContent?.includes('AI Usage')) { found = true; }
      });
      if (!found) {
        const body = card.querySelector('.attempt-body') as HTMLElement;
        if (body) {
          const metricsDiv = document.createElement('div');
          metricsDiv.className = 'attempt-section';
          metricsDiv.innerHTML = '<div class="attempt-section-title">\uD83D\uDCCA AI Usage</div>' + att.metricsHtml;
          // Insert after error section (if exists) or at top of body
          const errorSection = body.querySelector('.attempt-error-section');
          if (errorSection && errorSection.nextSibling) {
            body.insertBefore(metricsDiv, errorSection.nextSibling);
          } else {
            body.insertBefore(metricsDiv, body.firstChild);
          }
        }
      }
    }

    // ── Running placeholder: remove when body content appears ──
    const runningIndicator = card.querySelector('.attempt-running-indicator');
    if (runningIndicator && att.status !== 'running') {
      const section = runningIndicator.closest('.attempt-section');
      if (section) section.remove();
    }
  }

  /** Render the post-split checkpoint summary section. */
  private renderCheckpointSection(cp: CheckpointData): string {
    const pressurePct = Math.round(cp.pressure);

    // Sub-job list with status icons and clickable links
    const subJobListItems = cp.subJobs.map((sj, idx) => {
      const total = cp.subJobs.length;
      const connector = idx < total - 1 ? '\u251C\u2500' : '\u2514\u2500'; // ├─ or └─
      const statusIcon = sj.status === 'succeeded' ? '\u2713' // ✓
        : sj.status === 'failed' ? '\u2717'                   // ✗
        : sj.status === 'running' ? '\u27F3'                  // ⟳
        : '\u25CB';                                            // ○ (pending/ready)
      const statusCls = sj.status === 'succeeded' ? 'success'
        : sj.status === 'failed' ? 'failed'
        : sj.status === 'running' ? 'running'
        : 'pending';
      return '<div class="cp-subjob-row">'
        + '<span class="cp-connector">' + connector + ' </span>'
        + '<span class="step-icon ' + statusCls + '">' + statusIcon + '</span> '
        + '<a class="cp-subjob-link" data-node-id="' + escapeHtml(sj.nodeId) + '" '
        + 'data-plan-id="' + escapeHtml(cp.planId) + '" '
        + 'title="Open sub-job details">'
        + escapeHtml(sj.name) + ' (' + (idx + 1) + '/' + total + ')'
        + '</a>'
        + '</div>';
    }).join('');

    // Manifest expander
    let manifestHtml = '';
    if (cp.manifestJson) {
      const manifestId = 'cp-manifest-' + Date.now();
      manifestHtml = '<div class="cp-manifest-section">'
        + '<div class="cp-manifest-toggle" data-target="' + manifestId + '">'
        + '\uD83D\uDCCB Manifest \u25B8'
        + '</div>'
        + '<pre class="cp-manifest-content" id="' + manifestId + '" style="display:none;">'
        + escapeHtml(cp.manifestJson)
        + '</pre>'
        + '</div>';
    }

    // Tokens consumed / max line (shown when backend provides token data)
    const tokensLine = (cp.tokensConsumed !== undefined && cp.maxTokens)
      ? '<div class="cp-stat">Tokens consumed: <strong>'
        + cp.tokensConsumed.toLocaleString() + ' / ' + cp.maxTokens.toLocaleString()
        + '</strong></div>'
      : '';

    return '<div class="attempt-section cp-checkpoint-section">'
      + '<div class="attempt-section-title">\uD83E\uDDE0 Context Pressure \u2014 Checkpointed</div>'
      + '<div class="cp-summary">'
      + '<div class="cp-stat">Pressure at checkpoint: <strong>' + pressurePct + '%</strong></div>'
      + tokensLine
      + '<div class="cp-stat">Split into: <strong>' + cp.subJobCount + ' sub-jobs</strong></div>'
      + '</div>'
      + '<div class="cp-subjob-list">' + subJobListItems + '</div>'
      + manifestHtml
      + '</div>';
  }

  /** Render a single attempt card. */
  private renderCard(att: AttemptCardData): string {
    const isRunning = att.status === 'running';
    const duration = att.startedAt
      ? (isRunning
        ? formatDuration(Math.round((Date.now() - att.startedAt) / 1000)) + '\u2026'
        : formatDuration(Math.round(((att.endedAt || Date.now()) - att.startedAt) / 1000)))
      : '--';
    const timestamp = att.startedAt ? new Date(att.startedAt).toLocaleString() : '';

    const statusColor = att.status === 'succeeded' ? '#4ec9b0'
      : att.status === 'failed' ? '#f48771'
      : att.status === 'running' ? '#3794ff'
      : '#858585';
    const statusIcon = att.status === 'succeeded' ? '\u2713'
      : att.status === 'failed' ? '\u2717'
      : att.status === 'running' ? '\u25B6'
      : '\u2298';

    const triggerLabel = att.triggerType === 'auto-heal' ? '\uD83D\uDD27 Auto-Heal'
      : att.triggerType === 'retry' ? '\uD83D\uDD04 Retry'
      : att.triggerType === 'postchecks-revalidation' ? '\uD83D\uDD0D Re-validation'
      : '';
    const triggerBadge = triggerLabel ? '<span class="attempt-trigger-badge">' + triggerLabel + '</span>' : '';

    const ss = att.stepStatuses || {};
    const stepIndicators = '<span class="step-indicators">'
      + stepIconHtml(ss['merge-fi'])
      + stepIconHtml(ss['prechecks'])
      + stepIconHtml(ss['work'])
      + stepIconHtml(ss['commit'])
      + stepIconHtml(ss['postchecks'])
      + stepIconHtml(ss['merge-ri'])
      + '</span>';

    const expanded = this.expandedAttempts.has(att.attemptNumber);
    const bodyDisplay = expanded ? 'block' : 'none';

    // ── Error section ──
    const errorHtml = att.error
      ? '<div class="attempt-section attempt-error-section">'
        + '<div class="attempt-section-title">\u274C Error</div>'
        + '<div class="attempt-error-body">'
        + '<div class="attempt-error-msg">' + escapeHtml(att.error) + '</div>'
        + (att.failedPhase ? '<div class="attempt-error-detail">Failed in phase: <strong>' + escapeHtml(att.failedPhase) + '</strong></div>' : '')
        + (att.exitCode !== undefined ? '<div class="attempt-error-detail">Exit code: <strong>' + att.exitCode + '</strong></div>' : '')
        + '</div></div>'
      : '';

    // ── Metrics section ──
    // For running attempts, include contextPressureContainer inside the AI Usage section.
    // The differential update architecture prevents unnecessary rebuilds, so this survives.
    // For completed attempts, render the persisted snapshot inline.
    const isRunningAttempt = att.status === 'running';
    const cpContainerHtml = isRunningAttempt ? '<div id="contextPressureContainer" style="display:none;"></div>' : '';
    let snapshotHtml = '';
    if (!isRunningAttempt && att.contextPressureSnapshot && att.contextPressureSnapshot.currentInputTokens > 0) {
      const snap = att.contextPressureSnapshot;
      const maxTk = snap.maxPromptTokens || 136000;
      const pct = Math.round((snap.currentInputTokens / maxTk) * 100);
      const fmtTk = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
      const levelIcon = snap.level === 'critical' ? '🔴' : snap.level === 'elevated' ? '⚠' : '✅';
      const levelCap = snap.level.charAt(0).toUpperCase() + snap.level.slice(1);
      let modelRows = '';
      if (snap.modelBreakdown && snap.modelBreakdown.length > 0) {
        const rows = snap.modelBreakdown.map(m => {
          const cached = m.cachedTokens ? ', ' + fmtTk(m.cachedTokens) + ' cached' : '';
          return '<div class="model-row"><span class="model-name">' + escapeHtml(m.model) + '</span> ' + fmtTk(m.inputTokens) + ' in, ' + fmtTk(m.outputTokens) + ' out' + cached + ' (' + m.turns + ' turns)</div>';
        }).join('');
        const tpm = snap.turnsPerSecond ? ' · ' + snap.turnsPerSecond.toFixed(1) + ' turns/min' : '';
        modelRows = '<div class="context-pressure-models"><div class="model-breakdown-label">Model Usage (' + (snap.totalTurns || 0) + ' turns' + tpm + '):</div><div class="model-breakdown">' + rows + '</div></div>';
      }
      snapshotHtml = '<div class="context-pressure-section">'
        + '<div class="context-pressure-label">🧠 Context Window (final)</div>'
        + '<div class="context-pressure-bar-container"><div class="context-pressure-bar context-pressure-' + snap.level + '" style="width:' + Math.min(pct, 100) + '%;background:' + (snap.level === 'critical' ? 'var(--vscode-charts-red)' : snap.level === 'elevated' ? 'var(--vscode-charts-yellow)' : 'var(--vscode-charts-green)') + '"></div></div>'
        + '<div class="context-pressure-stats">' + pct + '% of ' + fmtTk(maxTk) + '</div>'
        + '<div class="context-pressure-status context-pressure-' + snap.level + '">Final status: ' + levelIcon + ' ' + levelCap + (snap.compactionDetected ? ' · Compaction detected' : '') + '</div>'
        + modelRows
        + '</div>';
    }
    const metricsHtml = (att.metricsHtml || snapshotHtml || cpContainerHtml)
      ? '<div class="attempt-section"><div class="attempt-section-title">\uD83D\uDCCA AI Usage</div>' + (att.metricsHtml || '') + snapshotHtml + cpContainerHtml + '</div>'
      : '';

    // ── Context pressure checkpoint section (post-split view) ──
    const checkpointHtml = att.contextPressureCheckpoint
      ? this.renderCheckpointSection(att.contextPressureCheckpoint)
      : '';

    // ── Context section ──
    const ctxItems: string[] = [];
    if (att.baseCommit) {
      ctxItems.push('<div class="attempt-ctx-row"><span class="attempt-ctx-label">Base</span><code class="attempt-ctx-value">' + att.baseCommit.slice(0, 8) + '</code></div>');
    }
    if (att.worktreePath) {
      ctxItems.push('<div class="attempt-ctx-row"><span class="attempt-ctx-label">Worktree</span><code class="attempt-ctx-value">' + escapeHtml(att.worktreePath) + '</code></div>');
    }
    if (att.logFilePath) {
      ctxItems.push('<div class="attempt-ctx-row"><span class="attempt-ctx-label">Log</span><span class="log-file-path attempt-ctx-value" data-path="' + escapeHtml(att.logFilePath) + '" title="' + escapeHtml(att.logFilePath) + '">\uD83D\uDCC4 ' + escapeHtml(truncateLogPath(att.logFilePath)) + '</span></div>');
    }
    if (att.copilotSessionId) {
      ctxItems.push('<div class="attempt-ctx-row"><span class="attempt-ctx-label">Session</span><span class="session-id attempt-ctx-value" data-session="' + escapeHtml(att.copilotSessionId) + '" title="Click to copy">' + escapeHtml(att.copilotSessionId.substring(0, 12)) + '\u2026 \uD83D\uDCCB</span></div>');
    }
    // Plan-level inherited env vars
    if (this.planEnvHtml) {
      ctxItems.push('<div class="attempt-ctx-row attempt-ctx-env"><span class="attempt-ctx-label">Plan Env</span><div class="attempt-ctx-value">' + this.planEnvHtml + '</div></div>');
    }
    const contextHtml = ctxItems.length > 0
      ? '<div class="attempt-section"><div class="attempt-section-title">\uD83D\uDD17 Context</div><div class="attempt-ctx-grid">' + ctxItems.join('') + '</div></div>'
      : '';

    // ── Specs sections ──
    const prechecksHtml = att.prechecksUsedHtml
      ? '<div class="attempt-section"><div class="attempt-section-title">\uD83D\uDD0D Prechecks</div>' + att.prechecksUsedHtml + '</div>'
      : '';
    const workHtml = att.workUsedHtml
      ? '<div class="attempt-section"><div class="attempt-section-title">\uD83D\uDCDD Work Spec</div>' + att.workUsedHtml + '</div>'
      : '';
    const postchecksHtml = att.postchecksUsedHtml
      ? '<div class="attempt-section"><div class="attempt-section-title">\u2705 Postchecks</div>' + att.postchecksUsedHtml + '</div>'
      : '';

    // ── Unified log section — one container for both live streaming and static logs ──
    const phases = ['all', 'merge-fi', 'prechecks', 'work', 'commit', 'postchecks', 'merge-ri'];
    const phaseLabels: Record<string, string> = {
      'all': '\uD83D\uDCC4 Full Log',
      'merge-fi': '\u21D9\u21D8 Merge FI',
      'prechecks': '\u2713 Prechecks',
      'work': '\u2699 Work',
      'commit': '\uD83D\uDCBE Commit',
      'postchecks': '\u2713 Postchecks',
      'merge-ri': '\u2197\u2199 Merge RI',
    };
    let initialLogContent = '';
    if (att.logs) {
      initialLogContent = escapeHtml(att.logs);
    }
    const ss2 = att.stepStatuses || {};
    const tabsHtml = phases.map(p => {
      const pStatus = p === 'all' ? '' : (ss2[p] || '');
      const statusCls = pStatus === 'success' || pStatus === 'succeeded' ? ' success'
        : pStatus === 'failed' ? ' failed'
        : pStatus === 'skipped' ? ' skipped'
        : '';
      return '<button class="attempt-phase-tab' + (p === 'all' ? ' active' : '') + statusCls + '" data-phase="' + p + '" data-attempt="' + att.attemptNumber + '">'
        + (phaseLabels[p] || p) + '</button>';
    }).join('');

    const logSection = '<div class="attempt-section"><div class="attempt-section-title">\uD83D\uDCCB Logs</div>'
      + '<div class="attempt-phases" data-attempt="' + att.attemptNumber + '">'
      + '<div class="attempt-phase-tabs">' + tabsHtml + '</div>'
      + '<pre class="attempt-live-log" data-attempt="' + att.attemptNumber + '" data-log-tag="log-attempt-' + att.attemptNumber + '" '
      + 'tabindex="0" data-selectable="true" '
      + 'style="max-height:500px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;'
      + 'font-size:12px;line-height:1.4;background:var(--vscode-editor-background);'
      + 'padding:8px;border-radius:4px;user-select:text;-webkit-user-select:text;">'
      + initialLogContent + '</pre>'
      + '</div></div>';

    // ── Running placeholder ──
    const hasBodyContent = errorHtml || metricsHtml || checkpointHtml || ctxItems.length > 0 || prechecksHtml || workHtml || postchecksHtml;
    const runningPlaceholder = (!hasBodyContent && isRunning)
      ? '<div class="attempt-section"><div class="attempt-running-indicator">\u27F3 Executing\u2026</div></div>'
      : '';

    return '<div class="attempt-card" data-attempt="' + att.attemptNumber + '" data-expanded="' + expanded + '" style="border-left: 3px solid ' + statusColor + ';">'
      + '<div class="attempt-header" data-expanded="' + expanded + '">'
      + '<div class="attempt-header-left">'
      + '<span class="attempt-status-icon" style="color:' + statusColor + ';">' + statusIcon + '</span>'
      + '<span class="attempt-badge">#' + att.attemptNumber + '</span>'
      + triggerBadge
      + stepIndicators
      + '</div>'
      + '<div class="attempt-header-right">'
      + '<span class="attempt-time">' + timestamp + '</span>'
      + '<span class="attempt-duration"' + (isRunning && att.startedAt ? ' data-started="' + att.startedAt + '"' : '') + '>' + duration + '</span>'
      + '<span class="attempt-chevron">\u203A</span>'
      + '</div>'
      + '</div>'
      + '<div class="attempt-body" style="display:' + bodyDisplay + ';">'
      + runningPlaceholder + errorHtml + metricsHtml + checkpointHtml + contextHtml + prechecksHtml + workHtml + postchecksHtml + logSection
      + '</div>'
      + '</div>';
  }

  // Legacy methods for compatibility
  update(data?: AttemptCardData): void {
    // No-op — rebuild() handles all updates now
  }

  expand(): void {
    // No-op — managed by rebuild click handlers
  }

  collapse(): void {
    // No-op — managed by rebuild click handlers
  }

  toggle(): void {
    // No-op — managed by rebuild click handlers
  }

  isExpanded(): boolean {
    return false;
  }
}
