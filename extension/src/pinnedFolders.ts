import { basename } from 'node:path';
import * as vscode from 'vscode';

const viewId = 'pdfutl.pinnedFolders';
const storageKey = 'pinnedFolders';

class Entry extends vscode.TreeItem {
  readonly id: string;

  constructor(readonly uri: vscode.Uri, kind: 'pin' | 'folder' | 'pdf', parent?: string) {
    const name = basename(uri.fsPath) || uri.fsPath;
    super(name, kind === 'pdf'
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed);
    this.id = parent ? `${parent}/${encodeURIComponent(name)}` : encodeURIComponent(uri.toString());
    this.resourceUri = uri;
    this.tooltip = uri.fsPath;
    this.iconPath = kind === 'pdf' ? vscode.ThemeIcon.File : vscode.ThemeIcon.Folder;
    if (kind === 'pin') this.contextValue = 'pdfutl.pinnedRoot';
    if (kind === 'pdf') {
      this.command = {
        command: 'vscode.openWith', title: 'Open PDF', arguments: [uri, 'pdfutl.viewer', { preview: false }],
      };
    }
  }
}

class PinnedFolders implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  constructor(private readonly state: vscode.Memento) {}

  getTreeItem(entry: vscode.TreeItem): vscode.TreeItem { return entry; }

  async getChildren(entry?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!entry) return this.paths.map(path => new Entry(vscode.Uri.file(path), 'pin'));
    if (!(entry instanceof Entry) || entry.collapsibleState === vscode.TreeItemCollapsibleState.None) return [];

    try {
      const children = await vscode.workspace.fs.readDirectory(entry.uri);
      const folders = children.filter(([, type]) => type & vscode.FileType.Directory);
      const pdfs = children.filter(([name, type]) => (type & vscode.FileType.File) && /\.pdf$/i.test(name));
      const byName = ([first]: [string, vscode.FileType], [second]: [string, vscode.FileType]) => this.collator.compare(first, second);
      return [
        ...folders.sort(byName).map(([name]) => new Entry(vscode.Uri.joinPath(entry.uri, name), 'folder', entry.id)),
        ...pdfs.sort(byName).map(([name]) => new Entry(vscode.Uri.joinPath(entry.uri, name), 'pdf', entry.id)),
      ];
    } catch (error) {
      const unavailable = new vscode.TreeItem('Folder unavailable');
      unavailable.tooltip = error instanceof Error ? error.message : String(error);
      return [unavailable];
    }
  }

  async pin(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      title: 'Pin folders for PDFs', openLabel: 'Pin', canSelectFolders: true, canSelectFiles: false, canSelectMany: true,
    });
    if (!selected?.length) return;

    const paths = new Map(this.paths.map(path => [this.pathKey(path), path]));
    for (const uri of selected) {
      const key = this.pathKey(uri.fsPath);
      if (!paths.has(key)) paths.set(key, uri.fsPath);
    }
    await this.state.update(storageKey, [...paths.values()]);
    this.refresh();
  }

  async unpin(entry: Entry): Promise<void> {
    await this.state.update(storageKey, this.paths.filter(path => path !== entry.uri.fsPath));
    this.refresh();
  }

  refresh(): void { this.changed.fire(); }

  dispose(): void { this.changed.dispose(); }

  private get paths(): string[] { return this.state.get<string[]>(storageKey, []); }

  private pathKey(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path; }
}

export function registerPinnedFolders(context: vscode.ExtensionContext): void {
  const provider = new PinnedFolders(context.globalState);
  context.subscriptions.push(
    provider,
    vscode.window.registerTreeDataProvider(viewId, provider),
    vscode.commands.registerCommand('pdfutl.pinFolder', () => provider.pin()),
    vscode.commands.registerCommand('pdfutl.unpinFolder', (entry: unknown) => {
      if (entry instanceof Entry && entry.contextValue === 'pdfutl.pinnedRoot') return provider.unpin(entry);
    }),
    vscode.commands.registerCommand('pdfutl.refreshPinnedFolders', () => provider.refresh()),
  );
}
