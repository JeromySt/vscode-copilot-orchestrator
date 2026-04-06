/**
 * @fileoverview Log file event producer for WebView subscriptions.
 *
 * Reads log files with byte-offset tracking for efficient delta delivery.
 * Used by the WebViewSubscriptionManager to stream log file content to webviews.
 *
 * @module ui/producers/logFileProducer
 */

import * as fs from 'fs';
import type { EventProducer } from '../webViewSubscriptionManager';

/** Cursor type for log file tracking — byte offset in the file. */
export type LogFileCursor = number;

/**
 * Event producer for log files. Tracks byte offsets to deliver only new content.
 */
export class LogFileProducer implements EventProducer<LogFileCursor> {
  readonly type = 'log';

  /**
   * Read the entire log file content.
   * @param key - Absolute path to the log file.
   */
  readFull(key: string): { content: string; cursor: LogFileCursor } | null {
    try {
      const content = fs.readFileSync(key, 'utf-8');
      const cursor = Buffer.byteLength(content, 'utf-8');
      return { content, cursor };
    } catch {
      // File may not exist yet — return empty with offset 0
      return { content: '', cursor: 0 };
    }
  }

  /**
   * Read new bytes since the last cursor position.
   * @param key - Absolute path to the log file.
   * @param cursor - Byte offset from last read.
   */
  readDelta(key: string, cursor: LogFileCursor): { content: string; cursor: LogFileCursor } | null {
    let fd: number;
    try {
      fd = fs.openSync(key, 'r');
    } catch {
      return null; // file may not exist yet
    }
    try {
      const stat = fs.fstatSync(fd);
      if (stat.size <= cursor) { return null; }
      const newBytes = Buffer.alloc(stat.size - cursor);
      fs.readSync(fd, newBytes, 0, newBytes.length, cursor);
      return {
        content: newBytes.toString('utf-8'),
        cursor: stat.size,
      };
    } finally {
      fs.closeSync(fd);
    }
  }
}
