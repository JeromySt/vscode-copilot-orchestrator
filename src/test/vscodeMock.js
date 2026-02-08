/**
 * @fileoverview Global vscode mock for running Mocha tests outside VS Code.
 *
 * Loaded via mocha --require before any test file.
 * Intercepts `require('vscode')` so that source modules resolve to a stub.
 */

const Module = require('module');

const vscodeMock = {
  commands: {
    executeCommand: (...args) => Promise.resolve(),
    getCommands: () => Promise.resolve([]),
    registerCommand: () => ({ dispose: () => {} }),
  },
  window: {
    createStatusBarItem: () => ({
      text: '',
      tooltip: undefined,
      command: undefined,
      alignment: 1,
      priority: 0,
      show: () => {},
      hide: () => {},
      dispose: () => {},
    }),
    createWebviewPanel: () => ({
      webview: { html: '', onDidReceiveMessage: () => ({ dispose: () => {} }) },
      onDidDispose: () => ({ dispose: () => {} }),
      reveal: () => {},
      dispose: () => {},
    }),
    showInformationMessage: () => Promise.resolve(),
    showErrorMessage: () => Promise.resolve(),
    showWarningMessage: () => Promise.resolve(),
    createOutputChannel: () => ({
      appendLine: () => {},
      append: () => {},
      show: () => {},
      dispose: () => {},
    }),
  },
  workspace: {
    getConfiguration: () => ({
      get: () => undefined,
      update: () => Promise.resolve(),
    }),
    workspaceFolders: [],
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  },
  extensions: {
    all: [{ id: 'mock.extension' }],
    getExtension: () => undefined,
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { One: 1, Two: 2, Beside: 2 },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
    parse: (s) => ({ fsPath: s, scheme: 'file', toString: () => s }),
  },
  EventEmitter: class {
    constructor() { this._listeners = []; }
    get event() { return (fn) => { this._listeners.push(fn); return { dispose: () => {} }; }; }
    fire(data) { this._listeners.forEach((fn) => fn(data)); }
    dispose() { this._listeners = []; }
  },
  Disposable: { from: (...disposables) => ({ dispose: () => disposables.forEach((d) => d.dispose()) }) },
  MarkdownString: class { constructor(value) { this.value = value || ''; } },
  TreeItem: class { constructor(label) { this.label = label; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
};

// Intercept Node's module resolution
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') {
    return 'vscode';
  }
  return originalResolveFilename.call(this, request, ...rest);
};

// Register mock in require.cache
require.cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: vscodeMock,
  parent: null,
  children: [],
  paths: [],
  path: '',
};
