import type { IGridLayoutArea } from '../../../../base/browser/ui/grid/gridview.js';
import './media/editorSplitFrames.css';

const halfGap = 1;
const stroke = 1;

export function layoutEditorSplitFrame(element: HTMLElement, view: IGridLayoutArea, grid?: IGridLayoutArea): IGridLayoutArea {
	const top = grid && view.top > grid.top ? halfGap : 0;
	const left = grid && view.left > grid.left ? halfGap : 0;
	const right = grid && view.left + view.width < grid.left + grid.width ? halfGap : 0;
	const bottom = grid && view.top + view.height < grid.top + grid.height ? halfGap : 0;
	const framed = top + left + right + bottom > 0;
	element.classList.toggle('pdfutl-split-editor-frame', framed);
	if (!framed) {
		return view;
	}

	const frameWidth = Math.max(0, view.width - left - right);
	const frameHeight = Math.max(0, view.height - top - bottom);
	element.style.setProperty('--pdfutl-split-frame-margin', [top, right, bottom, left].map(value => value + 'px').join(' '));
	element.style.setProperty('--pdfutl-split-frame-width', frameWidth + 'px');
	element.style.setProperty('--pdfutl-split-frame-height', frameHeight + 'px');
	return {
		width: Math.max(0, frameWidth - 2 * stroke),
		height: Math.max(0, frameHeight - 2 * stroke),
		top: view.top + top + stroke,
		left: view.left + left + stroke,
	};
}
