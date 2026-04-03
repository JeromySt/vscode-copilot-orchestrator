/**
 * @fileoverview Release management webview data-injection script.
 *
 * This template renders a **tiny** inline `<script>` that serializes server-side
 * data and calls `window.Orca.initReleasePanel()`.  All logic, classes, regex,
 * and DOM manipulation live in `src/ui/webview/releasePanel.ts` — a proper
 * TypeScript file compiled by esbuild as browser code — eliminating escaping
 * issues that occurred when JS lived inside template literals.
 *
 * @module ui/templates/release/scriptsTemplate
 */

import type { ReleaseDefinition } from '../../../plan/types/release';
import type { AvailablePlanSummary } from '../../panels/releaseManagementPanel';

/**
 * Render the webview `<script>` block for the release management view.
 *
 * The block only injects JSON data and calls the bundled init function.
 * All UI logic is in `dist/webview/release.js` (loaded via `<script src>`).
 *
 * @param release - Release definition data.
 * @param nonce - CSP nonce for script execution.
 * @param availablePlans - Real plan summaries from the plan runner.
 * @returns HTML `<script>…</script>` string.
 */
export function renderReleaseScripts(release: ReleaseDefinition, nonce: string, availablePlans: AvailablePlanSummary[] = []): string {
  // Safely serialize data for embedding in a <script> tag.
  // JSON.stringify doesn't escape </script> or <!, which would prematurely
  // close the script tag if present in comment bodies or other user content.
  const safeJson = (obj: unknown): string =>
    JSON.stringify(obj)
      .replace(/<\//g, '<\\/')     // </script> → <\/script>
      .replace(/<!--/g, '<\\!--'); // <!-- → <\!--

  return `<script nonce="${nonce}">
    window.Orca.initReleasePanel({
      releaseData: ${safeJson(release)},
      availablePlans: ${safeJson(availablePlans)},
    });
  </script>`;
}
