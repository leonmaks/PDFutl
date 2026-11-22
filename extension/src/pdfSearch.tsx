import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react';
import { StageToken } from '@embedpdf/plugin-stage/contract/host';
import { useCapability } from '@embedpdf/react/runtime';
import { useSearch, useSearchHits, useSearchState, type SearchHit } from '@embedpdf/react/search';
import { useStageState } from '@embedpdf/react/stage';
import type { PdfInteraction } from './pdfAnnotationActivity';
import { CommentIcon } from './pdfAnnotations';

const showDelay = 200;
const hideDelay = 350;
// With an explicit alignment object, EmbedPDF reveals the match within the padded viewport.
const revealInPaddedView = { align: {} };
const keepCurrentView = { align: { x: 'keep', y: 'keep' } } as const;

type SearchStep = 'enter' | 1 | -1;
type SearchRun = { running: boolean; revealed: boolean; moves: SearchStep[] };
type IconName = 'chevron' | 'previous' | 'next' | 'pin' | 'options' | 'minus' | 'plus' | 'fitPage';
type SearchPopup = 'matches' | 'options';
type ViewportRect = { x: number; y: number; width: number; height: number };

function overlapsHorizontally(a: ViewportRect, b: ViewportRect) {
  return a.x < b.x + b.width && b.x < a.x + a.width;
}

function overlaps(a: ViewportRect, b: ViewportRect) {
  return overlapsHorizontally(a, b) && a.y < b.y + b.height && b.y < a.y + a.height;
}

export type PdfSearchHandle = { open(): void; toggleComments(): void };

function SearchIcon({ name }: { name: IconName }) {
  const paths = {
    chevron: 'm5 7 3 3 3-3',
    previous: 'm10 4-4 4 4 4',
    next: 'm6 4 4 4-4 4',
    pin: 'M6 2.75h4m-3.5 0v4L4 9.25v1h8v-1l-2.5-2.5v-4M8 10.25v3',
    options: 'M2 4h3m3 0h6M2 8h7m3 0h2M2 12h3m3 0h6M5 2.5v3m7 1v3m-7 1v3',
    minus: 'M4 8h8',
    plus: 'M4 8h8M8 4v8',
    fitPage: 'M2 6V2h4m4 0h4v4m0 4v4h-4m-4 0H2v-4M6 5h4v6H6z',
  };
  return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
    strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={paths[name]} />
  </svg>;
}

function ZoomControls() {
  const stage = useCapability(StageToken);
  const zoom = Math.round(useStageState(state => state.zoomLevel) * 100);
  const [custom, setCustom] = useState<string | null>(null);

  function applyZoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (custom === null) return;
    const percent = Number(custom.trim().replace(/%$/, '').replace(',', '.'));
    if (Number.isFinite(percent) && percent > 0) stage.zoomTo(Math.min(4000, Math.max(25, percent)) / 100);
    setCustom(null);
  }

  return <div className="zoom-controls" role="group" aria-label="PDF zoom">
    <button className="search-icon" onClick={() => stage.zoomOut()} disabled={zoom <= 25}
      aria-label="Zoom out" title="Zoom out"><SearchIcon name="minus" /></button>
    <form onSubmit={applyZoom}>
      <input className="zoom-value" aria-label="Zoom percent" value={custom ?? `${zoom}%`}
        onFocus={event => event.currentTarget.select()} onChange={event => setCustom(event.target.value)}
        onBlur={() => setCustom(null)} />
    </form>
    <button className="search-icon" onClick={() => stage.zoomIn()} disabled={zoom >= 4000}
      aria-label="Zoom in" title="Zoom in"><SearchIcon name="plus" /></button>
    <button className="search-icon" onClick={() => stage.fitPage()} aria-label="Fit page" title="Fit page"><SearchIcon name="fitPage" /></button>
  </div>;
}

