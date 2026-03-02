/**
 * @fileoverview Unit tests for plansView styles template.
 *
 * @module test/unit/ui/templates/plansView/stylesTemplate
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { renderPlansViewStyles } from '../../../../../ui/templates/plansView/stylesTemplate';

suite('plansView stylesTemplate', () => {
  suite('renderPlansViewStyles', () => {
    test('returns string wrapped in <style> tags', () => {
      const result = renderPlansViewStyles();
      assert.ok(result.startsWith('<style>'), 'Should start with <style>');
      assert.ok(result.endsWith('</style>'), 'Should end with </style>');
    });

    test('includes body styles', () => {
      const result = renderPlansViewStyles();
      assert.ok(result.includes('body {'), 'Should include body styles');
      assert.ok(result.includes('font: 12px'), 'Should include font definition');
    });

    test('includes plan-item styles', () => {
      const result = renderPlansViewStyles();
      assert.ok(result.includes('.plan-item'), 'Should include .plan-item class');
      assert.ok(result.includes('.plan-item:hover'), 'Should include hover state');
      assert.ok(result.includes('.plan-item:focus'), 'Should include focus state');
    });

    test('includes status-specific styles', () => {
      const result = renderPlansViewStyles();
      assert.ok(result.includes('.plan-item.running'), 'Should include running status');
      assert.ok(result.includes('.plan-item.succeeded'), 'Should include succeeded status');
      assert.ok(result.includes('.plan-item.failed'), 'Should include failed status');
    });

    test('includes capacity bar styles', () => {
      const result = renderPlansViewStyles();
      assert.ok(result.includes('.global-capacity-bar'), 'Should include capacity bar');
      assert.ok(result.includes('.capacity-label'), 'Should include capacity label');
    });

    test('includes empty state styles', () => {
      const result = renderPlansViewStyles();
      assert.ok(result.includes('.empty'), 'Should include empty state');
      assert.ok(result.includes('.empty code'), 'Should include code block styling');
    });
  });
});
