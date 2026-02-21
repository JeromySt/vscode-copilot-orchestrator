/**
 * @fileoverview Build-time metadata injected by esbuild.
 * 
 * `__BUILD_COMMIT__` and `__BUILD_TIMESTAMP__` are replaced at compile time
 * by esbuild's `define` option in esbuild.js. At runtime they are string
 * literals baked into the bundle.
 * 
 * When running from TypeScript directly (tests, ts-node), the globals don't
 * exist — fallback to 'dev'.
 * 
 * @module core/buildInfo
 */

/* eslint-disable no-var */
declare var __BUILD_COMMIT__: string;
declare var __BUILD_TIMESTAMP__: string;
declare var __BUILD_VERSION__: string;
/* eslint-enable no-var */

/** Short git commit hash captured at build time (e.g. "a71158e") */
export const BUILD_COMMIT: string =
  typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev';

/** ISO timestamp of when the bundle was built (e.g. "2026-02-20T22:15:00.000Z") */
export const BUILD_TIMESTAMP: string =
  typeof __BUILD_TIMESTAMP__ !== 'undefined' ? __BUILD_TIMESTAMP__ : new Date().toISOString();

/** Extension version from package.json captured at build time (e.g. "0.13.47") */
export const BUILD_VERSION: string =
  typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'dev';

/** Combined version string for display: "0.13.38 (a71158e @ 2026-02-20T22:15:00Z)" */
export function getBuildVersion(): string {
  let version = 'unknown';
  try {
    const path = require('path');
    const fs = require('fs');
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    if (fs.existsSync(pkgPath)) {
      version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || 'unknown';
    }
  } catch { /* ignore */ }
  return `${version} (${BUILD_COMMIT} @ ${BUILD_TIMESTAMP})`;
}
