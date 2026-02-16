/**
 * @fileoverview Unit tests for plan name truncation in the Plans sidebar webview.
 *
 * Verifies that long plan names are truncated with CSS ellipsis and that a
 * title attribute is present so hovering reveals the full name.
 *
 * @module test/unit/ui/plansViewNameTruncation
 */

import { suite, test, setup, teardown } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';

// We test the HTML output of plansViewProvider._getHtml() by instantiating
// the class with a minimal mock PlanRunner and extracting the private method.

suite('PlansView Plan Name Truncation', () => {
  let sandbox: sinon.SinonSandbox;
  let html: string;

  setup(function () {
    this.timeout(10000);
    sandbox = sinon.createSandbox();

    // Minimal mock PlanRunner – plansViewProvider constructor subscribes to events
    const mockPlanRunner: any = {
      on: sandbox.stub(),
      getAll: sandbox.stub().returns([]),
      getByStatus: sandbox.stub().returns([]),
      getStateMachine: sandbox.stub().returns(undefined),
      getEffectiveEndedAt: sandbox.stub().returns(undefined),
    };
    const mockPulse: any = {
      onPulse: sandbox.stub().returns({ dispose: sandbox.stub() }),
    };
    const mockContext: any = {
      subscriptions: [],
    };

    // Import and instantiate to extract HTML
    const { plansViewProvider } = require('../../../ui/plansViewProvider');
    const provider = new plansViewProvider(mockContext, mockPlanRunner, mockPulse);

    // Access private _getHtml
    html = (provider as any)._getHtml();
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('CSS truncation styles', () => {
    test('should include text-overflow ellipsis for plan-name-text', () => {
      assert.ok(html.includes('text-overflow: ellipsis'), 'CSS should contain text-overflow: ellipsis');
    });

    test('should include overflow hidden for plan-name-text', () => {
      assert.ok(html.includes('overflow: hidden'), 'CSS should contain overflow: hidden');
    });

    test('should include white-space nowrap for plan-name-text', () => {
      assert.ok(html.includes('white-space: nowrap'), 'CSS should contain white-space: nowrap');
    });

    test('should include min-width 0 for flex child shrinking', () => {
      assert.ok(html.includes('min-width: 0'), 'CSS should contain min-width: 0 for flex child');
    });

    test('should include flex-shrink 0 on plan-status badge', () => {
      assert.ok(html.includes('flex-shrink: 0'), 'CSS should prevent status badge from shrinking');
    });
  });

  suite('Plan name title attribute in card template', () => {
    test('should set title attribute on plan-name-text span in _initDom template', () => {
      // The _initDom template uses: title="' + escapeHtml(data.name) + '"
      assert.ok(
        html.includes("'<span class=\"plan-name-text\" title=\"'"),
        'Card template should include title attribute on plan-name-text'
      );
    });

    test('should update title attribute during update (nameEl.title = data.name)', () => {
      assert.ok(
        html.includes('nameEl.title = data.name'),
        'Update logic should set title attribute on name element'
      );
    });
  });

  suite('Plan name flex layout', () => {
    test('should have gap between name and status badge', () => {
      assert.ok(html.includes('gap: 6px'), 'plan-name should have a gap for spacing');
    });

    test('should have flex: 1 on plan-name-text for proper shrinking', () => {
      assert.ok(html.includes('flex: 1'), 'plan-name-text should flex to fill available space');
    });
  });
});
