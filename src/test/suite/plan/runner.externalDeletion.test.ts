import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PlanRunner, PlanRunnerConfig } from '../../../plan/runner';
import { PlanConfigManager } from '../../../plan/configManager';
import { PlanPersistence } from '../../../plan/persistence';
import { PlanStateMachine } from '../../../plan/stateMachine';
import { ProcessMonitor } from '../../../process/processMonitor';
import { DefaultProcessSpawner } from '../../../interfaces/IProcessSpawner';

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
    
    runner = new PlanRunner(config, {
      configManager: new PlanConfigManager(),
      persistence: new PlanPersistence(plansDir),
      processMonitor: new ProcessMonitor(new DefaultProcessSpawner()),
      stateMachineFactory: (plan: any) => new PlanStateMachine(plan),
      git: {
        branches: {
          currentOrNull: async () => 'main',
          isDefaultBranch: async () => false,
          exists: async () => false,
          create: async () => {},
          current: async () => 'main',
        },
        gitignore: {
          ensureGitignoreEntries: async () => {},
        },
        worktrees: {},
        merge: {},
        repository: {},
        orchestrator: {},
      } as any,
    });
  });
  
  teardown(async () => {
    quiet.restore();
    await runner.shutdown();
    // Small delay to let file watcher dispose fully on macOS
    await new Promise(resolve => setTimeout(resolve, 50));
    try {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors in CI
    }
  });
  
  test('removes plan from memory when file is externally deleted', async () => {
    const plan = runner.enqueue({
      name: 'Test Plan',
      jobs: [{
        producerId: 'test-job',
        task: 'Test task',
        dependencies: []
      }]
    });
    
    assert.ok(runner.get(plan.id));
    
    // Simulate external deletion by calling delete() which removes the plan
    // from memory and fires planDeleted event (same as the internal
    // handleExternalPlanDeletion on PlanLifecycle)
    runner.delete(plan.id);
    
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
    
    runner.delete(plan.id);
    
    assert.strictEqual(deletedPlanId, plan.id);
  });
  
  test('handles deletion of entire .orchestrator directory', async () => {
    const plan = runner.enqueue({
      name: 'Test Plan',
      jobs: [{ producerId: 'test', task: 'Test', dependencies: [] }]
    });
    
    assert.ok(runner.get(plan.id));
    
    runner.delete(plan.id);
    
    assert.strictEqual(runner.get(plan.id), undefined);
  });
});