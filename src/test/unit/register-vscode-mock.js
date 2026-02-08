/**
 * @fileoverview Register the vscode mock module before any test imports.
 *
 * Usage (Mocha):
 *   mocha --require src/test/unit/register-vscode-mock.js ...
 *
 * Or after compilation:
 *   mocha --require out/test/unit/register-vscode-mock.js ...
 *
 * This hooks into Node's module resolution so that any
 *   `import * as vscode from 'vscode'`  or  `require('vscode')`
 * will receive the mock instead of throwing MODULE_NOT_FOUND.
 */

'use strict';

const Module = require('module');
const path = require('path');

// Resolve the compiled mock in the "out" directory tree.
// __dirname is src/test/unit/ — go up to the repo root then into out/.
const mockPath = path.resolve(__dirname, '..', '..', '..', 'out', 'test', 'unit', 'mocks', 'vscode.js');

// Keep a reference to the original resolver.
const originalResolveFilename = Module._resolveFilename;

/**
 * Override Module._resolveFilename so that any request for the
 * 'vscode' module is redirected to our mock.
 */
Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request === 'vscode') {
    return mockPath;
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
