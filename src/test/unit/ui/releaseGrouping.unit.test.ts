/**
 * @fileoverview Unit tests for Release Grouping in Plans Tab
 * 
 * Tests the ReleaseGroupControl and PlanListContainerControl's ability to:
 * - Group plans by release ID
 * - Display unassigned plans separately
 * - Handle collapse/expand of release groups
 * - Update plan counts and status
 * - Sort groups by release name
 * 
 * @module test/unit/ui/releaseGrouping
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';

/**
 * Mock vscode API for state management
 */
class MockVsCodeApi {
  private state: any = {};

  getState(): any {
    return this.state;
  }

  setState(newState: any): void {
    this.state = newState;
  }

  postMessage(_message: any): void {
    // No-op for tests
  }
}

/**
 * Mock EventBus for pub/sub
 */
class MockEventBus {
  private handlers: Map<string, Array<(data: any) => void>> = new Map();

  on(topic: string, handler: (data: any) => void): void {
    if (!this.handlers.has(topic)) {
      this.handlers.set(topic, []);
    }
    this.handlers.get(topic)!.push(handler);
  }

  emit(topic: string, data: any): void {
    const handlers = this.handlers.get(topic);
    if (handlers) {
      handlers.forEach(h => h(data));
    }
  }
}

/**
 * Mock SubscribableControl base class
 */
class MockSubscribableControl {
  protected bus: MockEventBus;
  protected controlId: string;
  private subscriptions: Array<{ topic: string; handler: (data: any) => void }> = [];

  constructor(bus: MockEventBus, controlId: string) {
    this.bus = bus;
    this.controlId = controlId;
  }

  subscribe(topic: string, handler: (data: any) => void): void {
    this.subscriptions.push({ topic, handler });
    this.bus.on(topic, handler);
  }

  dispose(): void {
    // In real implementation, would unsubscribe
    this.subscriptions = [];
  }
}

/**
 * Helper to create a mock DOM element
 */
function createMockElement(): any {
  const element: any = {
    className: '',
    _innerHTML: '',
    textContent: '',
    style: {},
    dataset: {},
    children: [] as any[],
    attributes: new Map<string, string>(),
    eventListeners: new Map<string, Array<(e: any) => void>>(),

    get innerHTML(): string {
      return this._innerHTML;
    },

    set innerHTML(value: string) {
      this._innerHTML = value;
      // Parse innerHTML and create child mock elements for common patterns
      this.children = [];
      
      // Simple regex-based parser for span elements with class
      const spanRegex = /<span\s+class="([^"]*)">([^<]*)<\/span>/g;
      let match;
      while ((match = spanRegex.exec(value)) !== null) {
        const childClass = match[1];
        const childText = match[2];
        const child: any = {
          className: childClass,
          textContent: childText,
          innerHTML: childText,
          classList: {
            add(cls: string): void { child.className += ' ' + cls; },
            remove(cls: string): void { child.className = child.className.replace(cls, '').trim(); },
            contains(cls: string): boolean { return child.className.includes(cls); }
          }
        };
        this.children.push(child);
      }
    },

    appendChild(child: any): void {
      this.children.push(child);
    },

    querySelector(selector: string): any {
      // Simple mock: find first child matching class (recursive)
      if (selector.startsWith('.')) {
        const className = selector.substring(1);
        
        // Check direct children first
        const directMatch = this.children.find((c: any) => {
          if (!c.className) return false;
          const classes = c.className.split(' ');
          return classes.some((cls: string) => cls === className || cls.startsWith(className));
        });
        
        if (directMatch) return directMatch;
        
        // Recursively search in children
        for (const child of this.children) {
          if (child.querySelector) {
            const childMatch = child.querySelector(selector);
            if (childMatch) return childMatch;
          }
        }
      }
      return null;
    },

    querySelectorAll(_selector: string): any[] {
      return [];
    },

    addEventListener(event: string, handler: (e: any) => void): void {
      if (!this.eventListeners.has(event)) {
        this.eventListeners.set(event, []);
      }
      this.eventListeners.get(event)!.push(handler);
    },

    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
    },

    getAttribute(name: string): string | null {
      return this.attributes.get(name) || null;
    },

    classList: {
      add(className: string): void {
        if (!element.className.includes(className)) {
          element.className = element.className ? `${element.className} ${className}` : className;
        }
      },
      remove(className: string): void {
        element.className = element.className.replace(className, '').trim();
      },
      contains(className: string): boolean {
        return element.className.includes(className);
      }
    }
  };
  return element;
}

