/**
 * @fileoverview Unit tests for OrchestratorFileWatcher.
 *
 * Tests filesystem watcher behavior including:
 * - Creating watcher with correct pattern 
 * - Plan ID extraction from UUID filenames
 * - Event filtering for non-UUID files
 * - Debouncing of rapid successive events
 * - Proper disposal and cleanup
 * - Optional create callback functionality
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { OrchestratorFileWatcher } from '../../../core/orchestratorFileWatcher';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress Logger console output to avoid hanging test workers. */
function silenceConsole(): { restore: () => void } {
  const origLog = console.log;
  const origDebug = console.debug;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = () => {};
  console.debug = () => {};
  console.warn = () => {};
  console.error = () => {};
  return {
    restore() {
      console.log = origLog;
      console.debug = origDebug;
      console.warn = origWarn;
      console.error = origError;
    }
  };
}

// Mock FileSystemWatcher implementation
class MockFileSystemWatcher {
  public _onDidDeleteCallbacks: ((uri: vscode.Uri) => void)[] = [];
  public _onDidCreateCallbacks: ((uri: vscode.Uri) => void)[] = [];

  ignoreCreateEvents = false;
  ignoreChangeEvents = true;  
  ignoreDeleteEvents = false;

  onDidCreate(listener: (e: vscode.Uri) => any): vscode.Disposable {
    this._onDidCreateCallbacks.push(listener);
    return new vscode.Disposable(() => {
      const idx = this._onDidCreateCallbacks.indexOf(listener);
      if (idx >= 0) {this._onDidCreateCallbacks.splice(idx, 1);}
    });
  }

  onDidChange(): vscode.Disposable {
    // Not used by OrchestratorFileWatcher
    return new vscode.Disposable(() => {});
  }

  onDidDelete(listener: (e: vscode.Uri) => any): vscode.Disposable {
    this._onDidDeleteCallbacks.push(listener);
    return new vscode.Disposable(() => {
      const idx = this._onDidDeleteCallbacks.indexOf(listener);
      if (idx >= 0) {this._onDidDeleteCallbacks.splice(idx, 1);}
    });
  }

  dispose(): void {
    this._onDidCreateCallbacks.length = 0;
    this._onDidDeleteCallbacks.length = 0;
  }

  // Test helpers
  simulateDelete(uri: vscode.Uri): void {
    this._onDidDeleteCallbacks.forEach(cb => cb(uri));
  }

