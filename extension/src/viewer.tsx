import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type FormEvent, type Ref } from 'react';
import { createRoot } from 'react-dom/client';
import { localEngine } from '@embedpdf/engine';
import { StageToken, ZoomMode, type StageViewState } from '@embedpdf/plugin-stage/contract/host';
import { DocumentGate, Viewer, useCapability, useDocumentId, useDocuments, usePageList, type InitialDocument } from '@embedpdf/react/runtime';
import { Stage, stagePlugin, useStage, useStageState } from '@embedpdf/react/stage';
import { RenderLayer, renderPlugin } from '@embedpdf/react/render';
import { SearchLayer, searchPlugin } from '@embedpdf/react/search';
import { SelectionClipboard, SelectionLayer, selectionPlugin } from '@embedpdf/react/selection';
import { AnnotationLayer, annotationPlugin } from '@embedpdf/react/annotation';
import { historyPlugin } from '@embedpdf/react/history';
import { interactionPlugin } from '@embedpdf/react/interaction';
import { outlinePlugin, useOutline } from '@embedpdf/react/outline';
import type { PdfBookmark } from './outlineProtocol';
import type { PdfFragment, PdfReadingPosition, SavedPdfCommentEdit, SavedPdfHighlight } from './pdfAnnotationActivity';
import type { HostMessage, ViewerMessage } from './protocol';
import { PdfSearch, type PdfSearchHandle } from './pdfSearch';
import { PageComments, PdfAnnotationOverlay, usePdfAnnotations } from './pdfAnnotations';
import './viewer.css';

type SavedPdfView = Pick<StageViewState, 'pageIndex' | 'anchor' | 'zoom'> & { version: 1; user?: string };

declare function acquireVsCodeApi(): {
  postMessage(message: ViewerMessage): void;
  getState(): unknown;
  setState(state: SavedPdfView): void;
};
const bridge = acquireVsCodeApi();
const mount = document.getElementById('app')!;
const plugins = [
  stagePlugin({ minZoom: 0.25, maxZoom: 40 }),
  renderPlugin(),
  interactionPlugin(),
  selectionPlugin(),
  searchPlugin({ reveal: { behavior: 'instant' } }),
  annotationPlugin(),
  historyPlugin(),
  outlinePlugin(),
];