export function PdfSearch({ ref, children, onSearch, pageComments, onToggleComments, onCloseComments }: {
  ref: Ref<PdfSearchHandle>; children: ReactNode; onSearch: (activity: Extract<PdfInteraction, { kind: 'search' }>) => void;
  pageComments?: ReactNode; onToggleComments: () => void; onCloseComments: () => void;
}) {
  const search = useSearch();
  const stage = useCapability(StageToken);
  const hits = useSearchHits();
  const active = useSearchState(state => state.activeHitIndex);
  const status = useSearchState(state => state.status);
  const preview = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLElement>(null);
  const toolbarBottom = useRef(0);
  const field = useRef<HTMLInputElement>(null);
  const resultsList = useRef<HTMLOListElement>(null);
  const optionsButton = useRef<HTMLButtonElement>(null);
  const optionsCard = useRef<HTMLDivElement>(null);
  const currentResult = useRef<HTMLButtonElement>(null);
  const matchPadding = useRef<{ top: number; release: () => void } | undefined>(undefined);
  const hovered = useRef(false);
  const hoverTimer = useRef<number | undefined>(undefined);
  const navigation = useRef<SearchRun>({ running: false, revealed: false, moves: [] });
  const [visible, setVisible] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [popup, setPopup] = useState<SearchPopup | null>(null);
  const [focusRequest, requestFocus] = useState(0);
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [error, setError] = useState('');
  const resultsOpen = popup === 'matches';
  const optionsOpen = popup === 'options';

  const clearMatchPadding = useCallback(() => {
    const padding = matchPadding.current;
    matchPadding.current = undefined;
    padding?.release();
  }, []);

  const goToResult = useCallback((hit: SearchHit, index: number) => {
    const viewport = preview.current?.getBoundingClientRect();
    const bar = overlay.current;
    const bounds = hit.bounds;
    const target = search.listHits()[index] === hit ? index : hit;
    if (!viewport || !bounds) {
      if (search.goToHit(target)) navigation.current.revealed = true;
      return;
    }

    const obstacles = [bar, resultsList.current, optionsCard.current].flatMap(element => {
      if (bar?.dataset.visible !== 'true' || !element) return [];
      const rect = element.getBoundingClientRect();
      return rect.height > 0
        ? [{ x: rect.left - viewport.left, y: rect.top - viewport.top, width: rect.width, height: rect.height }]
        : [];
    });
    const isCovered = (match: ViewportRect) => obstacles.some(obstacle => overlaps(match, obstacle) &&
      hit.segments.some(segment => {
        const line = stage.pageRectToViewport(hit.page, segment.rect);
        return line && overlaps(line, obstacle);
      }));

    const before = stage.pageRectToViewport(hit.page, bounds);
    const withinVerticalView = before && before.y >= 0 && before.y + before.height <= viewport.height;
    const alreadyVisible = withinVerticalView && before.x >= 0 && before.x + before.width <= viewport.width && !isCovered(before);
    const placement = alreadyVisible ? keepCurrentView : withinVerticalView ? revealInPaddedView : undefined;
    if (!search.goToHit(target, placement)) return;
    navigation.current.revealed = true;
    if (alreadyVisible) return;

    // Normal navigation may stop at the top of the PDF, so extend the limit only when a control still covers the hit.
    const after = stage.pageRectToViewport(hit.page, bounds);
    if (!after || !isCovered(after)) return;
    const overlappingColumns = obstacles.filter(obstacle => overlapsHorizontally(after, obstacle));
    const top = Math.ceil(Math.max(...overlappingColumns.map(obstacle => obstacle.y + obstacle.height))) + 8;
    if (matchPadding.current?.top !== top) {
      clearMatchPadding();
      const padding = stage.getSettings().padding;
      const sides = typeof padding === 'number' ? { top: padding, right: padding, bottom: padding, left: padding } : padding;
      matchPadding.current = {
        top,
        release: stage.lockSettings({
          by: 'pdfutl.search',
          settings: { padding: { ...sides, top: Math.max(sides.top, top) } },
        }),
      };
    }
    search.revealActiveHit(revealInPaddedView);
  }, [clearMatchPadding, search, stage]);

  const drainMoves = useCallback(() => {
    const run = navigation.current;
    while (run.moves.length) {
      const results = search.listHits();
      const count = results.length;
      const step = run.moves[0];
      // EmbedPDF highlights the first hit as soon as it finds one, before revealing it.
      const index = !run.revealed && step === 'enter' ? 0 : search.getActiveHitIndex() + (step === 'enter' ? 1 : step);
      if (run.running && (index < 0 || index >= count)) return;
      run.moves.shift();
      if (count) {
        const wrapped = (index % count + count) % count;
        goToResult(results[wrapped], wrapped);
      }
    }
  }, [goToResult, search]);

  const move = useCallback((step: SearchStep) => {
    if (!query) return;
    onSearch({ kind: 'search', query, matchCase, wholeWord, regex });
    navigation.current.moves.push(step);
    drainMoves();
  }, [drainMoves, matchCase, onSearch, query, regex, wholeWord]);

  useLayoutEffect(() => {
    const run: SearchRun = { running: Boolean(query), revealed: false, moves: [] };
    navigation.current = run;
    search.clear();
    setError('');
    if (!query) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void search.search({ text: query, matchCase, wholeWord, regex }, { signal: controller.signal, from: 0 })
        .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); })
        .finally(() => {
          if (controller.signal.aborted) return;
          run.running = false;
          drainMoves();
        });
    }, 130);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [search, query, matchCase, wholeWord, regex, drainMoves]);

  useLayoutEffect(() => { drainMoves(); }, [hits, drainMoves]);

  useLayoutEffect(() => {
    if (focusRequest) {
      field.current?.focus({ preventScroll: true });
      field.current?.select();
    }
  }, [focusRequest]);

  useLayoutEffect(() => {
    // Hiding search UI must not reclamp a view that still uses the extra room at the top.
    const onCameraChanged = stage.onCameraChanged(() => {
      const padding = matchPadding.current;
      if (!padding) return;
      queueMicrotask(() => {
        if (matchPadding.current !== padding) return;
        const { scrollTop, scrollHeight, clientHeight } = stage.getScrollMetrics();
        const original = stage.getViewState().padding;
        const extraTop = padding.top - (typeof original === 'number' ? original : original.top);
        if (scrollTop >= extraTop && scrollTop < scrollHeight - clientHeight) clearMatchPadding();
      });
    });
    const onZoomChanged = stage.onSettingsChanged(({ changedKeys }) => {
      const padding = matchPadding.current;
      if (!padding || !changedKeys.includes('zoom')) return;
      queueMicrotask(() => {
        if (matchPadding.current !== padding) return;
        clearMatchPadding();
        if (stage.getZoomMode() !== 'custom') stage.refit();
      });
    });
    return () => {
      onCameraChanged();
      onZoomChanged();
      clearMatchPadding();
    };
  }, [clearMatchPadding, stage]);

  useLayoutEffect(() => {
    const row = currentResult.current;
    const list = row?.closest('ol');
    if (!visible || !resultsOpen || !row || !list) return;
    const bounds = row.getBoundingClientRect();
    const top = list.getBoundingClientRect().top + list.clientTop;
    const bottom = top + list.clientHeight;
    if (bounds.top < top) list.scrollTop -= top - bounds.top;
    else if (bounds.bottom > bottom) list.scrollTop += bounds.bottom - bottom;
  }, [active, hits, resultsOpen, visible]);

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  useLayoutEffect(() => {
    const panel = overlay.current;
    const viewport = preview.current;
    if (!panel || !viewport) return;
    function measure() {
      if (!panel || !viewport) return;
      toolbarBottom.current = panel.offsetTop + panel.offsetHeight;
      viewport.style.setProperty('--pdf-tools-bottom', `${toolbarBottom.current}px`);
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel, { box: 'border-box' });
    return () => observer.disconnect();
  }, []);

  const open = useCallback(() => {
    window.clearTimeout(hoverTimer.current);
    onCloseComments();
    setPinned(true);
    setVisible(true);
    requestFocus(count => count + 1);
  }, [onCloseComments]);

  const toggleComments = useCallback(() => {
    setPopup(null);
    onToggleComments();
  }, [onToggleComments]);
  useImperativeHandle(ref, () => ({ open, toggleComments }), [open, toggleComments]);

  function togglePopup(next: SearchPopup) {
    onCloseComments();
    setPopup(value => value === next ? null : next);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.code === 'KeyF' && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        open();
      } else if (event.code === 'KeyM' && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) toggleComments();
      } else if (event.key === 'F3' && visible) {
        event.preventDefault();
        move(event.shiftKey ? -1 : 1);
      }
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, move, toggleComments, visible]);

  function scheduleVisibility(show: boolean, keepOpen = pinned) {
    window.clearTimeout(hoverTimer.current);
    if (keepOpen || show === visible) return;
    hoverTimer.current = window.setTimeout(() => {
      setVisible(show);
      if (!show) {
        setPopup(null);
        if (overlay.current?.contains(document.activeElement)) preview.current?.focus({ preventScroll: true });
      }
    }, show ? showDelay : hideDelay);
  }

  function updateHover(inside: boolean) {
    if (hovered.current === inside) return;
    hovered.current = inside;
    scheduleVisibility(inside);
  }

  return <div className="preview" ref={preview} tabIndex={-1} onPointerDown={event => {
    if (optionsOpen && !optionsButton.current?.parentElement?.contains(event.target as Node)) setPopup(null);
  }} onPointerMoveCapture={event => {
    if (event.pointerType !== 'mouse') return;
    const bounds = event.currentTarget.getBoundingClientRect();
    updateHover(event.clientY < bounds.top + toolbarBottom.current || !!overlay.current?.contains(event.target as Node));
  }} onPointerLeave={() => updateHover(false)}>
    {children}
    <section className="search-overlay" ref={overlay} aria-label="PDF search and zoom"
      data-visible={visible} inert={!visible} onMouseDown={event => {
        // Pointer navigation should leave Enter available in the search field.
        if (document.activeElement === field.current && (event.target as Element).closest('button[data-search-navigation]')) {
          event.preventDefault();
        }
      }} onKeyDown={event => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        if (optionsOpen) {
          setPopup(null);
          optionsButton.current?.focus({ preventScroll: true });
        } else if (resultsOpen) {
          setPopup(null);
          field.current?.focus({ preventScroll: true });
        } else {
          preview.current?.focus({ preventScroll: true });
        }
      }}>
      <div className="search-field">
        <input ref={field} type="search" aria-label="Find text" placeholder="Find in PDF" value={query}
          onFocus={onCloseComments} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
            event.preventDefault();
            move(event.shiftKey ? -1 : 'enter');
          }} />
        <button className="search-icon" type="button" aria-label="Search matches" title="Search matches"
          aria-controls="pdf-search-matches" aria-expanded={resultsOpen} disabled={!hits.length && !resultsOpen}
          data-search-navigation onClick={() => togglePopup('matches')}><SearchIcon name="chevron" /></button>
      </div>
      <div className="search-options">
        <button className="search-icon" ref={optionsButton} aria-label="Search options" title="Search options"
          aria-controls="pdf-search-options" aria-expanded={optionsOpen} data-active={matchCase || wholeWord || regex}
          onClick={() => togglePopup('options')}><SearchIcon name="options" /></button>
        <div className="search-options-popup" id="pdf-search-options" hidden={!optionsOpen}>
          <div className="search-options-card" role="group" aria-label="Search options" ref={optionsCard}>
            <label><input type="checkbox" checked={matchCase} onChange={event => setMatchCase(event.target.checked)} />Match case</label>
            <label><input type="checkbox" checked={wholeWord} onChange={event => setWholeWord(event.target.checked)} />Whole word</label>
            <label><input type="checkbox" checked={regex} onChange={event => setRegex(event.target.checked)} />Regular expression</label>
          </div>
        </div>
      </div>
      <div className="search-navigation">
        <span role="status" className="search-count muted" title={error || undefined}>
          {error || (hits.length ? `${active + 1} of ${hits.length}` : status === 'searching' ? 'Searching…' : query && status === 'complete' ? 'No matches' : '')}
        </span>
        <button className="search-icon" disabled={!hits.length} aria-label="Previous match" title="Previous match" data-search-navigation
          onClick={() => move(-1)}><SearchIcon name="previous" /></button>
        <button className="search-icon" disabled={!hits.length} aria-label="Next match" title="Next match" data-search-navigation
          onClick={() => move(1)}><SearchIcon name="next" /></button>
      </div>
      <ZoomControls />
      <button className="search-icon search-comments" aria-label="Page comments" aria-pressed={Boolean(pageComments)}
        aria-keyshortcuts="Control+Shift+M" title="Page comments (Ctrl+Shift+M)"
        onClick={toggleComments}><CommentIcon /></button>
      <button className="search-icon search-pin" aria-label="Pin search panel" aria-pressed={pinned}
        title={pinned ? 'Unpin search panel' : 'Pin search panel'} onClick={() => {
          setPinned(!pinned);
          if (pinned && !hovered.current) scheduleVisibility(false, false);
          else window.clearTimeout(hoverTimer.current);
        }}><SearchIcon name="pin" /></button>
      <div className="search-results-anchor" id="pdf-search-matches" hidden={!resultsOpen}>
        <div className="search-results-menu">
          <ol className="results search-results" aria-label="All matches" ref={resultsList}>
            {hits.map((hit, index) => <li key={`${hit.pageIndex}:${hit.start}:${hit.count}`}>
              <button className="result" aria-current={active === index ? 'true' : undefined}
                ref={active === index ? currentResult : undefined} data-search-navigation onClick={() => {
                  navigation.current.moves.length = 0;
                  goToResult(hit, index);
                }}>
                <span className="muted">Page {hit.pageIndex + 1}</span>
                {hit.snippet && <span>{hit.snippet.before}<mark>{hit.snippet.match}</mark>{hit.snippet.after}</span>}
              </button>
            </li>)}
          </ol>
        </div>
      </div>
    </section>
    {pageComments}
  </div>;
}
