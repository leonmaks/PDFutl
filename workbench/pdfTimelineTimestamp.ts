import { disposableTimeout } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { formatPdfTimelineDate } from './pdfTimelineDate.js';
import './media/pdfTimelineTimestamp.css';

const nowDuration = 30_000;

export function renderPdfTimelineTimestamp(element: HTMLSpanElement, timestamp: number, disposables: DisposableStore): void {
	const date = element.ownerDocument.createElement('span');
	date.className = 'pdfutl-timeline-date';
	date.textContent = formatPdfTimelineDate(timestamp);
	element.replaceChildren(date);
	element.ariaLabel = date.textContent;

	const age = Date.now() - timestamp;
	if (age < 0 || age >= nowDuration) {
		return;
	}
	const suffix = element.ownerDocument.createElement('span');
	suffix.className = 'pdfutl-timeline-now';
	suffix.textContent = ' (now)';
	element.append(suffix);
	disposableTimeout(() => suffix.remove(), nowDuration - age, disposables);
}