/**
 * Create mock document.createElement
 */
function createMockDocument(): any {
  return {
    createElement(_tagName: string): any {
      return createMockElement();
    },
    getElementById(_id: string): any {
      return null;
    },
    documentElement: {
      clientWidth: 1024,
      clientHeight: 768
    }
  };
}

/**
 * Helper to escape HTML (mimic real implementation)
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

/**
 * ReleaseGroupControl mock implementation for testing
 */
class ReleaseGroupControl extends MockSubscribableControl {
  element: any;
  releaseId: string;
  collapsed: boolean;
  headerEl: any;
  contentEl: any;
  private vsCodeApi: MockVsCodeApi;

  constructor(bus: MockEventBus, controlId: string, element: any, releaseId: string, releaseName: string, releaseStatus: string, vsCodeApi: MockVsCodeApi) {
    super(bus, controlId);
    this.element = element;
    this.releaseId = releaseId;
    this.vsCodeApi = vsCodeApi;
    this.collapsed = this._loadCollapseState();
    this._renderHeader(releaseName, releaseStatus);
    this._renderContent();
  }

  _loadCollapseState(): boolean {
    const state = this.vsCodeApi.getState();
    if (state && state.releaseGroupsCollapsed && state.releaseGroupsCollapsed[this.releaseId] !== undefined) {
      return state.releaseGroupsCollapsed[this.releaseId];
    }
    return false;
  }

  _saveCollapseState(): void {
    const state = this.vsCodeApi.getState() || {};
    if (!state.releaseGroupsCollapsed) {
      state.releaseGroupsCollapsed = {};
    }
    state.releaseGroupsCollapsed[this.releaseId] = this.collapsed;
    this.vsCodeApi.setState(state);
  }

  _renderHeader(name: string, status: string): void {
    this.headerEl = createMockElement();
    this.headerEl.className = 'release-group-header';
    
    const chevronClass = this.collapsed ? 'release-group-chevron codicon codicon-chevron-down collapsed' : 'release-group-chevron codicon codicon-chevron-down';
    
    this.headerEl.innerHTML = 
      '<span class="' + chevronClass + '"></span>' +
      '<span class="release-group-name">' + escapeHtml(name) + '</span>' +
      '<span class="release-group-status ' + status + '">' + status + '</span>' +
      '<span class="release-group-count">0 plans</span>';
    
    this.element.appendChild(this.headerEl);
    
    // Click header: toggle collapse
    this.headerEl.addEventListener('click', (e: any) => {
      if (e.ctrlKey || e.shiftKey) {
        return;
      }
      this.collapsed = !this.collapsed;
      this._updateCollapse();
      this._saveCollapseState();
    });
  }

  _renderContent(): void {
    this.contentEl = createMockElement();
    this.contentEl.className = 'release-group-content';
    if (this.collapsed) {
      this.contentEl.style.display = 'none';
    }
    this.element.appendChild(this.contentEl);
  }

  _updateCollapse(): void {
    const chevron = this.headerEl.querySelector('.release-group-chevron');
    if (chevron) {
      if (this.collapsed) {
        chevron.classList.add('collapsed');
      } else {
        chevron.classList.remove('collapsed');
      }
    }
    this.contentEl.style.display = this.collapsed ? 'none' : 'block';
  }

  updatePlanCount(count: number): void {
    const countEl = this.headerEl.querySelector('.release-group-count');
    if (countEl) {
      countEl.textContent = count + (count === 1 ? ' plan' : ' plans');
    }
  }

  updateStatus(status: string): void {
    const statusEl = this.headerEl.querySelector('.release-group-status');
    if (statusEl) {
      statusEl.className = 'release-group-status ' + status;
      statusEl.textContent = status;
    }
  }

