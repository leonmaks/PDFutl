import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Anchored, useProjectorBinding, type AnchorTarget } from '@embedpdf/react/anchored';
import {
  annotationKey, useAnnotation, useAnnotationAnchor, useAnnotationState, useCommentThreads,
  type Annotation, type AnnotationBundle, type AnnotationRef,
} from '@embedpdf/react/annotation';
import { usePageList } from '@embedpdf/react/runtime';
import { SelectionMenu, useSelection } from '@embedpdf/react/selection';
import { useStage, useStageState } from '@embedpdf/react/stage';
import { pdfCommentKey, type SavedPdfCommentEdit, type SavedPdfHighlight } from './pdfAnnotationActivity';
import type { ViewerMessage } from './protocol';

const colors = [
  { name: 'Yellow', value: '#ffe066' },
  { name: 'Blue', value: '#79cbff' },
  { name: 'Pink', value: '#ffa2bb' },
  { name: 'Purple', value: '#c4a4ff' },
] as const;
type Markup = Extract<Annotation, { subtype: 'highlight' }>;
type Card = { anchor: AnchorTarget } | { ref: AnnotationRef };
type PostAnnotation = (message: Extract<ViewerMessage, { type: 'annotationSaved' }>) => void;
type CommentThread = ReturnType<typeof useCommentThreads>[number];
const markKey = (page: number, name: string) => `${page}:${name}`;
const hasText = (item: Annotation) => Boolean(item.contents?.trim());
const hasComment = (thread: CommentThread) => hasText(thread.root) || thread.replies.some(hasText);
const authorOf = (item: Annotation) => item.author || item.createdBy || 'Unknown author';

function isolateCardWheel(card: HTMLElement | null) {
  if (!card) return;
  const stop = (event: WheelEvent) => event.stopPropagation();
  card.addEventListener('wheel', stop, { passive: true });
  return () => card.removeEventListener('wheel', stop);
}

function saveHighlight(item: Markup): SavedPdfHighlight {
  return {
    pageObjectNumber: item.page.objectNumber, name: item.nm!, quadPoints: item.quadPoints,
    color: item.color ?? colors[0].value, opacity: item.opacity ?? 1, contents: item.contents ?? null,
    attribution: {
      author: item.author, createdAt: item.createdAt, modifiedAt: item.modifiedAt,
      userId: item.userId, createdBy: item.createdBy, modifiedBy: item.modifiedBy,
    },
  };
}

function restoreBundle(highlights: readonly SavedPdfHighlight[], pages: ReturnType<typeof usePageList>): AnnotationBundle {
  const pageMap = new Map(pages.map(page => [Number(page.ref.objectNumber), page]));
  const used = new Map<number, AnnotationBundle['pages'][number]>();
  const items = highlights.flatMap((item, baseIndex) => {
    const page = pageMap.get(item.pageObjectNumber);
    if (!page) return [];
    used.set(item.pageObjectNumber, { page: page.ref, position: page.index, size: page.size });
    const points = item.quadPoints.flatMap(quad => [quad.upperLeft, quad.upperRight, quad.lowerLeft, quad.lowerRight]);
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    const data: Markup = {
      subtype: 'highlight', page: page.ref, ref: { kind: 'baseIndex', page: page.ref, baseIndex },
      nm: item.name, contents: item.contents, quadPoints: item.quadPoints, color: item.color, opacity: item.opacity,
      rect: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y },
      hasAppearance: false, structurePosition: null, appearanceState: null, popup: null, actions: null,
      author: null, createdAt: null, modifiedAt: null, userId: null, createdBy: null, modifiedBy: null, importedBy: null,
      richText: null, subject: null, blendMode: 'multiply', reply: null, groupId: null,
      invisible: false, hidden: false, print: true, noZoom: false, noRotate: false, noView: false,
      readOnly: false, locked: false, toggleNoView: false, lockedContents: false,
      ...item.attribution,
    };
    return [{ data, resources: {} }];
  });
  return { format: 'embedpdf/annotations', version: 1, pages: [...used.values()].sort((a, b) => a.position - b.position), items, resources: {} };
}

