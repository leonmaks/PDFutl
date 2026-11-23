import { basename } from 'node:path';
import * as vscode from 'vscode';
import { formatPdfTimelineDate } from './pdfTimelineDate';

const viewId = 'pdfutl.pinnedFolders';
const storageKey = 'pinnedFolders';
const preferencesKey = 'pinnedFolderPreferences';

type EntryKind = 'pin' | 'folder' | 'pdf';
type SortField = 'name' | 'date';
type SortOrder = `${SortField}-${'asc' | 'desc'}`;
type Preferences = { readonly sort?: SortOrder; readonly showDates?: boolean };
type PinnedPreferences = { readonly section?: Preferences; readonly folders?: Record<string, Preferences> };

class Entry extends vscode.TreeItem {
  readonly id: string;
  readonly name: string;

  constructor(readonly uri: vscode.Uri, readonly kind: EntryKind, readonly parent?: Entry) {
    const name = basename(uri.fsPath) || uri.fsPath;
    super(name, kind === 'pdf'
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed);
    this.name = name;
    this.id = parent ? `${parent.id}/${encodeURIComponent(name)}` : encodeURIComponent(uri.toString());
    this.resourceUri = uri;
    this.tooltip = uri.fsPath;
    this.iconPath = kind === 'pdf' ? vscode.ThemeIcon.File : vscode.ThemeIcon.Folder;
    if (kind === 'pdf') {
      this.command = {
        command: 'vscode.openWith', title: 'Open PDF', arguments: [uri, 'pdfutl.viewer', { preview: false }],
      };
    }
  }
}

class PinnedFolders implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Entry | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  private preferences: PinnedPreferences;

  constructor(private readonly state: vscode.Memento) {
    this.preferences = state.get<PinnedPreferences>(preferencesKey, {});
  }

  getTreeItem(entry: vscode.TreeItem): vscode.TreeItem {
    if (entry instanceof Entry && entry.kind !== 'pdf') {
      const kind = entry.kind === 'pin' ? 'pinnedRoot' : 'pinnedFolder';
      const dates = this.folderShowsDates(entry) ? 'dates-shown' : 'dates-hidden';
      entry.contextValue = `pdfutl.${kind}:${this.options(entry).sort ?? 'name-asc'}:${dates}`;
    }
    return entry;
  }

  async getChildren(entry?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!entry) return this.sortEntries(this.paths.map(path => new Entry(vscode.Uri.file(path), 'pin')));
    if (!(entry instanceof Entry) || entry.kind === 'pdf') return [];
    let children: [string, vscode.FileType][];
    try {
      children = await vscode.workspace.fs.readDirectory(entry.uri);
    } catch (error) {
      const unavailable = new vscode.TreeItem('Folder unavailable');
      unavailable.tooltip = error instanceof Error ? error.message : String(error);
      return [unavailable];
    }
    const entries: Entry[] = [];
    for (const [name, type] of children) {
      const uri = vscode.Uri.joinPath(entry.uri, name);
      if (type & vscode.FileType.Directory) entries.push(new Entry(uri, 'folder', entry));
      else if ((type & vscode.FileType.File) && /\.pdf$/i.test(name)) entries.push(new Entry(uri, 'pdf', entry));
    }
    return this.sortEntries(entries, entry);
  }

  private async sortEntries(entries: Entry[], parent?: Entry): Promise<Entry[]> {
    const sort = this.options(parent).sort ?? 'name-asc';
    const sortByDate = sort.startsWith('date');
    const direction = sort.endsWith('desc') ? -1 : 1;
    const showDates = this.sectionShowsDates && this.folderShowsDates(parent);
    const rows = await Promise.all(entries.map(async entry => {
      const info = (showDates || sortByDate) ? await vscode.workspace.fs.stat(entry.uri).then(result => result, () => undefined) : undefined;
      const timestamp = info?.mtime;
      const date = showDates && timestamp !== undefined ? formatPdfTimelineDate(timestamp) : undefined;
      entry.description = date;
      entry.accessibilityInformation = { label: date ? `${entry.name}, ${date}` : entry.name };
      return { entry, timestamp };
    }));
    rows.sort((a, b) => {
      const group = Number(a.entry.kind === 'pdf') - Number(b.entry.kind === 'pdf');
      if (group) return group;
      if (sortByDate) {
        if (a.timestamp === undefined && b.timestamp !== undefined) return 1;
        if (b.timestamp === undefined && a.timestamp !== undefined) return -1;
        if (a.timestamp !== undefined && b.timestamp !== undefined && a.timestamp !== b.timestamp) {
          return direction * (a.timestamp - b.timestamp);
        }
      }
      const byName = this.collator.compare(a.entry.name, b.entry.name) || a.entry.name.localeCompare(b.entry.name);
      return sortByDate ? byName : direction * byName;
    });
    return rows.map(row => row.entry);
  }

  async updateSort(field: SortField, entry?: Entry): Promise<void> {
    const sort = this.options(entry).sort ?? 'name-asc';
    await this.updateOptions({ sort: sort === `${field}-asc` ? `${field}-desc` : `${field}-asc` }, entry);
  }

  async toggleDates(entry?: Entry): Promise<void> {
    const showDates = entry ? this.folderShowsDates(entry) : this.sectionShowsDates;
    await this.updateOptions({ showDates: !showDates }, entry);
  }

  private async updateOptions(changes: Preferences, entry?: Entry): Promise<void> {
    const preferences = this.preferences;
    const options = { ...this.options(entry), ...changes };
    this.preferences = entry
      ? { ...preferences, folders: { ...preferences.folders, [entry.id]: options } }
      : { ...preferences, section: options };
    await this.state.update(preferencesKey, this.preferences);
    if (!entry) await this.updateSectionContext();
    this.refresh(entry);
  }

  async updateSectionContext(): Promise<void> {
    await Promise.all([
      vscode.commands.executeCommand('setContext', `${viewId}.sort`, this.options().sort ?? 'name-asc'),
      vscode.commands.executeCommand('setContext', `${viewId}.showDates`, this.sectionShowsDates),
    ]);
  }

  private options(entry?: Entry): Preferences {
    const preferences = this.preferences;
    return (entry ? preferences.folders?.[entry.id] : preferences.section) ?? {};
  }

  private get sectionShowsDates(): boolean { return this.options().showDates ?? true; }

  private folderShowsDates(entry?: Entry): boolean {
    for (let folder = entry; folder; folder = folder.parent) {
      const showDates = this.options(folder).showDates;
      if (showDates !== undefined) return showDates;
    }
    return true;
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

  refresh(entry?: Entry): void { this.changed.fire(entry); }

  dispose(): void { this.changed.dispose(); }

  private get paths(): string[] { return this.state.get<string[]>(storageKey, []); }

  private pathKey(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path; }
}

