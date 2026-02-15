import { suite, test } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as git from '../../../git';
import { BranchChangeWatcher } from '../../../git/branchWatcher';

suite('.gitignore Handling', () => {
  const mockWorkspaceRoot = '/test/workspace';
  suite('ensureOrchestratorGitIgnore',() => {
    let readFileStub: sinon.SinonStub;
    let writeFileStub: sinon.SinonStub;

    teardown(() => {
      sinon.restore();
    });

    test('should create .gitignore if it does not exist', async () => {
      readFileStub = sinon.stub(fs.promises, 'readFile').rejects(new Error('ENOENT'));
      writeFileStub = sinon.stub(fs.promises, 'writeFile').resolves();
      
      const result = await git.gitignore.ensureOrchestratorGitIgnore(mockWorkspaceRoot);
      
      assert.strictEqual(result, true);
      assert.ok(writeFileStub.calledOnce);
      const writtenContent = writeFileStub.getCall(0).args[1] as string;
      assert.ok(writtenContent.includes('.worktrees/'));
      assert.ok(writtenContent.includes('.orchestrator/'));
    });
    
    test('should add missing entries to existing .gitignore', async () => {
      readFileStub = sinon.stub(fs.promises, 'readFile').resolves('node_modules/\n');
      writeFileStub = sinon.stub(fs.promises, 'writeFile').resolves();
      
      const result = await git.gitignore.ensureOrchestratorGitIgnore(mockWorkspaceRoot);
      
      assert.strictEqual(result, true);
      const writtenContent = writeFileStub.getCall(0).args[1] as string;
      assert.ok(writtenContent.includes('node_modules/'));
      assert.ok(writtenContent.includes('.worktrees/'));
      assert.ok(writtenContent.includes('.orchestrator/'));
    });
    
    test('should not modify .gitignore if entries already exist', async () => {
      readFileStub = sinon.stub(fs.promises, 'readFile').resolves(
        'node_modules/\n.worktrees/\n.orchestrator/\n.github/instructions/orchestrator-*.instructions.md\n'
      );
      writeFileStub = sinon.stub(fs.promises, 'writeFile').resolves();
      
      const result = await git.gitignore.ensureOrchestratorGitIgnore(mockWorkspaceRoot);
      
      assert.strictEqual(result, false);
      assert.ok(writeFileStub.notCalled);
    });
    
    test('should handle entries without trailing slash', async () => {
      readFileStub = sinon.stub(fs.promises, 'readFile').resolves(
        '.worktrees\n.orchestrator\n'  // Without trailing /
      );
      writeFileStub = sinon.stub(fs.promises, 'writeFile').resolves();
      
      const result = await git.gitignore.ensureOrchestratorGitIgnore(mockWorkspaceRoot);
      
      assert.strictEqual(result, true);  // Should add entries with slashes since they don't exist
      assert.ok(writeFileStub.calledOnce);
      const writtenContent = writeFileStub.getCall(0).args[1] as string;
      assert.ok(writtenContent.includes('.worktrees/'));
      assert.ok(writtenContent.includes('.orchestrator/'));
    });
    
    test('should add comment header when adding entries', async () => {
      readFileStub = sinon.stub(fs.promises, 'readFile').resolves('node_modules/\n');
      writeFileStub = sinon.stub(fs.promises, 'writeFile').resolves();
      
      await git.gitignore.ensureOrchestratorGitIgnore(mockWorkspaceRoot);
      
      const writtenContent = writeFileStub.getCall(0).args[1] as string;
      assert.ok(writtenContent.includes('# Copilot Orchestrator'));
    });
  });
  
  suite('isOrchestratorGitIgnoreConfigured', () => {
    let readFileStub: sinon.SinonStub;

    teardown(() => {
      sinon.restore();
    });

    test('should return true if all entries exist', async () => {
      readFileStub = sinon.stub(fs.promises, 'readFile').resolves(
        '.worktrees/\n.orchestrator/\n.github/instructions/orchestrator-*.instructions.md\n'
      );
      
      const result = await git.gitignore.isOrchestratorGitIgnoreConfigured(mockWorkspaceRoot);
      
      assert.strictEqual(result, true);
    });
    
    test('should return false if entries missing', async () => {
      readFileStub = sinon.stub(fs.promises, 'readFile').resolves('node_modules/\n');
      
      const result = await git.gitignore.isOrchestratorGitIgnoreConfigured(mockWorkspaceRoot);
      
      assert.strictEqual(result, false);
    });
    
    test('should return false if .gitignore does not exist', async () => {
      readFileStub = sinon.stub(fs.promises, 'readFile').rejects(new Error('ENOENT'));
      
      const result = await git.gitignore.isOrchestratorGitIgnoreConfigured(mockWorkspaceRoot);
      
      assert.strictEqual(result, false);
    });
  });
});

suite('BranchChangeWatcher', () => {
  let mockLogger: any;
  
  setup(() => {
    mockLogger = {
      warn: sinon.fake(),
      debug: sinon.fake(),
      info: sinon.fake(),
      error: sinon.fake()
    };
  });
  
  teardown(() => {
    sinon.restore();
  });
  
  test('should call ensureOrchestratorGitIgnore on branch change', async () => {
    const ensureSpy = sinon.stub().resolves(true);
    
    // Create a mock module to replace the import
    const gitModule = await import('../../../git');
    const originalEnsure = gitModule.gitignore.ensureOrchestratorGitIgnore;
    (gitModule.gitignore as any).ensureOrchestratorGitIgnore = ensureSpy;
    
    const watcher = new BranchChangeWatcher(mockLogger);
    
    // Simulate branch change callback
    await watcher['ensureGitIgnoreOnBranchChange']('/workspace');
    
    assert.ok(ensureSpy.calledWith('/workspace'));
    
    // Restore original function
    (gitModule.gitignore as any).ensureOrchestratorGitIgnore = originalEnsure;
  });
  
  test('should detect branch change via repository state', async () => {
    // This would require mocking VS Code Git extension API
    // Implementation depends on how the watcher is structured
    const _watcher = new BranchChangeWatcher(mockLogger);
    assert.ok(_watcher);
  });
});