export function usePdfAnnotations(
  user: string, highlights: readonly SavedPdfHighlight[], edits: readonly SavedPdfCommentEdit[],
  unrestored: readonly SavedPdfCommentEdit[], post: PostAnnotation,
) {
  const stage = useStage();
  const pages = usePageList();
  const selection = useSelection();
  const annotation = useAnnotation();
  const status = useAnnotationState(state => state.status);
  const threads = useCommentThreads();
  const profileMarks = useRef(new Set(highlights.map(item => markKey(item.pageObjectNumber, item.name))));
  const [lastEditors, setLastEditors] = useState(() => new Map(edits.map(edit => [pdfCommentKey(edit.ref), edit.editor])));
  const [restoring, setRestoring] = useState(highlights.length > 0 || unrestored.length > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [card, setCard] = useState<Card>();
  const lastColor = useRef<string>(colors[0].value);

  useEffect(() => {
    if (!restoring || status === 'loading' || !pages.length) return;
    if (status !== 'ready') { setRestoring(false); return; }
    const controller = new AbortController();
    const { signal } = controller;
    async function restore() {
      const imported = new Set(annotation.list().map(item => markKey(item.page.objectNumber, item.nm ?? '')));
      const bundle = restoreBundle(highlights.filter(item => !imported.has(markKey(item.pageObjectNumber, item.name))), pages);
      if (bundle.items.length) await annotation.import(bundle, { attribution: 'restore', history: false, signal });
      for (const edit of unrestored) {
        if (signal.aborted) return;
        if (annotation.get(edit.ref)) await annotation.comments.setText(edit.ref, edit.contents, { signal });
      }
    }
    void restore().catch(reason => {
      if (!signal.aborted) setError(`Could not restore saved annotations. ${messageOf(reason)}`);
    }).finally(() => { if (!signal.aborted) setRestoring(false); });
    return () => controller.abort();
  }, [annotation, highlights, pages, restoring, status, unrestored]);

  function fragmentFor(item: Annotation) {
    const page = pages.find(page => page.ref.objectNumber === item.page.objectNumber);
    return page && { pageIndex: page.index, pageObjectNumber: page.ref.objectNumber, rect: item.rect };
  }

  async function add(color: string, comment: string): Promise<boolean> {
    if (busy || restoring) return false;
    const selectedPages = selection.getSnapshot().pages.filter(entry => entry.segments.length);
    if (!selectedPages.length) return false;
    setBusy(true);
    setError('');
    try {
      const results = await Promise.allSettled(selectedPages.map(entry => annotation.create(entry.page, {
        subtype: 'highlight', nm: crypto.randomUUID(), quadPoints: entry.segments.map(segment => segment.quad),
        color, opacity: 0.45, print: true, contents: comment || null,
      })));
      const created = results.flatMap(result => result.status === 'fulfilled' && result.value.annotation.subtype === 'highlight'
        ? [result.value.annotation] : []);
      const first = created[0];
      const fragment = first && fragmentFor(first);
      if (fragment) {
        const marks = created.map(saveHighlight);
        for (const mark of marks) profileMarks.current.add(markKey(mark.pageObjectNumber, mark.name));
        post({ type: 'annotationSaved', highlights: marks,
          activity: comment ? { kind: 'comment', comment, fragment } : { kind: 'highlight', fragment } });
        lastColor.current = color;
        selection.clear();
        setCard(comment ? { ref: first.ref } : undefined);
      }
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) setError(messageOf(rejected.reason));
      return Boolean(fragment);
    } finally {
      setBusy(false);
    }
  }

  async function edit(item: Annotation, comment: string): Promise<boolean> {
    const fragment = fragmentFor(item);
    if (!fragment || busy || !annotation.comments.canSetText(item.ref)) return false;
    if (item.contents === comment) return true;
    setBusy(true);
    setError('');
    try {
      await annotation.comments.setText(item.ref, comment);
      const current = annotation.get(item.ref);
      const activity = { kind: item.contents?.trim() ? 'commentEdited' : 'comment', comment, fragment } as const;
      if (current?.subtype === 'highlight' && current.nm && profileMarks.current.has(markKey(current.page.objectNumber, current.nm))) {
        post({ type: 'annotationSaved', activity, highlights: [saveHighlight(current)] });
      } else {
        post({ type: 'annotationSaved', activity, commentEdit: { ref: item.ref, contents: comment } });
        setLastEditors(editors => new Map(editors).set(pdfCommentKey(item.ref), user));
      }
      return true;
    } catch (reason) {
      setError(messageOf(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function open(item: Annotation, reveal = false) {
    if (reveal) stage.reveal(item.page, { rect: item.rect, align: { y: 0.4 }, behavior: 'instant' });
    setError('');
    setCard({ ref: item.ref });
  }

  function openAt(point: { x: number; y: number }) {
    if (busy || selection.hasSelection()) return;
    const target = stage.getPageAt(point);
    if (!target) return;
    const item = annotation.getAt(target.ref, target.point);
    if (item?.subtype === 'highlight') open(annotation.comments.getThread(item.ref)?.root ?? item);
  }

  function startComment() {
    const anchor = selection.getAnchor();
    if (anchor) { setError(''); setCard({ anchor }); }
  }

  return {
    user, restoring, busy, error, threads, card, open, openAt, startComment, edit,
    clearCard: () => { if (!busy) { setCard(undefined); setError(''); } },
    add: (comment: string, color = lastColor.current) => add(color, comment),
    canAdd: !restoring && !busy && annotation.canCreate(),
    canEdit: (item: Annotation) => !restoring && annotation.comments.canSetText(item.ref),
    editor: (item: Annotation) => lastEditors.get(pdfCommentKey(item.ref)) ?? item.modifiedBy,
  };
}

export type PdfAnnotations = ReturnType<typeof usePdfAnnotations>;

function messageOf(reason: unknown): string {
  return reason && typeof reason === 'object' && 'message' in reason ? String(reason.message) : String(reason);
}

export function CommentIcon() {
  return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
    strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 3h8a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7l-3 3v-3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
  </svg>;
}

function CommentBadge({ thread, open }: { thread: CommentThread; open: () => void }) {
  const item = thread.root;
  const anchor = useAnnotationAnchor(item.ref);
  const quad = 'quadPoints' in item && item.quadPoints?.[0];
  const points = quad ? [quad.upperLeft, quad.upperRight, quad.lowerLeft, quad.lowerRight] : undefined;
  const top = points && Math.min(...points.map(point => point.y));
  const right = points && Math.max(...points.map(point => point.x));
  const lineEnd = anchor && top !== undefined && right !== undefined
    ? { page: anchor.page, bounds: { x: right, y: top, width: 0, height: 0 } }
    : anchor;
  const tooltip = [item, ...thread.replies].filter(hasText)
    .map(message => `${authorOf(message)}\n${message.contents}`).join('\n\n');
  return <Anchored anchor={lineEnd} placement={quad ? 'top-start' : 'top-end'} gap={1} pinned>
    <button className="annotation-chrome annotation-marker" aria-label="Open comment" title={tooltip} onClick={open}><CommentIcon /></button>
  </Anchored>;
}

function CommentCard({ thread, anchor, annotations }: { thread?: CommentThread; anchor?: AnchorTarget | null; annotations: PdfAnnotations }) {
  const item = thread?.root;
  const itemAnchor = useAnnotationAnchor(item?.ref ?? null);
  const { projector } = useProjectorBinding();
  const target = itemAnchor ?? anchor ?? null;
  const box = target && projector.toScreen(target.page, target.bounds);
  const view = projector.view();
  const width = view && Math.min(300, view.width - 16);
  const fitsBeside = box && view && width &&
    Math.max(box.x - view.x, view.x + view.width - box.x - box.width) >= width + 16;
  const [draft, setDraft] = useState<string | null>(() => thread && hasComment(thread) ? null : '');
  const author = item ? authorOf(item) : annotations.user;
  const editor = item && annotations.editor(item);
  const existing = item?.contents?.trim();

  async function save(event: FormEvent) {
    event.preventDefault();
    const comment = draft?.trim();
    if (!comment) return;
    if (item ? await annotations.edit(item, comment) : await annotations.add(comment)) setDraft(null);
  }

  return <Anchored anchor={target} placement={fitsBeside ? 'right' : 'bottom'}>
    <section ref={isolateCardWheel} className="annotation-chrome annotation-card" aria-label="Comment card" onKeyDown={event => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
        event.stopPropagation();
        annotations.clearCard();
      }
    }}>
      <div className="annotation-card-heading">
        <strong>{author}</strong>
        <button type="button" className="annotation-badge" aria-label="Close comment card" onClick={annotations.clearCard}>×</button>
      </div>
      {editor && editor !== author && <span className="muted">Edited by {editor}</span>}
      {draft === null ? <>
        {existing && <p className="annotation-comment-text">{item?.contents}</p>}
        {thread?.replies.filter(hasText).map(reply => <div key={annotationKey(reply.ref)}>
          <strong>{authorOf(reply)}</strong><p className="annotation-comment-text">{reply.contents}</p>
        </div>)}
        {item && annotations.canEdit(item) &&
          <button onClick={() => setDraft(item.contents ?? '')}>{existing ? 'Edit comment' : 'Add comment'}</button>}
      </> : <form onSubmit={event => void save(event)}>
        <textarea aria-label="Comment text" rows={3} value={draft} onChange={event => setDraft(event.target.value)} />
        <div className="annotation-card-actions">
          <button type="button" onClick={() => thread && hasComment(thread) ? setDraft(null) : annotations.clearCard()}>Cancel</button>
          <button type="submit" disabled={!draft.trim() || annotations.busy || (item ? !annotations.canEdit(item) : !annotations.canAdd)}>
            {existing ? 'Save comment' : 'Add comment'}
          </button>
        </div>
      </form>}
    </section>
  </Anchored>;
}

export function PageComments({ annotations, close }: { annotations: PdfAnnotations; close: () => void }) {
  const pageIndex = useStageState(state => state.currentPageIndex);
  const closeButton = useRef<HTMLButtonElement>(null);
  const threads = annotations.threads.filter(thread => thread.pageIndex === pageIndex && hasComment(thread));

  useLayoutEffect(() => closeButton.current?.focus({ preventScroll: true }), []);

  return <section id="pdf-page-comments" className="annotation-chrome page-comments-panel" aria-label="Comments on current page"
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    }}>
    <div className="annotation-card-heading">
      <strong>Comments · Page {pageIndex + 1}</strong>
      <button ref={closeButton} className="annotation-badge" aria-label="Close page comments" onClick={close}>×</button>
    </div>
    {threads.length ? <ol className="page-comments-list" aria-label="Page comments">
      {threads.map(thread => <li key={annotationKey(thread.root.ref)}>
        <button className="page-comment-item" onClick={() => { close(); annotations.open(thread.root, true); }}>
          {[thread.root, ...thread.replies].filter(hasText).map(item => <span className="page-comment-message" key={annotationKey(item.ref)}>
            <strong>{authorOf(item)}</strong>
            <span className="annotation-comment-text">{item.contents}</span>
          </span>)}
        </button>
      </li>)}
    </ol> : <p className="page-comments-empty muted">No comments on this page.</p>}
  </section>;
}

