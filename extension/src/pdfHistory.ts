import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import * as vscode from 'vscode';
import { isPdfAnnotationActivity, isSavedPdfCommentEdit, isSavedPdfHighlight, openAnnotationActivityCommand, pdfCommentKey, type PdfAnnotationActivity, type PdfReadingPosition, type SavedPdfCommentEdit, type SavedPdfHighlight } from './pdfAnnotationActivity';
import { formatPdfTimelineDate, pdfTimelineSource } from './pdfTimelineDate';

interface SavedCopy {
  readonly id: string;
  readonly source: string;
  readonly exported: string;
  readonly timestamp: number;
  readonly user?: string;
}

interface AnnotationRecord {
  readonly id: string;
  readonly resource: string;
  readonly timestamp: number;
  readonly user?: string;
  readonly activity: PdfAnnotationActivity;
  readonly highlights?: readonly SavedPdfHighlight[];
  readonly commentEdit?: SavedPdfCommentEdit;
}

interface ReadingPositionRecord {
  readonly id: string;
  readonly resource: string;
  readonly timestamp: number;
  readonly user: string;
  readonly activity: { readonly kind: 'view'; readonly position: PdfReadingPosition };
}

const recordId = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const recordName = new RegExp('^(' + recordId + ')\\.json$');
const annotationRecordName = new RegExp('^annotation-([a-f0-9]{64})-(?:([a-f0-9]{64})-)?(' + recordId + ')\\.json$');

