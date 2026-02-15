/**
 * @fileoverview Unit tests for planDetail DAG template.
 *
 * @module test/unit/ui/templates/planDetailDag
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { renderPlanDag } from '../../../../ui/templates/planDetail/dagTemplate';
import type { PlanDagData } from '../../../../ui/templates/planDetail/dagTemplate';

suite('planDetail dagTemplate', () => {

  function makeData(overrides?: Partial<PlanDagData>): PlanDagData {
    return {
      mermaidDef: 'flowchart LR\n  A --> B',
      status: 'running',
      ...overrides,
    };
  }

  // -----------------------------------------------------------------------
  // Mermaid container
  // -----------------------------------------------------------------------
  suite('Mermaid diagram section', () => {
    test('renders mermaid-diagram container', () => {
      const html = renderPlanDag(makeData());
      assert.ok(html.includes('id="mermaid-diagram"'));
    });

    test('renders mermaid definition in pre block', () => {
      const html = renderPlanDag(makeData({ mermaidDef: 'flowchart LR\n  X --> Y' }));
      assert.ok(html.includes('flowchart LR'));
      assert.ok(html.includes('X --> Y'));
    });

    test('renders mermaid container with correct id', () => {
      const html = renderPlanDag(makeData());
      assert.ok(html.includes('id="mermaidContainer"'));
    });

    test('renders pre with class="mermaid"', () => {
      const html = renderPlanDag(makeData());
      assert.ok(html.includes('class="mermaid"'));
    });
  });

  // -----------------------------------------------------------------------
  // Zoom controls
  // -----------------------------------------------------------------------
  suite('Zoom controls', () => {
    test('renders zoom-controls container', () => {
      const html = renderPlanDag(makeData());
      assert.ok(html.includes('class="zoom-controls"'));
    });

    test('renders zoom in button', () => {
      const html = renderPlanDag(makeData());
      assert.ok(html.includes('onclick="zoomIn()"'));
      assert.ok(html.includes('title="Zoom In"'));
    });

    test('renders zoom out button', () => {
      const html = renderPlanDag(makeData());
      assert.ok(html.includes('onclick="zoomOut()"'));
      assert.ok(html.includes('title="Zoom Out"'));
    });

    test('renders zoom reset button', () => {
      const html = renderPlanDag(makeData());
      assert.ok(html.includes('onclick="zoomReset()"'));
      assert.ok(html.includes('title="Reset Zoom"'));
    });

    test('renders zoom fit button', () => {
      const html = renderPlanDag(makeData());
      assert.ok(html.includes('onclick="zoomFit()"'));
      assert.ok(html.includes('title="Fit to View"'));
    });

    test('renders zoom level label', () => {
      const html = renderPlanDag(makeData());
      assert.ok(html.includes('id="zoomLevel"'));
      assert.ok(html.includes('100%'));
    });
  });

  // -----------------------------------------------------------------------
  // Legend
  // -----------------------------------------------------------------------
  suite('Legend', () => {
    test('renders legend container', () => {
      const html = renderPlanDag(makeData());
      assert.ok(html.includes('class="legend"'));
    });

    test('renders all five status legend items', () => {
      const html = renderPlanDag(makeData());
      assert.ok(html.includes('Pending'));
      assert.ok(html.includes('Running'));
      assert.ok(html.includes('Succeeded'));
      assert.ok(html.includes('Failed'));
      assert.ok(html.includes('Blocked'));
    });

    test('renders legend icons with correct classes', () => {
      const html = renderPlanDag(makeData());
      assert.ok(html.includes('class="legend-icon pending"'));
      assert.ok(html.includes('class="legend-icon running"'));
      assert.ok(html.includes('class="legend-icon succeeded"'));
      assert.ok(html.includes('class="legend-icon failed"'));
      assert.ok(html.includes('class="legend-icon blocked"'));
    });

    test('renders status icon characters', () => {
      const html = renderPlanDag(makeData());
      assert.ok(html.includes('>○<'), 'Pending icon');
      assert.ok(html.includes('>▶<'), 'Running icon');
      assert.ok(html.includes('>✓<'), 'Succeeded icon');
      assert.ok(html.includes('>✗<'), 'Failed icon');
      assert.ok(html.includes('>⊘<'), 'Blocked icon');
    });
  });

  // -----------------------------------------------------------------------
  // Processes section
  // -----------------------------------------------------------------------
  suite('Processes section', () => {
    test('renders processes section when status is running', () => {
      const html = renderPlanDag(makeData({ status: 'running' }));
      assert.ok(html.includes('id="processesSection"'));
      assert.ok(html.includes('id="processesContainer"'));
      assert.ok(html.includes('Running Processes'));
      assert.ok(html.includes('Loading processes...'));
    });

    test('hides processes section when succeeded', () => {
      const html = renderPlanDag(makeData({ status: 'succeeded' }));
      assert.ok(html.includes('id="processesSection"'));
      assert.ok(html.includes('style="display:none;"'));
    });

    test('hides processes section when failed', () => {
      const html = renderPlanDag(makeData({ status: 'failed' }));
      assert.ok(html.includes('id="processesSection"'));
      assert.ok(html.includes('style="display:none;"'));
    });

    test('hides processes section when pending', () => {
      const html = renderPlanDag(makeData({ status: 'pending' }));
      assert.ok(html.includes('id="processesSection"'));
      assert.ok(html.includes('style="display:none;"'));
    });

    test('hides processes section when paused', () => {
      const html = renderPlanDag(makeData({ status: 'paused' }));
      assert.ok(html.includes('id="processesSection"'));
      assert.ok(html.includes('style="display:none;"'));
    });

    test('hides processes section when canceled', () => {
      const html = renderPlanDag(makeData({ status: 'canceled' }));
      assert.ok(html.includes('id="processesSection"'));
      assert.ok(html.includes('style="display:none;"'));
    });
  });

  // -----------------------------------------------------------------------
  // Complex mermaid definitions
  // -----------------------------------------------------------------------
  test('handles multi-line mermaid definitions', () => {
    const def = `flowchart LR
  classDef pending fill:#3c3c3c
  A["○ Task A | 2s"] --> B["○ Task B | --"]
  B --> C["✓ Task C | 5s"]`;
    const html = renderPlanDag(makeData({ mermaidDef: def }));
    assert.ok(html.includes('Task A'));
    assert.ok(html.includes('Task B'));
    assert.ok(html.includes('Task C'));
  });

  test('handles empty mermaid definition', () => {
    const html = renderPlanDag(makeData({ mermaidDef: '' }));
    assert.ok(html.includes('class="mermaid"'));
  });
});
