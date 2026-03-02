/**
 * @fileoverview Unit tests for node detail scripts template.
 *
 * Tests the webviewScripts function with various configurations
 * to ensure correct script generation.
 *
 * @module test/unit/ui/templates/nodeDetailScripts
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { webviewScripts } from '../../../../ui/templates/nodeDetail/scriptsTemplate';
import type { ScriptsConfig } from '../../../../ui/templates/nodeDetail/scriptsTemplate';

suite('Node Detail Scripts Template', () => {

  const baseConfig: ScriptsConfig = {
    planId: 'plan-abc-123',
    nodeId: 'node-def-456',
    currentPhase: null,
    initialPhase: null,
    nodeStatus: 'pending',
  };

  suite('webviewScripts', () => {
    test('includes vscode API acquisition', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('acquireVsCodeApi()'));
    });

    test('destructures window.Orca', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('window.Orca'));
      assert.ok(script.includes('EventBus'));
      assert.ok(script.includes('Topics'));
      assert.ok(script.includes('StatusBadge'));
      assert.ok(script.includes('DurationCounter'));
    });

    test('does NOT include inline EventBus code', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(!script.includes('function EB()'), 'should not contain inline EventBus implementation');
      assert.ok(!script.includes('EB.prototype.on'), 'should not contain EventBus prototype methods');
    });

    test('does NOT include inline SubscribableControl code', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(!script.includes('function SC('), 'should not contain inline SubscribableControl implementation');
      assert.ok(!script.includes('SC.prototype.subscribe'), 'should not contain SubscribableControl prototype methods');
    });

    test('sets PLAN_ID constant', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('"plan-abc-123"'));
    });

    test('sets NODE_ID constant', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('"node-def-456"'));
    });

    test('sets currentPhase to null when not provided', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('var currentPhase = null'));
    });

    test('sets currentPhase when provided', () => {
      const script = webviewScripts({ ...baseConfig, currentPhase: 'work' });
      assert.ok(script.includes('var currentPhase = "work"'));
    });

    test('sets initialPhase when provided', () => {
      const script = webviewScripts({ ...baseConfig, initialPhase: 'prechecks' });
      assert.ok(script.includes('var initialPhase = "prechecks"'));
    });

    test('sets initialPhase to null when not provided', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('var initialPhase = null'));
    });

    test('includes Ctrl+C copy handler', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes("e.key === 'c'"));
      assert.ok(script.includes('copyToClipboard'));
    });

    test('includes openPlan function', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('function openPlan(planId)'));
      assert.ok(script.includes("type: 'openPlan'"));
    });

    test('includes openWorktree function', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('function openWorktree()'));
      assert.ok(script.includes("type: 'openWorktree'"));
    });

    test('includes refresh function', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('function refresh()'));
      assert.ok(script.includes("type: 'refresh'"));
    });

    test('includes session ID copy handler', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('.session-id'));
      assert.ok(script.includes('data-session'));
    });

    test('includes log file path click handler', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('.log-file-path'));
      assert.ok(script.includes("type: 'openLogFile'"));
    });

    test('includes retry button handlers', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('.retry-btn'));
      assert.ok(script.includes("type: 'retryNode'"));
      assert.ok(script.includes('resumeSession: true'));
      assert.ok(script.includes('resumeSession: false'));
    });

    test('includes force-fail confirmation via postMessage', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes("type: 'confirmForceFailNode'"));
      assert.ok(script.includes('force-fail-node') || script.includes('force-fail-btn'));
    });

    test('includes attempt card toggle handler', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('.attempt-header'));
      assert.ok(script.includes('.attempt-body') || script.includes('nextElementSibling'));
      assert.ok(script.includes('.attempt-header'));
    });

    test('includes attempt phase tab handler', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('.attempt-phase-tab'));
      assert.ok(script.includes('attempt-logs-data'));
    });

    test('includes selectPhase function', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('function selectPhase(phase)'));
      assert.ok(script.includes("type: 'getLog'") || script.includes('phaseTabBar.selectPhase'));
    });

    test('routes messages to EventBus topics', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('bus.emit'));
      assert.ok(script.includes('Topics.LOG_UPDATE') || script.includes("'node:log'"));
      assert.ok(script.includes('Topics.PROCESS_STATS') || script.includes("'node:process-stats'"));
    });

    test('instantiates controls from window.Orca', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('new StatusBadge'), 'should instantiate StatusBadge');
      assert.ok(script.includes('new DurationCounter'), 'should instantiate DurationCounter');
      assert.ok(script.includes('new LogViewer'), 'should instantiate LogViewer');
      assert.ok(script.includes('new ProcessTree'), 'should instantiate ProcessTree');
      assert.ok(script.includes('new PhaseTabBar'), 'should instantiate PhaseTabBar');
    });

    test('includes message routing logic', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes("'logContent'"));
    });

    test('includes selection handlers', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('window.getSelection()'));
    });

    test('includes process tree instantiation', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('ProcessTree') || script.includes('processTree'));
    });

    test('includes process stats polling', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('processTreeSection'));
      assert.ok(script.includes("type: 'getProcessStats'"));
    });

    test('includes control instantiation', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('DurationCounter'), 'should reference DurationCounter');
      assert.ok(script.includes('duration-timer'));
    });

    test('JSON-encodes planId safely', () => {
      const script = webviewScripts({ ...baseConfig, planId: 'plan"with"quotes' });
      assert.ok(script.includes('plan\\"with\\"quotes'));
    });

    test('JSON-encodes nodeId safely', () => {
      const script = webviewScripts({ ...baseConfig, nodeId: 'node"special' });
      assert.ok(script.includes('node\\"special'));
    });

    test('routes messages to EventBus topics', () => {
      const script = webviewScripts({ ...baseConfig, nodeStatus: 'succeeded' });
      assert.ok(script.includes('bus.emit'));
      assert.ok(script.includes('Topics.') || script.includes('LOG_UPDATE'));
    });

    test('auto-selects phase on load when currentPhase set', () => {
      const script = webviewScripts({ ...baseConfig, currentPhase: 'work' });
      assert.ok(script.includes('phaseToSelect'));
      assert.ok(script.includes('selectPhase(phaseToSelect)'));
    });

    test('auto-selects phase on load when initialPhase set', () => {
      const script = webviewScripts({ ...baseConfig, initialPhase: 'all' });
      assert.ok(script.includes('phaseToSelect'));
    });

    test('does not auto-select phase when both null', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('var currentPhase = null'));
      assert.ok(script.includes('var initialPhase = null'));
    });
  });
});