function actorName(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : 'Unknown user';
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function historyKey(path: string): string {
  return createHash('sha256').update(pathKey(path)).digest('hex');
}

function annotationKey(uri: vscode.Uri, revision: string): string {
  return createHash('sha256').update(pathKey(uri.fsPath)).update('\0').update(revision).digest('hex');
}

export function samePdfFile(first: vscode.Uri, second: vscode.Uri): boolean {
  return first.scheme === 'file' && second.scheme === 'file'
    ? pathKey(first.fsPath) === pathKey(second.fsPath)
    : first.toString() === second.toString();
}

export class PdfHistory implements vscode.TimelineProvider, vscode.Disposable {
  private readonly directory: vscode.Uri;
  private readonly changed = new vscode.EventEmitter<undefined>();
  private readonly subscriptions: vscode.Disposable;
  readonly onDidChangeTimeline = this.changed.event;

  constructor(storage: vscode.Uri, readonly user: string) {
    // Open archives as ordinary local PDFs so Timeline follows them by file URI.
    this.directory = vscode.Uri.joinPath(vscode.Uri.file(storage.fsPath), 'saved-pdf-copies');
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.directory, '*.json'));
    const updateTimeline = (uri: vscode.Uri) => {
      const file = basename(uri.path);
      if (recordName.test(file) || annotationRecordName.test(file)) this.changed.fire(undefined);
    };
    this.subscriptions = vscode.Disposable.from(
      this.changed, watcher,
      watcher.onDidCreate(updateTimeline),
      watcher.onDidDelete(updateTimeline),
      vscode.workspace.registerTimelineProvider(pdfTimelineSource, 'PDFUtl Activity', 'file', this),
    );
  }

  dispose(): void { this.subscriptions.dispose(); }

  async provideTimeline(uri: vscode.Uri, options: vscode.TimelineOptions, token: vscode.CancellationToken): Promise<vscode.Timeline | undefined> {
    if (!/\.pdf$/i.test(uri.path)) return;
    const records = await this.readRecords();
    const source = this.sourceFor(uri, records);
    const annotations = await this.annotationItems(source);
    if (token.isCancellationRequested) return;
    const versions = records.filter(record => pathKey(record.source) === pathKey(source));
    const items = [...versions.map((record, index) => this.toItem(record, versions.length - index)), ...annotations];
    items.sort((a, b) => b.timestamp - a.timestamp);
    const start = options.cursor ? items.findIndex(item => item.id === options.cursor) + 1 : 0;
    const end = options.limit === undefined ? items.length : start + options.limit;
    return {
      items: items.slice(start, end),
      cursor: end < items.length ? items[end - 1]?.id : undefined,
    };
  }

  async saveLocation(uri: vscode.Uri): Promise<vscode.Uri> {
    const parent = vscode.Uri.joinPath(uri, '..');
    if (!samePdfFile(vscode.Uri.joinPath(parent, '..'), this.directory)) return uri;
    const file = `${basename(parent.fsPath)}.json`;
    const record = await this.readRecord(file);
    return record && samePdfFile(uri, this.snapshotUri(record)) ? vscode.Uri.file(record.exported) : uri;
  }

  async readAnnotations(uri: vscode.Uri, revision: string): Promise<{ highlights: SavedPdfHighlight[]; commentEdits: SavedPdfCommentEdit[] }> {
    const key = annotationKey(uri, revision);
    const records = await this.readAnnotationRecords(match => match[2] === key);
    const highlights = new Map<string, SavedPdfHighlight>();
    const commentEdits = new Map<string, SavedPdfCommentEdit>();
    for (const record of records.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))) {
      for (const highlight of record.highlights ?? []) highlights.set(`${highlight.pageObjectNumber}:${highlight.name}`, highlight);
      if (record.commentEdit) commentEdits.set(pdfCommentKey(record.commentEdit.ref), record.commentEdit);
    }
    return { highlights: [...highlights.values()], commentEdits: [...commentEdits.values()] };
  }

  async recordAnnotation(uri: vscode.Uri, revision: string, activity: PdfAnnotationActivity, highlights?: readonly SavedPdfHighlight[], commentEdit?: SavedPdfCommentEdit): Promise<void> {
    if (uri.scheme !== 'file' || !/\.pdf$/i.test(uri.path)) return;
    const timestamp = Date.now();
    const source = this.sourceFor(uri, await this.readRecords());
    const record: AnnotationRecord = { id: randomUUID(), resource: uri.fsPath, timestamp, user: this.user, activity, highlights, commentEdit };
    await mkdir(this.directory.fsPath, { recursive: true });
    await this.publishRecord(`annotation-${historyKey(source)}-${annotationKey(uri, revision)}-${record.id}.json`, record);
    this.changed.fire(undefined);
  }

  async recordReadingPosition(uri: vscode.Uri, position: PdfReadingPosition): Promise<void> {
    if (uri.scheme !== 'file' || !/\.pdf$/i.test(uri.path)) return;
    const record: ReadingPositionRecord = {
      id: randomUUID(), timestamp: Date.now(), resource: uri.fsPath, user: this.user, activity: { kind: 'view', position },
    };
    const source = this.sourceFor(uri, await this.readRecords());
    await mkdir(this.directory.fsPath, { recursive: true });
    await this.publishRecord(`view-${historyKey(source)}-${record.id}.json`, record);
  }

  async recordCopy(source: vscode.Uri, exported: vscode.Uri, bytes: Uint8Array): Promise<void> {
    if (source.scheme !== 'file' || exported.scheme !== 'file') return;
    const record: SavedCopy = {
      id: randomUUID(), source: this.sourceFor(source, await this.readRecords()),
      exported: exported.fsPath, timestamp: Date.now(), user: this.user,
    };
    const path = this.snapshotUri(record).fsPath;
    const snapshotDirectory = dirname(path);
    await mkdir(this.directory.fsPath, { recursive: true });
    await mkdir(snapshotDirectory);
    try {
      await writeFile(path, bytes, { flag: 'wx' });
      // Publish only after the immutable PDF is readable, including in other windows.
      await this.publishRecord(`${record.id}.json`, record);
    } catch (error) {
      await unlink(path).catch(() => {});
      await rmdir(snapshotDirectory).catch(() => {});
      throw error;
    }
    this.changed.fire(undefined);
  }

  private async publishRecord(file: string, record: SavedCopy | AnnotationRecord | ReadingPositionRecord): Promise<void> {
    const metadata = vscode.Uri.joinPath(this.directory, file).fsPath;
    const pending = `${metadata}.tmp`;
    try {
      await writeFile(pending, JSON.stringify(record), { flag: 'wx' });
      await rename(pending, metadata);
    } catch (error) {
      await unlink(pending).catch(() => {});
      throw error;
    }
  }

  private sourceFor(uri: vscode.Uri, records: readonly SavedCopy[]): string {
    const path = pathKey(uri.fsPath);
    const copy = records.find(record => pathKey(record.exported) === path || samePdfFile(uri, this.snapshotUri(record)));
    return copy?.source ?? uri.fsPath;
  }

  private snapshotUri(record: SavedCopy): vscode.Uri {
    const name = basename(record.exported);
    return vscode.Uri.joinPath(this.directory, record.id, /\.pdf$/i.test(name) ? name : `${name}.pdf`);
  }

  private toItem(record: SavedCopy, version: number): vscode.TimelineItem {
    const resourceUri = this.snapshotUri(record);
    const time = formatPdfTimelineDate(record.timestamp);
    return {
      id: record.id, timestamp: record.timestamp,
      label: basename(record.exported), description: `v${version} · ${actorName(record.user)}`,
      tooltip: `${record.exported}\n${time}\n${actorName(record.user)}`,
      iconPath: new vscode.ThemeIcon('file-pdf'), resourceUri,
      command: { title: 'Open saved PDF copy', command: 'vscode.openWith', arguments: [resourceUri, 'pdfutl.viewer', { preview: false }] },
    };
  }

  private async annotationItems(source: string): Promise<vscode.TimelineItem[]> {
    const key = historyKey(source);
    const records = await this.readAnnotationRecords(match => match[1] === key);
    return records.map(({ id, activity, resource, timestamp, user }) => {
      const isComment = activity.kind !== 'highlight';
      const eventName = activity.kind === 'commentEdited' ? 'Comment edited' : isComment ? 'Comment added' : 'Highlight added';
      const page = `Page ${activity.fragment.pageIndex + 1}`;
      const label = isComment ? `${eventName} · ${activity.comment.replace(/\s+/g, ' ')}` : eventName;
      return {
        id: `annotation-${id}`, timestamp, label, description: `${page} · ${actorName(user)}`,
        tooltip: `${eventName} · ${page}\n${formatPdfTimelineDate(timestamp)}\n${actorName(user)}${isComment ? '\n' + activity.comment : ''}`,
        iconPath: new vscode.ThemeIcon(isComment ? 'comment' : 'edit'),
        command: { title: 'Open PDF fragment', command: openAnnotationActivityCommand, arguments: [vscode.Uri.file(resource), activity.fragment] },
      };
    });
  }

  private async readAnnotationRecords(matches: (match: RegExpExecArray) => boolean): Promise<AnnotationRecord[]> {
    const files = await this.readFiles();
    const records = await Promise.all(files.map(async (file): Promise<AnnotationRecord | undefined> => {
      const match = annotationRecordName.exec(file);
      if (!match || !matches(match)) return;
      const record = await this.readMetadata(file) as Partial<AnnotationRecord> | undefined;
      if (!record || record.id !== match[3] || typeof record.resource !== 'string' || typeof record.timestamp !== 'number' ||
          !Number.isFinite(new Date(record.timestamp).getTime()) || !isPdfAnnotationActivity(record.activity)) return;
      return {
        id: record.id, resource: record.resource, timestamp: record.timestamp, activity: record.activity,
        user: typeof record.user === 'string' ? record.user : undefined,
        highlights: Array.isArray(record.highlights) ? record.highlights.filter(isSavedPdfHighlight) : undefined,
        commentEdit: isSavedPdfCommentEdit(record.commentEdit) ? record.commentEdit : undefined,
      };
    }));
    return records.filter(record => record !== undefined);
  }

  private readFiles(): Promise<string[]> {
    return readdir(this.directory.fsPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  }

  private async readRecords(): Promise<SavedCopy[]> {
    const files = await this.readFiles();
    const found = await Promise.all(files.filter(file => recordName.test(file)).map(file => this.readRecord(file)));
    return found.filter(record => record !== undefined)
      .sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
  }

  private async readRecord(file: string): Promise<SavedCopy | undefined> {
    const match = recordName.exec(file);
    if (!match) return;
    const value = await this.readMetadata(file) as Partial<SavedCopy> | null | undefined;
    if (value?.id === match[1] && typeof value.source === 'string' && typeof value.exported === 'string' &&
        typeof value.timestamp === 'number' && Number.isFinite(new Date(value.timestamp).getTime())) return value as SavedCopy;
  }

  private async readMetadata(file: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(vscode.Uri.joinPath(this.directory, file).fsPath, 'utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
