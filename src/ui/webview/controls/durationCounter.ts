/**
 * @fileoverview Duration counter control — displays formatted elapsed time.
 *
 * Subscribes to {@link Topics.PULSE} while the node is running and
 * updates its DOM element with a formatted duration string.
 *
 * @module ui/webview/controls/durationCounter
 */

import { EventBus, Subscription } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';

/**
 * Format milliseconds into a human-readable duration string.
 *
 * @param ms - Elapsed time in milliseconds.
 * @returns Formatted string such as `"1m 30s"` or `"2h 5m"`.
 */
export function formatElapsed(ms: number): string {
  if (ms < 0) { return '0s'; }
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const parts: string[] = [];
  if (hours > 0) { parts.push(`${hours}h`); }
  if (minutes > 0) { parts.push(`${minutes}m`); }
  if (seconds > 0 || parts.length === 0) { parts.push(`${seconds}s`); }
  return parts.join(' ');
}

/** Data delivered with each update. */
export interface DurationData {
  /** Epoch ms when the timer started, or `undefined` to stop. */
  startedAt?: number;
  /** Whether the associated entity is running. */
  running: boolean;
}

/**
 * Live duration counter that ticks on each PULSE while running.
 */
export class DurationCounter extends SubscribableControl {
  private elementId: string;
  private startedAt: number | undefined;
  private running = false;
  private pulseSub: Subscription | null = null;

  constructor(bus: EventBus, controlId: string, elementId: string) {
    super(bus, controlId);
    this.elementId = elementId;
  }

  /** Receive new running state and start/stop pulse subscription. */
  update(data?: DurationData): void {
    if (!data) { return; }
    this.startedAt = data.startedAt;
    this.running = data.running;

    if (this.running && !this.pulseSub) {
      this.pulseSub = this.subscribe(Topics.PULSE, () => this.tick());
    } else if (!this.running && this.pulseSub) {
      this.pulseSub.unsubscribe();
      this.pulseSub = null;
    }
    this.tick();
  }

  private tick(): void {
    const el = this.getElement(this.elementId);
    if (!el) { return; }
    if (!this.startedAt) {
      el.textContent = '--';
    } else {
      const elapsed = Date.now() - this.startedAt;
      el.textContent = formatElapsed(elapsed);
    }
    this.publishUpdate();
  }

  dispose(): void {
    if (this.pulseSub) {
      this.pulseSub.unsubscribe();
      this.pulseSub = null;
    }
    super.dispose();
  }
}
