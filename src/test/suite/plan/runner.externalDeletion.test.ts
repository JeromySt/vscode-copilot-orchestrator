import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { PlanRunner, PlanRunnerConfig } from '../../../plan/runner';

function silenceConsole(): { restore: () => void } {
  const orig = { log: console.log, debug: console.debug, warn: console.warn, error: console.error };
  console.log = console.debug = console.warn = console.error = () => {};
  return { restore() { Object.assign(console, orig); } };
}

suite('PlanRunner External Deletion Handling', () => {
  let runner: PlanRunner;
  let workspacePath: string;
  let plansDir: string;
  let quiet: { restore: () => void };
  let mockFileWatcher: vscode.FileSystemWatcher;
  
  setup(() => {
    quiet = silenceConsole();
    
    // Use temp directory for tests
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-test-'));
    plansDir = path.join(workspacePath, '.orchestrator', 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    
    const config: PlanRunnerConfig = {
      storagePath: plansDir,
      defaultRepoPath: workspacePath,
    };
    
    runner = new PlanRunner(config);
    
    // Get the file watcher instance that was created by PlanRunner
    // This is a bit hacky but necessary since the file watcher is private
    mockFileWatcher = (runner as any)._fileWatcher._watcher;
  });
  
  teardown(async () => {
    quiet.restore();
    await runner.shutdown();
    // Clean up temp directory
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });
  
  test('removes plan from memory when file is externally deleted', async () => {
    // Create a plan
    const plan = runner.enqueue({
      name: 'Test Plan',
      jobs: [{
        producerId: 'test-job',
        task: 'Test task',
        dependencies: []
      }]
    });
    
    // Verify plan exists
    assert.ok(runner.get(plan.id));
    
    // Simulate external deletion by manually triggering the file watcher event
    const planFilePath = path.join(plansDir, `plan-${plan.id}.json`);
    const planUri = vscode.Uri.file(planFilePath);
    
    // Trigger file deletion event through the mock file watcher
    (mockFileWatcher as any)._fireDelete(planUri);
    
    // Give some time for the event to process
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Plan should be removed from memory
    assert.strictEqual(runner.get(plan.id), undefined);
  });
  
  test('fires planDeleted event on external deletion', async () => {
    const plan = runner.enqueue({
      name: 'Test Plan',
      jobs: [{ producerId: 'test', task: 'Test', dependencies: [] }]
    });
    
    let deletedPlanId: string | undefined;
    runner.on('planDeleted', (id: string) => {
      deletedPlanId = id;
    });
    
    // Simulate external deletion by manually triggering the file watcher event
    const planFilePath = path.join(plansDir, `plan-${plan.id}.json`);
    const planUri = vscode.Uri.file(planFilePath);
    
    // Trigger file deletion event
    (mockFileWatcher as any)._fireDelete(planUri);
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    assert.strictEqual(deletedPlanId, plan.id);
  });
  
  test('handles deletion of entire .orchestrator directory', async () => {
    const plan = runner.enqueue({
      name: 'Test Plan',
      jobs: [{ producerId: 'test', task: 'Test', dependencies: [] }]
    });
    
    // Verify plan exists in memory initially
    assert.ok(runner.get(plan.id));
    
    // Simulate external deletion by manually triggering the file watcher event
    const planFilePath = path.join(plansDir, `plan-${plan.id}.json`);
    const planUri = vscode.Uri.file(planFilePath);
    
    // Trigger file deletion event (simulating git clean -dfx)
    (mockFileWatcher as any)._fireDelete(planUri);
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Plan should be gone from memory
    assert.strictEqual(runner.get(plan.id), undefined);
  });
});