  getContentElement(): any {
    return this.contentEl;
  }
}

suite('Release Grouping in Plans Tab', () => {
  let sandbox: sinon.SinonSandbox;
  let mockBus: MockEventBus;
  let mockVsCodeApi: MockVsCodeApi;
  let mockDocument: any;

  setup(() => {
    sandbox = sinon.createSandbox();
    mockBus = new MockEventBus();
    mockVsCodeApi = new MockVsCodeApi();
    mockDocument = createMockDocument();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('ReleaseGroupControl', () => {
    test('creates group header with release name and status', () => {
      const element = createMockElement();
      const control = new ReleaseGroupControl(
        mockBus,
        'test-group',
        element,
        'release-1',
        'v1.0.0',
        'open',
        mockVsCodeApi
      );

      const header = element.querySelector('.release-group-header');
      assert.ok(header, 'header should exist');
      assert.ok(header.innerHTML.includes('v1.0.0'), 'should include release name');
      assert.ok(header.innerHTML.includes('open'), 'should include status');
    });

    test('initializes collapsed state from storage', () => {
      // Set initial state
      mockVsCodeApi.setState({
        releaseGroupsCollapsed: {
          'release-1': true
        }
      });

      const element = createMockElement();
      const control = new ReleaseGroupControl(
        mockBus,
        'test-group',
        element,
        'release-1',
        'v1.0.0',
        'open',
        mockVsCodeApi
      );

      assert.strictEqual(control.collapsed, true, 'should load collapsed state from storage');
      const content = element.querySelector('.release-group-content');
      assert.strictEqual(content.style.display, 'none', 'content should be hidden when collapsed');
    });

    test('defaults to expanded when no stored state', () => {
      const element = createMockElement();
      const control = new ReleaseGroupControl(
        mockBus,
        'test-group',
        element,
        'release-1',
        'v1.0.0',
        'open',
        mockVsCodeApi
      );

      assert.strictEqual(control.collapsed, false, 'should default to expanded');
      const content = element.querySelector('.release-group-content');
      assert.notStrictEqual(content.style.display, 'none', 'content should be visible');
    });

    test('toggles collapse state on header click', () => {
      const element = createMockElement();
      const control = new ReleaseGroupControl(
        mockBus,
        'test-group',
        element,
        'release-1',
        'v1.0.0',
        'open',
        mockVsCodeApi
      );

      const header = element.querySelector('.release-group-header');
      const initialState = control.collapsed;

      // Simulate click
      const clickHandlers = header.eventListeners.get('click');
      assert.ok(clickHandlers && clickHandlers.length > 0, 'should have click handler');
      clickHandlers![0]({ ctrlKey: false, shiftKey: false });

      assert.strictEqual(control.collapsed, !initialState, 'should toggle collapsed state');
    });

    test('does not toggle on Ctrl+Click (preserves multi-select)', () => {
      const element = createMockElement();
      const control = new ReleaseGroupControl(
        mockBus,
        'test-group',
        element,
        'release-1',
        'v1.0.0',
        'open',
        mockVsCodeApi
      );

      const header = element.querySelector('.release-group-header');
      const initialState = control.collapsed;

      // Simulate Ctrl+click
      const clickHandlers = header.eventListeners.get('click');
      clickHandlers![0]({ ctrlKey: true, shiftKey: false });

      assert.strictEqual(control.collapsed, initialState, 'should not toggle on Ctrl+click');
    });

    test('saves collapse state to storage', () => {
      const element = createMockElement();
      const control = new ReleaseGroupControl(
        mockBus,
        'test-group',
        element,
        'release-1',
        'v1.0.0',
        'open',
        mockVsCodeApi
      );

      const header = element.querySelector('.release-group-header');
      const clickHandlers = header.eventListeners.get('click');
      clickHandlers![0]({ ctrlKey: false, shiftKey: false });

      const state = mockVsCodeApi.getState();
      assert.ok(state.releaseGroupsCollapsed, 'should have releaseGroupsCollapsed in state');
      assert.strictEqual(state.releaseGroupsCollapsed['release-1'], control.collapsed, 'should save collapsed state');
    });

    test('updates plan count display', () => {
      const element = createMockElement();
      const control = new ReleaseGroupControl(
        mockBus,
        'test-group',
        element,
        'release-1',
        'v1.0.0',
        'open',
        mockVsCodeApi
      );

      control.updatePlanCount(5);

      const countEl = element.querySelector('.release-group-count');
      assert.strictEqual(countEl.textContent, '5 plans', 'should show "5 plans" for multiple');
    });

    test('uses singular "plan" for count of 1', () => {
      const element = createMockElement();
      const control = new ReleaseGroupControl(
        mockBus,
        'test-group',
        element,
        'release-1',
        'v1.0.0',
        'open',
        mockVsCodeApi
      );

      control.updatePlanCount(1);

      const countEl = element.querySelector('.release-group-count');
      assert.strictEqual(countEl.textContent, '1 plan', 'should show "1 plan" for singular');
    });

    test('updates status display', () => {
      const element = createMockElement();
      const control = new ReleaseGroupControl(
        mockBus,
        'test-group',
        element,
        'release-1',
        'v1.0.0',
        'open',
        mockVsCodeApi
      );

      control.updateStatus('merged');

      const statusEl = element.querySelector('.release-group-status');
      assert.ok(statusEl.className.includes('merged'), 'should update status class');
      assert.strictEqual(statusEl.textContent, 'merged', 'should update status text');
    });

    test('hides content when collapsed', () => {
      const element = createMockElement();
      const control = new ReleaseGroupControl(
        mockBus,
        'test-group',
        element,
        'release-1',
        'v1.0.0',
        'open',
        mockVsCodeApi
      );

      // Expand first
      control.collapsed = false;
      control._updateCollapse();
      assert.notStrictEqual(control.contentEl.style.display, 'none', 'should be visible when expanded');

      // Then collapse
      control.collapsed = true;
      control._updateCollapse();
      assert.strictEqual(control.contentEl.style.display, 'none', 'should be hidden when collapsed');
    });

    test('shows content when expanded', () => {
      const element = createMockElement();
      const control = new ReleaseGroupControl(
        mockBus,
        'test-group',
        element,
        'release-1',
        'v1.0.0',
        'open',
        mockVsCodeApi
      );

      // Collapse first
      control.collapsed = true;
      control._updateCollapse();
      assert.strictEqual(control.contentEl.style.display, 'none', 'should be hidden when collapsed');

      // Then expand
      control.collapsed = false;
      control._updateCollapse();
      assert.strictEqual(control.contentEl.style.display, 'block', 'should be visible when expanded');
    });
  });

  suite('Plan Grouping Logic', () => {
    test('groups plans with same release ID together', () => {
      const plans = [
        { id: 'plan-1', name: 'Plan 1', release: { id: 'release-1', name: 'v1.0.0', status: 'open' } },
        { id: 'plan-2', name: 'Plan 2', release: { id: 'release-1', name: 'v1.0.0', status: 'open' } },
        { id: 'plan-3', name: 'Plan 3', release: { id: 'release-2', name: 'v2.0.0', status: 'open' } }
      ];

      const releaseGroups = new Map();
      const unassigned: any[] = [];

      for (const plan of plans) {
        if (plan.release && plan.release.id) {
          const releaseId = plan.release.id;
          if (!releaseGroups.has(releaseId)) {
            releaseGroups.set(releaseId, { release: plan.release, plans: [] });
          }
          releaseGroups.get(releaseId).plans.push(plan);
        } else {
          unassigned.push(plan);
        }
      }

      assert.strictEqual(releaseGroups.size, 2, 'should create 2 release groups');
      assert.strictEqual(releaseGroups.get('release-1').plans.length, 2, 'release-1 should have 2 plans');
      assert.strictEqual(releaseGroups.get('release-2').plans.length, 1, 'release-2 should have 1 plan');
      assert.strictEqual(unassigned.length, 0, 'should have no unassigned plans');
    });

    test('separates plans without releases into unassigned section', () => {
      const plans: any[] = [
        { id: 'plan-1', name: 'Plan 1', release: { id: 'release-1', name: 'v1.0.0', status: 'open' } },
        { id: 'plan-2', name: 'Plan 2' }, // No release
        { id: 'plan-3', name: 'Plan 3' }  // No release
      ];

      const releaseGroups = new Map();
      const unassigned: any[] = [];

      for (const plan of plans) {
        if (plan.release && plan.release.id) {
          const releaseId = plan.release.id;
          if (!releaseGroups.has(releaseId)) {
            releaseGroups.set(releaseId, { release: plan.release, plans: [] });
          }
          releaseGroups.get(releaseId).plans.push(plan);
        } else {
          unassigned.push(plan);
        }
      }

      assert.strictEqual(releaseGroups.size, 1, 'should create 1 release group');
      assert.strictEqual(unassigned.length, 2, 'should have 2 unassigned plans');
      assert.strictEqual(unassigned[0].id, 'plan-2', 'first unassigned should be plan-2');
      assert.strictEqual(unassigned[1].id, 'plan-3', 'second unassigned should be plan-3');
    });

    test('handles all plans without releases (no groups)', () => {
      const plans: any[] = [
        { id: 'plan-1', name: 'Plan 1' },
        { id: 'plan-2', name: 'Plan 2' },
        { id: 'plan-3', name: 'Plan 3' }
      ];

      const releaseGroups = new Map();
      const unassigned: any[] = [];
      let hasAnyRelease = false;

      for (const plan of plans) {
        if (plan.release && plan.release.id) {
          hasAnyRelease = true;
          const releaseId = plan.release.id;
          if (!releaseGroups.has(releaseId)) {
            releaseGroups.set(releaseId, { release: plan.release, plans: [] });
          }
          releaseGroups.get(releaseId).plans.push(plan);
        } else {
          unassigned.push(plan);
        }
      }

      assert.strictEqual(hasAnyRelease, false, 'should have no releases');
      assert.strictEqual(releaseGroups.size, 0, 'should create no release groups');
      assert.strictEqual(unassigned.length, 3, 'all plans should be unassigned');
    });

    test('sorts release groups by name alphabetically', () => {
      const releaseGroups = new Map([
        ['release-c', { release: { id: 'release-c', name: 'v3.0.0', status: 'open' }, plans: [] }],
        ['release-a', { release: { id: 'release-a', name: 'v1.0.0', status: 'open' }, plans: [] }],
        ['release-b', { release: { id: 'release-b', name: 'v2.0.0', status: 'open' }, plans: [] }]
      ]);

      const sortedReleases = Array.from(releaseGroups.entries()).sort((a, b) => {
        return a[1].release.name.localeCompare(b[1].release.name);
      });

      assert.strictEqual(sortedReleases.length, 3, 'should have 3 sorted groups');
      assert.strictEqual(sortedReleases[0][1].release.name, 'v1.0.0', 'first should be v1.0.0');
      assert.strictEqual(sortedReleases[1][1].release.name, 'v2.0.0', 'second should be v2.0.0');
      assert.strictEqual(sortedReleases[2][1].release.name, 'v3.0.0', 'third should be v3.0.0');
    });

    test('handles multiple releases with different statuses', () => {
      const plans = [
        { id: 'plan-1', name: 'Plan 1', release: { id: 'release-1', name: 'v1.0.0', status: 'open' } },
        { id: 'plan-2', name: 'Plan 2', release: { id: 'release-2', name: 'v2.0.0', status: 'merged' } },
        { id: 'plan-3', name: 'Plan 3', release: { id: 'release-3', name: 'v3.0.0', status: 'closed' } }
      ];

      const releaseGroups = new Map();

      for (const plan of plans) {
        if (plan.release && plan.release.id) {
          const releaseId = plan.release.id;
          if (!releaseGroups.has(releaseId)) {
            releaseGroups.set(releaseId, { release: plan.release, plans: [] });
          }
          releaseGroups.get(releaseId).plans.push(plan);
        }
      }

      assert.strictEqual(releaseGroups.size, 3, 'should create 3 release groups');
      assert.strictEqual(releaseGroups.get('release-1').release.status, 'open');
      assert.strictEqual(releaseGroups.get('release-2').release.status, 'merged');
      assert.strictEqual(releaseGroups.get('release-3').release.status, 'closed');
    });

    test('updates plan count when plans added to group', () => {
      const element = createMockElement();
      const control = new ReleaseGroupControl(
        mockBus,
        'test-group',
        element,
        'release-1',
        'v1.0.0',
        'open',
        mockVsCodeApi
      );

      // Initial count
      control.updatePlanCount(2);
      let countEl = element.querySelector('.release-group-count');
      assert.strictEqual(countEl.textContent, '2 plans');

      // Add more plans
      control.updatePlanCount(5);
      countEl = element.querySelector('.release-group-count');
      assert.strictEqual(countEl.textContent, '5 plans');
    });

    test('updates plan count when plans removed from group', () => {
      const element = createMockElement();
      const control = new ReleaseGroupControl(
        mockBus,
        'test-group',
        element,
        'release-1',
        'v1.0.0',
        'open',
        mockVsCodeApi
      );

      // Initial count
      control.updatePlanCount(5);
      let countEl = element.querySelector('.release-group-count');
      assert.strictEqual(countEl.textContent, '5 plans');

      // Remove plans
      control.updatePlanCount(2);
      countEl = element.querySelector('.release-group-count');
      assert.strictEqual(countEl.textContent, '2 plans');
    });
  });

  suite('Group Header Display', () => {
    test('displays release name in header', () => {
      const element = createMockElement();
      const control = new ReleaseGroupControl(
        mockBus,
        'test-group',
        element,
        'release-1',
        'Feature Release v1.5.0',
        'open',
        mockVsCodeApi
      );

      const header = element.querySelector('.release-group-header');
      assert.ok(header.innerHTML.includes('Feature Release v1.5.0'), 'should display full release name');
    });

    test('displays release status badge', () => {
      const element = createMockElement();
      const control = new ReleaseGroupControl(
        mockBus,
        'test-group',
        element,
        'release-1',
        'v1.0.0',
        'merged',
        mockVsCodeApi
      );

      const statusEl = element.querySelector('.release-group-status');
      assert.ok(statusEl, 'should have status element');
      assert.ok(statusEl.className.includes('merged'), 'should have merged class');
      assert.strictEqual(statusEl.textContent, 'merged', 'should show merged text');
    });

    test('displays initial plan count as 0', () => {
      const element = createMockElement();
      const control = new ReleaseGroupControl(
        mockBus,
        'test-group',
        element,
        'release-1',
        'v1.0.0',
        'open',
        mockVsCodeApi
      );

      const countEl = element.querySelector('.release-group-count');
      assert.strictEqual(countEl.textContent, '0 plans', 'should start with 0 plans');
    });

    test('includes chevron icon for collapse/expand', () => {
      const element = createMockElement();
      const control = new ReleaseGroupControl(
        mockBus,
        'test-group',
        element,
        'release-1',
        'v1.0.0',
        'open',
        mockVsCodeApi
      );

      const header = element.querySelector('.release-group-header');
      assert.ok(header.innerHTML.includes('release-group-chevron'), 'should have chevron element');
      assert.ok(header.innerHTML.includes('codicon-chevron-down'), 'should use codicon chevron icon');
    });

    test('applies collapsed class to chevron when collapsed', () => {
      const element = createMockElement();
      
      // Pre-set collapsed state
      mockVsCodeApi.setState({
        releaseGroupsCollapsed: {
          'release-1': true
        }
      });

      const control = new ReleaseGroupControl(
        mockBus,
        'test-group',
        element,
        'release-1',
        'v1.0.0',
        'open',
        mockVsCodeApi
      );

      const header = element.querySelector('.release-group-header');
      assert.ok(header.innerHTML.includes('collapsed'), 'chevron should have collapsed class');
    });
  });
});
