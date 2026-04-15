/**
 * @fileoverview Handler that extracts the Copilot session ID from stdout.
 *
 * Replaces the inline `extractSession()` closure in copilotCliRunner.ts.
 * Three regex patterns are tried in order; once a session ID is captured,
 * subsequent lines are skipped (early return).
 *
 * @see docs/PROCESS_OUTPUT_BUS_DESIGN.md §6.3
 * @module agent/handlers/sessionIdHandler
 */

import type { IOutputHandler, OutputSource } from '../../interfaces/IOutputHandler';
import { OutputSources } from '../../interfaces/IOutputHandler';
import type { IOutputHandlerFactory } from '../../interfaces/IOutputHandlerRegistry';

const RE_SESSION_PATTERNS = [
  /Session ID[:\s]+([a-f0-9-]{36})/i,
  /session[:\s]+([a-f0-9-]{36})/i,
  /Starting session[:\s]+([a-f0-9-]{36})/i,
];

export class SessionIdHandler implements IOutputHandler {
  readonly name = 'session-id';
  readonly sources = [OutputSources.stdout];
  readonly windowSize = 1;

  private _sessionId?: string;

  onLine(window: ReadonlyArray<string>, _source: OutputSource): void {
    if (this._sessionId) { return; }
    const line = window[window.length - 1];
    for (const re of RE_SESSION_PATTERNS) {
      const match = re.exec(line);
      if (match) { this._sessionId = match[1]; return; }
    }
  }

  getSessionId(): string | undefined { return this._sessionId; }
}

export const SessionIdHandlerFactory: IOutputHandlerFactory = {
  name: 'session-id',
  processFilter: ['copilot'],
  create: () => new SessionIdHandler(),
};
