import { isFullscreen } from '../../../base/browser/browser.js';
import { addDisposableListener, getActiveWindow } from '../../../base/browser/dom.js';
import { CodeWindow } from '../../../base/browser/window.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { WebviewInput } from '../../contrib/webviewPanel/browser/webviewEditorInput.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import { IHostService } from '../../services/host/browser/host.js';

const fullscreenClass = 'pdfutl-fullscreen-webview';
const sessions = new WeakMap<Window, () => Promise<void>>();

CommandsRegistry.registerCommand('pdfutl.exitFullscreen', () => sessions.get(getActiveWindow())?.());

export function togglePdfFullscreen(editorService: IEditorService, host: IHostService, target: CodeWindow): Promise<void> | undefined {
	const exit = sessions.get(target);
	if (exit) {
		return exit();
	}
	const editor = editorService.activeEditor;
	if (isFullscreen(target) || !(editor instanceof WebviewInput) || editor.viewType !== 'pdfutl.viewer') {
		return undefined;
	}
	return enterPdfFullscreen(editor, editorService, host, target);
}

async function enterPdfFullscreen(editor: WebviewInput, editorService: IEditorService, host: IHostService, target: CodeWindow): Promise<void> {
	const container = editor.webview.container;
	const session = new DisposableStore();
	let exitRequest: Promise<void> | undefined;
	let active = false;
	const entering = host.toggleFullScreen(target);
	const cleanup = () => {
		if (sessions.get(target) !== exit) {
			return;
		}
		session.dispose();
		sessions.delete(target);
		container.classList.remove(fullscreenClass);
		if (active && !editor.isDisposed()) {
			void editor.webview.postMessage({ type: 'pdfutl.fullscreen', active: false });
		}
	};
	const exit = () => exitRequest ??= entering.then(() => host.toggleFullScreen(target)).finally(cleanup);
	sessions.set(target, exit);
	session.add(host.onDidChangeFullScreen(event => {
		if (event.windowId === target.vscodeWindowId && !event.fullscreen) {
			cleanup();
		}
	}));
	session.add(editorService.onDidActiveEditorChange(() => {
		if (editorService.activeEditor !== editor) {
			void exit();
		}
	}));
	session.add(addDisposableListener(target, 'keydown', event => {
		if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && !event.repeat) {
			event.preventDefault();
			void exit();
		}
	}));
	session.add(editor.webview.onDidDispose(() => void exit()));
	session.add(editor.webview.onMessage(({ message }) => {
		if (active && message?.type === 'ready') {
			void editor.webview.postMessage({ type: 'pdfutl.fullscreen', active: true });
		}
	}));
	try {
		await entering;
	} catch (error) {
		cleanup();
		throw error;
	}
	if (exitRequest) {
		return;
	}
	active = true;
	container.classList.add(fullscreenClass);
	void editor.webview.postMessage({ type: 'pdfutl.fullscreen', active: true });
	editor.webview.focus();
}
