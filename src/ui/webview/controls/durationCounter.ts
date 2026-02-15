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
import { formatDurationMs } from '../../templates/helpers';



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
      el.textContent = formatDurationMs(elapsed);
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
