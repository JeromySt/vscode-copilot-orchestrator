/**
 * @fileoverview Unit tests for git repository operations.
 *
 * Tests the repository module (src/git/core/repository.ts) by mocking
 * the underlying git command executor. For ensureGitignore, uses real
 * temp directories since it uses fs.promises directly.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as repository from '../../../git/core/repository';
import * as executor from '../../../git/core/executor';
import type { CommandResult } from '../../../git/core/executor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(stdout = '', stderr = ''): CommandResult {
  return { success: true, stdout, stderr, exitCode: 0 };
}

function fail(stderr = '', stdout = '', exitCode = 1): CommandResult {
  return { success: false, stdout, stderr, exitCode };
}

/** Create a temp directory for fs-based tests. */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'repo-test-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('Git Repository Operations', () => {
  let execAsyncStub: sinon.SinonStub;
  let execAsyncOrNullStub: sinon.SinonStub;
  let execAsyncOrThrowStub: sinon.SinonStub;

  setup(() => {
    execAsyncStub = sinon.stub(executor, 'execAsync');
    execAsyncOrNullStub = sinon.stub(executor, 'execAsyncOrNull');
    execAsyncOrThrowStub = sinon.stub(executor, 'execAsyncOrThrow');
  });

  teardown(() => {
    sinon.restore();
  });

  // =========================================================================
  // fetch()
  // =========================================================================

  suite('fetch()', () => {
    test('fetches from origin by default', async () => {
      execAsyncOrThrowStub.resolves('');

      await repository.fetch('/repo');

      const [args, cwd] = execAsyncOrThrowStub.firstCall.args;
      assert.deepStrictEqual(args, ['fetch', 'origin']);
      assert.strictEqual(cwd, '/repo');
    });

    test('fetches all remotes', async () => {
      execAsyncOrThrowStub.resolves('');

      await repository.fetch('/repo', { all: true });

      const [args] = execAsyncOrThrowStub.firstCall.args;
      assert.deepStrictEqual(args, ['fetch', '--all']);
    });

    test('fetches with tags', async () => {
      execAsyncOrThrowStub.resolves('');

      await repository.fetch('/repo', { tags: true });

      const [args] = execAsyncOrThrowStub.firstCall.args;
      assert.ok(args.includes('--tags'));
    });

    test('uses custom remote', async () => {
      execAsyncOrThrowStub.resolves('');

      await repository.fetch('/repo', { remote: 'upstream' });

      const [args] = execAsyncOrThrowStub.firstCall.args;
      assert.ok(args.includes('upstream'));
    });

    test('invokes logger', async () => {
      execAsyncOrThrowStub.resolves('');
      const messages: string[] = [];

      await repository.fetch('/repo', { log: (m) => messages.push(m) });

      assert.ok(messages.some((m) => m.includes('Fetching')));
      assert.ok(messages.some((m) => m.includes('Fetch complete')));
    });
  });

  // =========================================================================
  // pull()
  // =========================================================================

  suite('pull()', () => {
    test('returns true on successful pull', async () => {
      execAsyncStub.resolves(ok('Already up to date.\n'));

      const result = await repository.pull('/repo');

      assert.strictEqual(result, true);
      const [args] = execAsyncStub.firstCall.args;
      assert.deepStrictEqual(args, ['pull', '--ff-only']);
    });

    test('returns true when no tracking branch', async () => {
      execAsyncStub.resolves(fail('no tracking information'));

      const result = await repository.pull('/repo');

      assert.strictEqual(result, true);
    });

    test('returns false on other failures', async () => {
      execAsyncStub.resolves(fail('fatal: error'));

      const result = await repository.pull('/repo');

      assert.strictEqual(result, false);
    });

    test('invokes logger on success', async () => {
      execAsyncStub.resolves(ok());
      const messages: string[] = [];

      await repository.pull('/repo', (m) => messages.push(m));

      assert.ok(messages.some((m) => m.includes('Pulling')));
      assert.ok(messages.some((m) => m.includes('Pull complete')));
    });

    test('invokes logger on failure', async () => {
      execAsyncStub.resolves(fail('conflict'));
      const messages: string[] = [];

      await repository.pull('/repo', (m) => messages.push(m));

      assert.ok(messages.some((m) => m.includes('Pull failed')));
    });
  });

  // =========================================================================
  // push()
  // =========================================================================

  suite('push()', () => {
    test('pushes to origin by default', async () => {
      execAsyncStub.resolves(ok());

      const result = await repository.push('/repo');

      assert.strictEqual(result, true);
      const [args] = execAsyncStub.firstCall.args;
      assert.deepStrictEqual(args, ['push', 'origin']);
    });

    test('pushes specific branch', async () => {
      execAsyncStub.resolves(ok());

      await repository.push('/repo', { branch: 'feature/x' });

      const [args] = execAsyncStub.firstCall.args;
      assert.ok(args.includes('feature/x'));
    });

    test('uses force-with-lease when force is true', async () => {
      execAsyncStub.resolves(ok());

      await repository.push('/repo', { force: true });

      const [args] = execAsyncStub.firstCall.args;
      assert.ok(args.includes('--force-with-lease'));
    });

    test('returns false on failure', async () => {
      execAsyncStub.resolves(fail('rejected'));

      const result = await repository.push('/repo');

      assert.strictEqual(result, false);
    });

    test('invokes logger', async () => {
      execAsyncStub.resolves(ok());
      const messages: string[] = [];

      await repository.push('/repo', { log: (m) => messages.push(m) });

      assert.ok(messages.some((m) => m.includes('Pushing')));
      assert.ok(messages.some((m) => m.includes('Push complete')));
    });
  });

  // =========================================================================
  // stageAll()
  // =========================================================================

  suite('stageAll()', () => {
    test('stages all changes', async () => {
      execAsyncOrThrowStub.resolves('');

      await repository.stageAll('/repo');

      const [args, cwd] = execAsyncOrThrowStub.firstCall.args;
      assert.deepStrictEqual(args, ['add', '-A']);
      assert.strictEqual(cwd, '/repo');
    });

    test('invokes logger', async () => {
      execAsyncOrThrowStub.resolves('');
      const messages: string[] = [];

      await repository.stageAll('/repo', (m) => messages.push(m));

      assert.ok(messages.some((m) => m.includes('Staging')));
    });
  });

  // =========================================================================
  // commit()
  // =========================================================================

  suite('commit()', () => {
    test('creates commit with message', async () => {
      execAsyncStub.resolves(ok());

      const result = await repository.commit('/repo', 'Initial commit');

      assert.strictEqual(result, true);
      const [args] = execAsyncStub.firstCall.args;
      assert.deepStrictEqual(args, ['commit', '-m', 'Initial commit']);
    });

    test('supports allowEmpty option', async () => {
      execAsyncStub.resolves(ok());

      await repository.commit('/repo', 'empty', { allowEmpty: true });

      const [args] = execAsyncStub.firstCall.args;
      assert.ok(args.includes('--allow-empty'));
    });

    test('returns true when nothing to commit', async () => {
      execAsyncStub.resolves(fail('', 'nothing to commit'));

      const result = await repository.commit('/repo', 'msg');

      assert.strictEqual(result, true);
    });

    test('returns true when nothing to commit in stderr', async () => {
      execAsyncStub.resolves(fail('nothing to commit'));

      const result = await repository.commit('/repo', 'msg');

      assert.strictEqual(result, true);
    });

    test('returns false on other failures', async () => {
      execAsyncStub.resolves(fail('error'));

      const result = await repository.commit('/repo', 'msg');

      assert.strictEqual(result, false);
    });

    test('invokes logger on success', async () => {
      execAsyncStub.resolves(ok());
      const messages: string[] = [];

      await repository.commit('/repo', 'msg', { log: (m) => messages.push(m) });

      assert.ok(messages.some((m) => m.includes('Creating commit')));
      assert.ok(messages.some((m) => m.includes('Committed')));
    });
  });

  // =========================================================================
  // hasChanges() / hasStagedChanges()
  // =========================================================================

  suite('hasChanges()', () => {
    test('returns true when there are changes', async () => {
      execAsyncStub.resolves(ok('M file.txt\n'));

      const result = await repository.hasChanges('/repo');

      assert.strictEqual(result, true);
    });

    test('returns false when clean', async () => {
      execAsyncStub.resolves(ok(''));

      const result = await repository.hasChanges('/repo');

      assert.strictEqual(result, false);
    });

    test('returns false when command fails', async () => {
      execAsyncStub.resolves(fail());

      const result = await repository.hasChanges('/repo');

      assert.strictEqual(result, false);
    });
  });

  suite('hasStagedChanges()', () => {
    test('returns true when staged changes exist', async () => {
      execAsyncStub.resolves(ok('file.txt\n'));

      const result = await repository.hasStagedChanges('/repo');

      assert.strictEqual(result, true);
      const [args] = execAsyncStub.firstCall.args;
      assert.deepStrictEqual(args, ['diff', '--cached', '--name-only']);
    });

    test('returns false when no staged changes', async () => {
      execAsyncStub.resolves(ok(''));

      const result = await repository.hasStagedChanges('/repo');

      assert.strictEqual(result, false);
    });
  });

  // =========================================================================
  // getHead()
  // =========================================================================

  suite('getHead()', () => {
    test('returns HEAD commit hash', async () => {
      execAsyncOrNullStub.resolves('abc123');

      const result = await repository.getHead('/repo');

      assert.strictEqual(result, 'abc123');
      const [args] = execAsyncOrNullStub.firstCall.args;
      assert.deepStrictEqual(args, ['rev-parse', 'HEAD']);
    });

    test('returns null when not a git repo', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await repository.getHead('/repo');

      assert.strictEqual(result, null);
    });
  });

  // =========================================================================
  // resolveRef()
  // =========================================================================

  suite('resolveRef()', () => {
    test('resolves ref to commit SHA', async () => {
      execAsyncOrThrowStub.resolves('abc123def456\n');

      const result = await repository.resolveRef('main', '/repo');

      assert.strictEqual(result, 'abc123def456');
      const [args] = execAsyncOrThrowStub.firstCall.args;
      assert.deepStrictEqual(args, ['rev-parse', 'main']);
    });
  });

  // =========================================================================
  // getCommitLog()
  // =========================================================================

  suite('getCommitLog()', () => {
    test('returns parsed commit log', async () => {
      const logOutput = [
        'abc123|abc|Alice|2024-01-01|First commit',
        'def456|def|Bob|2024-01-02|Second commit',
      ].join('\n');
      execAsyncOrNullStub.resolves(logOutput);

      const result = await repository.getCommitLog('from-ref', 'to-ref', '/repo');

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].hash, 'abc123');
      assert.strictEqual(result[0].shortHash, 'abc');
      assert.strictEqual(result[0].author, 'Alice');
      assert.strictEqual(result[0].message, 'First commit');
      assert.strictEqual(result[1].hash, 'def456');
    });

    test('returns empty array on null result', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await repository.getCommitLog('a', 'b', '/repo');

      assert.deepStrictEqual(result, []);
    });

    test('handles commit messages with pipe characters', async () => {
      execAsyncOrNullStub.resolves('abc|ab|Author|2024-01-01|msg|with|pipes');

      const result = await repository.getCommitLog('a', 'b', '/repo');

      assert.strictEqual(result[0].message, 'msg|with|pipes');
    });

    test('filters blank lines', async () => {
      execAsyncOrNullStub.resolves('abc|ab|Author|2024-01-01|msg\n\n');

      const result = await repository.getCommitLog('a', 'b', '/repo');

      assert.strictEqual(result.length, 1);
    });
  });

  // =========================================================================
  // getCommitChanges()
  // =========================================================================

  suite('getCommitChanges()', () => {
    test('returns parsed file changes', async () => {
      const output = ['A\tsrc/new.ts', 'M\tsrc/mod.ts', 'D\tsrc/old.ts'].join('\n');
      execAsyncOrNullStub.resolves(output);

      const result = await repository.getCommitChanges('abc123', '/repo');

      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].status, 'added');
      assert.strictEqual(result[0].path, 'src/new.ts');
      assert.strictEqual(result[1].status, 'modified');
      assert.strictEqual(result[2].status, 'deleted');
    });

    test('returns empty array on null result', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await repository.getCommitChanges('abc', '/repo');

      assert.deepStrictEqual(result, []);
    });

    test('handles rename status', async () => {
      execAsyncOrNullStub.resolves('R100\told.ts');

      const result = await repository.getCommitChanges('abc', '/repo');

      assert.strictEqual(result[0].status, 'renamed');
    });

    test('handles copy status', async () => {
      execAsyncOrNullStub.resolves('C100\tcopy.ts');

      const result = await repository.getCommitChanges('abc', '/repo');

      assert.strictEqual(result[0].status, 'copied');
    });

    test('defaults to modified for unknown status', async () => {
      execAsyncOrNullStub.resolves('X\tunknown.ts');

      const result = await repository.getCommitChanges('abc', '/repo');

      assert.strictEqual(result[0].status, 'modified');
    });
  });

  // =========================================================================
  // getDiffStats()
  // =========================================================================

  suite('getDiffStats()', () => {
    test('returns diff statistics', async () => {
      const output = ['A\tnew.ts', 'M\tmod.ts', 'D\told.ts', 'R100\trenamed.ts', 'C100\tcopied.ts'].join('\n');
      execAsyncOrNullStub.resolves(output);

      const result = await repository.getDiffStats('from', 'to', '/repo');

      assert.strictEqual(result.added, 2);    // A + C
      assert.strictEqual(result.modified, 2); // M + R
      assert.strictEqual(result.deleted, 1);
    });

    test('returns zeros on null result', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await repository.getDiffStats('a', 'b', '/repo');

      assert.deepStrictEqual(result, { added: 0, modified: 0, deleted: 0 });
    });

    test('returns zeros on empty output', async () => {
      execAsyncOrNullStub.resolves('');

      const result = await repository.getDiffStats('a', 'b', '/repo');

      assert.deepStrictEqual(result, { added: 0, modified: 0, deleted: 0 });
    });
  });

  // =========================================================================
  // ensureGitignore()
  // =========================================================================

  suite('ensureGitignore()', () => {
    let tempDir: string;

    setup(() => {
      tempDir = createTempDir();
    });

    teardown(() => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    });

    test('creates .gitignore with patterns when file does not exist', async () => {
      await repository.ensureGitignore(tempDir, ['.orchestrator/', 'coverage/']);

      const content = fs.readFileSync(path.join(tempDir, '.gitignore'), 'utf-8');
      assert.ok(content.includes('# Copilot Orchestrator'));
      assert.ok(content.includes('.orchestrator/'));
      assert.ok(content.includes('coverage/'));
    });

    test('appends to existing .gitignore', async () => {
      fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules/\n', 'utf-8');

      await repository.ensureGitignore(tempDir, ['.orchestrator/']);

      const content = fs.readFileSync(path.join(tempDir, '.gitignore'), 'utf-8');
      assert.ok(content.includes('node_modules/'));
      assert.ok(content.includes('.orchestrator/'));
    });

    test('does not duplicate existing patterns', async () => {
      fs.writeFileSync(path.join(tempDir, '.gitignore'), '.orchestrator/\n', 'utf-8');

      await repository.ensureGitignore(tempDir, ['.orchestrator/']);

      const content = fs.readFileSync(path.join(tempDir, '.gitignore'), 'utf-8');
      const count = (content.match(/\.orchestrator\//g) || []).length;
      assert.strictEqual(count, 1);
    });

    test('adds newline before appending if file does not end with newline', async () => {
      fs.writeFileSync(path.join(tempDir, '.gitignore'), 'node_modules/', 'utf-8');

      await repository.ensureGitignore(tempDir, ['.orchestrator/']);

      const content = fs.readFileSync(path.join(tempDir, '.gitignore'), 'utf-8');
      assert.ok(content.includes('node_modules/\n'));
    });

    test('invokes logger on update', async () => {
      const messages: string[] = [];

      await repository.ensureGitignore(tempDir, ['.orchestrator/'], (m) => messages.push(m));

      assert.ok(messages.some((m) => m.includes('Updated .gitignore')));
    });

    test('does not modify when all patterns exist', async () => {
      fs.writeFileSync(path.join(tempDir, '.gitignore'), '.orchestrator/\ncoverage/\n', 'utf-8');

      await repository.ensureGitignore(tempDir, ['.orchestrator/', 'coverage/']);

      const content = fs.readFileSync(path.join(tempDir, '.gitignore'), 'utf-8');
      assert.ok(!content.includes('# Copilot Orchestrator'));
    });

    test('handles patterns with leading slash', async () => {
      fs.writeFileSync(path.join(tempDir, '.gitignore'), '.orchestrator/\n', 'utf-8');

      // Pattern with leading slash should match existing pattern without it
      await repository.ensureGitignore(tempDir, ['/.orchestrator/']);

      const content = fs.readFileSync(path.join(tempDir, '.gitignore'), 'utf-8');
      // Should not duplicate since it checks after stripping leading /
      const count = (content.match(/orchestrator/g) || []).length;
      assert.strictEqual(count, 1);
    });
  });

  // =========================================================================
  // hasUncommittedChanges()
  // =========================================================================

  suite('hasUncommittedChanges()', () => {
    test('returns true when uncommitted changes exist', async () => {
      execAsyncStub.resolves(ok('M file.txt\n'));

      const result = await repository.hasUncommittedChanges('/repo');

      assert.strictEqual(result, true);
    });

    test('returns false when clean', async () => {
      execAsyncStub.resolves(ok(''));

      const result = await repository.hasUncommittedChanges('/repo');

      assert.strictEqual(result, false);
    });
  });

  // =========================================================================
  // stashPush()
  // =========================================================================

  suite('stashPush()', () => {
    test('returns true when changes are stashed', async () => {
      // hasUncommittedChanges check
      execAsyncStub
        .onFirstCall().resolves(ok('M file.txt\n'))  // status --porcelain
        .onSecondCall().resolves(ok());                // stash push

      const result = await repository.stashPush('/repo', 'WIP: saving');

      assert.strictEqual(result, true);
      const [args] = execAsyncStub.secondCall.args;
      assert.deepStrictEqual(args, ['stash', 'push', '-m', 'WIP: saving']);
    });

    test('returns false when nothing to stash', async () => {
      execAsyncStub.resolves(ok(''));  // status --porcelain returns empty

      const result = await repository.stashPush('/repo', 'WIP');

      assert.strictEqual(result, false);
    });

    test('throws when stash fails', async () => {
      execAsyncStub
        .onFirstCall().resolves(ok('M file.txt\n'))
        .onSecondCall().resolves(fail('stash error'));

      await assert.rejects(
        () => repository.stashPush('/repo', 'WIP'),
        /Failed to stash/
      );
    });

    test('invokes logger', async () => {
      execAsyncStub
        .onFirstCall().resolves(ok('M file.txt\n'))
        .onSecondCall().resolves(ok());
      const messages: string[] = [];

      await repository.stashPush('/repo', 'WIP', (m) => messages.push(m));

      assert.ok(messages.some((m) => m.includes('Stashing')));
      assert.ok(messages.some((m) => m.includes('stashed')));
    });

    test('logs when nothing to stash', async () => {
      execAsyncStub.resolves(ok(''));
      const messages: string[] = [];

      await repository.stashPush('/repo', 'WIP', (m) => messages.push(m));

      assert.ok(messages.some((m) => m.includes('Nothing to stash')));
    });
  });

  // =========================================================================
  // stashPop()
  // =========================================================================

  suite('stashPop()', () => {
    test('returns true on successful pop', async () => {
      execAsyncStub.resolves(ok());

      const result = await repository.stashPop('/repo');

      assert.strictEqual(result, true);
      const [args] = execAsyncStub.firstCall.args;
      assert.deepStrictEqual(args, ['stash', 'pop']);
    });

    test('returns false when no stash entries', async () => {
      execAsyncStub.resolves(fail('No stash entries found'));

      const result = await repository.stashPop('/repo');

      assert.strictEqual(result, false);
    });

    test('throws on other failures', async () => {
      execAsyncStub.resolves(fail('conflict during pop'));

      await assert.rejects(
        () => repository.stashPop('/repo'),
        /Failed to pop stash/
      );
    });

    test('invokes logger on success', async () => {
      execAsyncStub.resolves(ok());
      const messages: string[] = [];

      await repository.stashPop('/repo', (m) => messages.push(m));

      assert.ok(messages.some((m) => m.includes('Popping stash')));
      assert.ok(messages.some((m) => m.includes('Stash popped')));
    });

    test('invokes logger when no stash', async () => {
      execAsyncStub.resolves(fail('No stash entries found'));
      const messages: string[] = [];

      await repository.stashPop('/repo', (m) => messages.push(m));

      assert.ok(messages.some((m) => m.includes('No stash to pop')));
    });
  });

  // =========================================================================
  // stashList()
  // =========================================================================

  suite('stashList()', () => {
    test('returns list of stash entries', async () => {
      execAsyncOrNullStub.resolves('stash@{0}: WIP on main\nstash@{1}: WIP on feature');

      const result = await repository.stashList('/repo');

      assert.deepStrictEqual(result, ['stash@{0}: WIP on main', 'stash@{1}: WIP on feature']);
      const [args] = execAsyncOrNullStub.firstCall.args;
      assert.deepStrictEqual(args, ['stash', 'list']);
    });

    test('returns empty array on null result', async () => {
      execAsyncOrNullStub.resolves(null);

      const result = await repository.stashList('/repo');

      assert.deepStrictEqual(result, []);
    });

    test('filters blank lines', async () => {
      execAsyncOrNullStub.resolves('stash@{0}: WIP\n\n');

      const result = await repository.stashList('/repo');

      assert.deepStrictEqual(result, ['stash@{0}: WIP']);
    });
  });

  // =========================================================================
  // getIgnoredFiles()
  // =========================================================================

  suite('getIgnoredFiles()', () => {
    test('returns list of ignored files', async () => {
      execAsyncStub.resolves(ok('!! .env\n!! node_modules/package.json\n!! dist/app.js\n'));

      const result = await repository.getIgnoredFiles('/repo');

      assert.deepStrictEqual(result, ['.env', 'node_modules/package.json', 'dist/app.js']);
      const [args] = execAsyncStub.firstCall.args;
      assert.deepStrictEqual(args, ['status', '--ignored', '--short']);
    });

    test('returns empty array when no ignored files', async () => {
      execAsyncStub.resolves(ok(''));

      const result = await repository.getIgnoredFiles('/repo');

      assert.deepStrictEqual(result, []);
    });

    test('returns empty array on command failure', async () => {
      execAsyncStub.resolves(fail('not a git repository'));

      const result = await repository.getIgnoredFiles('/repo');

      assert.deepStrictEqual(result, []);
    });

    test('filters out non-ignored status lines', async () => {
      execAsyncStub.resolves(ok('M file.txt\n!! .env\n?? untracked.txt\n!! logs/\n'));

      const result = await repository.getIgnoredFiles('/repo');

      assert.deepStrictEqual(result, ['.env', 'logs/']);
    });

    test('handles files with spaces in names', async () => {
      execAsyncStub.resolves(ok('!! my file.txt\n!! "file with quotes.log"\n'));

      const result = await repository.getIgnoredFiles('/repo');

      assert.deepStrictEqual(result, ['my file.txt', '"file with quotes.log"']);
    });

    test('invokes logger on success', async () => {
      execAsyncStub.resolves(ok('!! .env\n'));
      const messages: string[] = [];

      await repository.getIgnoredFiles('/repo', (m) => messages.push(m));

      assert.ok(messages.some((m) => m.includes('Getting ignored files')));
      assert.ok(messages.some((m) => m.includes('Found 1 ignored files')));
    });

    test('invokes logger when no ignored files found', async () => {
      execAsyncStub.resolves(ok(''));
      const messages: string[] = [];

      await repository.getIgnoredFiles('/repo', (m) => messages.push(m));

      assert.ok(messages.some((m) => m.includes('Getting ignored files')));
      assert.ok(messages.some((m) => m.includes('No ignored files found')));
    });
  });
});