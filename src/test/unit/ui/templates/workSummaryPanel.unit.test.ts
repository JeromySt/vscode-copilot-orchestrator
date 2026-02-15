/**
 * @fileoverview Unit tests for workSummaryPanel template.
 *
 * @module test/unit/ui/templates/workSummaryPanel
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { renderWorkSummaryPanelHtml } from '../../../../ui/templates/workSummaryPanel';
import type { WorkSummaryPanelData, WsPanelJob, WsJourneyNode } from '../../../../ui/templates/workSummaryPanel';

suite('workSummaryPanel template', () => {

  function makeJob(overrides?: Partial<WsPanelJob>): WsPanelJob {
    return {
      nodeId: 'node-1',
      nodeName: 'Test Job',
      description: 'A test job',
      commits: 1,
      filesAdded: 2,
      filesModified: 3,
      filesDeleted: 0,
      commitDetails: [{
        shortHash: 'abc12345',
        message: 'Work completed',
        date: '2026-02-14T03:15:00Z',
        filesAdded: ['src/new.ts'],
        filesModified: ['src/utils.ts', 'src/core.ts'],
        filesDeleted: [],
      }],
      ...overrides,
    };
  }

  function makeData(overrides?: Partial<WorkSummaryPanelData>): WorkSummaryPanelData {
    return {
      planName: 'Test Plan',
      baseBranch: 'main',
      totalCommits: 1,
      totalFilesAdded: 2,
      totalFilesModified: 3,
      totalFilesDeleted: 0,
      jobs: [makeJob()],
      journeyNodes: [],
      ...overrides,
    };
  }

  // -----------------------------------------------------------------------
  // Empty / null data
  // -----------------------------------------------------------------------
  test('returns fallback HTML for null data', () => {
    const html = renderWorkSummaryPanelHtml(null);
    assert.ok(html.includes('No work summary available'));
  });

  test('returns fallback HTML for undefined data', () => {
    const html = renderWorkSummaryPanelHtml(undefined);
    assert.ok(html.includes('No work summary available'));
  });

  // -----------------------------------------------------------------------
  // Header stats
  // -----------------------------------------------------------------------
  test('renders plan name in title', () => {
    const html = renderWorkSummaryPanelHtml(makeData());
    assert.ok(html.includes('Test Plan'));
  });

  test('renders target branch suffix when present', () => {
    const html = renderWorkSummaryPanelHtml(makeData({ targetBranch: 'feature/branch' }));
    assert.ok(html.includes('Merged to feature/branch'));
  });

  test('renders total commit count', () => {
    const html = renderWorkSummaryPanelHtml(makeData({ totalCommits: 5 }));
    assert.ok(html.includes('>5<'));
  });

  test('renders total files added count', () => {
    const html = renderWorkSummaryPanelHtml(makeData({ totalFilesAdded: 10 }));
    assert.ok(html.includes('>+10<'));
  });

  test('renders total files modified count', () => {
    const html = renderWorkSummaryPanelHtml(makeData({ totalFilesModified: 7 }));
    assert.ok(html.includes('>~7<'));
  });

  test('renders total files deleted count', () => {
    const html = renderWorkSummaryPanelHtml(makeData({ totalFilesDeleted: 3 }));
    assert.ok(html.includes('>-3<'));
  });

  // -----------------------------------------------------------------------
  // Job cards
  // -----------------------------------------------------------------------
  test('renders job name in collapsible card', () => {
    const html = renderWorkSummaryPanelHtml(makeData());
    assert.ok(html.includes('Test Job'));
    assert.ok(html.includes('class="job-card"'));
    assert.ok(html.includes('<details'));
  });

  test('renders job duration when available', () => {
    const html = renderWorkSummaryPanelHtml(makeData({
      jobs: [makeJob({ durationMs: 874000 })], // 14m 34s
    }));
    assert.ok(html.includes('14m 34s'));
  });

  test('omits duration when not available', () => {
    const html = renderWorkSummaryPanelHtml(makeData({
      jobs: [makeJob({ durationMs: undefined })],
    }));
    // No duration text should appear
    assert.ok(!html.includes('NaN'));
  });

  test('renders job file stats', () => {
    const html = renderWorkSummaryPanelHtml(makeData());
    assert.ok(html.includes('+2'));
    assert.ok(html.includes('~3'));
  });

  test('renders commit details as collapsible', () => {
    const html = renderWorkSummaryPanelHtml(makeData());
    assert.ok(html.includes('abc12345'));
    assert.ok(html.includes('Work completed'));
    assert.ok(html.includes('class="commit-detail"'));
  });

  test('renders no commits message when empty', () => {
    const html = renderWorkSummaryPanelHtml(makeData({
      jobs: [makeJob({ commitDetails: [] })],
    }));
    assert.ok(html.includes('No commit details available'));
  });

  test('renders multiple jobs', () => {
    const html = renderWorkSummaryPanelHtml(makeData({
      jobs: [
        makeJob({ nodeId: 'n1', nodeName: 'Job Alpha' }),
        makeJob({ nodeId: 'n2', nodeName: 'Job Beta' }),
      ],
    }));
    assert.ok(html.includes('Job Alpha'));
    assert.ok(html.includes('Job Beta'));
  });

  // -----------------------------------------------------------------------
  // Clickable files
  // -----------------------------------------------------------------------
  test('renders files as clickable links', () => {
    const html = renderWorkSummaryPanelHtml(makeData());
    assert.ok(html.includes('class="file-link'));
    assert.ok(html.includes("openFile("));
    assert.ok(html.includes('src/new.ts'));
    assert.ok(html.includes('src/utils.ts'));
  });

  test('renders file status classes', () => {
    const html = renderWorkSummaryPanelHtml(makeData());
    assert.ok(html.includes('file-added'));
    assert.ok(html.includes('file-modified'));
  });

  test('renders show more toggle when many files', () => {
    const manyFiles = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);
    const html = renderWorkSummaryPanelHtml(makeData({
      jobs: [makeJob({
        commitDetails: [{
          shortHash: 'abc12345',
          message: 'Bulk work',
          date: '',
          filesAdded: manyFiles,
          filesModified: [],
          filesDeleted: [],
        }],
      })],
    }));
    assert.ok(html.includes('+5 more'));
  });

  // -----------------------------------------------------------------------
  // Journey visualization
  // -----------------------------------------------------------------------
  test('renders journey when nodes present', () => {
    const html = renderWorkSummaryPanelHtml(makeData({
      journeyNodes: [
        { nodeName: 'Job A', shortHash: 'af06acee', status: 'succeeded', mergedToTarget: true, isLeaf: true },
      ],
    }));
    assert.ok(html.includes('Commit Journey'));
    assert.ok(html.includes('class="journey"'));
    assert.ok(html.includes('Job A'));
    assert.ok(html.includes('af06acee'));
  });

  test('renders base branch in journey', () => {
    const html = renderWorkSummaryPanelHtml(makeData({
      baseBranch: 'develop',
      baseCommitShort: 'abcd1234',
      journeyNodes: [
        { nodeName: 'Job A', status: 'succeeded', isLeaf: true },
      ],
    }));
    assert.ok(html.includes('develop'));
    assert.ok(html.includes('abcd1234'));
  });

  test('renders target branch in journey', () => {
    const html = renderWorkSummaryPanelHtml(makeData({
      targetBranch: 'users/test/refactor',
      journeyNodes: [
        { nodeName: 'Job A', status: 'succeeded', isLeaf: true },
      ],
    }));
    assert.ok(html.includes('users/test/refactor'));
    assert.ok(html.includes('🎯 Target:'));
  });

  test('shows merged status for merged nodes', () => {
    const html = renderWorkSummaryPanelHtml(makeData({
      journeyNodes: [
        { nodeName: 'Job A', status: 'succeeded', mergedToTarget: true, isLeaf: true },
      ],
    }));
    assert.ok(html.includes('merged'));
    assert.ok(html.includes('✅'));
  });

  test('shows succeeded status for non-merged nodes', () => {
    const html = renderWorkSummaryPanelHtml(makeData({
      journeyNodes: [
        { nodeName: 'Job A', status: 'succeeded', isLeaf: false },
      ],
    }));
    assert.ok(html.includes('succeeded'));
  });

  test('skips journey section when no journey nodes', () => {
    const html = renderWorkSummaryPanelHtml(makeData({ journeyNodes: [] }));
    assert.ok(!html.includes('Commit Journey'));
  });

  test('renders multiple journey nodes with connectors', () => {
    const html = renderWorkSummaryPanelHtml(makeData({
      journeyNodes: [
        { nodeName: 'Job A', shortHash: 'aaaa1111', status: 'succeeded', isLeaf: false },
        { nodeName: 'Job B', shortHash: 'bbbb2222', status: 'succeeded', isLeaf: false },
        { nodeName: 'Job C', shortHash: 'cccc3333', status: 'succeeded', mergedToTarget: true, isLeaf: true },
      ],
    }));
    assert.ok(html.includes('├──'));
    assert.ok(html.includes('└──'));
  });

  // -----------------------------------------------------------------------
  // HTML escaping (security)
  // -----------------------------------------------------------------------
  test('escapes HTML in plan name', () => {
    const html = renderWorkSummaryPanelHtml(makeData({ planName: '<script>alert(1)</script>' }));
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });

  test('escapes HTML in job name', () => {
    const html = renderWorkSummaryPanelHtml(makeData({
      jobs: [makeJob({ nodeName: '<img src=x onerror=alert(1)>' })],
    }));
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img'));
  });

  test('escapes HTML in file paths', () => {
    const html = renderWorkSummaryPanelHtml(makeData({
      jobs: [makeJob({
        commitDetails: [{
          shortHash: 'abc',
          message: 'test',
          date: '',
          filesAdded: ['<script>alert("xss")</script>'],
          filesModified: [],
          filesDeleted: [],
        }],
      })],
    }));
    assert.ok(!html.includes('<script>alert'));
  });

  // -----------------------------------------------------------------------
  // Script inclusion
  // -----------------------------------------------------------------------
  test('includes acquireVsCodeApi script', () => {
    const html = renderWorkSummaryPanelHtml(makeData());
    assert.ok(html.includes('acquireVsCodeApi'));
  });

  test('includes openFile function', () => {
    const html = renderWorkSummaryPanelHtml(makeData());
    assert.ok(html.includes('function openFile'));
  });

  test('CSP allows inline scripts', () => {
    const html = renderWorkSummaryPanelHtml(makeData());
    assert.ok(html.includes("script-src 'unsafe-inline'"));
  });

  // -----------------------------------------------------------------------
  // Empty jobs
  // -----------------------------------------------------------------------
  test('handles empty jobs array gracefully', () => {
    const html = renderWorkSummaryPanelHtml(makeData({ jobs: [] }));
    assert.ok(!html.includes('Job Details'));
  });

  // -----------------------------------------------------------------------
  // Deleted files
  // -----------------------------------------------------------------------
  test('renders deleted files with correct class', () => {
    const html = renderWorkSummaryPanelHtml(makeData({
      jobs: [makeJob({
        filesDeleted: 1,
        commitDetails: [{
          shortHash: 'del123',
          message: 'Remove file',
          date: '',
          filesAdded: [],
          filesModified: [],
          filesDeleted: ['src/old.ts'],
        }],
      })],
    }));
    assert.ok(html.includes('file-deleted'));
    assert.ok(html.includes('src/old.ts'));
  });
});
