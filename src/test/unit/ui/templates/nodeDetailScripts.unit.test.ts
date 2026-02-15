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
      assert.ok(script.includes('force-fail-node'));
    });

    test('includes attempt card toggle handler', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('.attempt-header'));
      assert.ok(script.includes('.attempt-body'));
      assert.ok(script.includes('.chevron'));
    });

    test('includes attempt phase tab handler', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('.attempt-phase-tab'));
      assert.ok(script.includes('attempt-logs-data'));
    });

    test('includes selectPhase function', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('function selectPhase(phase)'));
      assert.ok(script.includes("type: 'getLog'"));
    });

    test('includes log content message handler', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes("'logContent'"));
      assert.ok(script.includes('lastLogContent'));
    });

    test('includes selection-preserving logic', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('window.getSelection()'));
      assert.ok(script.includes('selection.toString().length > 0'));
    });

    test('includes auto-scroll logic', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('wasAtBottom'));
      assert.ok(script.includes('scrollHeight'));
    });

    test('includes process tree rendering', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('ProcessTreeControl'));
      assert.ok(script.includes('processTree'));
      assert.ok(script.includes('processTreeTitle'));
    });

    test('includes agent work indicator', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('isAgentWork'));
      assert.ok(script.includes('agent-work-indicator'));
    });

    test('includes formatDuration function', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('function formatDuration(ms)'));
    });

    test('includes process stats polling', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('processTreeSection'));
      assert.ok(script.includes("type: 'getProcessStats'"));
    });

    test('includes duration timer driven by pulse events', () => {
      const script = webviewScripts({ ...baseConfig, nodeStatus: 'running' });
      assert.ok(script.includes('duration-timer'));
      assert.ok(script.includes('T.PULSE'));
      assert.ok(script.includes('formatDuration'));
    });

    test('includes escapeHtml client-side function', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('function escapeHtml(text)'));
      assert.ok(script.includes('createElement'));
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
      assert.ok(script.includes('T.LOG_UPDATE'));
      assert.ok(script.includes('T.PROCESS_STATS'));
    });

    test('includes keyboard shortcuts for log viewer', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes("e.key === 'a'")); // Ctrl+A
      assert.ok(script.includes("e.key === 'Escape'")); // Escape
    });

    test('includes countAndSum for process tree stats', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('countAndSum'));
      assert.ok(script.includes('cpu'));
      assert.ok(script.includes('memory'));
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

    test('process tree renderNode handles nested children', () => {
      const script = webviewScripts(baseConfig);
      assert.ok(script.includes('function renderNode(proc, depth)'));
      assert.ok(script.includes('proc.children'));
    });
  });
});
