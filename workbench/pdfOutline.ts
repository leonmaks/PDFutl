import { IconLabel } from '../../../../base/browser/ui/iconLabel/iconLabel.js';
import { ITreeRenderer } from '../../../../base/browser/ui/tree/tree.js';
import { DeferredPromise, raceCancellation } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { createMatches, FuzzyScore } from '../../../../base/common/filters.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IEditorPane } from '../../../common/editor.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IOutline, IOutlineCreator, IOutlineListConfig, IOutlineService, OutlineTarget } from '../../../services/outline/browser/outline.js';
import { CustomEditorInput } from '../../customEditor/browser/customEditorInput.js';
import { IOverlayWebview } from '../../webview/browser/webview.js';
import type { PdfBookmark, PdfOutlineRequest, PdfOutlineResponse } from './pdfOutlineProtocol.js';

interface Entry extends PdfBookmark {
	readonly position: number;
}

const renderer: ITreeRenderer<Entry, FuzzyScore, IconLabel> = {
	templateId: 'pdfutl.bookmark',
	renderTemplate: container => new IconLabel(container, { supportHighlights: true }),
	renderElement: ({ element, filterData }, _index, label) => label.setLabel(element.title, undefined, {
		matches: createMatches(filterData),
		labelEscapeNewLines: true,
		title: element.title,
	}),
	disposeTemplate: label => label.dispose(),
};

class PdfOutline implements IOutline<Entry> {
	readonly outlineKind = 'pdfutl';
	readonly onDidChange = Event.None;
	readonly activeElement = undefined;
	private readonly children = new Map<number | null, Entry[]>();
	private disposed = false;

	constructor(private readonly input: CustomEditorInput, bookmarks: readonly PdfBookmark[]) {
		const ids = new Set(bookmarks.map(bookmark => bookmark.id));
		for (const [position, bookmark] of bookmarks.entries()) {
			const parent = bookmark.parentId !== null && ids.has(bookmark.parentId) ? bookmark.parentId : null;
			let siblings = this.children.get(parent);
			if (!siblings) {
				siblings = [];
				this.children.set(parent, siblings);
			}
			siblings.push({ ...bookmark, position });
		}
	}

	readonly config: IOutlineListConfig<Entry> = {
		treeDataSource: { getChildren: entry => this.children.get('id' in entry ? entry.id : null) ?? [] },
		delegate: { getHeight: () => 22, getTemplateId: () => renderer.templateId },
		renderers: [renderer],
		comparator: {
			compareByPosition: (a, b) => a.position - b.position,
			compareByName: (a, b) => a.title.localeCompare(b.title),
			compareByType: (a, b) => a.position - b.position,
		},
		options: {
			accessibilityProvider: {
				getWidgetAriaLabel: () => localize('pdfBookmarks', 'PDF Bookmarks'),
				getAriaLabel: entry => entry.title,
			},
			identityProvider: { getId: entry => String(entry.id) },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: entry => entry.title },
		},
		breadcrumbsDataSource: { getBreadcrumbElements: () => [] },
		quickPickDataSource: { getQuickPickElements: () => [] },
	};

	get uri() { return this.input.resource; }
	get isEmpty() { return !this.children.get(null)?.length; }

	async reveal(entry: Entry): Promise<void> {
		if (!this.disposed && entry.canNavigate) {
			await this.input.webview.postMessage({ type: 'pdfutl.revealBookmark', id: entry.id } satisfies PdfOutlineRequest);
		}
	}

	preview() { return Disposable.None; }
	captureViewState() { return Disposable.None; }
	dispose() { this.disposed = true; }
}

async function readBookmarks(webview: IOverlayWebview, token: CancellationToken): Promise<readonly PdfBookmark[] | undefined> {
	if (token.isCancellationRequested) return;
	const bookmarks = new DeferredPromise<readonly PdfBookmark[]>();
	const listeners = new DisposableStore();
	try {
		listeners.add(webview.onMessage(({ message }: { message: PdfOutlineResponse | undefined }) => {
			if (message?.type === 'pdfutl.outline' && Array.isArray(message.bookmarks)) {
				void bookmarks.complete(message.bookmarks);
			}
		}));
		listeners.add(webview.onDidDispose(() => void bookmarks.complete([])));
		listeners.add(webview.onFatalError(() => void bookmarks.complete([])));
		// The viewer publishes on load and replays the result if the Outline opens later.
		void webview.postMessage({ type: 'pdfutl.requestOutline' } satisfies PdfOutlineRequest);
		return await raceCancellation(bookmarks.p, token);
	} finally {
		listeners.dispose();
	}
}

class PdfOutlineCreator extends Disposable implements IOutlineCreator<IEditorPane, Entry> {
	constructor(@IOutlineService outlineService: IOutlineService) {
		super();
		this._register(outlineService.registerOutlineCreator(this));
	}

	matches(editor: IEditorPane): editor is IEditorPane {
		return editor.input instanceof CustomEditorInput && editor.input.viewType === 'pdfutl.viewer';
	}

	async createOutline(editor: IEditorPane, target: OutlineTarget, token: CancellationToken): Promise<PdfOutline | undefined> {
		const input = editor.input;
		if (target !== OutlineTarget.OutlinePane || !(input instanceof CustomEditorInput)) return;
		const bookmarks = await readBookmarks(input.webview, token);
		return bookmarks && new PdfOutline(input, bookmarks);
	}
}

registerWorkbenchContribution2('pdfutl.outlineCreator', PdfOutlineCreator, WorkbenchPhase.BlockRestore);
