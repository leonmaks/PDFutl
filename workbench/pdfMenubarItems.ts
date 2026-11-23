import type { IMenuItem, ISubmenuItem } from './actions.js';
import type { IRecentlyOpened } from '../../workspaces/common/workspaces.js';

// Keep the native menu renderer, actions, context keys and keyboard shortcuts.
const visibleItems: Record<string, readonly string[]> = {
	MenubarMainMenu: ['MenubarFileMenu', 'MenubarEditMenu', 'MenubarViewMenu', 'MenubarGoMenu', 'PdfutlMenubarAnnotationsMenu', 'MenubarHelpMenu'],
	MenubarFileMenu: [
		'workbench.action.newWindow', 'workbench.action.files.openFile', 'MenubarRecentMenu', 'pdfutl.pinFolder',
		'workbench.action.files.saveAs', 'MenubarPreferencesMenu', 'workbench.action.closeActiveEditor',
		'workbench.action.closeWindow', 'workbench.action.quit',
	],
	MenubarPreferencesMenu: [
		'workbench.action.openSettings', 'workbench.action.openGlobalKeybindings', 'ThemesSubMenu',
		'workbench.profiles.actions.manageProfiles', 'Profiles',
	],
	MenubarEditMenu: [
		'undo', 'redo', 'editor.action.clipboardCutAction', 'editor.action.clipboardCopyAction',
		'editor.action.clipboardPasteAction', 'editor.action.selectAll',
		'pdfutl.find', 'pdfutl.findNext', 'pdfutl.findPrevious',
	],
	MenubarViewMenu: [
		'workbench.action.showCommands', 'workbench.action.toggleSidebarVisibility',
		'outline.focus', 'timeline.focus', 'MenubarLayoutMenu', 'MenubarAppearanceMenu',
		'pdfutl.zoomIn', 'pdfutl.zoomOut', 'pdfutl.actualSize', 'pdfutl.fitPage',
	],
	MenubarAppearanceMenu: [
		'workbench.action.toggleFullScreen', 'workbench.action.toggleStatusbarVisibility',
		'workbench.action.toggleSidebarPosition', 'EditorTabsBarShowTabsSubmenu', 'EditorActionsPositionSubmenu',
		'workbench.action.zoomIn', 'workbench.action.zoomOut', 'workbench.action.zoomReset',
	],
	MenubarLayoutMenu: [
		'workbench.action.splitEditorUp', 'workbench.action.splitEditorDown',
		'workbench.action.splitEditorLeft', 'workbench.action.splitEditorRight',
		'workbench.action.splitEditorInGroup', 'workbench.action.joinEditorInGroup',
		'workbench.action.toggleMaximizeEditorGroup', 'workbench.action.moveEditorToNewWindow',
		'workbench.action.copyEditorToNewWindow', 'workbench.action.editorLayoutSingle',
		'workbench.action.editorLayoutTwoColumns', 'workbench.action.editorLayoutThreeColumns',
		'workbench.action.editorLayoutTwoRows', 'workbench.action.editorLayoutThreeRows',
		'workbench.action.editorLayoutTwoByTwoGrid', 'workbench.action.editorLayoutTwoRowsRight',
		'workbench.action.editorLayoutTwoColumnsBottom', 'workbench.action.toggleEditorGroupLayout',
	],
	MenubarGoMenu: [
		'workbench.action.navigateBack', 'workbench.action.navigateForward', 'workbench.action.quickOpen',
		'MenubarSwitchEditorMenu', 'MenubarSwitchGroupMenu', 'pdfutl.goToPage',
	],
	MenubarHelpMenu: [
		'workbench.action.getStartedWithAccessibilityFeatures', 'workbench.action.openIssueReporter',
		'workbench.action.openLicenseUrl', 'workbench.action.showAboutDialog', 'PdfutlMenubarDiagnosticsMenu',
	],
};

export function filterPdfMenubarItems(menu: string, items: Array<IMenuItem | ISubmenuItem>): Array<IMenuItem | ISubmenuItem> {
	if (!Object.hasOwn(visibleItems, menu)) {
		return items;
	}
	const allowed = visibleItems[menu];
	return items.filter(item => allowed.includes('command' in item ? item.command.id : item.submenu.id));
}

export function localPdfRecents(recentlyOpened: IRecentlyOpened): IRecentlyOpened {
	return { workspaces: [], files: recentlyOpened.files.filter(({ fileUri, remoteAuthority }) =>
		fileUri.scheme === 'file' && !remoteAuthority && /\.pdf$/i.test(fileUri.path)) };
}
