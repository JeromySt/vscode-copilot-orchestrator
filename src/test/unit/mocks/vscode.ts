/**
 * @fileoverview Minimal vscode API mock for unit tests that run outside VS Code.
 *
 * Provides stub implementations of the most-used vscode APIs so that
 * production modules can be imported without the real extension host.
 */

// ---------------------------------------------------------------------------
// Disposable
// ---------------------------------------------------------------------------

export class Disposable {
  private _callOnDispose?: () => void;

  constructor(callOnDispose?: () => void) {
    this._callOnDispose = callOnDispose;
  }

  static from(...disposables: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => {
      for (const d of disposables) {
        d.dispose();
      }
    });
  }

  dispose(): void {
    this._callOnDispose?.();
  }
}

// ---------------------------------------------------------------------------
// EventEmitter
// ---------------------------------------------------------------------------

export class EventEmitter<T> {
  private _listeners: Array<(e: T) => void> = [];

  event = (listener: (e: T) => void): Disposable => {
    this._listeners.push(listener);
    return new Disposable(() => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) { this._listeners.splice(idx, 1); }
    });
  };

  fire(data: T): void {
    for (const listener of this._listeners) {
      listener(data);
    }
  }

  dispose(): void {
    this._listeners = [];
  }
}

// ---------------------------------------------------------------------------
// Uri
// ---------------------------------------------------------------------------

export class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  readonly fsPath: string;

  private constructor(scheme: string, authority: string, path: string, query: string, fragment: string) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
    this.fsPath = path.replace(/\//g, '\\');
  }

  static file(fsPath: string): Uri {
    return new Uri('file', '', fsPath.replace(/\\/g, '/'), '', '');
  }

  static parse(value: string): Uri {
    try {
      const url = new URL(value);
      return new Uri(url.protocol.replace(':', ''), url.host, url.pathname, url.search.replace('?', ''), url.hash.replace('#', ''));
    } catch {
      return new Uri('', '', value, '', '');
    }
  }

  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`;
  }

  with(_change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(
      _change.scheme ?? this.scheme,
      _change.authority ?? this.authority,
      _change.path ?? this.path,
      _change.query ?? this.query,
      _change.fragment ?? this.fragment,
    );
  }
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function _noop(..._args: unknown[]): undefined { return undefined; }

function createOutputChannel(_name: string) {
  return {
    append: _noop,
    appendLine: _noop,
    clear: _noop,
    show: _noop,
    hide: _noop,
    dispose: _noop,
  };
}

function createStatusBarItem(_alignment?: StatusBarAlignment, _priority?: number) {
  return {
    text: '',
    tooltip: '',
    command: undefined as string | undefined,
    alignment: _alignment ?? StatusBarAlignment.Left,
    priority: _priority ?? 0,
    show: _noop,
    hide: _noop,
    dispose: _noop,
  };
}

function createTerminal(_options?: unknown) {
  return {
    show: _noop,
    sendText: _noop,
    dispose: _noop,
  };
}

function createWebviewPanel(_viewType: string, _title: string, _showOptions: unknown, _options?: unknown) {
  const onDidDisposeEmitter = new EventEmitter<void>();
  const onDidReceiveMessageEmitter = new EventEmitter<unknown>();
  return {
    webview: {
      html: '',
      onDidReceiveMessage: onDidReceiveMessageEmitter.event,
      postMessage: async (_msg: unknown) => true,
      asWebviewUri: (uri: Uri) => uri,
      cspSource: '',
    },
    onDidDispose: onDidDisposeEmitter.event,
    reveal: _noop,
    dispose: _noop,
  };
}

export const window = {
  showInformationMessage: async (..._args: unknown[]) => undefined as string | undefined,
  showWarningMessage: async (..._args: unknown[]) => undefined as string | undefined,
  showErrorMessage: async (..._args: unknown[]) => undefined as string | undefined,
  showQuickPick: async (..._args: unknown[]) => undefined,
  showInputBox: async (..._args: unknown[]) => undefined as string | undefined,
  createOutputChannel,
  createStatusBarItem,
  createTerminal,
  createWebviewPanel,
  registerWebviewViewProvider: (_viewType: string, _provider: unknown) => new Disposable(),
  withProgress: async <T>(_options: unknown, task: (progress: unknown, token: unknown) => Thenable<T>): Promise<T> => {
    return task({ report: _noop }, { isCancellationRequested: false, onCancellationRequested: new EventEmitter<void>().event });
  },
};

// ---------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------

function createMockConfiguration(): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  return {
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      return (store[key] as T) ?? defaultValue;
    },
    has: (key: string): boolean => key in store,
    update: async (_key: string, _value: unknown, _target?: ConfigurationTarget) => {},
    inspect: (_key: string) => undefined,
  };
}

const onDidChangeConfigurationEmitter = new EventEmitter<{ affectsConfiguration: (section: string) => boolean }>();

export const workspace = {
  getConfiguration: (_section?: string) => createMockConfiguration(),
  workspaceFolders: undefined as Array<{ uri: Uri; name: string; index: number }> | undefined,
  onDidChangeConfiguration: onDidChangeConfigurationEmitter.event,
  fs: {
    readFile: async (_uri: Uri) => new Uint8Array(),
    writeFile: async (_uri: Uri, _content: Uint8Array) => {},
    stat: async (_uri: Uri) => ({ type: 1, ctime: 0, mtime: 0, size: 0 }),
  },
};

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const _commandRegistry = new Map<string, (...args: unknown[]) => unknown>();

export const commands = {
  registerCommand: (command: string, callback: (...args: unknown[]) => unknown): Disposable => {
    _commandRegistry.set(command, callback);
    return new Disposable(() => { _commandRegistry.delete(command); });
  },
  executeCommand: async <T>(command: string, ...args: unknown[]): Promise<T | undefined> => {
    const handler = _commandRegistry.get(command);
    if (handler) { return handler(...args) as T; }
    return undefined;
  },
  getCommands: async (_filterInternal?: boolean): Promise<string[]> => {
    return Array.from(_commandRegistry.keys());
  },
};

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

export const env = {
  clipboard: {
    readText: async () => '',
    writeText: async (_value: string) => {},
  },
  openExternal: async (_target: Uri) => true,
  uriScheme: 'vscode',
  language: 'en',
};

// ---------------------------------------------------------------------------
// extensions
// ---------------------------------------------------------------------------

export const extensions = {
  getExtension: (_extensionId: string) => undefined,
  all: [] as unknown[],
};

// ---------------------------------------------------------------------------
// ThemeIcon
// ---------------------------------------------------------------------------

export class ThemeIcon {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

// ---------------------------------------------------------------------------
// CancellationTokenSource
// ---------------------------------------------------------------------------

export class CancellationTokenSource {
  private _emitter = new EventEmitter<void>();
  token = {
    isCancellationRequested: false,
    onCancellationRequested: this._emitter.event,
  };

  cancel(): void {
    this.token.isCancellationRequested = true;
    this._emitter.fire();
  }

  dispose(): void {
    this._emitter.dispose();
  }
}
