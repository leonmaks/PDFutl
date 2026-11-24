import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const codeOss = join(root, '.upstream', 'code-oss');
export const electronVersion = '45.4.1';
export const electron = join(root, '.upstream', `electron-${electronVersion}`, 'electron.exe');
export const nodeDir = join(root, '.upstream', 'node-24.22.3', 'node-v24.22.3-win-x64');
export const productDisplay = {
  nameShort: 'PDFutl',
  nameLong: 'PDFutl',
  reportIssueUrl: 'https://github.com/leonmaks/PDFutl/issues/new',
};
const sourceRef = '1.147.0';
const sourceCommit = '8a14f0cc1b08d531eb83255ea3764ae22aa932b5';

export const appEnv = { ...process.env, VSCODE_CLI: '1', VSCODE_DEV: '1', NODE_ENV: 'development' };
delete appEnv.ELECTRON_RUN_AS_NODE;

export const defaultSettings = {
  'workbench.editor.doubleClickTabToToggleEditorGroupSizes': 'maximize',
  'workbench.editor.enablePreview': false,
  'workbench.editorAssociations': { '*.pdf': 'pdfutl.viewer' },
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.disableAIFeatures': true,
  'window.menuBarVisibility': 'visible',
  'window.restoreWindows': 'all',
  'workbench.startupEditor': 'none',
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoUpdate': false,
};

export function profileArguments(profile) {
  const user = join(profile, 'User');
  mkdirSync(user, { recursive: true });
  const settings = join(user, 'settings.json');
  if (!existsSync(settings)) {
    writeFileSync(settings, JSON.stringify(defaultSettings, null, 2));
  }
  return ['--user-data-dir', profile, '--extensions-dir', join(profile, 'extensions'), '--shared-data-dir', join(profile, 'shared-data')];
}