export function PdfAnnotationOverlay({ annotations }: { annotations: PdfAnnotations }) {
  const { card } = annotations;
  const thread = card && 'ref' in card && annotations.threads.find(view => annotationKey(view.root.ref) === annotationKey(card.ref));
  return <>
    {annotations.threads.filter(entry => hasComment(entry) && entry !== thread)
      .map(entry => <CommentBadge key={annotationKey(entry.root.ref)} thread={entry} open={() => annotations.open(entry.root)} />)}
    {!card && annotations.canAdd && <SelectionMenu>
      <div className="annotation-chrome annotation-palette" role="toolbar" aria-label="Highlight palette">
        {colors.map(color => <button key={color.name} className="annotation-swatch" aria-label={`Highlight ${color.name.toLowerCase()}`}
          title={color.name} onClick={() => void annotations.add('', color.value)}>
          <span style={{ background: color.value }} />
        </button>)}
        <button className="annotation-badge" aria-label="Comment on selection" title="Add comment"
          onClick={annotations.startComment}><CommentIcon /></button>
      </div>
    </SelectionMenu>}
    {thread ? <CommentCard key={annotationKey(thread.root.ref)} thread={thread} annotations={annotations} /> :
      card && 'anchor' in card ? <CommentCard anchor={card.anchor} annotations={annotations} /> : null}
  </>;
}
