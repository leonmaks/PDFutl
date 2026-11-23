import { localize } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { CONTEXT_ACTIVE_CUSTOM_EDITOR_ID } from '../../../contrib/customEditor/common/customEditor.js';
import { EditorPartMaximizedEditorGroupContext, EditorPartMultipleEditorGroupsContext, SideBarVisibleContext } from '../../../common/contextkeys.js';

const activePdf = CONTEXT_ACTIVE_CUSTOM_EDITOR_ID.isEqualTo('pdfutl.viewer');

function addCommand(menu: MenuId, id: string, title: string, group: string, order: number) {
	MenuRegistry.appendMenuItem(menu, { command: { id, title, precondition: activePdf }, group, order });
}

addCommand(MenuId.MenubarEditMenu, 'pdfutl.find', localize('pdfutl.find', "&&Find"), '3_find', 1);
addCommand(MenuId.MenubarEditMenu, 'pdfutl.findNext', localize('pdfutl.findNext', "Find Next"), '3_find', 2);
addCommand(MenuId.MenubarEditMenu, 'pdfutl.findPrevious', localize('pdfutl.findPrevious', "Find Previous"), '3_find', 3);
MenuRegistry.appendMenuItem(MenuId.MenubarEditMenu, {
	command: { id: 'editor.action.selectAll', title: localize('pdfutl.selectAll', "Select &&All") },
	group: '2_ccp',
	order: 5,
});

MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
	command: { id: 'pdfutl.pinFolder', title: localize('pdfutl.pinFolder', "&&Pin Folder...") },
	group: '2_open',
	order: 5,
});

MenuRegistry.appendMenuItems([
	{ id: MenuId.MenubarViewMenu, item: {
		command: { id: 'workbench.action.toggleSidebarVisibility', title: localize('pdfutl.navigator', "&&Navigator"), toggled: SideBarVisibleContext },
		group: '1_open', order: 2,
	} },
	{ id: MenuId.MenubarViewMenu, item: {
		command: { id: 'outline.focus', title: localize('pdfutl.outline', "PDF &&Outline"), precondition: activePdf },
		group: '1_open', order: 3,
	} },
	{ id: MenuId.MenubarViewMenu, item: {
		command: { id: 'timeline.focus', title: localize('pdfutl.timeline', "PDF &&Timeline"), precondition: activePdf },
		group: '1_open', order: 4,
	} },
]);

MenuRegistry.appendMenuItems([
	{ id: MenuId.MenubarLayoutMenu, item: {
		command: {
			id: 'workbench.action.toggleMaximizeEditorGroup',
			title: localize('pdfutl.maximizeGroup', "Maximize Editor Group"),
			precondition: EditorPartMultipleEditorGroupsContext,
		},
		when: EditorPartMaximizedEditorGroupContext.negate(),
		group: '2_split_in_group', order: 2,
	} },
	{ id: MenuId.MenubarLayoutMenu, item: {
		command: { id: 'workbench.action.toggleMaximizeEditorGroup', title: localize('pdfutl.restoreGroups', "Restore Editor Groups") },
		when: EditorPartMaximizedEditorGroupContext,
		group: '2_split_in_group', order: 2,
	} },
]);

addCommand(MenuId.MenubarViewMenu, 'pdfutl.zoomIn', localize('pdfutl.zoomIn', "PDF Zoom In"), '3_pdf_zoom', 1);
addCommand(MenuId.MenubarViewMenu, 'pdfutl.zoomOut', localize('pdfutl.zoomOut', "PDF Zoom Out"), '3_pdf_zoom', 2);
addCommand(MenuId.MenubarViewMenu, 'pdfutl.actualSize', localize('pdfutl.actualSize', "Actual Size (100%)"), '3_pdf_zoom', 3);
addCommand(MenuId.MenubarViewMenu, 'pdfutl.fitPage', localize('pdfutl.fitPage', "Fit Page"), '3_pdf_zoom', 4);
addCommand(MenuId.MenubarGoMenu, 'pdfutl.goToPage', localize('pdfutl.goToPage', "Go to &&Page..."), '4_page', 1);

const annotationsMenu = new MenuId('PdfutlMenubarAnnotationsMenu');
MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: annotationsMenu,
	title: { value: 'Annotations', original: 'Annotations', mnemonicTitle: localize('pdfutl.annotations', "&&Annotations") },
	order: 6,
});
addCommand(annotationsMenu, 'pdfutl.highlightSelection', localize('pdfutl.highlightSelection', "&&Highlight Selection"), '1_markup', 1);
addCommand(annotationsMenu, 'pdfutl.addComment', localize('pdfutl.addComment', "Add &&Comment"), '1_markup', 2);
addCommand(annotationsMenu, 'pdfutl.togglePageComments', localize('pdfutl.pageComments', "Comments on Current &&Page"), '2_views', 1);

const diagnosticsMenu = new MenuId('PdfutlMenubarDiagnosticsMenu');
MenuRegistry.appendMenuItem(MenuId.MenubarHelpMenu, {
	submenu: diagnosticsMenu,
	title: localize('pdfutl.diagnostics', "&&Diagnostics"),
	group: '5_tools',
	order: 1,
});
MenuRegistry.appendMenuItems([
	{ id: diagnosticsMenu, item: { command: {
		id: 'workbench.action.toggleDevTools', title: localize('pdfutl.devTools', "Toggle Developer Tools"),
	}, order: 1 } },
	{ id: diagnosticsMenu, item: { command: {
		id: 'workbench.action.openProcessExplorer', title: localize('pdfutl.processExplorer', "Open Process Explorer"),
	}, order: 2 } },
]);
