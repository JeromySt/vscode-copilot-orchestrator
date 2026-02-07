/**
 * @fileoverview VS Code Extension Test Runner
 *
 * Downloads and launches VS Code, then runs the test suite inside it.
 * Executed by `npm test` via the compiled `out/test/runTest.js`.
 */

import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  try {
    // The folder containing the Extension Manifest (package.json)
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');

    // The path to the test runner script (compiled suite/index.js)
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    // Download VS Code, unzip it, and run the integration tests
    await runTests({ extensionDevelopmentPath, extensionTestsPath });
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exit(1);
  }
}

main();
