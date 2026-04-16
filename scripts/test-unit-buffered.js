#!/usr/bin/env node
'use strict';

/**
 * Buffered unit test runner.
 *
 * Problem solved:
 *   Piping `npm run test:unit` to `Select-String | Select-Object -First N` in
 *   PowerShell causes a deadlock on Windows. Tests emit console output containing
 *   "error" text (from expected error-handling scenarios). Once N such lines match,
 *   Select-Object closes the pipe. Mocha does not handle broken pipes on Windows
 *   and hangs indefinitely until the orchestrator kills it (exit code -1).
 *
 * Solution:
 *   Run mocha with its stdout+stderr redirected to a temp file so it never touches
 *   the downstream pipe. After mocha exits (with its real exit code), stream the
 *   file to our own stdout. If the downstream consumer closes the pipe early (EPIPE),
 *   we exit cleanly with mocha's exit code rather than hanging.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const tmpDir = path.join(process.cwd(), '.orchestrator', 'tmp');
const tmpFile = path.join(tmpDir, 'test-unit-output.txt');

// Ensure temp directory exists
try {
  fs.mkdirSync(tmpDir, { recursive: true });
} catch {
  // Ignore — directory may already exist
}

// Open the temp file for writing
let outFd;
try {
  outFd = fs.openSync(tmpFile, 'w');
} catch (err) {
  process.stderr.write(`test-unit-buffered: failed to open temp file: ${err.message}\n`);
  process.exit(1);
}

// Run mocha synchronously, redirecting ALL output (stdout + stderr) to the
// temp file. spawnSync blocks until mocha exits, avoiding any pipe contention.
const result = spawnSync(process.execPath, [
  path.join('node_modules', 'mocha', 'bin', 'mocha.js'),
  '--ui', 'tdd',
  '--exit',
  '--reporter', 'min',
  'out/test/unit/**/*.test.js',
  '--require', 'src/test/unit/register-vscode-mock.js',
  '--timeout', '60000',
], {
  cwd: process.cwd(),
  env: process.env,
  // Direct both stdout and stderr into the temp file; mocha never writes to a pipe
  stdio: ['inherit', outFd, outFd],
});

try { fs.closeSync(outFd); } catch { /* ignore */ }

const exitCode = result.status ?? (result.signal ? 1 : 0);

function cleanup() {
  try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
}

// Handle EPIPE: downstream consumer (e.g., Select-Object -First 5) closed the
// read end of the pipe before we finished writing. This is expected — exit with
// mocha's actual exit code so the postchecks result reflects whether tests passed.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') {
    cleanup();
    process.exit(exitCode);
  }
});

// Stream the captured output to stdout after mocha has fully completed
let readStream;
try {
  readStream = fs.createReadStream(tmpFile);
} catch {
  cleanup();
  process.exit(exitCode);
}

readStream.on('error', () => {
  cleanup();
  process.exit(exitCode);
});

readStream.on('end', () => {
  // Give stdout a chance to flush before exiting
  setImmediate(() => {
    cleanup();
    process.exit(exitCode);
  });
});

readStream.pipe(process.stdout, { end: false });
