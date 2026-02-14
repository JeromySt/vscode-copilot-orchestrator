/**
 * @fileoverview Process tree control — displays running process hierarchy.
 *
 * Subscribes to {@link Topics.PROCESS_STATS} and incrementally updates
 * the process tree DOM rows.
 *
 * @module ui/webview/controls/processTree
 */

import { EventBus } from '../eventBus';
import { SubscribableControl } from '../subscribableControl';
import { Topics } from '../topics';
import { escapeHtml, formatDurationMs } from '../../templates/helpers';

/** Single process node in the tree. */
export interface ProcessNode {
  pid: number;
  name: string;
  cpu?: number;
  memory?: number;
  commandLine?: string;
  children?: ProcessNode[];
}

/** Data delivered with each update. */
export interface ProcessTreeData {
  pid?: number;
  running: boolean;
  tree?: ProcessNode[];
  isAgentWork?: boolean;
  duration?: number;
}





function countProcesses(nodes: ProcessNode[]): { count: number; cpu: number; memory: number } {
  let count = 0, cpu = 0, memory = 0;
  for (const node of nodes) {
    count++;
    cpu += node.cpu || 0;
    memory += node.memory || 0;
    if (node.children) {
      const child = countProcesses(node.children);
      count += child.count;
      cpu += child.cpu;
      memory += child.memory;
    }
  }
  return { count, cpu, memory };
}

function renderNode(proc: ProcessNode, depth: number): string {
  const memMB = ((proc.memory || 0) / 1024 / 1024).toFixed(1);
  const cpuPct = (proc.cpu || 0).toFixed(0);
  const indent = depth * 16;
  const arrow = depth > 0 ? '↳ ' : '';
  let html = `<div class="process-node" style="margin-left:${indent}px;">`;
  html += `<span class="process-node-name">${arrow}${escapeHtml(proc.name)}</span>`;
  html += `<span class="process-node-pid">PID ${proc.pid}</span>`;
  html += `<span class="process-stat">CPU:${cpuPct}% Mem:${memMB}MB</span>`;
  html += '</div>';
  if (proc.children) {
    for (const child of proc.children) {
      html += renderNode(child, depth + 1);
    }
  }
  return html;
}

/**
 * Process tree control that renders running process hierarchies.
 */
export class ProcessTree extends SubscribableControl {
  private treeElementId: string;
  private titleElementId: string;

  constructor(bus: EventBus, controlId: string, treeElementId: string, titleElementId: string) {
    super(bus, controlId);
    this.treeElementId = treeElementId;
    this.titleElementId = titleElementId;
    this.subscribe(Topics.PROCESS_STATS, (data?: ProcessTreeData) => this.update(data));
  }

  update(data?: ProcessTreeData): void {
    if (!data) { return; }
    const treeEl = this.getElement(this.treeElementId);
    const titleEl = this.getElement(this.titleElementId);
    if (!treeEl) { return; }

    if (data.isAgentWork && !data.pid && data.running) {
      const dur = data.duration ? ` (${formatDurationMs(data.duration)})` : '';
      treeEl.innerHTML = `<div class="agent-work-indicator">🤖 Agent starting...${dur}</div>`;
      if (titleEl) { titleEl.textContent = 'Agent Work (starting)'; }
      this.publishUpdate(data);
      return;
    }

    if (!data.pid || !data.running) {
      treeEl.innerHTML = '<div class="process-loading">No active process</div>';
      if (titleEl) { titleEl.textContent = 'Processes'; }
      this.publishUpdate(data);
      return;
    }

    const tree = data.tree || [];
    if (tree.length === 0) {
      treeEl.innerHTML = `<div class="process-loading">Process running (PID ${data.pid})</div>`;
      if (titleEl) { titleEl.textContent = `Processes PID ${data.pid}`; }
      this.publishUpdate(data);
      return;
    }

    const totals = countProcesses(tree);
    const memMB = (totals.memory / 1024 / 1024).toFixed(1);
    if (titleEl) {
      titleEl.textContent = `Processes (${totals.count} • ${totals.cpu.toFixed(0)}% CPU • ${memMB} MB)`;
    }

    treeEl.innerHTML = tree.map(p => renderNode(p, 0)).join('');
    this.publishUpdate(data);
  }
}
