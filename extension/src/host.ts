import { createHash, randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { basename } from 'node:path';
import * as vscode from 'vscode';
import { isPdfAnnotationActivity, isPdfFragment, isPdfReadingPosition, isSavedPdfCommentEdit, isSavedPdfHighlight, openAnnotationActivityCommand, type PdfFragment } from './pdfAnnotationActivity';
import { PdfHistory, samePdfFile } from './pdfHistory';
import { registerPinnedFolders } from './pinnedFolders';
import type { HostMessage, ViewerMessage } from './protocol';

const pendingHistoryWrites = new Set<Promise<void>>();

function trackHistoryWrite(write: Promise<void>): Promise<void> {
  pendingHistoryWrites.add(write);
  return write.finally(() => pendingHistoryWrites.delete(write));
}

function currentUserName(): string {
  try {
    return userInfo().username.trim() || 'Unknown user';
  } catch {
    return process.env.USERNAME?.trim() || process.env.USER?.trim() || 'Unknown user';
  }
}

interface PdfDocumentView {
  readonly uri: vscode.Uri;
  loaded: boolean;
}

class PdfViewer implements vscode.CustomReadonlyEditorProvider {
  private readonly panels = new Map<vscode.WebviewPanel, PdfDocumentView>();
  private readonly saving = new Set<vscode.WebviewPanel>();
  private pendingFragment?: { uri: vscode.Uri; fragment: PdfFragment };
  constructor(private readonly extensionUri: vscode.Uri, private readonly history: PdfHistory) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose() {} };
  }

  sendToActiveView(type: 'focusFind' | 'togglePageComments'): void {
    const panel = [...this.panels.keys()].find(candidate => candidate.active);
    if (!panel) return;
    panel.reveal(undefined, false);
    void panel.webview.postMessage({ type } satisfies HostMessage);
  }

  async saveAs(uri: vscode.Uri, viewColumn: number): Promise<boolean> {
    const panel = [...this.panels].find(([candidate, document]) =>
      candidate.viewColumn === viewColumn && document.loaded && samePdfFile(document.uri, uri))?.[0];
    if (!panel) {
      void vscode.window.showWarningMessage('Open the PDF before saving a copy.');
      return false;
    }
    if (this.saving.has(panel)) return false;
    this.saving.add(panel);
    try {
      const location = await this.history.saveLocation(uri);
      const copy = vscode.Uri.joinPath(location, '..', `${basename(location.path).replace(/\.pdf$/i, '')} (review).pdf`);
      const target = await vscode.window.showSaveDialog({
        defaultUri: copy,
        filters: { 'PDF': ['pdf'] },
        title: 'Save PDF As',
      });
      if (!target || !this.panels.has(panel)) return false;
      if (samePdfFile(target, uri)) throw new Error('Choose a different filename for the annotated copy.');

      const bytes = await this.requestExport(panel);
      if (!bytes) return false;
      await vscode.workspace.fs.writeFile(target, bytes);
      try {
        await trackHistoryWrite(this.history.recordCopy(uri, target, bytes));
      } catch (error) {
        console.error('PDF copy history:', error);
        void vscode.window.showWarningMessage('The PDF copy was saved. Timeline could not record this version.');
      }
      if (this.panels.has(panel)) {
        void panel.webview.postMessage({ type: 'saved', name: basename(target.path) } satisfies HostMessage);
      }
      return true;
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      this.saving.delete(panel);
    }
  }

  private requestExport(panel: vscode.WebviewPanel): Promise<Uint8Array | undefined> {
    const requestId = randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const subscriptions: vscode.Disposable[] = [];
      const finish = (bytes?: Uint8Array, error?: unknown) => {
        for (const subscription of subscriptions) subscription.dispose();
        if (error) reject(error);
        else resolve(bytes);
      };
      subscriptions.push(
        panel.onDidDispose(() => finish()),
        panel.webview.onDidReceiveMessage((message: ViewerMessage) => {
          if (message.type === 'ready') finish();
          if (message.type === 'exportedPdf' && message.requestId === requestId) {
            if (message.bytes instanceof ArrayBuffer) finish(new Uint8Array(message.bytes));
            else finish(undefined, new Error('The PDF viewer returned an invalid copy.'));
          }
          if (message.type === 'exportFailed' && message.requestId === requestId) {
            finish(undefined, new Error(message.message));
          }
        }),
      );
      void panel.webview.postMessage({ type: 'exportPdf', requestId } satisfies HostMessage).then(sent => {
        if (!sent) finish(undefined, new Error('Could not reach the PDF viewer.'));
      }, error => finish(undefined, error));
    });
  }

  async revealFragment(uri: vscode.Uri, fragment: PdfFragment): Promise<void> {
    const request = { uri, fragment };
    this.pendingFragment = request;
    if (this.deliverFragment()) return;
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'pdfutl.viewer', { preview: false });
      this.deliverFragment();
    } catch (error) {
      if (this.pendingFragment === request) this.pendingFragment = undefined;
      throw error;
    }
  }

  private deliverFragment(): boolean {
    const request = this.pendingFragment;
    if (!request) return false;
    for (const [panel, document] of this.panels) {
      if (!panel.active || !document.loaded || !samePdfFile(document.uri, request.uri)) continue;
      this.pendingFragment = undefined;
      void panel.webview.postMessage({ type: 'revealFragment', fragment: request.fragment } satisfies HostMessage);
      return true;
    }
    return false;
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const documentView = { uri: document.uri, loaded: false };
    this.panels.set(panel, documentView);
    const viewListener = panel.onDidChangeViewState(() => this.deliverFragment());
    const { webview } = panel;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, name));
    webview.options = { enableScripts: true, localResourceRoots: [dist] };

    const post = (message: HostMessage) => webview.postMessage(message);
    const name = basename(document.uri.path);
    let revision: string | undefined;
    const listener = webview.onDidReceiveMessage(async (message: ViewerMessage) => {
      try {
        switch (message.type) {
          case 'ready': {
            documentView.loaded = false;
            const bytes = await vscode.workspace.fs.readFile(document.uri);
            revision = createHash('sha256').update(bytes).digest('hex');
            let annotations: Awaited<ReturnType<PdfHistory['readAnnotations']>> = { highlights: [], commentEdits: [] };
            try {
              annotations = await this.history.readAnnotations(document.uri, revision);
            } catch (error) {
              console.error('PDF annotation restore:', error);
              void vscode.window.showWarningMessage('Could not read annotations saved in the PDFUtl profile.');
            }
            await post({ type: 'open', name, bytes: Uint8Array.from(bytes).buffer, user: this.history.user, ...annotations });
            break;
          }
          case 'opened':
            if (!documentView.loaded) {
              documentView.loaded = true;
              this.deliverFragment();
            }
            break;
          case 'annotationSaved': {
            const highlights = Array.isArray(message.highlights) && message.highlights.length > 0 &&
              message.highlights.every(isSavedPdfHighlight) ? message.highlights : undefined;
            const edit = message.commentEdit && { ...message.commentEdit, editor: this.history.user };
            const commentEdit = isSavedPdfCommentEdit(edit) ? edit : undefined;
            if (revision && isPdfAnnotationActivity(message.activity) && (highlights || commentEdit)) {
              try {
                await trackHistoryWrite(this.history.recordAnnotation(document.uri, revision, message.activity, highlights, commentEdit));
              } catch (error) {
                console.error('PDF annotation save:', error);
                await post({ type: 'annotationSaveError', message: 'Could not save this annotation in the PDFUtl profile.' });
              }
            }
            break;
          }
          case 'readingPosition':
            if (documentView.loaded && isPdfReadingPosition(message.position)) {
              void trackHistoryWrite(this.history.recordReadingPosition(document.uri, message.position))
                .catch(error => console.error('PDF reading position:', error));
            }
            break;
          case 'openError':
            console.error(`PDF viewer: ${message.message}`);
            break;
        }
      } catch (error) {
        await post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    });

    panel.onDidDispose(() => {
      this.panels.delete(panel);
      viewListener.dispose();
      listener.dispose();
    });
    const nonce = randomBytes(16).toString('base64');
    webview.html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src blob:; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} blob: data:; connect-src ${webview.cspSource};">
  <link rel="stylesheet" href="${asset('viewer.css')}">
  <title>PDF Viewer</title>