async function localAsset(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load a PDF engine asset (${response.status}).`);
  return response;
}

async function createPdfEngine() {
  const [workerSource, wasm] = await Promise.all([
    localAsset(mount.dataset.worker!).then(response => response.text()),
    localAsset(mount.dataset.wasm!).then(response => response.arrayBuffer()),
  ]);
  return localEngine({
    wasmBinary: wasm,
    encoderWorker: false,
    defaultFallbackFonts: false,
    worker: () => {
      const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
      const worker = new Worker(url, { type: 'module', name: 'pdfutl-pdfium' });
      URL.revokeObjectURL(url);
      return worker;
    },
  });
}

async function restoreOtherEditors(
  engine: Awaited<ReturnType<typeof createPdfEngine>>, source: ArrayBuffer, user: string,
  edits: readonly SavedPdfCommentEdit[],
) {
  const byEditor = new Map<string, SavedPdfCommentEdit[]>();
  for (const edit of edits) {
    if (edit.editor === user) continue;
    const group = byEditor.get(edit.editor) ?? [];
    group.push(edit);
    byEditor.set(edit.editor, group);
  }

  let bytes = source;
  const restored = new Set<SavedPdfCommentEdit>();
  for (const [editor, group] of byEditor) {
    // Reapply edits of PDF-native notes as their recorded editor, in a local working copy.
    try {
      const document = await engine.open({ kind: 'bytes', bytes: bytes.slice(0) },
        { identity: { userId: editor, displayName: editor } });
      try {
        for (const edit of group) {
          await document.page(edit.ref.page).annotations.update(edit.ref, { contents: edit.contents });
        }
        bytes = Uint8Array.from(await document.download({ mode: 'incremental' })).buffer;
        for (const edit of group) restored.add(edit);
      } finally {
        await document.close();
      }
    } catch (reason) {
      console.warn('Could not reapply a saved PDF comment with its original attribution.', reason);
    }
  }
  return { bytes, unrestored: edits.filter(edit => !restored.has(edit)) };
}

function messageOf(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
}

function readPdfView(): SavedPdfView | undefined {
  const state = bridge.getState() as SavedPdfView | null;
  if (state?.version !== 1 || !Number.isInteger(state.pageIndex) || state.pageIndex < 0) return;
  const { anchor, zoom } = state;
  if (!anchor || !Number.isInteger(anchor.pageIndex) || anchor.pageIndex < 0 ||
      !Number.isFinite(anchor.fractionX) || !Number.isFinite(anchor.fractionY)) return;
  if (!zoom || typeof zoom !== 'object') return;
  if ('mode' in zoom && Object.values(ZoomMode).includes(zoom.mode)) return state;
  if ('level' in zoom && Number.isFinite(zoom.level) && zoom.level > 0) return state;
}

function PdfViewPersistence({ user }: { user: string }) {
  const stage = useCapability(StageToken);

  useLayoutEffect(() => {
    const saved = readPdfView();
    let lastSaved = JSON.stringify(saved);
    let scheduled = false;
    let disposed = false;
    let lastPosition: PdfReadingPosition | undefined;
    let pendingPosition: PdfReadingPosition | undefined;
    let historyTimer: number | undefined;

    function publishView() {
      if (!pendingPosition) return;
      bridge.postMessage({ type: 'readingPosition', position: pendingPosition });
      pendingPosition = undefined;
    }

    const removeInitialView = stage.provideInitialView(0, () => {
      if (!saved) return null;
      const lastPage = stage.getPageCount() - 1;
      return {
        ...stage.getViewState(),
        pageIndex: Math.min(saved.pageIndex, lastPage),
        anchor: { ...saved.anchor, pageIndex: Math.min(saved.anchor.pageIndex, lastPage) },
        zoom: saved.zoom,
      };
    });

    function saveView() {
      if (scheduled) return;
      scheduled = true;
      // EmbedPDF may update the cursor and camera in separate steps of one move.
      queueMicrotask(() => {
        scheduled = false;
        if (disposed || !stage.getCurrentPage()) return;
        const { width, height } = stage.getViewportSize();
        if (width <= 0 || height <= 0) return;
        const { pageIndex, anchor, zoom } = stage.getViewState();
        const snapshot: SavedPdfView = { version: 1, pageIndex, anchor, zoom, user };
        const serialized = JSON.stringify(snapshot);
        if (serialized === lastSaved) return;
        // Code-OSS serializes each custom editor's webview state with its tab.
        bridge.setState(snapshot);
        lastSaved = serialized;
        const position = { pageIndex, anchor, zoomPercent: Math.round(stage.getZoomLevel() * 100) };
        if (lastPosition) {
          pendingPosition = position;
          window.clearTimeout(historyTimer);
          if (position.pageIndex !== lastPosition.pageIndex || position.zoomPercent !== lastPosition.zoomPercent) publishView();
          else historyTimer = window.setTimeout(publishView, 750);
        }
        lastPosition = position;
      });
    }

    const removeListeners = [
      stage.onCameraChanged(saveView), stage.onPageChanged(saveView), stage.onViewportChanged(saveView),
      stage.onSettingsChanged(({ changedKeys }) => { if (changedKeys.includes('zoom')) saveView(); }),
    ];
    return () => {
      disposed = true;
      window.clearTimeout(historyTimer);
      publishView();
      removeInitialView();
      for (const remove of removeListeners) remove();
    };
  }, [stage, user]);

  return null;
}

type PageIndicatorHandle = { open(): void };

function PageIndicator({ ref }: { ref: Ref<PageIndicatorHandle> }) {
  const stage = useStage();
  const page = useStageState(state => state.currentPageIndex) + 1;
  const pages = useStageState(state => state.pageCount);
  const field = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const editing = draft !== null;

  const open = useCallback(() => {
    if (editing) {
      field.current?.focus({ preventScroll: true });
      field.current?.select();
    } else {
      setDraft(String(page));
    }
  }, [editing, page]);
  useImperativeHandle(ref, () => ({ open }), [open]);

  useLayoutEffect(() => {
    if (editing) {
      field.current?.focus({ preventScroll: true });
      field.current?.select();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      button.current?.focus({ preventScroll: true });
    }
  }, [editing]);

  function finishEditing(focusButton: boolean) {
    returnFocus.current = focusButton;
    setInvalid(false);
    setDraft(null);
  }

  function goToPage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft === null) return;
    const text = draft.trim();
    const target = Number(text);
    if (!/^\d+$/.test(text) || target < 1 || target > pages) {
      setInvalid(true);
      field.current?.select();
      return;
    }
    finishEditing(true);
    if (target !== page) stage.goToPage(target - 1, { behavior: 'instant' });
  }

  if (pages <= 1 && !editing) return null;

  return <form className="page-indicator" aria-label="Current page" data-current-page={page} onSubmit={goToPage}>
    {editing ? <input ref={field} className="page-number" aria-label="Page number" type="text" inputMode="numeric"
      size={Math.max(2, String(pages).length)} value={draft} aria-invalid={invalid || undefined}
      aria-describedby={invalid ? 'page-number-error' : undefined}
      onChange={event => { setDraft(event.target.value); setInvalid(false); }}
      onBlur={() => finishEditing(false)} onKeyDown={event => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        finishEditing(true);
    }} /> : <button ref={button} className="page-number" type="button"
      aria-label={`Page ${page} of ${pages}. Go to page`} title="Go to page"
      onClick={open}>{page}</button>}
    <span> / {pages}</span>
    {invalid && <span className="page-number-error" id="page-number-error" role="alert">
      Enter a page from 1 to {pages}.
    </span>}
  </form>;
}

function usePublishOutline(bookmarks: readonly PdfBookmark[] | undefined) {
  useEffect(() => {
    if (!bookmarks) return;
    const publish = () => bridge.postMessage({ type: 'pdfutl.outline', bookmarks });
    const onMessage = (event: MessageEvent<HostMessage>) => {
      if (event.data?.type === 'pdfutl.requestOutline') publish();
    };
    window.addEventListener('message', onMessage);
    publish();
    return () => window.removeEventListener('message', onMessage);
  }, [bookmarks]);
}

const emptyOutline: readonly PdfBookmark[] = [];

function UnavailablePdfOutline() {
  usePublishOutline(emptyOutline);
  return null;
}

function PdfOutlineBridge() {
  const outline = useOutline();
  const stage = useStage();
  const [bookmarks, setBookmarks] = useState<readonly PdfBookmark[]>();
  usePublishOutline(bookmarks);

  useEffect(() => {
    const controller = new AbortController();
    void outline.ensureLoaded({ signal: controller.signal }).then(() => {
      if (controller.signal.aborted) return;
      setBookmarks(outline.list().map(item => ({
        id: item.ref.objectNumber,
        parentId: item.parent?.objectNumber ?? null,
        title: item.title,
        canNavigate: item.target?.kind === 'goto',
      })));
    }).catch(() => { if (!controller.signal.aborted) setBookmarks(emptyOutline); });

    const onMessage = (event: MessageEvent<HostMessage>) => {
      if (event.data?.type !== 'pdfutl.revealBookmark') return;
      const target = outline.get({ kind: 'objectNumber', objectNumber: event.data.id })?.target;
      if (target?.kind === 'goto') stage.goToDestination(target.destination, { behavior: 'instant' });
    };
    window.addEventListener('message', onMessage);
    return () => {
      controller.abort();
      window.removeEventListener('message', onMessage);
    };
  }, [outline, stage]);
  return null;
}

function PdfDocument({ name, user, highlights, commentEdits, unrestored, fullscreen }: {
  name: string | undefined; user: string; highlights: readonly SavedPdfHighlight[];
  commentEdits: readonly SavedPdfCommentEdit[]; unrestored: readonly SavedPdfCommentEdit[];
  fullscreen: boolean;
}) {
  const documents = useDocuments();
  const id = useDocumentId();
  const search = useRef<PdfSearchHandle>(null);
  const pageIndicator = useRef<PageIndicatorHandle>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [exportRequest, setExportRequest] = useState<string>();
  const [notice, setNotice] = useState('');
  const [fragment, setFragment] = useState<PdfFragment>();
  const pendingAnnotation = useRef<{ id: string; resolve: () => void; reject: (reason: Error) => void } | undefined>(undefined);
  const pages = usePageList();
  const stage = useStage();
  const annotations = usePdfAnnotations(user, highlights, commentEdits, unrestored, message => new Promise<void>((resolve, reject) => {
    pendingAnnotation.current = { id: message.id, resolve, reject };
    bridge.postMessage(message);
  }));
  const toggleComments = useCallback(() => setCommentsOpen(value => !value), []);
  const closeComments = useCallback(() => setCommentsOpen(false), []);
  const fragmentPage = fragment && (pages.find(page => page.ref.objectNumber === fragment.pageObjectNumber) ?? pages[fragment.pageIndex]);

  useEffect(() => {
    const dispose = (event: MessageEvent<HostMessage>) => {
      switch (event.data?.type) {
        case 'focusFind':
          window.focus();
          search.current?.open();
          return;
        case 'moveSearch':
          search.current?.move(event.data.direction);
          return;
        case 'focusPageNumber':
          window.focus();
          pageIndicator.current?.open();
          return;
        case 'togglePageComments':
          window.focus();
          search.current?.toggleComments();
          return;
        case 'revealFragment':
          setFragment(event.data.fragment);
          return;
        case 'annotationSaveResult': {
          const request = pendingAnnotation.current;
          if (request?.id !== event.data.id) return;
          pendingAnnotation.current = undefined;
          if (event.data.error) request.reject(new Error(event.data.error));
          else request.resolve();
          return;
        }
        case 'exportPdf':
          setNotice('');
          setExportRequest(event.data.requestId);
          return;
        case 'saved': setNotice(`Saved ${event.data.name}`); break;
        case 'error': setNotice(event.data.message); break;
        default: return;
      }
    };
    window.addEventListener('message', dispose);
    bridge.postMessage({ type: 'opened' });
    return () => {
      window.removeEventListener('message', dispose);
      pendingAnnotation.current?.reject(new Error('The PDF view was closed.'));
      pendingAnnotation.current = undefined;
    };
  }, []);

  const { add, canAdd, hasSelection, startComment } = annotations;
  useLayoutEffect(() => {
    function onMenuCommand(event: MessageEvent<HostMessage>) {
      const message = event.data;
      if (message?.type === 'zoomPdf') {
        switch (message.action) {
          case 'in': stage.zoomIn(); break;
          case 'out': stage.zoomOut(); break;
          case 'actualSize': stage.zoomTo(1); break;
          case 'fitPage': stage.fitPage(); break;
        }
      }
      if (message?.type !== 'addComment' && message?.type !== 'highlightSelection') return;
      if (!hasSelection()) {
        setNotice('Select text in the PDF first.');
        return;
      }
      if (!canAdd) return;
      setNotice('');
      if (message.type === 'addComment') {
        window.focus();
        startComment();
      } else {
        void add('');
      }
    }
    window.addEventListener('message', onMenuCommand);
    return () => window.removeEventListener('message', onMenuCommand);
  }, [add, canAdd, hasSelection, stage, startComment]);

  const undoAnnotation = annotations.undo;
  useLayoutEffect(() => {
    function undo() {
      const active = document.activeElement;
      if (active instanceof HTMLElement && (active.isContentEditable ||
          active.matches('textarea:not([readonly]), input:is([type=text], [type=search], :not([type])):not([readonly])'))) {
        document.execCommand('undo');
        return;
      }
      undoAnnotation();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || event.isComposing || event.code !== 'KeyZ') return;
      event.preventDefault();
      // The webview normally forwards Ctrl+Z to Code-OSS. Handle it once, where focus is known.
      event.stopImmediatePropagation();
      undo();
    }
    function onMessage(event: MessageEvent<HostMessage>) {
      if (event.data?.type === 'undoAnnotation') undo();
    }
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('message', onMessage);
    };
  }, [undoAnnotation]);

  useEffect(() => {
    if (!fragment || !fragmentPage) return;
    let revealed = false;
    const reveal = () => {
      const { width, height } = stage.getViewportSize();
      if (revealed || width <= 0 || height <= 0) return;
      revealed = true;
      stage.reveal(fragmentPage.ref, { rect: fragment.rect, align: { x: 'center', y: 'center' }, behavior: 'instant' });
    };
    const removeListener = stage.onViewportChanged(reveal);
    reveal();
    return removeListener;
  }, [fragment, fragmentPage, stage]);

  useEffect(() => {
    if (!exportRequest || annotations.restoring || annotations.busy) return;
    setExportRequest(undefined);
    void documents.download(id ?? undefined).then(bytes => {
      bridge.postMessage({ type: 'exportedPdf', requestId: exportRequest, bytes: new Uint8Array(bytes).buffer });
    }).catch(error => {
      bridge.postMessage({ type: 'exportFailed', requestId: exportRequest, message: messageOf(error) });
    });
  }, [annotations.busy, annotations.restoring, documents, exportRequest, id]);

  return <main className="viewer" aria-label={name}>
    {notice && <div className="status" role="status">{notice}</div>}
    {annotations.error && <div className="status" role="alert">{annotations.error}</div>}
    <div className="reading-area">
      <SelectionClipboard />
      <PdfViewPersistence user={user} />
      <PdfSearch ref={search} fullscreen={fullscreen}
        onToggleComments={toggleComments} onCloseComments={closeComments}
        pageComments={commentsOpen ? <PageComments annotations={annotations} close={closeComments} /> : undefined}>
        <Stage className="stage" overlay={<PdfAnnotationOverlay annotations={annotations} />}>
          {page => <div className="page-paper" data-pdf-page={page.pageIndex + 1} onPointerDown={() => {
            setFragment(undefined);
            annotations.clearCard();
          }} onClick={event => {
            const bounds = event.currentTarget.parentElement?.closest('.stage')?.getBoundingClientRect();
            if (bounds) annotations.openAt({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
          }}>
          <div className="search-background"><SearchLayer /></div>
          <div className="page-art"><RenderLayer /></div>
          <AnnotationLayer />
          <SelectionLayer />
          {fragment && page.ref.objectNumber === fragmentPage?.ref.objectNumber && <div className="timeline-fragment" aria-hidden="true" style={{
            left: fragment.rect.x * page.transform.viewScale, top: fragment.rect.y * page.transform.viewScale,
            width: fragment.rect.width * page.transform.viewScale, height: fragment.rect.height * page.transform.viewScale,
          }} />}
        </div>}</Stage>
        <PageIndicator ref={pageIndicator} />
      </PdfSearch>
      <PdfOutlineBridge />
    </div>
  </main>;
}

function App() {
  const [session, setSession] = useState<{
    engine: Awaited<ReturnType<typeof createPdfEngine>>; source: InitialDocument; user: string;
    highlights: readonly SavedPdfHighlight[]; commentEdits: readonly SavedPdfCommentEdit[]; unrestored: readonly SavedPdfCommentEdit[];
  }>();
  const [error, setError] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef(false);

  useLayoutEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
      const exit = event.key === 'Escape' && fullscreenRef.current;
      if (!exit && event.key !== 'F11') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) bridge.postMessage({ type: exit ? 'exitFullscreen' : 'toggleFullscreen' });
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  useEffect(() => {
    async function receive(event: MessageEvent<HostMessage>) {
      const message = event.data;
      if (message?.type === 'pdfutl.fullscreen') {
        fullscreenRef.current = message.active;
        setFullscreen(message.active);
        return;
      }
      if (message?.type === 'error') { if (!session) setError(message.message); return; }
      if (message?.type !== 'open') return;
      try {
        const engine = await createPdfEngine();
        const { bytes, unrestored } = await restoreOtherEditors(engine, message.bytes, message.user, message.commentEdits);
        setSession({ engine, source: { source: { kind: 'bytes', bytes }, name: message.name },
          user: message.user, highlights: message.highlights, commentEdits: message.commentEdits, unrestored });
      } catch (reason) {
        const details = messageOf(reason);
        setError(details);
        bridge.postMessage({ type: 'openError', message: details });
      }
    }
    window.addEventListener('message', receive);
    bridge.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', receive);
  }, []);

  const failed = (reason: string) => <><UnavailablePdfOutline /><p role="alert" className="status">{reason}</p></>;
  if (error && !session) return failed(error);
  const opening = <p role="status" className="status">Opening PDF…</p>;
  if (!session) return opening;
  return <Viewer engine={session.engine} initialDocuments={[session.source]} plugins={plugins} fallback={opening}
    identity={{ userId: session.user, displayName: session.user }}
    renderError={reason => failed(messageOf(reason))}>
    <DocumentGate fallback={opening} error={pdf => failed(messageOf(pdf.error))}
      locked={() => failed('This PDF requires a password.')}>
      <PdfDocument name={session.source.name} user={session.user} highlights={session.highlights} fullscreen={fullscreen}
        commentEdits={session.commentEdits} unrestored={session.unrestored} />
    </DocumentGate>
  </Viewer>;
}

createRoot(mount).render(<App />);
