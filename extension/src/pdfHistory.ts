import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import * as vscode from 'vscode';
import { isPdfAnnotationActivity, isPdfAnnotationUndo, isSavedPdfCommentEdit, isSavedPdfHighlight, openAnnotationActivityCommand, pdfCommentKey, type PdfAnnotationActivity, type PdfAnnotationUndo, type PdfReadingPosition, type SavedPdfCommentEdit, type SavedPdfHighlight } from './pdfAnnotationActivity';
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
  readonly activity: PdfAnnotationActivity | PdfAnnotationUndo;
  readonly highlights?: readonly SavedPdfHighlight[];
  readonly updatesHighlight?: true;
  readonly commentEdit?: SavedPdfCommentEdit;
}

interface ReadingPositionRecord {
  readonly id: string;
  readonly resource: string;
  readonly timestamp: number;
  readonly user: string;
  readonly activity: { readonly kind: 'view'; readonly position: PdfReadingPosition };
}

interface OpenRecord {
  readonly id: string;
  readonly resource: string;
  readonly timestamp: number;
  readonly user: string;
  readonly activity: { readonly kind: 'opened' };
}

const recordId = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const recordName = new RegExp('^(' + recordId + ')\\.json$');
const annotationRecordName = new RegExp('^annotation-([a-f0-9]{64})-(?:([a-f0-9]{64})-)?(' + recordId + ')\\.json$');
const activityRecordName = new RegExp('^activity-([a-f0-9]{64})-(' + recordId + ')\\.json$');
const firstOpenRecordName = /^first-open-[a-f0-9]{64}\.json$/;

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
  private readonly annotationWrites = new Map<string, Promise<void>>();
  readonly onDidChangeTimeline = this.changed.event;

  constructor(storage: vscode.Uri, readonly user: string) {
    // Open archives as ordinary local PDFs so Timeline follows them by file URI.
    this.directory = vscode.Uri.joinPath(vscode.Uri.file(storage.fsPath), 'saved-pdf-copies');
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.directory, '*.json'));
    const updateTimeline = (uri: vscode.Uri) => {
      const file = basename(uri.path);
      if (recordName.test(file) || annotationRecordName.test(file) || activityRecordName.test(file) || firstOpenRecordName.test(file)) {
        this.changed.fire(undefined);
      }
    };
    this.subscriptions = vscode.Disposable.from(
      this.changed, watcher,
      watcher.onDidCreate(updateTimeline),
      watcher.onDidDelete(updateTimeline),
      vscode.workspace.registerTimelineProvider(pdfTimelineSource, 'PDFutl Activity', 'file', this),
    );
  }

  dispose(): void { this.subscriptions.dispose(); }

  async provideTimeline(uri: vscode.Uri, options: vscode.TimelineOptions, token: vscode.CancellationToken): Promise<vscode.Timeline | undefined> {
    if (!/\.pdf$/i.test(uri.path)) return;
    const files = await this.readFiles();
    const records = await this.readRecords(files);
    const source = this.sourceFor(uri, records);
    const [annotations, openings] = await Promise.all([this.annotationItems(source, files), this.openItems(source, files)]);
    if (token.isCancellationRequested) return;
    const versions = records.filter(record => pathKey(record.source) === pathKey(source));
    const items = [...versions.map((record, index) => this.toItem(record, versions.length - index)), ...annotations, ...openings];
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
    await this.annotationWrites.get(key)?.catch(() => {});
    const records = await this.readAnnotationRecords(match => match[2] === key);
    const undone = new Set(records.flatMap(record => record.activity.kind === 'undo' ? [record.activity.operationId] : []));
    const highlights = new Map<string, SavedPdfHighlight>();
    const commentEdits = new Map<string, SavedPdfCommentEdit>();
    for (const record of records.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))) {
      if (record.activity.kind === 'undo' || undone.has(record.id)) continue;
      for (const highlight of record.highlights ?? []) {
        const key = `${highlight.pageObjectNumber}:${highlight.name}`;
        if (!record.updatesHighlight || highlights.has(key)) highlights.set(key, highlight);
      }
      if (record.commentEdit) commentEdits.set(pdfCommentKey(record.commentEdit.ref), record.commentEdit);
    }
    return { highlights: [...highlights.values()], commentEdits: [...commentEdits.values()] };
  }

  async recordAnnotation(uri: vscode.Uri, revision: string, id: string, activity: AnnotationRecord['activity'],
    highlights?: readonly SavedPdfHighlight[], commentEdit?: SavedPdfCommentEdit, updatesHighlight?: true): Promise<void> {
    if (uri.scheme !== 'file' || !/\.pdf$/i.test(uri.path)) return;
    const key = annotationKey(uri, revision);
    const write = (this.annotationWrites.get(key)?.catch(() => {}) ?? Promise.resolve()).then(async () => {
      const source = this.sourceFor(uri, await this.readRecords());
      const prefix = `annotation-${historyKey(source)}-${key}-`;
      if (activity.kind === 'undo') {
        const original = await this.readMetadata(prefix + activity.operationId + '.json') as Partial<AnnotationRecord> | undefined;
        if (!isPdfAnnotationActivity(original?.activity)) throw new Error('The original annotation operation could not be found.');
      }
      const record: AnnotationRecord = {
        id, resource: uri.fsPath, timestamp: Date.now(), user: this.user, activity, highlights, commentEdit, updatesHighlight,
      };
      await mkdir(this.directory.fsPath, { recursive: true });
      await this.publishRecord(prefix + id + '.json', record);
      this.changed.fire(undefined);
    });
    this.annotationWrites.set(key, write);
    try {
      await write;
    } finally {
      if (this.annotationWrites.get(key) === write) this.annotationWrites.delete(key);
    }
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

  async recordOpen(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== 'file' || !/\.pdf$/i.test(uri.path)) return;
    const record: OpenRecord = {
      id: randomUUID(), resource: uri.fsPath, timestamp: Date.now(), user: this.user, activity: { kind: 'opened' },
    };
    const source = this.sourceFor(uri, await this.readRecords());
    await mkdir(this.directory.fsPath, { recursive: true });
    await this.publishRecord(`activity-${historyKey(source)}-${record.id}.json`, record);
    this.changed.fire(undefined);
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

  private async publishRecord(file: string, record: SavedCopy | AnnotationRecord | ReadingPositionRecord | OpenRecord): Promise<void> {
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

  private async openItems(source: string, files: readonly string[]): Promise<vscode.TimelineItem[]> {
    const key = historyKey(source);
    const first = `first-open-${key}.json`;
    const items = await Promise.all(files.map(async (file): Promise<vscode.TimelineItem | undefined> => {
      const match = activityRecordName.exec(file);
      const isFirst = file === first;
      if (!isFirst && match?.[1] !== key) return;
      const record = await this.readMetadata(file) as Partial<OpenRecord> | number | null | undefined;
      if (!isFirst && (typeof record !== 'object' || record?.id !== match?.[2] || record?.activity?.kind !== 'opened')) return;
      const timestamp = typeof record === 'number' ? record : record?.timestamp;
      if (typeof timestamp !== 'number' || !Number.isFinite(new Date(timestamp).getTime())) return;
      const user = actorName(typeof record === 'object' ? record?.user : undefined);
      const resource = typeof record === 'object' ? record?.resource : undefined;
      const label = isFirst ? 'First opened' : 'Opened';
      return {
        id: file, timestamp, label, description: user,
        tooltip: [label, formatPdfTimelineDate(timestamp), user, typeof resource === 'string' ? resource : source].join('\n'),
        iconPath: new vscode.ThemeIcon(isFirst ? 'folder-opened' : 'file-pdf'),
      };
    }));
    return items.filter(item => item !== undefined);
  }

  private async annotationItems(source: string, files: readonly string[]): Promise<vscode.TimelineItem[]> {
    const key = historyKey(source);
    const records = await this.readAnnotationRecords(match => match[1] === key, files);
    const originals = new Map(records.flatMap(({ id, activity }) => activity.kind === 'undo' ? [] : [[id, activity] as const]));
    return records.flatMap(({ id, activity: event, resource, timestamp, user }) => {
      const reverted = event.kind === 'undo';
      const activity = reverted ? originals.get(event.operationId) : event;
      if (!activity) return [];
      const isComment = activity.kind !== 'highlight';
      const action = activity.kind === 'commentEdited' ? 'Comment edited' : isComment ? 'Comment added' : 'Highlight added';
      const eventName = reverted ? `Undo · ${action}` : action;
      const page = `Page ${activity.fragment.pageIndex + 1}`;
      const label = isComment ? `${eventName} · ${activity.comment.replace(/\s+/g, ' ')}` : eventName;
      return {
        id: `annotation-${id}`, timestamp, label, description: `${page} · ${actorName(user)}`,
        tooltip: `${eventName} · ${page}\n${formatPdfTimelineDate(timestamp)}\n${actorName(user)}${isComment ? '\n' + activity.comment : ''}`,
        iconPath: new vscode.ThemeIcon(reverted ? 'discard' : isComment ? 'comment' : 'edit'),
        command: { title: 'Open PDF fragment', command: openAnnotationActivityCommand, arguments: [vscode.Uri.file(resource), activity.fragment] },
      };
    });
  }

  private async readAnnotationRecords(matches: (match: RegExpExecArray) => boolean, files?: readonly string[]): Promise<AnnotationRecord[]> {
    const records = await Promise.all((files ?? await this.readFiles()).map(async (file): Promise<AnnotationRecord | undefined> => {
      const match = annotationRecordName.exec(file);
      if (!match || !matches(match)) return;
      const record = await this.readMetadata(file) as Partial<AnnotationRecord> | undefined;
      if (!record || record.id !== match[3] || typeof record.resource !== 'string' || typeof record.timestamp !== 'number' ||
          !Number.isFinite(new Date(record.timestamp).getTime()) ||
          !(isPdfAnnotationActivity(record.activity) || isPdfAnnotationUndo(record.activity))) return;
      return {
        id: record.id, resource: record.resource, timestamp: record.timestamp, activity: record.activity,
        user: typeof record.user === 'string' ? record.user : undefined,
        highlights: Array.isArray(record.highlights) ? record.highlights.filter(isSavedPdfHighlight) : undefined,
        updatesHighlight: record.updatesHighlight === true ? true : undefined,
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

  private async readRecords(files?: readonly string[]): Promise<SavedCopy[]> {
    const found = await Promise.all((files ?? await this.readFiles()).filter(file => recordName.test(file)).map(file => this.readRecord(file)));
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