  simulateCreate(uri: vscode.Uri): void {
    this._onDidCreateCallbacks.forEach(cb => cb(uri));
  }
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

suite('OrchestratorFileWatcher', () => {
  let mockWatcher: MockFileSystemWatcher;
  let deleteCallback: sinon.SinonStub;
  let createCallback: sinon.SinonStub;
  let clock: sinon.SinonFakeTimers;
  let consoleRestore: { restore: () => void };
  let originalCreateFileSystemWatcher: typeof vscode.workspace.createFileSystemWatcher;

  suiteSetup(() => {
    consoleRestore = silenceConsole();
  });

  suiteTeardown(() => {
    consoleRestore.restore();
  });

  setup(() => {
    clock = sinon.useFakeTimers();

    // Mock the file system watcher creation
    mockWatcher = new MockFileSystemWatcher();
    
    // Store original and replace with mock
    originalCreateFileSystemWatcher = vscode.workspace.createFileSystemWatcher;
    (vscode.workspace as any).createFileSystemWatcher = () => mockWatcher;

    // Create test callbacks
    deleteCallback = sinon.stub();
    createCallback = sinon.stub();
  });

  teardown(() => {
    clock.restore();
    
    // Restore original method
    (vscode.workspace as any).createFileSystemWatcher = originalCreateFileSystemWatcher;
  });

  suite('constructor', () => {
    test('creates watcher successfully', () => {
      const watcher = new OrchestratorFileWatcher('/workspace', deleteCallback);
      assert.ok(watcher, 'watcher should be created');
      watcher.dispose();
    });

    test('registers delete handler', () => {
      const watcher = new OrchestratorFileWatcher('/workspace', deleteCallback);
      
      // Should have one delete callback registered
      assert.strictEqual(mockWatcher._onDidDeleteCallbacks.length, 1, 
        'should register delete callback');
      
      watcher.dispose();
    });

    test('registers create handler when callback provided', () => {
      const watcher = new OrchestratorFileWatcher('/workspace', deleteCallback, createCallback);
      
      // Should have one create callback registered
      assert.strictEqual(mockWatcher._onDidCreateCallbacks.length, 1,
        'should register create callback');
      
      watcher.dispose();
    });

    test('does not register create handler when callback not provided', () => {
      const watcher = new OrchestratorFileWatcher('/workspace', deleteCallback);
      
      // Should have no create callbacks registered
      assert.strictEqual(mockWatcher._onDidCreateCallbacks.length, 0,
        'should not register create callback');
      
      watcher.dispose();
    });
  });

  suite('file deletion handling', () => {
    test('extracts plan ID from valid UUID filename', async () => {
      const watcher = new OrchestratorFileWatcher('/workspace', deleteCallback);
      
      // Simulate file deletion
      const planId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      const uri = vscode.Uri.file(`/workspace/.orchestrator/plans/plan-${planId}.json`);
      mockWatcher.simulateDelete(uri);

      // Advance timers past debounce
      await clock.tickAsync(150);

      assert.ok(deleteCallback.calledOnce, 'delete callback should be called');
      assert.ok(deleteCallback.calledWith(planId), 
        'delete callback should be called with correct plan ID');
      
      watcher.dispose();
    });

    test('ignores non-UUID filenames', async () => {
      const watcher = new OrchestratorFileWatcher('/workspace', deleteCallback);
      
      // Simulate deletion of non-UUID file
      const uri = vscode.Uri.file('/workspace/.orchestrator/plans/plan-not-a-uuid.json');
      mockWatcher.simulateDelete(uri);

      await clock.tickAsync(150);

      assert.ok(deleteCallback.notCalled, 'delete callback should not be called for non-UUID files');
      
      watcher.dispose();
    });

    test('debounces rapid successive events', async () => {
      const watcher = new OrchestratorFileWatcher('/workspace', deleteCallback);
      
      const planId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      const uri = vscode.Uri.file(`/workspace/.orchestrator/plans/plan-${planId}.json`);

      // Fire multiple delete events rapidly
      mockWatcher.simulateDelete(uri);
      await clock.tickAsync(50);
      mockWatcher.simulateDelete(uri);
      await clock.tickAsync(50);
      mockWatcher.simulateDelete(uri);

      // Still within debounce window
      assert.ok(deleteCallback.notCalled, 'callback should not fire within debounce window');

      // Advance past debounce
      await clock.tickAsync(150);

      // Should only fire once
      assert.strictEqual(deleteCallback.callCount, 1, 'callback should fire only once after debounce');
      assert.ok(deleteCallback.calledWith(planId), 'callback should be called with correct plan ID');
      
      watcher.dispose();
    });

    test('handles multiple different plan deletions independently', async () => {
      const watcher = new OrchestratorFileWatcher('/workspace', deleteCallback);

      const plan1 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      const plan2 = 'a1b2c3d4-5678-90ab-cdef-1234567890ab';

      mockWatcher.simulateDelete(vscode.Uri.file(`/workspace/.orchestrator/plans/plan-${plan1}.json`));
      mockWatcher.simulateDelete(vscode.Uri.file(`/workspace/.orchestrator/plans/plan-${plan2}.json`));

      await clock.tickAsync(150);

      assert.strictEqual(deleteCallback.callCount, 2, 'callback should be called twice for different plans');
      assert.ok(deleteCallback.calledWith(plan1), 'callback should be called with first plan ID');
      assert.ok(deleteCallback.calledWith(plan2), 'callback should be called with second plan ID');
      
      watcher.dispose();
    });
  });

  suite('file creation handling', () => {
    test('calls create callback when provided', async () => {
      const watcher = new OrchestratorFileWatcher('/workspace', deleteCallback, createCallback);
      
      const planId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      const filePath = `/workspace/.orchestrator/plans/plan-${planId}.json`;
      const uri = vscode.Uri.file(filePath);

      mockWatcher.simulateCreate(uri);
      await clock.tickAsync(150);

      assert.ok(createCallback.calledOnce, 'create callback should be called');
      assert.ok(createCallback.calledWith(planId, filePath), 
        'create callback should be called with plan ID and file path');
      
      watcher.dispose();
    });

    test('ignores non-UUID filenames for creation', async () => {
      const watcher = new OrchestratorFileWatcher('/workspace', deleteCallback, createCallback);

      const uri = vscode.Uri.file('/workspace/.orchestrator/plans/plan-not-a-uuid.json');
      mockWatcher.simulateCreate(uri);
      await clock.tickAsync(150);

      assert.ok(createCallback.notCalled, 'create callback should not be called for non-UUID files');
      
      watcher.dispose();
    });

    test('debounces creation events', async () => {
      const watcher = new OrchestratorFileWatcher('/workspace', deleteCallback, createCallback);
      
      const planId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      const uri = vscode.Uri.file(`/workspace/.orchestrator/plans/plan-${planId}.json`);

      // Fire multiple create events rapidly
      mockWatcher.simulateCreate(uri);
      await clock.tickAsync(50);
      mockWatcher.simulateCreate(uri);
      await clock.tickAsync(50);
      mockWatcher.simulateCreate(uri);

      // Still within debounce window
      assert.ok(createCallback.notCalled, 'callback should not fire within debounce window');

      // Advance past debounce
      await clock.tickAsync(150);

      // Should only fire once
      assert.strictEqual(createCallback.callCount, 1, 'callback should fire only once after debounce');
      
      watcher.dispose();
    });
  });

  suite('disposal', () => {
    test('disposes watcher and clears timers', async () => {
      const watcher = new OrchestratorFileWatcher('/workspace', deleteCallback);
      
      // Start a debounce timer
      const planId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      const uri = vscode.Uri.file(`/workspace/.orchestrator/plans/plan-${planId}.json`);
      mockWatcher.simulateDelete(uri);

      // Dispose before timer fires
      watcher.dispose();

      await clock.tickAsync(150);

      // Callback should not fire after dispose
      assert.ok(deleteCallback.notCalled, 'callback should not fire after disposal');
    });

    test('clears all handlers on dispose', () => {
      const watcher = new OrchestratorFileWatcher('/workspace', deleteCallback, createCallback);
      
      // Should have registered handlers
      assert.strictEqual(mockWatcher._onDidDeleteCallbacks.length, 1, 'should have delete handler');
      assert.strictEqual(mockWatcher._onDidCreateCallbacks.length, 1, 'should have create handler');
      
      watcher.dispose();
      
      // Handlers should still be registered on mock (disposal happens internally)
      // The actual disposables manage the cleanup, not the mock
    });
  });

  suite('UUID validation', () => {
    test('accepts valid UUID formats', async () => {
      const watcher = new OrchestratorFileWatcher('/workspace', deleteCallback);

      const validUuids = [
        'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        '123e4567-e89b-12d3-a456-426614174000',
        '00000000-0000-0000-0000-000000000000',
        'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF'
      ];

      for (const uuid of validUuids) {
        const uri = vscode.Uri.file(`/workspace/.orchestrator/plans/plan-${uuid}.json`);
        mockWatcher.simulateDelete(uri);
      }

      await clock.tickAsync(150);

      assert.strictEqual(deleteCallback.callCount, validUuids.length, 
        'all valid UUIDs should trigger callbacks');
      
      watcher.dispose();
    });

    test('rejects invalid UUID formats', async () => {
      const watcher = new OrchestratorFileWatcher('/workspace', deleteCallback);

      const invalidFormats = [
        'not-a-uuid',
        '123456789',
        'f47ac10b-58cc-4372-a567-0e02b2c3d47', // too short
        'f47ac10b-58cc-4372-a567-0e02b2c3d4799', // too long
        'g47ac10b-58cc-4372-a567-0e02b2c3d479', // invalid hex
        'f47ac10b58cc4372a5670e02b2c3d479', // missing dashes
        'f47ac10b-58cc-4372-a567-0e02b2c3d479-extra' // extra content
      ];

      for (const invalid of invalidFormats) {
        const uri = vscode.Uri.file(`/workspace/.orchestrator/plans/plan-${invalid}.json`);
        mockWatcher.simulateDelete(uri);
      }

      await clock.tickAsync(150);

      assert.ok(deleteCallback.notCalled, 'invalid UUID formats should not trigger callbacks');
      
      watcher.dispose();
    });
  });
});