</head>
<body>
  <div id="app" data-worker="${asset('pdf-worker.js')}" data-wasm="${asset('pdfium.wasm')}"></div>
  <script nonce="${nonce}" src="${asset('viewer.js')}"></script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  registerPinnedFolders(context);
  const history = new PdfHistory(context.globalStorageUri, currentUserName());
  const provider = new PdfViewer(context.extensionUri, history);
  context.subscriptions.push(
    history,
    vscode.commands.registerCommand('pdfutl.find', () => provider.sendToActiveView('focusFind')),
    vscode.commands.registerCommand('pdfutl.togglePageComments', () => provider.sendToActiveView('togglePageComments')),
    vscode.commands.registerCommand('pdfutl.saveAs', (uri: unknown, viewColumn: unknown) => {
      if (uri instanceof vscode.Uri && typeof viewColumn === 'number') return provider.saveAs(uri, viewColumn);
      return false;
    }),
    vscode.commands.registerCommand(openAnnotationActivityCommand, (uri: unknown, fragment: unknown) => {
      if (uri instanceof vscode.Uri && uri.scheme === 'file' && /\.pdf$/i.test(uri.path) && isPdfFragment(fragment)) {
        return provider.revealFragment(uri, fragment);
      }
    }),
    vscode.window.registerCustomEditorProvider('pdfutl.viewer', provider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  void openStartupPdfs().catch(error => console.error('PDF startup:', error));
}

export async function deactivate(): Promise<void> {
  await Promise.allSettled(pendingHistoryWrites);
}

async function openStartupPdfs(): Promise<void> {
  // A local file passed to Code-OSS can open before editor contributions are ready.
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.isDirty || !(tab.input instanceof vscode.TabInputText) || !/\.pdf$/i.test(tab.input.uri.path)) continue;
      await vscode.commands.executeCommand('vscode.openWith', tab.input.uri, 'pdfutl.viewer', {
        viewColumn: group.viewColumn,
        preserveFocus: !tab.isActive,
        preview: false,
      });
      await vscode.window.tabGroups.close(tab, true);
    }
  }
}
