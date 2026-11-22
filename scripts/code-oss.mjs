import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const codeOss = join(root, '.upstream', 'code-oss');
export const electronVersion = '45.4.1';
export const electron = join(root, '.upstream', `electron-${electronVersion}`, 'electron.exe');
export const nodeDir = join(root, '.upstream', 'node-24.22.3', 'node-v24.22.3-win-x64');
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
  prepareEditorSplitFrames();
  preparePdfTimelinePresentation();
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
    // Use a fresh visibility key because older PDFUtl builds always saved the sidebar as hidden.
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
    .replace(
      'const chord = new KeyCodeChord(ctrlKey, keyboardEvent.shiftKey, altKey, keyboardEvent.metaKey, keyboardEvent.keyCode);',
      `// Normalize the physical keys used by PDFUtl shortcuts in every Windows layout.
		let keyCode = keyboardEvent.keyCode;
		if (ctrlKey && !altKey && !keyboardEvent.metaKey && keyCode !== KeyCode.KEY_IN_COMPOSITION) {
			if (keyboardEvent.shiftKey && keyboardEvent.code === 'KeyM') {
				keyCode = KeyCode.KeyM;
			} else if (!keyboardEvent.shiftKey && keyboardEvent.code === 'KeyB') {
				keyCode = KeyCode.KeyB;
			} else if (!keyboardEvent.shiftKey && keyboardEvent.code === 'KeyF') {
				keyCode = KeyCode.KeyF;
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
    // Restore only the icons and actions that previous PDFUtl builds removed.
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
