import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import './media/pdfPinnedFolders.css';

export const pdfPinnedFoldersViewId = 'pdfutl.pinnedFolders';

const view = ContextKeyExpr.equals('view', pdfPinnedFoldersViewId);
const folder = ContextKeyExpr.regex('viewItem', /^pdfutl\.pinned(?:Root|Folder):/);

function addAction(id: string, title: string, icon: ThemeIcon, order: number,
	section: ContextKeyExpression, row: ContextKeyExpression, active = false): void {
	MenuRegistry.appendMenuItems([
		{
			id: MenuId.ViewTitle,
			item: {
				command: { id: id + 'InSection', title, icon, toggled: active ? section : undefined },
				when: ContextKeyExpr.and(view, section), group: 'navigation', order: order + 2,
			},
		},
		{
			id: MenuId.ViewItemContext,
			item: {
				command: { id, title, icon, toggled: active ? row : undefined },
				when: ContextKeyExpr.and(view, folder, row), group: 'inline', order,
			},
		},
	]);
}

for (const { field, command, icon, first, last, order } of [
	{ field: 'name', command: 'pdfutl.sortPinnedByName', icon: Codicon.caseSensitive, first: 'A–Z', last: 'Z–A', order: 1 },
	{ field: 'date', command: 'pdfutl.sortPinnedByDate', icon: Codicon.calendar, first: 'Oldest first', last: 'Newest first', order: 2 },
]) {
	const sectionAsc = ContextKeyExpr.equals(`${pdfPinnedFoldersViewId}.sort`, `${field}-asc`);
	const sectionDesc = ContextKeyExpr.equals(`${pdfPinnedFoldersViewId}.sort`, `${field}-desc`);
	const rowAsc = ContextKeyExpr.regex('viewItem', new RegExp(`:${field}-asc:`));
	const rowDesc = ContextKeyExpr.regex('viewItem', new RegExp(`:${field}-desc:`));
	addAction(command, `Sort by ${field} · ${first}`, icon, order,
		ContextKeyExpr.and(sectionAsc.negate(), sectionDesc.negate())!,
		ContextKeyExpr.and(rowAsc.negate(), rowDesc.negate())!);
	addAction(command, `Sorted by ${field} · ${first}. Switch to ${last}`,
		registerIcon(`pdfutl-${field}-asc`, icon, `Sort by ${field}, ascending`), order, sectionAsc, rowAsc, true);
	addAction(command, `Sorted by ${field} · ${last}. Switch to ${first}`,
		registerIcon(`pdfutl-${field}-desc`, icon, `Sort by ${field}, descending`), order, sectionDesc, rowDesc, true);
}

const sectionDates = ContextKeyExpr.has(`${pdfPinnedFoldersViewId}.showDates`);
const folderDates = ContextKeyExpr.regex('viewItem', /:dates-shown$/);
addAction('pdfutl.togglePinnedDates', 'Hide modification dates', Codicon.clock, 3, sectionDates, folderDates, true);
addAction('pdfutl.togglePinnedDates', 'Show modification dates', Codicon.eyeClosed, 3, sectionDates.negate(), folderDates.negate());