export function registerPinnedFolders(context: vscode.ExtensionContext): void {
  const provider = new PinnedFolders(context.globalState);
  void provider.updateSectionContext();
  const isFolder = (entry: unknown): entry is Entry => entry instanceof Entry && entry.kind !== 'pdf';
  context.subscriptions.push(
    provider,
    vscode.window.registerTreeDataProvider(viewId, provider),
    vscode.commands.registerCommand('pdfutl.pinFolder', () => provider.pin()),
    vscode.commands.registerCommand('pdfutl.unpinFolder', (entry: unknown) => {
      if (entry instanceof Entry && entry.kind === 'pin') return provider.unpin(entry);
    }),
    vscode.commands.registerCommand('pdfutl.refreshPinnedFolders', () => provider.refresh()),
    vscode.commands.registerCommand('pdfutl.sortPinnedByNameInSection', () => provider.updateSort('name')),
    vscode.commands.registerCommand('pdfutl.sortPinnedByDateInSection', () => provider.updateSort('date')),
    vscode.commands.registerCommand('pdfutl.togglePinnedDatesInSection', () => provider.toggleDates()),
    vscode.commands.registerCommand('pdfutl.sortPinnedByName', (entry: unknown) => {
      if (isFolder(entry)) return provider.updateSort('name', entry);
    }),
    vscode.commands.registerCommand('pdfutl.sortPinnedByDate', (entry: unknown) => {
      if (isFolder(entry)) return provider.updateSort('date', entry);
    }),
    vscode.commands.registerCommand('pdfutl.togglePinnedDates', (entry: unknown) => {
      if (isFolder(entry)) return provider.toggleDates(entry);
    }),
  );
}
