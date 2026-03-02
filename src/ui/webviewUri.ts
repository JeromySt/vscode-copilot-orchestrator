/**
 * @fileoverview Webview bundle URI helper.
 *
 * Utilities for resolving webview bundle URIs and generating script tags.
 *
 * @module ui/webviewUri
 */

import * as vscode from 'vscode';

export type WebviewBundle = 'planDetail' | 'nodeDetail' | 'plansList';

/**
 * Get the webview URI for a specific bundle.
 *
 * @param webview - The webview instance.
 * @param extensionUri - The extension URI.
 * @param bundle - The bundle name.
 * @returns The webview URI for the bundle.
 */
export function getWebviewBundleUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  bundle: WebviewBundle,
): vscode.Uri {
  return webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', `${bundle}.js`),
  );
}

/**
 * Generate a script tag for a webview bundle.
 *
 * @param webview - The webview instance.
 * @param extensionUri - The extension URI.
 * @param bundle - The bundle name.
 * @returns An HTML script tag string.
 */
export function webviewScriptTag(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  bundle: WebviewBundle,
): string {
  const uri = getWebviewBundleUri(webview, extensionUri, bundle);
  return `<script src="${uri}"></script>`;
}