export function appArguments(profile, files = []) {
  const builtin = join(codeOss, 'extensions', 'pdfutl-viewer');
  mkdirSync(builtin, { recursive: true });
  copyFileSync(join(root, 'extension', 'package.json'), join(builtin, 'package.json'));
  cpSync(join(root, 'extension', 'dist'), join(builtin, 'dist'), { recursive: true });
  const openInNewWindow = files.length ? ['--new-window'] : [];
  return [codeOss, ...profileArguments(profile),
    ...openInNewWindow, '--disable-extension=vscode.vscode-api-tests', '--skip-welcome', '--skip-release-notes', ...files];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

function patchCodeOssSource(file, update) {
  const path = join(codeOss, 'src', 'vs', file);
  const contents = readFileSync(path, 'utf8');
  const updated = update(contents);
  if (updated !== contents) writeFileSync(path, updated);
}

function prepare() {
  if (!existsSync(join(codeOss, '.git'))) {
    run('git', ['clone', '--depth', '1', '--branch', sourceRef, 'https://github.com/microsoft/vscode.git', codeOss]);
  }
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: codeOss, encoding: 'utf8' });
  if (git.status !== 0 || git.stdout.trim() !== sourceCommit) throw new Error(`Expected Code-OSS ${sourceRef} at ${codeOss}`);
  const file = join(codeOss, 'package.json');
  const contents = readFileSync(file, 'utf8');
  const config = JSON.parse(contents).nativeBuild;
  if (config.target !== '43.8.9' && config.target !== electronVersion) throw new Error(`Unexpected Code-OSS native build target: ${config.target}`);
  const configured = contents.replace('"target": "43.8.9"', `"target": "${electronVersion}"`)
    .replace(/^ +"msBuildId": "[0-9]+",\r?\n/m, '');
  if (configured !== contents) writeFileSync(file, configured);

  const productFile = join(codeOss, 'product.json');
  const product = JSON.parse(readFileSync(productFile, 'utf8'));
  if (Object.entries(productDisplay).some(([key, value]) => product[key] !== value)) {
    writeFileSync(productFile, JSON.stringify({ ...product, ...productDisplay }, null, '\t') + '\n');
  }

  // The upstream verifier assumes Microsoft's private build ID. OSS uses the public assets.
  const versionFile = join(codeOss, 'build', 'lib', 'electronVersion.ts');
  const versionSource = readFileSync(versionFile, 'utf8');
  const versionPatch = versionSource.replace(' || !config.msBuildId', '')
    .replace('a target and an msBuildId.', 'and a target.')
    .replace('msBuildId: config.msBuildId };', "msBuildId: config.msBuildId ?? '' };");
  if (versionPatch !== versionSource) writeFileSync(versionFile, versionPatch);

  const checksumFile = join(codeOss, 'build', 'checksums', 'electron.txt');
  const checksums = readFileSync(checksumFile, 'utf8');
  const patched = checksums.replace(/^[a-f0-9]{64}(?= \*electron\.d\.ts$)/m, '727a4f56b47dddd34ff239e8c89d31b9906fa1e5bfd86f11e41a746a8a0a99b9')
    .replace(/^[a-f0-9]{64}(?= \*electron-v43\.8\.9-win32-x64\.zip$)/m, '2ba6223afa9121f42831fefe92c434334907540165294fc56697449d12e7cfe9')
    .replace(' *electron-v43.8.9-win32-x64.zip', ` *electron-v${electronVersion}-win32-x64.zip`);
  if (patched !== checksums) writeFileSync(checksumFile, patched);

  restoreSidebarActions();
  preparePdfMenubar();
  prepareEditorSplitFrames();
  preparePdfTimelinePresentation();
  preparePdfOpenTracking();
  preparePdfOpenOrder();
  preparePdfPinnedFolders();
  preparePdfThemeName();
  preparePdfWindowZoom();
  preparePdfFullscreen();
  patchCodeOssSource('workbench/contrib/customEditor/browser/customEditorInput.ts', source => {
    if (source.includes("'pdfutl.saveAs'")) return source;
    return source
      .replace("import { IContextKeyService }", "import { ICommandService } from '../../../../platform/commands/common/commands.js';\nimport { IContextKeyService }")
      .replace("import { IEditorGroupsService }", "import { editorGroupToColumn } from '../../../services/editor/common/editorGroupColumn.js';\nimport { IEditorGroupsService }")
      .replace('\t\tconst dialogPath = this._editorResource;', [
        "\t\tif (this.viewType === 'pdfutl.viewer') {",
        "\t\t\tconst viewColumn = editorGroupToColumn(this.editorGroupsService, groupId) + 1;",
        "\t\t\tconst saved = await this.instantiationService.invokeFunction(accessor => accessor.get(ICommandService)",
        "\t\t\t\t.executeCommand<boolean>('pdfutl.saveAs', this.resource, viewColumn));",
        "\t\t\treturn saved ? this : undefined;",
        "\t\t}",
        "",
        "\t\tconst dialogPath = this._editorResource;",
      ].join('\n'));
  });
  patchCodeOssSource('workbench/contrib/customEditor/browser/customEditorInput.ts', source => {
    if (source.includes("'pdfutl.undoAnnotation'")) return source;
    return source.replace('public undo(): void | Promise<void> {', `public undo(): void | Promise<void> {
		if (this.viewType === 'pdfutl.viewer') {
			return this.instantiationService.invokeFunction(accessor => accessor.get(ICommandService)
				.executeCommand<void>('pdfutl.undoAnnotation'));
		}`);
  });
  patchCodeOssSource('workbench/contrib/files/browser/explorerViewlet.ts', source => source
    .replace(/^[\t]{3}hideByDefault: true,\r?\n(?=\t{3}focusCommand:\s*\{\s*id: 'workbench\.files\.action\.focusOpenEditorsView')/m, '')
    .replace(/(id: EmptyView\.ID,)(\r?\n)(?=\t{3}name:)/, "$1$2\t\t\twhen: WorkbenchStateContext.notEqualsTo('empty'),$2")
    .replace("storageId: 'workbench.explorer.views.state',", "storageId: 'pdfutl.navigator.views.state',\n\tviewOrderDelegate: { getOrder: group => group === 'pdfutl.pinnedFolders' ? 1 : undefined },"));
  patchCodeOssSource('workbench/api/browser/viewsExtensionPoint.ts', source => source.replace(
    'collapsed: this.showCollapsed(container) || initialVisibility === InitialVisibility.Collapsed,',
    "collapsed: (item.group !== 'pdfutl.pinnedFolders' && this.showCollapsed(container)) || initialVisibility === InitialVisibility.Collapsed,",
  ));
  const outlineDir = 'workbench/contrib/outline/browser';
  for (const [source, name] of [['workbench/pdfOutline.ts', 'pdfOutline.ts'], ['extension/src/outlineProtocol.ts', 'pdfOutlineProtocol.ts']]) {
    const from = join(root, source);
    const to = join(codeOss, 'src', 'vs', outlineDir, name);
    if (!existsSync(to) || !readFileSync(from).equals(readFileSync(to))) copyFileSync(from, to);
  }
  patchCodeOssSource(`${outlineDir}/outline.contribution.ts`, source => source.replace(
    /import '\.\/outlineActions\.js';(?!\r?\nimport '\.\/pdfOutline\.js';)/,
    "$&\nimport './pdfOutline.js';",
  ));
  patchCodeOssSource(`${outlineDir}/outlinePane.ts`, source => source.replace(
    "this._showMessage(localize('no-symbols', \"No symbols found in document '{0}'\", basename(resource)));",
    `this._showMessage(newOutline.outlineKind === 'pdfutl'
					? localize('no-pdf-bookmarks', "No bookmarks in '{0}'", basename(resource))
					: localize('no-symbols', "No symbols found in document '{0}'", basename(resource)));`,
  ));
  patchCodeOssSource('workbench/browser/layout.ts', source => source
    // Use a fresh visibility key because older PDFutl builds always saved the sidebar as hidden.
    .replace("RuntimeStateKey<boolean>('sideBar.hidden'", "RuntimeStateKey<boolean>('pdfutl.navigator.hidden'")
    .replace('workbenchState === WorkbenchState.EMPTY || auxiliaryBarForceMaximized === true;', 'auxiliaryBarForceMaximized === true;')
    .replace(/^\t\tthis\.stateCache\.set\(LayoutStateKeys\.SIDEBAR_HIDDEN\.name, true\);\r?\n/m, '')
    .replace(/(private setSideBarHidden\(hidden: boolean\): void \{\r?\n)\t\tif \(!hidden\) \{ return; \}\r?\n/, '$1')
    .replace('this.stateCache.set(LayoutStateKeys.ACTIVITYBAR_HIDDEN.name, this.isActivityBarHidden());',
      'this.stateCache.set(LayoutStateKeys.ACTIVITYBAR_HIDDEN.name, true);')
    .replace(/(private isActivityBarHidden\(\): boolean \{)(\r?\n)\t\tconst oldValue[\s\S]*?(?=\r?\n\t\})/, '$1$2\t\treturn true;')
    .replace(/(private setActivityBarHidden\(hidden: boolean\): void \{)(\r?\n)(?!\t\tif \(!hidden\) \{ return; \})/,
      '$1$2\t\tif (!hidden) { return; }$2'));
  patchCodeOssSource('workbench/services/keybinding/common/windowsKeyboardMapper.ts', source => source
    .replace(/\/\/ Keep the navigator shortcut[^\r\n]*\r?\n\t\tconst toggleNavigator[^\r\n]*\r?\n\t\tconst keyCode[^\r\n]*\r?\n\t\tconst chord = new KeyCodeChord\(ctrlKey, keyboardEvent.shiftKey, altKey, keyboardEvent.metaKey, keyCode\);/,
      'const chord = new KeyCodeChord(ctrlKey, keyboardEvent.shiftKey, altKey, keyboardEvent.metaKey, keyboardEvent.keyCode);')
    .replace(/\/\/ Keep the navigator and PDF search shortcuts on physical keys in every Windows layout\.[\s\S]*?const chord = new KeyCodeChord\(ctrlKey, keyboardEvent.shiftKey, altKey, keyboardEvent.metaKey, keyCode\);/,
      'const chord = new KeyCodeChord(ctrlKey, keyboardEvent.shiftKey, altKey, keyboardEvent.metaKey, keyboardEvent.keyCode);')
    .replace(/\/\/ Normalize the physical keys used by PDF[Uu]tl shortcuts in every Windows layout\.[\s\S]*?const chord = new KeyCodeChord\(ctrlKey, keyboardEvent.shiftKey, altKey, keyboardEvent.metaKey, keyCode\);/,
      'const chord = new KeyCodeChord(ctrlKey, keyboardEvent.shiftKey, altKey, keyboardEvent.metaKey, keyboardEvent.keyCode);')
    .replace(
      'const chord = new KeyCodeChord(ctrlKey, keyboardEvent.shiftKey, altKey, keyboardEvent.metaKey, keyboardEvent.keyCode);',
      `// Normalize the physical keys used by PDFutl shortcuts in every Windows layout.
		let keyCode = keyboardEvent.keyCode;
		if (ctrlKey && !altKey && !keyboardEvent.metaKey && keyCode !== KeyCode.KEY_IN_COMPOSITION) {
			if (keyboardEvent.shiftKey && keyboardEvent.code === 'KeyM') {
				keyCode = KeyCode.KeyM;
			} else if (!keyboardEvent.shiftKey && keyboardEvent.code === 'KeyB') {
				keyCode = KeyCode.KeyB;
			} else if (!keyboardEvent.shiftKey && keyboardEvent.code === 'KeyF') {
				keyCode = KeyCode.KeyF;
			} else if (!keyboardEvent.shiftKey && keyboardEvent.code === 'KeyZ') {
				keyCode = KeyCode.KeyZ;
			}
		}
		const chord = new KeyCodeChord(ctrlKey, keyboardEvent.shiftKey, altKey, keyboardEvent.metaKey, keyCode);`,
    ));
  patchCodeOssSource('workbench/contrib/workspace/browser/workspace.contribution.ts', source => source
    .replace(/(\[WORKSPACE_TRUST_EMPTY_WINDOW\]: \{\s*type: 'boolean',\s*default: )true/, '$1false')
    .replace(/(private getBannerItem\(restrictedMode: boolean\): IBannerItem \| undefined \{)(\r?\n)(?!\t\tif \(this\.workspaceContextService\.getWorkbenchState\(\) === WorkbenchState\.EMPTY\))/,
      '$1$2\t\tif (this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY) { return undefined; }$2$2')
    .replace('if (trusted && this.statusbarEntryAccessor.value) {',
      'if (trusted || this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY) {'));

  // Restore the native editor state of standalone document windows only.
  patchCodeOssSource('platform/windows/electron-main/windowsMainService.ts', source => source
    .replace(/^\t\tconst untitledWorkspacesToRestore: IWorkspacePathToOpen\[\] = \[\];\r?\n/m, '')
    .replace(/^\t{3}\/\/ Untitled workspaces are always restored\r?\n\t{3}untitledWorkspacesToRestore\.push[^\r\n]*\r?\n\t{3}workspacesToOpen\.push\(\.\.\.untitledWorkspacesToRestore\);\r?\n\r?\n/m, '')
    .replace(/^\t{7}\(usedWindow\.openedWorkspace && untitledWorkspacesToRestore\.some[^\r\n]*\r?\n/m, '')
    .replace('this.backupMainService.getEmptyWindowBackups());',
      'this.backupMainService.getEmptyWindowBackups().filter(info => !info.remoteAuthority));')
    .replace('pathsToOpen = await this.doGetPathsFromLastSession();', 'pathsToOpen = await this.doGetPathsFromLastSession(true);')
    .replace('const lastSessionPaths = await this.doGetPathsFromLastSession();', 'const lastSessionPaths = await this.doGetPathsFromLastSession(true);')
    .replace('private async doGetPathsFromLastSession():', 'private async doGetPathsFromLastSession(onlyDocumentWindows = false):')
    .replace(/(lastSessionWindows\.map\(async lastSessionWindow => \{)(\r?\n)(?!\t{5}if \(onlyDocumentWindows)/,
      '$1$2\t\t\t\t\tif (onlyDocumentWindows && (lastSessionWindow.workspace || lastSessionWindow.folderUri || lastSessionWindow.remoteAuthority)) {$2\t\t\t\t\t\treturn undefined;$2\t\t\t\t\t}$2'));
}

function preparePdfPinnedFolders() {
  const viewsDir = 'workbench/browser/parts/views';
  for (const [source, target] of [['pdfPinnedFolders.ts', 'pdfPinnedFolders.ts'], ['pdfPinnedFolders.css', 'media/pdfPinnedFolders.css']]) {
    const contents = readFileSync(join(root, 'workbench', source));
    const to = join(codeOss, 'src', 'vs', viewsDir, target);
    if (!existsSync(to) || !contents.equals(readFileSync(to))) writeFileSync(to, contents);
  }
  patchCodeOssSource(`${viewsDir}/treeView.ts`, source => {
    if (source.includes('pdfPinnedFoldersViewId')) return source;
    return source
      .replace("import * as DOM from '../../../../base/browser/dom.js';", `import * as DOM from '../../../../base/browser/dom.js';
import { pdfPinnedFoldersViewId } from './pdfPinnedFolders.js';`)
      .replace('export class TreeViewPane extends ViewPane {', `export class TreeViewPane extends ViewPane {

	protected override renderHeader(container: HTMLElement): void {
		super.renderHeader(container);
		container.classList.toggle('pdfutl-pinned-header', this.id === pdfPinnedFoldersViewId);
	}`)
      .replace('identityProvider: new TreeViewIdentityProvider(),', `identityProvider: new TreeViewIdentityProvider(),
			horizontalScrolling: this.id === pdfPinnedFoldersViewId ? false : undefined,`)
      .replace('interface ITreeExplorerTemplateData {', `interface ITreeExplorerTemplateData {
	readonly pinnedDate?: HTMLElement;`)
      .replace("const actionsContainer = DOM.append(resourceLabel.element, DOM.$('.actions'));", `const pinned = this.treeViewId === pdfPinnedFoldersViewId;
		const actionsContainer = DOM.append(pinned ? container : resourceLabel.element, DOM.$('.actions'));
		const pinnedDate = pinned ? DOM.append(container, DOM.$('span.pdfutl-pinned-date')) : undefined;
		if (pinnedDate) {
			DOM.append(pinnedDate, DOM.$('span'));
		}
		container.classList.toggle('pdfutl-pinned-row', pinned);`)
      .replace('return { resourceLabel, icon, checkboxContainer, actionBar, container };',
        'return { resourceLabel, icon, checkboxContainer, actionBar, container, pinnedDate };')
      .replace('const labelStr = treeItemLabel ?', `if (templateData.pinnedDate) {
			templateData.pinnedDate.firstElementChild!.textContent = description ?? '';
			templateData.pinnedDate.hidden = !description;
		}
		const visibleDescription = templateData.pinnedDate ? undefined : description;
		const labelStr = treeItemLabel ?`)
      .replace('setResource({ name: label, description, resource: labelResource }', 'setResource({ name: label, description: visibleDescription, resource: labelResource }')
      .replace('setResource({ name: label, description }', 'setResource({ name: label, description: visibleDescription }');
  });
}

function preparePdfOpenTracking() {
  const customEditorDir = 'workbench/contrib/customEditor/browser';
  const input = `${customEditorDir}/customEditorInput.ts`;
  const patch = (file, before, after) => patchCodeOssSource(file, source => {
    if (source.includes(after)) return source;
    if (!source.includes(before)) throw new Error(`Could not add PDF Timeline open tracking to ${file}`);
    return source.replace(before, after);
  });
  // Only the regular file resolver marks new inputs. Restored tabs and split copies bypass it.
  patch(input, 'interface CustomEditorInputInitInfo {',
    'interface CustomEditorInputInitInfo {\n\treadonly pdfutlExplicitOpen?: boolean;');
  patch(input, 'public readonly oldResource?: URI;', 'public readonly oldResource?: URI;\n\tpublic readonly pdfutlExplicitOpen: boolean;');
  patch(input, 'this.oldResource = options.oldResource;',
    'this.oldResource = options.oldResource;\n\t\tthis.pdfutlExplicitOpen = init.pdfutlExplicitOpen === true;');
  patch(`${customEditorDir}/customEditors.ts`,
    'preferredName: label, iconPath: undefined',
    "preferredName: label, iconPath: undefined, pdfutlExplicitOpen: contributedEditor.id === 'pdfutl.viewer'");
  patch('workbench/api/browser/mainThreadCustomEditors.ts',
    'await this._proxyCustomEditors.$resolveCustomEditor(actualResource, handle, viewType, initData, position, cancellation);',
    `await this._proxyCustomEditors.$resolveCustomEditor(actualResource, handle, viewType, {
							...initData,
							pdfutlExplicitOpen: webviewInput.pdfutlExplicitOpen,
						}, position, cancellation);`);
  for (const file of ['extHost.protocol.ts', 'extHostCustomEditors.ts']) {
    const path = `workbench/api/common/${file}`;
    patchCodeOssSource(path, source => {
      const start = source.indexOf('$resolveCustomEditor(');
      const end = source.indexOf('position: EditorGroupColumn,', start);
      const signature = source.slice(start, end);
      if (signature.includes('pdfutlExplicitOpen')) return source;
      if (start < 0 || end < 0 || !signature.includes('active: boolean;')) {
        throw new Error(`Could not add PDF Timeline open tracking to ${path}`);
      }
      return source.slice(0, start) + signature.replace('active: boolean;', 'active: boolean;\n\t\t\tpdfutlExplicitOpen?: boolean;') + source.slice(end);
    });
  }
  patch('workbench/api/common/extHostCustomEditors.ts',
    'return entry.provider.resolveCustomEditor(document, panel, cancellation);',
    `if (viewType === 'pdfutl.viewer' && initData.pdfutlExplicitOpen) {
					Object.assign(panel, { pdfutlExplicitOpen: true });
				}
				return entry.provider.resolveCustomEditor(document, panel, cancellation);`);
}

function preparePdfMenubar() {
  const titlebar = 'workbench/browser/parts/titlebar';
  const actions = 'platform/actions/common/actions.ts';
  const control = `${titlebar}/menubarControl.ts`;
  for (const [name, folder] of [['pdfMenubarItems.ts', 'platform/actions/common'], ['pdfMenubar.ts', titlebar]]) {
    const implementation = readFileSync(join(root, 'workbench', name));
    const target = join(codeOss, 'src', 'vs', folder, name);
    if (!existsSync(target) || !implementation.equals(readFileSync(target))) writeFileSync(target, implementation);
  }

  function patch(file, before, after) {
    patchCodeOssSource(file, source => {
      if (source.includes(after)) return source;
      const updated = source.replace(before, after);
      if (updated === source) throw new Error(`Could not configure the PDFutl menu in ${file}`);
      return updated;
    });
  }

  const actionImport = "import { IKeybindingRule, KeybindingsRegistry } from '../../keybinding/common/keybindingsRegistry.js';";
  patch(actions, actionImport, `${actionImport}\nimport { filterPdfMenubarItems } from './pdfMenubarItems.js';`);
  patch(actions, /return result;(?=\r?\n\t}\r?\n\r?\n\tappendMenuGroup)/,
    'return filterPdfMenubarItems(id.id, result);');

  const menuImport = "import { IsMacNativeContext } from '../../../../platform/contextkey/common/contextkeys.js';";
  patch(`${titlebar}/menubar.contribution.ts`, menuImport, `${menuImport}\nimport './pdfMenubar.js';`);
  const recentImport = "import { IRecentlyOpened, isRecentFolder, IRecent, isRecentWorkspace, IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';";
  patch(control, recentImport, `${recentImport}\nimport { localPdfRecents } from '../../../../platform/actions/common/pdfMenubarItems.js';`);
  patch(control, 'this.recentlyOpened = recentlyOpened;', 'this.recentlyOpened = localPdfRecents(recentlyOpened);');

  const windowActions = 'workbench/browser/actions/windowActions.ts';
  const workspaceImport = "import { IWorkspaceContextService, IWorkspaceIdentifier, isWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier } from '../../../platform/workspace/common/workspace.js';";
  patch(windowActions, workspaceImport, workspaceImport.replace('isSingleFolderWorkspaceIdentifier }', 'isSingleFolderWorkspaceIdentifier, WorkbenchState }') +
    "\nimport { localPdfRecents } from '../../../platform/actions/common/pdfMenubarItems.js';");
  patch(windowActions, 'const filePicks = recentlyOpened.files.map(',
    `const documentWindow = contextService.getWorkbenchState() === WorkbenchState.EMPTY;
		const visibleRecents = documentWindow ? localPdfRecents(recentlyOpened) : recentlyOpened;
		const filePicks = visibleRecents.files.map(`);
  patch(windowActions, 'const picks = [workspaceSeparator, ...workspacePicks, fileSeparator, ...filePicks];',
    'const picks = documentWindow ? filePicks : [workspaceSeparator, ...workspacePicks, fileSeparator, ...filePicks];');
  patch(windowActions, 'activeItem: [...workspacePicks, ...filePicks][autoFocusSecondEntry ? 1 : 0],',
    'activeItem: documentWindow ? filePicks[0] : [...workspacePicks, ...filePicks][autoFocusSecondEntry ? 1 : 0],');
}

function preparePdfOpenOrder() {
  patchCodeOssSource('workbench/browser/workbench.contribution.ts', source => source.replace(
    /('workbench\.editor\.openPositioning': \{\s*'type': 'string',\s*'enum': \['left', 'right', 'first', 'last'\],\s*'default': )'right'/,
    "$1'first'",
  ));
  patchCodeOssSource('workbench/browser/parts/editor/editor.ts', source =>
    source.replace("openPositioning: 'right',", "openPositioning: 'first',"));
  patchCodeOssSource('workbench/browser/parts/editor/editorGroupView.ts', source => source.replace(
    'index: startingIndex + index',
    `// Let the group model insert new PDFs at the start, also when opened together.
				index: this.groupsView.partOptions.openPositioning === 'first' && editor.editorId === 'pdfutl.viewer'
					? options?.index
					: startingIndex + index`,
  ));
}

function preparePdfThemeName() {
  patchCodeOssSource('workbench/browser/workbench.contribution.ts', source => {
    if (source.includes('migratePdfutlThemeName')) return source;
    return `${source.trimEnd()}

function migratePdfutlThemeName(value: unknown): ConfigurationKeyValuePairs {
	return typeof value === 'string' && /^PDF[U]tl Darcula$/.test(value)
		? [['workbench.colorTheme', { value: 'PDFutl Darcula' }]]
		: [];
}

Registry.as<IConfigurationMigrationRegistry>(Extensions.ConfigurationMigration)
	.registerConfigurationMigrations([{ key: 'workbench.colorTheme', migrateFn: migratePdfutlThemeName }]);
`;
  });
}

function preparePdfFullscreen() {
  const actionsDir = 'workbench/browser/actions';
  const implementation = readFileSync(join(root, 'workbench', 'pdfFullscreen.ts'));
  const target = join(codeOss, 'src', 'vs', actionsDir, 'pdfFullscreen.ts');
  if (!existsSync(target) || !implementation.equals(readFileSync(target))) writeFileSync(target, implementation);

  // A running development instance caches the list of CSS modules for new windows.
  const styles = readFileSync(join(root, 'workbench', 'pdfFullscreen.css'), 'utf8');
  const marker = '\n/* PDFutl fullscreen */\n';
  patchCodeOssSource(`${actionsDir}/media/actions.css`, source =>
    `${source.split(/\r?\n\/\* PDF[Uu]tl fullscreen \*\//, 1)[0].trimEnd()}\n${marker}${styles}`);

  patchCodeOssSource(`${actionsDir}/windowActions.ts`, source => {
    if (source.includes('togglePdfFullscreen')) return source;
    return source
      .replace("import { IHostService }", "import { togglePdfFullscreen } from './pdfFullscreen.js';\nimport { IEditorService } from '../../services/editor/common/editorService.js';\nimport { IHostService }")
      .replace('return hostService.toggleFullScreen(getActiveWindow());',
        'const window = getActiveWindow();\n\t\treturn togglePdfFullscreen(accessor.get(IEditorService), hostService, window) ?? hostService.toggleFullScreen(window);');
  });
}

function preparePdfWindowZoom() {
  patchCodeOssSource('workbench/electron-browser/window.ts', source => {
    const updated = source.replace(/registerPdf[Uu]tlWheelZoom/g, 'registerPdfutlWheelZoom');
    if (updated.includes('registerPdfutlWheelZoom')) return updated;
    return updated
      .replace('getWindowById, getWindows, $', 'getWindowById, getWindows, onDidRegisterWindow, $')
      .replace('protected registerListeners(): void {', `private registerPdfutlWheelZoom(target: Window) {
		return addDisposableListener(target, 'wheel', (event: WheelEvent) => {
			if (!event.ctrlKey || event.altKey || event.metaKey || !event.deltaY) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			void this.commandService.executeCommand(event.deltaY < 0 ? 'workbench.action.zoomIn' : 'workbench.action.zoomOut');
		}, { capture: true, passive: false });
	}

	protected registerListeners(): void {
		this._register(this.registerPdfutlWheelZoom(mainWindow));
		this._register(onDidRegisterWindow(({ window, disposables }) => {
			disposables.add(this.registerPdfutlWheelZoom(window));
		}));`);
  });
  patchCodeOssSource('workbench/contrib/webview/browser/webviewElement.ts', source => {
    if (source.includes('updatePdfPreviewScale')) return source;
    return source
      .replace("import { isFirefox }", "import { getZoomFactor, isFirefox, onDidChangeZoomLevel }")
      .replace('EventType, getWindow, getWindowById }', 'EventType, getWindow, getWindowById, scheduleAtNextAnimationFrame }')
      .replace('this._windowId = targetWindow.vscodeWindowId;', `this._windowId = targetWindow.vscodeWindowId;
		if (this.providedViewType === 'pdfutl.viewer') {
			// Chromium inherits window zoom even across iframe origins. Offset it before it reaches the PDF stage.
			const updatePdfPreviewScale = () => {
				if (this.element) {
					this.element.style.zoom = String(1 / getZoomFactor(targetWindow));
				}
			};
			updatePdfPreviewScale();
			const pendingScale = this._mountDisposables.add(new MutableDisposable<IDisposable>());
			this._mountDisposables.add(onDidChangeZoomLevel(windowId => {
				if (windowId === targetWindow.vscodeWindowId) {
					// Let Chromium propagate page zoom to the iframe before changing its CSS zoom.
					pendingScale.value = scheduleAtNextAnimationFrame(targetWindow, () => {
						pendingScale.value = scheduleAtNextAnimationFrame(targetWindow, updatePdfPreviewScale);
					});
				}
			}));
		}`);
  });
}

function preparePdfTimelinePresentation() {
  const timelineDir = 'workbench/contrib/timeline/browser';
  const files = [
    ['extension/src/pdfTimelineDate.ts', 'pdfTimelineDate.ts'],
    ['workbench/pdfTimelineTimestamp.ts', 'pdfTimelineTimestamp.ts'],
    ['workbench/pdfTimelineTimestamp.css', 'media/pdfTimelineTimestamp.css'],
  ];
  for (const [source, target] of files) {
    const contents = readFileSync(join(root, source));
    const to = join(codeOss, 'src', 'vs', timelineDir, target);
    if (!existsSync(to) || !contents.equals(readFileSync(to))) writeFileSync(to, contents);
  }
  patchCodeOssSource(`${timelineDir}/timelinePane.ts`, source => {
    if (source.includes('renderPdfTimelineTimestamp')) return source;
    return source
      .replace("import './media/timelinePane.css';", `import './media/timelinePane.css';
import { formatPdfTimelineDate, pdfTimelineSource } from './pdfTimelineDate.js';
import { renderPdfTimelineTimestamp } from './pdfTimelineTimestamp.js';`)
      .replace("element.relativeTimeFullWord ?? '', getLabel(element)", "element.source === pdfTimelineSource ? formatPdfTimelineDate(element.timestamp) : element.relativeTimeFullWord ?? '', getLabel(element)")
      .replace(/\t\ttemplate\.timestamp\.textContent = item\.relativeTime \?\? '';\r?\n\t\ttemplate\.timestamp\.ariaLabel = item\.relativeTimeFullWord \?\? '';\r?\n\t\ttemplate\.timestamp\.parentElement!\.classList\.toggle\('timeline-timestamp--duplicate', isTimelineItem\(item\) && item\.hideRelativeTime\);/, `\t\tconst usePdfTimestamp = isTimelineItem(item) && item.source === pdfTimelineSource;
		template.container.classList.toggle('pdfutl-timeline-event', usePdfTimestamp);
		if (usePdfTimestamp) {
			renderPdfTimelineTimestamp(template.timestamp, item.timestamp, template.elementDisposables);
		} else {
			template.timestamp.textContent = item.relativeTime ?? '';
			template.timestamp.ariaLabel = item.relativeTimeFullWord ?? '';
		}
		template.timestamp.parentElement!.classList.toggle('timeline-timestamp--duplicate', !usePdfTimestamp && isTimelineItem(item) && item.hideRelativeTime);`);
  });
}

function prepareEditorSplitFrames() {
  const editorDir = 'workbench/browser/parts/editor';
  for (const [source, target] of [['editorSplitFrames.ts', 'editorSplitFrames.ts'], ['editorSplitFrames.css', 'media/editorSplitFrames.css']]) {
    const from = join(root, 'workbench', source);
    const to = join(codeOss, 'src', 'vs', editorDir, target);
    const contents = readFileSync(from);
    if (!existsSync(to) || !contents.equals(readFileSync(to))) writeFileSync(to, contents);
  }

  // Opt-in to the outer grid bounds so nested and maximized groups trim only shared edges.
  patchCodeOssSource('base/browser/ui/grid/gridview.ts', source => {
    if (source.includes('export interface IGridLayoutArea')) return source;
    return source
      .replace('interface IRelativeBoundarySashes {', `export interface IGridLayoutArea extends IViewSize {
	readonly top: number;
	readonly left: number;
}

interface IRelativeBoundarySashes {`)
      .replace('layout(width: number, height: number, top: number, left: number): void;', `layout(width: number, height: number, top: number, left: number, grid?: IGridLayoutArea): void;

	readonly needsGridLayoutArea?: boolean;`)
      .replace('class LayoutController {', 'class LayoutController {\n\tarea?: IGridLayoutArea;')
      .replace('private cachedLeft: number = 0;', 'private cachedLeft: number = 0;\n\tprivate cachedGridArea?: IGridLayoutArea;')
      .replace('if (this.cachedWidth === width && this.cachedHeight === height && this.cachedTop === top && this.cachedLeft === left) {', `const grid = this.view.needsGridLayoutArea ? this.layoutController.area : undefined;
		if (this.cachedWidth === width && this.cachedHeight === height && this.cachedTop === top && this.cachedLeft === left && this.cachedGridArea === grid) {`)
      .replace('this.view.layout(width, height, top, left);', `this.cachedGridArea = grid;
		if (grid) {
			this.view.layout(width, height, top, left, grid);
		} else {
			this.view.layout(width, height, top, left);
		}`)
      .replace('this.layoutController.isLayoutEnabled = true;', `this.layoutController.isLayoutEnabled = true;
		const area = this.layoutController.area;
		if (!area || area.width !== width || area.height !== height || area.top !== top || area.left !== left) {
			this.layoutController.area = { width, height, top, left };
		}`);
  });
  patchCodeOssSource(`${editorDir}/editorPart.ts`, source => source.replace(
    /(this\.gridWidget = gridWidget;)(\r?\n)(?!\t\tgridWidget\.element\.classList\.add\('pdfutl-editor-split-grid'\);)/,
    "$1$2\t\tgridWidget.element.classList.add('pdfutl-editor-split-grid');$2",
  ));
  patchCodeOssSource(`${editorDir}/editorGroupView.ts`, source => {
    if (source.includes('layoutEditorSplitFrame')) return source;
    return source
      .replace("import './media/editorgroupview.css';", `import './media/editorgroupview.css';
import type { IGridLayoutArea } from '../../../../base/browser/ui/grid/gridview.js';
import { layoutEditorSplitFrame } from './editorSplitFrames.js';`)
      .replace('private lastLayout: IDomNodePagePosition | undefined;', 'private lastLayout: (IDomNodePagePosition & { grid?: IGridLayoutArea }) | undefined;')
      .replace(/layout\(width: number, height: number, top: number, left: number\): void \{\r?\n\t\tthis\.lastLayout = \{ width, height, top, left \};/, `readonly needsGridLayoutArea = true;

	layout(width: number, height: number, top: number, left: number, grid?: IGridLayoutArea): void {
		this.lastLayout = { width, height, top, left, grid };
		({ width, height, top, left } = layoutEditorSplitFrame(this.element, this.lastLayout, grid));`)
      .replace('const { width, height, top, left } = this.lastLayout;', 'const { width, height, top, left, grid } = this.lastLayout;')
      .replace('this.layout(width, height, top, left);', 'this.layout(width, height, top, left, grid);');
  });
}

function restoreSidebarActions() {
  const file = 'workbench/browser/actions/layoutActions.ts';
  patchCodeOssSource(file, source => {
    if (source.includes('registerAction2(ToggleSidebarVisibilityAction);')) return source;
    const original = spawnSync('git', ['show', `HEAD:src/vs/${file}`], { cwd: codeOss, encoding: 'utf8' });
    if (original.status !== 0) throw new Error(`Could not restore native sidebar actions: ${original.stderr}`);
    // Restore only the icons and actions that previous PDFutl builds removed.
    const iconLines = original.stdout.match(/^const panel(?:Left|Right)OffIcon = [^\r\n]*/gm);
    const registrations = original.stdout.match(/registerAction2\(ToggleSidebarVisibilityAction\);\r?\n\r?\nMenuRegistry\.appendMenuItems\(\[[\s\S]*?\r?\n\]\);/);
    const toggle = original.stdout.match(/^\tCreateToggleLayoutItem\(ToggleSidebarVisibilityAction\.ID,[^\r\n]*/m);
    if (!iconLines || !registrations || !toggle) throw new Error('Expected native sidebar actions in pinned Code-OSS');
    return source.replace(/^const panelIcon = /m, `${iconLines.join('\n')}\nconst panelIcon = `)
      .replace('// --- Toggle Statusbar Visibility', `${registrations[0]}\n\n// --- Toggle Statusbar Visibility`)
      .replace(/^\tCreateToggleLayoutItem\(ToggleAuxiliaryBarAction\.ID,/m, `${toggle[0]}\n\tCreateToggleLayoutItem(ToggleAuxiliaryBarAction.ID,`);
  });
}

function compile() {
  prepare();
  const env = { ...process.env, FOUNDRY_LOCAL_SKIP_INSTALL: '1', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', PNPM_CONFIG_FROZEN_LOCKFILE: 'true' };
  if (existsSync(join(nodeDir, 'node.exe'))) env.PATH = `${nodeDir}${delimiter}${process.env.PATH}`;
  for (const args of [['install', '--frozen-lockfile'], ['run', 'build-fast', '--client-only'],
    ['run', 'gulp', 'transpile-extensions', 'compile-extension-media']]) {
    run('pnpm.cmd', args, { cwd: codeOss, env, shell: true });
  }
}

function start(files) {
  if (!existsSync(electron) || !existsSync(join(codeOss, 'out', 'main.js')) || !existsSync(join(root, 'extension', 'dist', 'host.cjs'))) {
    throw new Error('Build the extension and Code-OSS, and extract Electron 45.4.1 first. See README.md.');
  }
  const profile = join(root, '.upstream', 'profile');
  const pdfs = files.map(file => {
    const path = resolve(file);
    if (!/\.pdf$/i.test(path) || !statSync(path, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Expected an existing PDF file: ${file}`);
    }
    return path;
  });
  const child = spawn(electron, appArguments(profile, pdfs), { env: appEnv, stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'prepare') prepare();
  else if (action === 'compile') compile();
  else if (action === 'start') start(args);
  else throw new Error(`Unknown action: ${action}`);
}
