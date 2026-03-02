/**
 * @fileoverview Unit tests for webviewUri helper
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';
import { getWebviewBundleUri, webviewScriptTag } from '../../../ui/webviewUri';
import type * as vscode from 'vscode';

suite('webviewUri', () => {
  let mockWebview: any;
  let mockExtensionUri: any;
  let sandbox: sinon.SinonSandbox;
  let joinPathStub: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();

    // Create a stub for Uri.joinPath that will be called
    joinPathStub = sandbox.stub();
    joinPathStub.callsFake((...args: any[]) => {
      return { 
        fsPath: args.slice(1).join('/'),
        _isUri: true 
      } as any;
    });

    // Mock vscode.Uri with joinPath
    const vscodeModule = require('vscode');
    vscodeModule.Uri.joinPath = joinPathStub;

    mockExtensionUri = { fsPath: '/ext/path' } as vscode.Uri;

    mockWebview = {
      asWebviewUri: sandbox.stub().callsFake((uri: any) => {
        return {
          toString: () => `vscode-webview://bundle/${uri.fsPath}`,
          fsPath: uri.fsPath
        } as vscode.Uri;
      })
    };
  });

  teardown(() => {
    sandbox.restore();
  });

  suite('getWebviewBundleUri', () => {
    test('should return URI for planDetail bundle', () => {
      const uri = getWebviewBundleUri(mockWebview, mockExtensionUri, 'planDetail');
      
      assert.ok(mockWebview.asWebviewUri.calledOnce);
      assert.strictEqual(uri.toString(), 'vscode-webview://bundle/dist/webview/planDetail.js');
    });

    test('should return URI for nodeDetail bundle', () => {
      const uri = getWebviewBundleUri(mockWebview, mockExtensionUri, 'nodeDetail');
      
      assert.ok(mockWebview.asWebviewUri.calledOnce);
      assert.strictEqual(uri.toString(), 'vscode-webview://bundle/dist/webview/nodeDetail.js');
    });

    test('should return URI for plansList bundle', () => {
      const uri = getWebviewBundleUri(mockWebview, mockExtensionUri, 'plansList');
      
      assert.ok(mockWebview.asWebviewUri.calledOnce);
      assert.strictEqual(uri.toString(), 'vscode-webview://bundle/dist/webview/plansList.js');
    });
  });

  suite('webviewScriptTag', () => {
    test('should generate script tag for planDetail', () => {
      const tag = webviewScriptTag(mockWebview, mockExtensionUri, 'planDetail');
      
      assert.strictEqual(tag, '<script src="vscode-webview://bundle/dist/webview/planDetail.js"></script>');
    });

    test('should generate script tag for nodeDetail', () => {
      const tag = webviewScriptTag(mockWebview, mockExtensionUri, 'nodeDetail');
      
      assert.strictEqual(tag, '<script src="vscode-webview://bundle/dist/webview/nodeDetail.js"></script>');
    });

    test('should generate script tag for plansList', () => {
      const tag = webviewScriptTag(mockWebview, mockExtensionUri, 'plansList');
      
      assert.strictEqual(tag, '<script src="vscode-webview://bundle/dist/webview/plansList.js"></script>');
    });
  });
});
