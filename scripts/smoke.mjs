import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { _electron } from 'playwright-core';
import { appArguments, appEnv, electron, electronVersion, root } from './code-oss.mjs';
import { makeFixtures } from './fixtures.mjs';

await mkdir(join(root, '.smoke'), { recursive: true });
const run = await mkdtemp(join(root, '.smoke', 'run-'));
const files = await makeFixtures(join(run, 'documents'));
const originalBytes = await Promise.all(files.map(file => readFile(file)));
const pinnedFolder = dirname(files[0]);
const archiveFolder = join(run, 'Archive');
const copyPath = join(run, 'review-copy.pdf');
const revisedComment = 'Second annotation version';
const profileComment = 'Saved only in the PDFUtl profile';
const originalProfileComment = 'Draft from the annotation card';
const currentUser = userInfo().username;
const viewerOnly = process.argv.includes('--viewer');
const portableArg = process.argv.find(arg => arg.startsWith('--portable='));
if (portableArg && viewerOnly) throw new Error('Choose either --portable or --viewer');
const executable = portableArg ? resolve(portableArg.slice('--portable='.length)) : electron;
const profile = portableArg ? join(dirname(executable), 'data', 'user-data') : join(run, 'profile');
const launchEnv = portableArg ? { ...process.env } : appEnv;
if (portableArg) {
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VSCODE_DEV', 'VSCODE_PORTABLE']) delete launchEnv[key];
}
const workbenchArgs = (docs = []) => portableArg ? docs : appArguments(profile, docs);
const args = viewerOnly
  ? [join(root, 'scripts', 'viewer-test-host.cjs'), files[0], copyPath, profile]
  : workbenchArgs(files);
let app = await launch(args);
let workbench;

try {
  assert.equal(await app.evaluate(() => process.versions.electron), electronVersion);
  console.log(`Electron ${electronVersion}`);
  workbench = await app.firstWindow({ timeout: 60_000 });
  workbench.setDefaultTimeout(25_000);
  workbench.on('pageerror', error => console.error('Renderer:', error.message));
  if (viewerOnly) await verifyWithoutWorkbench(workbench);
  else {
    await verifyWithWorkbench(workbench);
    const readingPositions = await setReadingPositions(workbench);
    const layout = await tabLayout(workbench);
    await openLegacyWorkspace();
    await app.close();
    workbench = undefined;
    await seedUntitledWorkspace();
    app = await launch(workbenchArgs());
    workbench = await app.firstWindow({ timeout: 60_000 });
    await verifyRestoredSession(workbench, layout);
    await verifyReadingPositions(workbench, readingPositions);
    await verifyProfileAnnotations(workbench, readingPositions.background.group);
    await verifyRestoredTimeline(workbench, readingPositions.background.group);
    await verifyActivityFiles();
    for (const [index, file] of files.entries()) {
      assert.deepEqual(await readFile(file), originalBytes[index], 'Autosaving annotations preserves the original PDF bytes');
    }
    await unpinRestoredFolder(workbench);
  }
} catch (error) {
  if (workbench) {
    await workbench.screenshot({ path: join(run, 'failure.png') }).catch(() => {});
    for (const frame of workbench.frames()) {
      const messages = await frame.getByRole('alert').allTextContents().catch(() => []);
      if (messages.length) console.error(messages.join('\n'));
    }
  }
  console.error(`Smoke artifacts: ${run}`);
  throw error;
} finally {
  await app.close();
}

function launch(args) {
  return _electron.launch({ executablePath: executable, args, env: launchEnv, timeout: 60_000 });
}

async function verifyWithoutWorkbench(page) {
  await verifyPageIndicator(page.mainFrame());
  await verifySearchPanel(page.mainFrame());
  await verifyPdf(page.mainFrame());
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('pdfutl-test-host', { type: 'exportPdf', requestId: 'viewer-smoke' });
  });
  await expectSavedPdf(page.mainFrame());
  await page.reload();
  await checkReopenedCopy(page.mainFrame());
  await page.screenshot({ path: join(run, 'viewer.png') });
  const revised = 'Revised PDF-native comment';
  const sidebar = page.getByRole('list', { name: 'Page comments' });
  const card = page.getByRole('region', { name: 'Comment card' });
  await sidebar.getByRole('button').filter({ hasText: 'Verified review comment' }).click();
  await card.getByRole('button', { name: 'Edit comment' }).click();
  await card.getByRole('textbox', { name: 'Comment text' }).fill(revised);
  await card.getByRole('button', { name: 'Save comment' }).click();
  await card.getByText(revised, { exact: true }).waitFor();
  await page.reload();
  await openPageComments(page.mainFrame());
  await sidebar.getByRole('button').filter({ hasText: revised }).click();
  await card.getByText('Edited by Historical reviewer', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('pdfutl-test-host', { type: 'exportPdf', requestId: 'viewer-editor-smoke' });
  });
  await expectSavedPdf(page.mainFrame());
  await page.reload();
  await openPageComments(page.mainFrame());
  await sidebar.getByRole('button').filter({ hasText: revised }).click();
  await card.getByText(currentUser, { exact: true }).waitFor();
  await card.getByText('Edited by Historical reviewer', { exact: true }).waitFor();
  console.log('An edit attributed to another user keeps its editor in a newly exported PDF');
}

async function verifyWithWorkbench(workbench) {
  await app.evaluate(({ dialog }, { destination, folders }) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
    dialog.showOpenDialog = async (windowOrOptions, options = windowOrOptions) => ({
      canceled: false, filePaths: options.properties.includes('openDirectory') ? folders : [destination],
    });
  }, { destination: copyPath, folders: [pinnedFolder, archiveFolder] });

  const tab = name => workbench.locator('.editor-group-container .tab').filter({ hasText: name });
  const activeTab = name => tab(name).and(workbench.locator('.editor-group-container.active .tab.active'));
  const groups = () => workbench.locator('.editor-group-container:not(.empty)').evaluateAll(nodes => nodes.map(node => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return { x, y, width, height };
  }).filter(box => box.width > 0 && box.height > 0));

  await tab(basename(files[0])).first().waitFor();
  await tab(basename(files[1])).first().waitFor();
  await tab(basename(files[1])).first().click();
  const second = await pdfFrame(workbench, basename(files[1]));
  await waitForImage(second.locator('[data-pdf-page="1"]'));
  await verifySinglePageSearch(second);
  await addProfileAnnotations(workbench, second);
  await tab(basename(files[0])).first().click();
  await waitForImage((await pdfFrame(workbench, basename(files[0]))).locator('[data-pdf-page="1"]'));
  console.log('Two local PDFs opened from CLI');
  await assertDocumentLayout(workbench);
  await verifyNavigator(workbench);
  await verifyIndependentZoom(workbench, await pdfFrame(workbench, basename(files[0])));
  await verifyOutline(workbench);
  const timeline = await openTimeline(workbench);
  await verifyTimelineActionsOnly(timeline);

  await splitTab(activeTab(basename(files[0])), workbench, 'Right');
  await poll(async () => (await groups()).length === 2, 'Two editor groups after Split Right');
  const right = await groups();
  assert.equal(Math.round(right[0].y), Math.round(right[1].y));
  assert.notEqual(Math.round(right[0].x), Math.round(right[1].x));
  await verifySplitFrame(workbench, 'vertical');
  const leftPdf = await pdfFrame(workbench, basename(files[0]), 0);
  const rightPdf = await pdfFrame(workbench, basename(files[0]), 1);
  await verifyPageIndicatorPosition(leftPdf);
  await verifyPageIndicatorPosition(rightPdf);
  await jumpToPage(leftPdf, 1);
  await jumpToPage(rightPdf, 2);
  assert.equal(await leftPdf.getByLabel('Current page').textContent(), '1 / 2');
  console.log('Each split PDF displays and navigates with its own page indicator');
  console.log('Split right');

  await splitTab(activeTab(basename(files[0])), workbench, 'Down');
  await poll(async () => (await groups()).length === 3, 'Three editor groups after Split Down');
  const down = await groups();
  assert.ok(new Set(down.map(box => Math.round(box.y))).size > 1);
  await verifySplitFrame(workbench, 'horizontal');
  console.log('Split down');
  await workbench.screenshot({ path: join(run, 'split.png') });

  const selectedTab = activeTab(basename(files[0]));
  await selectedTab.dblclick();
  await poll(async () => {
    const boxes = await groups();
    return boxes.length === 1 && boxes[0].width > Math.max(...down.map(box => box.width));
  }, 'Double-click maximizes only the active editor group');
  assert.equal(await workbench.locator('.pdfutl-split-editor-frame:visible').count(), 0);
  await selectedTab.dblclick();
  await poll(async () => (await groups()).length === 3, 'Double-click restores editor groups');
  console.log('Maximize and restore by tab double-click');

  await selectedTab.dblclick();
  const frame = await pdfFrame(workbench, basename(files[0]));
  await verifyPageIndicator(frame);
  await verifySearchPanel(frame, selectedTab);
  await verifyPdf(frame);
  await verifyTimelineActionsOnly(timeline);
  assert.equal(await frame.getByRole('button', { name: 'Save PDF copy' }).count(), 0);
  const versions = timeline.getByRole('treeitem', { name: /review-copy\.pdf/ });
  await workbench.getByRole('menubar').getByRole('menuitem', { name: 'File' }).click();
  await workbench.getByRole('menuitem', { name: /^Save As/ }).click();
  await expectSavedPdf(frame);
  await revealTimelineItem(timeline, versions.filter({ has: workbench.getByText(`v1 · ${currentUser}`, { exact: true }) }));
  await openPdfTools(frame);
  await frame.getByRole('button', { name: 'Fit page' }).click();
  await closeSearch(frame);
  await addReviewComment(frame, frame.locator('[data-pdf-page="1"]'), 96, revisedComment);
  await frame.locator('.preview').focus();
  await workbench.keyboard.press('Control+Shift+s');
  await expectSavedPdf(frame);
  await revealTimelineItem(timeline, versions.filter({ has: workbench.getByText(`v2 · ${currentUser}`, { exact: true }) }));
  await verifyTimelineTimestamp(workbench, timeline, versions);
  console.log('Timeline updates after each save, including an overwrite of the exported PDF');
  await verifyAnnotationEvents(workbench, frame, timeline);
  await workbench.getByRole('menubar').getByRole('menuitem', { name: 'File' }).click();
  await workbench.getByRole('menuitem', { name: /Open File/ }).first().click();
  await tab(basename(copyPath)).first().waitFor();
  await checkReopenedCopy(await pdfFrame(workbench, basename(copyPath)));
  await (await pdfFrame(workbench, basename(copyPath))).getByText(revisedComment, { exact: true }).waitFor();
  await assertDocumentLayout(workbench);
  await workbench.screenshot({ path: join(run, 'code-oss.png') });
  await activeTab(basename(copyPath)).dblclick();
  await poll(async () => (await groups()).length === 3, 'Three visible groups before restart');
}

async function addProfileAnnotations(workbench, frame) {
  const page = frame.locator('[data-pdf-page="1"]');
  await selectReviewText(frame, page, 44);
  const palette = frame.getByRole('toolbar', { name: 'Highlight palette' });
  for (const color of ['yellow', 'blue', 'pink', 'purple']) await palette.getByRole('button', { name: `Highlight ${color}` }).waitFor();
  await palette.getByRole('button', { name: 'Comment on selection' }).click();
  const card = frame.getByRole('region', { name: 'Comment card' });
  await card.getByText(currentUser, { exact: true }).waitFor();
  await card.getByRole('textbox', { name: 'Comment text' }).fill(originalProfileComment);
  await card.getByRole('button', { name: 'Add comment' }).click();
  await card.getByText(originalProfileComment, { exact: true }).waitFor();
  await card.getByRole('button', { name: 'Close comment card' }).click();
  await frame.getByRole('button', { name: 'Open comment', exact: true }).click();
  await card.getByRole('button', { name: 'Edit comment' }).click();
  await card.getByRole('textbox', { name: 'Comment text' }).fill(profileComment);
  await card.getByRole('button', { name: 'Save comment' }).click();
  await card.getByText(profileComment, { exact: true }).waitFor();
  await card.getByRole('button', { name: 'Close comment card' }).click();
  await selectReviewText(frame, page, 96);
  await palette.getByRole('button', { name: 'Highlight purple' }).click();
  const timeline = await openTimeline(workbench);
  for (const label of [/Comment added/, /Comment edited/, /Highlight added/]) {
    await revealTimelineItem(timeline, timeline.getByRole('treeitem', { name: label }).filter({ hasText: currentUser }));
  }
  const marker = frame.getByRole('button', { name: 'Open comment', exact: true });
  assert.equal(await marker.count(), 1, 'A highlight without a comment leaves no comment badge');
  const markerBox = await marker.boundingBox();
  const pageBox = await page.boundingBox();
  assert.ok(markerBox && pageBox && markerBox.height <= 12 &&
    markerBox.y + markerBox.height < pageBox.y + 44 * pageBox.width / 440,
    'The small badge sits above the line of text');
  await frame.page().mouse.click(pageBox.x + 58 * pageBox.width / 440, pageBox.y + 96 * pageBox.width / 440);
  await card.getByRole('button', { name: 'Add comment' }).waitFor();
  await card.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await marker.count(), 1);
  console.log('Contextual palette and card create and edit attributed annotations without exporting the PDF');
}

async function verifyProfileAnnotations(workbench, group) {
  const frame = await pdfFrame(workbench, basename(files[1]), group);
  const notes = (await openPageComments(frame)).getByRole('list', { name: 'Page comments' });
  await notes.getByText(profileComment, { exact: true }).waitFor();
  assert.equal(await notes.getByText(originalProfileComment, { exact: true }).count(), 0);
  assert.equal(await notes.getByRole('button').count(), 1);
  await notes.getByText(currentUser, { exact: true }).waitFor();
  await notes.getByRole('button').filter({ hasText: profileComment }).click();
  const card = frame.getByRole('region', { name: 'Comment card' });
  await card.getByText(profileComment, { exact: true }).waitFor();
  await card.getByText(currentUser, { exact: true }).waitFor();
  const timeline = await openTimeline(workbench);
  for (const label of [/Comment added/, /Comment edited/, /Highlight added/]) {
    await revealTimelineItem(timeline, timeline.getByRole('treeitem', { name: label }).filter({ hasText: currentUser }));
  }
  await workbench.screenshot({ path: join(run, 'annotations-restored.png') });
  console.log('The comment and highlight were restored without a PDF copy or duplicate Timeline events');
}

async function verifySplitFrame(workbench, direction) {
  const grid = workbench.locator('.part.editor .pdfutl-editor-split-grid');
  const { x, y, gap, borders, sidebarColor } = await grid.evaluate((element, orientation) => {
    const vertical = orientation === 'vertical';
    const groupElements = [...element.querySelectorAll('.pdfutl-split-editor-frame')].filter(group => group.checkVisibility());
    const groups = groupElements.map(group => ({ box: group.getBoundingClientRect(), style: getComputedStyle(group) }));
    for (const first of groups) {
      for (const second of groups) {
        const start = vertical ? first.box.right : first.box.bottom;
        const end = vertical ? second.box.left : second.box.top;
        const distance = end - start;
        const overlapStart = Math.max(vertical ? first.box.top : first.box.left, vertical ? second.box.top : second.box.left);
        const overlapEnd = Math.min(vertical ? first.box.bottom : first.box.right, vertical ? second.box.bottom : second.box.right);
        if (distance < 0 || distance > 10 || overlapEnd - overlapStart < 100) continue;
        const across = (start + end) / 2;
        const along = (overlapStart + overlapEnd) / 2;
        return {
          x: vertical ? across : along,
          y: vertical ? along : across,
          gap: distance,
          borders: [first.style.borderTopWidth, second.style.borderTopWidth, first.style.borderTopColor, second.style.borderTopColor],
          sidebarColor: getComputedStyle(document.querySelector('.part.sidebar')).borderTopColor,
        };
      }
    }
    throw new Error('Could not find adjacent split editor frames');
  }, direction);
  assert.equal(gap, 2);
  assert.deepEqual(borders, ['1px', '1px', sidebarColor, sidebarColor]);
  await workbench.mouse.move(x, y);
  const sashHighlighted = state => workbench.evaluate(({ x, y, direction, state }) => {
    const sash = document.elementFromPoint(x, y)?.closest('.monaco-sash');
    if (!sash?.classList.contains(direction) || !sash.classList.contains(state)) return false;
    const accent = document.createElement('div');
    accent.style.color = 'var(--vscode-sash-hoverBorder)';
    sash.append(accent);
    const accentColor = getComputedStyle(accent).color;
    accent.remove();
    return getComputedStyle(sash, '::before').backgroundColor === accentColor;
  }, { x, y, direction, state });
  await poll(() => sashHighlighted('hover'), 'Split sash uses native highlight on hover');
  await workbench.mouse.down();
  await poll(() => sashHighlighted('active'), 'Split sash keeps native highlight while dragging');
  await workbench.mouse.up();
  await workbench.mouse.move(350, 10);
  console.log(direction + ' split has a 2 px gap and native borders and sash highlight');
}

async function openTimeline(workbench) {
  const header = workbench.locator('.part.sidebar .pane-header').filter({
    has: workbench.getByRole('heading', { name: 'Timeline', exact: true }),
  });
  await header.waitFor();
  if (await header.getAttribute('aria-expanded') === 'false') await header.click();
  return header.locator('..');
}

async function revealTimelineItem(timeline, item) {
  if (await item.isVisible()) return;
  const list = timeline.locator('.monaco-list').first();
  const more = timeline.getByRole('treeitem', { name: /Load more/ });
  // The latest entries may arrive while the virtual list is being scrolled.
  for (let pass = 0; pass < 3; pass++) {
    await list.press('Home');
    if (await item.waitFor({ timeout: 800 }).then(() => true, () => false)) return;
    let lastFocus;
    for (let step = 0; step < 36; step++) {
      if (await item.isVisible()) return;
      if (await more.isVisible()) {
        await more.click();
        lastFocus = undefined;
      } else {
        await list.press('PageDown');
        const focus = await list.getAttribute('aria-activedescendant');
        if (focus && focus === lastFocus) break;
        lastFocus = focus;
      }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }
  await item.waitFor();
}

async function verifyTimelineActionsOnly(timeline) {
  assert.equal(await timeline.getByRole('treeitem', { name: /^(First opened|Opened|Closed|Searched|Viewed page)\b/ }).count(), 0,
    'Opening, closing, viewing and searching stay out of Timeline');
}

async function verifyTimelineTimestamp(workbench, timeline, versions) {
  const newest = versions.filter({ has: workbench.getByText(`v2 · ${currentUser}`, { exact: true }) });
  await revealTimelineItem(timeline, newest);
  const suffix = newest.locator('.pdfutl-timeline-now');
  await suffix.waitFor();
  assert.equal(await suffix.textContent(), ' (now)');
  const rightEdges = await timeline.locator('.pdfutl-timeline-event .timeline-timestamp:visible')
    .evaluateAll(elements => elements.map(element => element.getBoundingClientRect().right));
  assert.ok(Math.max(...rightEdges) - Math.min(...rightEdges) <= 1, 'Timeline timestamps align on the right');
  const date = newest.locator('.pdfutl-timeline-date');
  const sidebar = workbench.locator('.part.sidebar');
  const originalWidth = (await sidebar.boundingBox()).width;

  // Going past the sidebar's minimum snaps it closed.
  await moveSidebarDivider(workbench, Math.round(172 - originalWidth));
  await poll(async () => ((await sidebar.boundingBox())?.width ?? Infinity) <= 175, 'Navigator stays visible near its minimum width');
  await suffix.waitFor({ state: 'hidden' });
  assert.equal(await date.evaluate(element => {
    const { left, right, width } = element.getBoundingClientRect();
    const label = element.closest('.monaco-icon-label').getBoundingClientRect();
    return width > 0 && left >= label.left && right <= label.right && label.right - right < 8;
  }), true, 'Full timestamp remains visible at the right edge of the narrow navigator');
  await workbench.screenshot({ path: join(run, 'timeline-narrow.png') });

  const narrowWidth = (await sidebar.boundingBox()).width;
  await moveSidebarDivider(workbench, originalWidth - narrowWidth);
  await poll(async () => Math.abs((await sidebar.boundingBox()).width - originalWidth) < 2, 'Navigator returns to its original width');
  await suffix.waitFor();
  await suffix.waitFor({ state: 'detached', timeout: 35_000 });
  await date.waitFor();
  assert.match((await newest.locator('.timeline-timestamp').textContent()).trim(), /^\d{2}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}$/);
  console.log('Timeline timestamps stay visible in the narrow navigator and (now) expires without a refresh');
}

async function moveSidebarDivider(workbench, offset) {
  await workbench.mouse.move(350, 10);
  const { x, y } = await workbench.evaluate(() => {
    const sidebar = document.querySelector('.part.sidebar').getBoundingClientRect();
    const editor = document.querySelector('.part.editor').getBoundingClientRect();
    for (const fraction of [0.5, 0.25, 0.75]) {
      const y = Math.round(sidebar.top + sidebar.height * fraction);
      for (let x = Math.floor(sidebar.right) - 2; x <= Math.ceil(editor.left) + 2; x++) {
        if (document.elementFromPoint(x, y)?.closest('.monaco-sash.vertical')) return { x, y };
      }
    }
    throw new Error('Could not find the navigator sash');
  });
  await workbench.mouse.move(x, y);
  await workbench.mouse.down();
  await workbench.mouse.move(x + offset, y, { steps: 8 });
  await workbench.mouse.up();
  await workbench.mouse.move(350, 10);
}

async function verifyRestoredTimeline(workbench, group) {
  const timeline = await openTimeline(workbench);
  const versions = timeline.getByRole('treeitem', { name: /review-copy\.pdf/ });
  const original = tabInGroup(workbench, group, basename(files[0]));
  await original.click();
  const first = versions.filter({ has: workbench.getByText(`v1 · ${currentUser}`, { exact: true }) });
  const second = versions.filter({ has: workbench.getByText(`v2 · ${currentUser}`, { exact: true }) });
  await revealTimelineItem(timeline, first);
  await revealTimelineItem(timeline, second);
  await verifyTimelineActionsOnly(timeline);

  await tabInGroup(workbench, group, basename(files[1])).click();
  await first.waitFor({ state: 'hidden' });
  assert.equal(await versions.count(), 0);
  await verifyTimelineActionsOnly(timeline);

  await original.click();
  await revealTimelineItem(timeline, first);
  await first.click();
  const previous = await pdfFrame(workbench, basename(copyPath), group);
  await checkReopenedCopy(previous);
  assert.equal(await previous.getByText(revisedComment, { exact: true }).count(), 0);

  // The timeline remains available when an archived copy becomes the active document.
  const copies = tabInGroup(workbench, group, basename(copyPath));
  const count = await copies.count();
  await revealTimelineItem(timeline, second);
  await second.click();
  await poll(async () => (await copies.count()) === count + 1, 'Open the second archived PDF as its own tab');
  const newest = await pdfFrame(workbench, basename(copyPath), group);
  await checkReopenedCopy(newest);
  await newest.getByText(revisedComment, { exact: true }).waitFor();
  await verifyTimelineActionsOnly(timeline);
  await workbench.screenshot({ path: join(run, 'timeline.png') });
  console.log('Timeline restored after restart and opened both exact saved versions with their annotations');
  await verifyRestoredAnnotationEvents(workbench, timeline);
}

async function verifyAnnotationEvents(workbench, frame, timeline) {
  const comments = timeline.getByRole('treeitem', { name: /Comment added/ });
  const first = comments.filter({ hasText: 'Verified review comment' });
  const second = comments.filter({ hasText: revisedComment });
  await closeSearch(frame);
  await findInPdf(frame, 'Third LEDGER detail');
  await frame.getByLabel('Current page').filter({ hasText: '2 / 2' }).waitFor();
  await closeSearch(frame);
  await selectReviewText(frame, frame.locator('[data-pdf-page="2"]'), 44);
  await frame.getByRole('button', { name: 'Highlight yellow', exact: true }).click();
  const highlight = timeline.getByRole('treeitem', { name: /Highlight added/ }).filter({ hasText: 'Page 2' });
  const empty = await openPageComments(frame);
  await empty.getByText('No comments on this page.').waitFor();
  await closePageComments(frame);
  await revealTimelineItem(timeline, first);
  await first.click();
  const firstPosition = await verifyVisibleFragment(frame, 1);
  await revealTimelineItem(timeline, second);
  await second.click();
  const secondPosition = await verifyVisibleFragment(frame, 1, firstPosition);
  assert.ok(secondPosition > firstPosition + 25, 'Comments on the same page point to different lines');
  await openPdfTools(frame);
  await frame.getByRole('button', { name: 'Page comments', exact: true }).click();
  const entries = frame.getByRole('list', { name: 'Page comments' });
  await entries.getByText('Verified review comment', { exact: true }).waitFor();
  await entries.getByText(revisedComment, { exact: true }).waitFor();
  assert.equal(await entries.getByText(currentUser, { exact: true }).count(), 2);
  await closePageComments(frame);
  await closeSearch(frame);
  await revealTimelineItem(timeline, highlight);
  await highlight.click();
  await verifyVisibleFragment(frame, 2);
  await workbench.screenshot({ path: join(run, 'timeline-fragment.png') });
  console.log('Timeline records comments and an unsaved highlight and navigates to the exact text on both pages');
}

async function verifyRestoredAnnotationEvents(workbench, timeline) {
  const originalTabs = workbench.locator('.editor-group-container .tab').filter({ hasText: basename(files[0]) });
  for (let count = await originalTabs.count(); count > 0; count--) {
    const tab = originalTabs.first();
    await tab.hover();
    await tab.locator('.tab-actions .action-label').click();
    await poll(async () => (await originalTabs.count()) < count, 'Close an original PDF tab');
  }
  const highlight = timeline.getByRole('treeitem', { name: /Highlight added/ }).filter({ hasText: 'Page 2' });
  await revealTimelineItem(timeline, highlight);
  await highlight.click();
  const original = await pdfFrame(workbench, basename(files[0]));
  await verifyVisibleFragment(original, 2);
  const empty = await openPageComments(original);
  await empty.getByText('No comments on this page.').waitFor();
  await jumpToPage(original, 1);
  const notes = empty.getByRole('list', { name: 'Page comments' });
  await notes.getByText('Verified review comment', { exact: true }).waitFor();
  await notes.getByText(revisedComment, { exact: true }).waitFor();
  assert.equal(await notes.getByRole('button').count(), 2);
  console.log('A restored Timeline event opens a closed original PDF directly at its marked fragment');
}

async function verifyActivityFiles() {
  const directory = join(profile, 'User', 'globalStorage', 'pdfutl.pdfutl-viewer', 'saved-pdf-copies');
  const files = (await readdir(directory)).filter(file => file.endsWith('.json'));
  const records = await Promise.all(files.map(async file => JSON.parse(await readFile(join(directory, file), 'utf8'))));
  assert.ok(records.length > 0 && records.every(record => record.user === currentUser));
  for (const kind of ['view', 'comment', 'commentEdited', 'highlight']) {
    assert.ok(records.some(record => record.activity?.kind === kind), `Persisted an attributed ${kind} event`);
  }
  assert.ok(files.every(file => !/^(first-open-|activity-)/.test(file)), 'Read-only activity does not create Timeline records');
  const snapshots = records.filter(record => record.exported);
  assert.equal(snapshots.length, 2);
  const marks = records.flatMap(record => record.highlights ?? []);
  assert.ok(marks.some(mark => mark.color.toLowerCase() === '#c4a4ff'));
  assert.ok(marks.every(mark => mark.attribution?.author === currentUser));
  assert.ok(marks.some(mark => mark.contents === profileComment && mark.attribution.modifiedBy === currentUser));
  console.log('The Windows user is recorded on PDF history entries, including view positions, colors and edits');
}

async function verifyVisibleFragment(frame, pageNumber, previousPosition) {
  const marker = frame.locator('[data-pdf-page="' + pageNumber + '"] .timeline-fragment');
  await marker.waitFor();
  let position;
  await poll(async () => {
    if ((await frame.getByLabel('Current page').textContent()).trim() !== pageNumber + ' / 2') return false;
    position = await marker.evaluate(element => {
      const box = element.getBoundingClientRect();
      const stage = element.closest('.stage').getBoundingClientRect();
      const paper = element.closest('.page-paper').getBoundingClientRect();
      return box.top + box.height / 2 >= stage.top && box.top + box.height / 2 <= stage.bottom
        ? 590 * Number.parseFloat(element.style.top) / paper.height : undefined;
    });
    return position !== undefined && (previousPosition === undefined || Math.abs(position - previousPosition) > 1);
  }, 'The Timeline fragment is visible on page ' + pageNumber);
  return position;
}

async function verifyOutline(workbench) {
  const header = workbench.locator('.part.sidebar .pane-header').filter({ has: workbench.getByRole('heading', { name: 'Outline', exact: true }) });
  const outline = header.locator('..');
  const section = outline.getByRole('treeitem', { name: 'Annual review', exact: true });
  const detail = outline.getByRole('treeitem', { name: 'Ledger detail', exact: true });
  const tab = name => workbench.locator('.editor-group-container .tab').filter({ hasText: name }).first();

  await header.click();
  await section.waitFor();
  if (await section.getAttribute('aria-expanded') === 'false') await section.locator('.monaco-tl-twistie').click();
  await detail.waitFor();
  assert.equal(Number(await detail.getAttribute('aria-level')), Number(await section.getAttribute('aria-level')) + 1);
  const frame = await pdfFrame(workbench, basename(files[0]));
  await detail.click();
  await poll(async () => (await frame.getByLabel('Current page').textContent()).trim() === '2 / 2', 'Outline navigates to a named destination');
  await waitForImage(frame.locator('[data-pdf-page="2"]'));
  await workbench.mouse.move(350, 10);
  await workbench.screenshot({ path: join(run, 'outline.png') });

  await tab(basename(files[1])).click();
  await outline.getByText(/No bookmarks in .*Review B\.pdf/).waitFor();
  assert.equal(await detail.count(), 0);
  await tab(basename(files[0])).click();
  await section.click();
  await poll(async () => (await frame.getByLabel('Current page').textContent()).trim() === '1 / 2', 'Outline uses the restored PDF tab after switching');
  await header.click();
  console.log('Native PDF Outline follows tabs, preserves nested bookmarks, and opens direct and named destinations');
}

async function verifyNavigator(workbench) {
  const sidebar = workbench.locator('.part.sidebar');
  const heading = label => sidebar.locator('.pane-header').filter({ has: workbench.getByRole('heading', { name: label, exact: true }) });
  await heading('Open Editors').waitFor();
  await heading('Pinned Folders').waitFor();
  const headers = await sidebar.locator('.pane-header h3:visible').allTextContents();
  assert.deepEqual(headers.slice(0, 2), ['Open Editors', 'Pinned Folders']);
  assert.ok(headers.indexOf('Outline') > 1 && headers.indexOf('Timeline') > 1);
  const editors = heading('Open Editors').locator('..');
  for (const file of files) await editors.getByRole('listitem', { name: new RegExp(basename(file)) }).waitFor();

  const activeFrame = await pdfFrame(workbench, basename(files[0]));
  await activeFrame.locator('[data-pdf-page="1"]').click();
  await workbench.keyboard.press('Control+b');
  await sidebar.waitFor({ state: 'hidden' });
  // Send the Russian layout's key value, but keep the same physical KeyB as Ctrl+B.
  const session = await workbench.context().newCDPSession(workbench);
  try {
    await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, code: 'KeyB', key: 'и', windowsVirtualKeyCode: 0 });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, code: 'KeyB', key: 'и', windowsVirtualKeyCode: 0 });
    await sidebar.waitFor();
  } finally {
    await session.detach();
  }

  const nested = join(pinnedFolder, 'Reference');
  await mkdir(nested);
  await mkdir(archiveFolder);
  await copyFile(files[1], join(nested, 'Nested.PDF'));
  await copyFile(files[1], join(nested, 'Older.pdf'));
  await writeFile(join(nested, 'Notes.txt'), 'Excluded from the PDF navigator');
  const older = new Date(2025, 5, 1, 10, 5, 45);
  const newer = new Date(2025, 5, 2, 10, 5, 45);
  for (const path of [archiveFolder, files[0], join(nested, 'Older.pdf')]) await utimes(path, older, older);
  for (const path of [pinnedFolder, files[1], join(nested, 'Nested.PDF')]) await utimes(path, newer, newer);

  const header = heading('Pinned Folders');
  const pinned = header.locator('..');
  await header.hover();
  await pinned.getByRole('button', { name: 'Pin Folder…' }).last().click();
  const row = name => pinned.getByRole('treeitem').filter({ has: workbench.getByText(name, { exact: true }) });
  const namesAtLevel = level => pinned.locator(`[role="treeitem"][aria-level="${level}"] .label-name`).allTextContents();
  const checkOrder = async (level, names, label) => {
    await poll(async () => JSON.stringify(await namesAtLevel(level)) === JSON.stringify(names), label);
  };
  const documents = row(basename(pinnedFolder));
  const archive = row(basename(archiveFolder));
  const reference = row('Reference');
  const date = '.pdfutl-pinned-date';
  await checkOrder(1, ['Archive', 'documents'], 'Pinned roots sort by name');
  await workbench.mouse.move(350, 10);
  assert.equal(await header.getByRole('button', { name: /Sorted by name/ }).isVisible(), false);
  await header.hover();
  await header.getByRole('button', { name: /Sorted by name · A–Z/ }).click();
  await checkOrder(1, ['documents', 'Archive'], 'Pinned roots reverse name order');
  await header.getByRole('button', { name: /Sort by date/ }).click();
  await checkOrder(1, ['Archive', 'documents'], 'Pinned roots sort oldest first');
  await header.getByRole('button', { name: /Sorted by date · Oldest first/ }).click();
  await checkOrder(1, ['documents', 'Archive'], 'Pinned roots sort newest first');
  await documents.locator('.monaco-tl-twistie').click();
  await checkOrder(2, ['Reference', 'Review A.pdf', 'Review B.pdf'], 'Folder starts with its own name sort');
  await documents.hover();
  await documents.getByRole('button', { name: /Sorted by name · A–Z/ }).click();
  await checkOrder(2, ['Reference', 'Review B.pdf', 'Review A.pdf'], 'Folder reverses its name sort');
  await documents.getByRole('button', { name: /Sort by date/ }).click();
  await checkOrder(2, ['Reference', 'Review A.pdf', 'Review B.pdf'], 'Folder sorts oldest first');
  await documents.getByRole('button', { name: /Sorted by date · Oldest first/ }).click();
  await checkOrder(2, ['Reference', 'Review B.pdf', 'Review A.pdf'], 'Folder sorts newest first');
  await reference.locator('.monaco-tl-twistie').click();
  await checkOrder(3, ['Nested.PDF', 'Older.pdf'], 'Nested folder keeps an independent sort');
  await reference.hover();
  await reference.getByRole('button', { name: /Sort by date/ }).click();
  await checkOrder(3, ['Older.pdf', 'Nested.PDF'], 'Nested folder changes its own sort');
  const dates = pinned.locator(`${date}:visible`);
  const edges = await dates.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().right));
  assert.ok(edges.length >= 6 && Math.max(...edges) - Math.min(...edges) <= 1, 'Dates align at the right edge across levels');
  assert.equal(await archive.locator(date).textContent(), '25.06.01 10:05:45');
  const wide = (await sidebar.boundingBox()).width;
  await moveSidebarDivider(workbench, Math.round(172 - wide));
  await documents.hover();
  const narrowDate = await documents.locator(date).evaluate(element => {
    const row = element.closest('.monaco-list-row').getBoundingClientRect();
    const text = document.createRange();
    text.selectNodeContents(element.firstElementChild);
    return { row: row.toJSON(), lines: Array.from(text.getClientRects(), rect => rect.toJSON()) };
  });
  assert.ok(narrowDate.lines.length > 0 && narrowDate.lines.every(rect =>
    rect.left >= narrowDate.row.left && rect.right <= narrowDate.row.right &&
    rect.top >= narrowDate.row.top - 2 && rect.bottom <= narrowDate.row.bottom + 2),
  `Timestamp stays visible beside hover actions in a narrow sidebar: ${JSON.stringify(narrowDate)}`);
  await moveSidebarDivider(workbench, Math.round(wide - (await sidebar.boundingBox()).width));
  await reference.hover();
  await reference.getByRole('button', { name: 'Hide modification dates' }).click();
  await row('Nested.PDF').locator(date).waitFor({ state: 'hidden' });
  await archive.locator(date).waitFor();
  await header.hover();
  await header.getByRole('button', { name: 'Hide modification dates' }).click();
  await archive.locator(date).waitFor({ state: 'hidden' });
  await header.getByRole('button', { name: 'Show modification dates' }).click();
  await archive.locator(date).waitFor();
  assert.equal(await row('Nested.PDF').locator(date).isVisible(), false);
  await row('Nested.PDF').click();
  await waitForImage((await pdfFrame(workbench, 'Nested.PDF')).locator('[data-pdf-page="1"]'));
  assert.equal(await pinned.getByText('Notes.txt', { exact: true }).count(), 0);
  const nestedTab = workbench.locator('.editor-group-container .tab').filter({ hasText: 'Nested.PDF' });
  await nestedTab.locator('.tab-actions .action-label').click();
  await nestedTab.waitFor({ state: 'hidden' });
  await editors.getByRole('listitem', { name: /Review A\.pdf/ }).click();
  await workbench.locator('.editor-group-container.active .tab.active').filter({ hasText: basename(files[0]) }).waitFor();
  await workbench.mouse.move(350, 10);
  await workbench.screenshot({ path: join(run, 'navigator.png') });
  console.log('Pinned roots, folders and nested folders have independent sort controls and right-aligned date toggles');
}

async function unpinRestoredFolder(workbench) {
  const folder = workbench.locator('.part.sidebar').getByRole('treeitem')
    .filter({ has: workbench.getByText(basename(pinnedFolder), { exact: true }) });
  await folder.waitFor();
  await folder.locator('.pdfutl-pinned-date').waitFor();
  await folder.hover();
  await folder.getByRole('button', { name: /Sorted by date · Newest first/ }).waitFor();
  const header = workbench.locator('.part.sidebar .pane-header').filter({
    has: workbench.getByRole('heading', { name: 'Pinned Folders', exact: true }),
  });
  await header.hover();
  await header.getByRole('button', { name: /Sorted by date · Newest first/ }).waitFor();
  await folder.hover();
  await folder.getByRole('button', { name: 'Unpin Folder' }).click();
  await folder.waitFor({ state: 'hidden' });
  assert.ok((await stat(pinnedFolder)).isDirectory());
  console.log('Pinned folders survived restart and unpinning left the directory on disk');
}

async function tabLayout(workbench) {
  return workbench.locator('.part.editor').evaluate(editor => {
    const area = editor.getBoundingClientRect();
    return Array.from(editor.querySelectorAll('.editor-group-container:not(.empty)'), group => {
      const bounds = group.getBoundingClientRect();
      return {
        position: [bounds.x - area.x, bounds.y - area.y, bounds.width, bounds.height]
          .map((value, index) => Math.round(100 * value / (index % 2 ? area.height : area.width))),
        active: group.classList.contains('active'),
        tabs: Array.from(group.querySelectorAll('.tab[data-resource-name]'), tab => ({
          name: tab.getAttribute('data-resource-name'),
          active: tab.classList.contains('active'),
        })),
      };
    });
  });
}

async function setReadingPositions(workbench) {
  const layout = await tabLayout(workbench);
  const secondName = basename(files[1]);
  const backgroundGroup = layout.findIndex(group => group.tabs.some(tab => tab.name === secondName && !tab.active));
  assert.ok(backgroundGroup >= 0, 'A PDF tab should be hidden by another tab in its group');

  const visibleName = layout[backgroundGroup].tabs.find(tab => tab.active).name;
  await tabInGroup(workbench, backgroundGroup, secondName).click();
  const background = await setReadingPosition(workbench, backgroundGroup, secondName, 1, 275, 133, 187);
  await tabInGroup(workbench, backgroundGroup, visibleName).click();

  const visible = [];
  for (const [group, { tabs }] of layout.entries()) {
    const name = tabs.find(tab => tab.active).name;
    visible.push(await setReadingPosition(workbench, group, name, group === 2 ? 1 : 2,
      200 + 50 * group, 177 + 31 * group, 225 + 44 * group));
  }
  return { visible, background };
}

function tabInGroup(workbench, group, name) {
  return workbench.locator('.editor-group-container:not(.empty)').nth(group)
    .locator('.tab[data-resource-name]').filter({ hasText: name });
}

async function setReadingPosition(workbench, group, name, page, zoom, scrollX, scrollY) {
  const frame = await pdfFrame(workbench, name, group);
  await closeSearch(frame);
  await closePageComments(frame);
  await openPdfTools(frame);
  await verifyPdfToolLayout(frame);
  const zoomField = frame.getByRole('textbox', { name: 'Zoom percent' });
  await zoomField.fill(String(zoom));
  await zoomField.press('Enter');

  if (name !== basename(files[1])) {
    await findInPdf(frame, page === 2 ? 'Third LEDGER detail' : 'LEDGER annual review');
    await frame.getByText('1 of 1', { exact: true }).waitFor();
    await poll(async () => (await readingPosition(frame))?.page === page, `Search jumps to page ${page}`);
  }
  await closeSearch(frame);

  await poll(async () => (await readingPosition(frame))?.page === page, `Navigate to page ${page} in group ${group + 1}`);
  const before = await readingPosition(frame);
  await frame.locator('.stage').hover();
  await workbench.mouse.wheel(scrollX, scrollY);
  await poll(async () => {
    const after = await readingPosition(frame);
    return after?.page === page && after.x < before.x - 2 && after.y < before.y - 2;
  }, `Horizontal and vertical scroll on page ${page} in group ${group + 1}`);
  return { group, name, ...await readingPosition(frame) };
}

function readingPosition(frame) {
  return frame.evaluate(() => {
    const page = Number(document.querySelector('.page-indicator')?.dataset.currentPage ?? 1);
    const view = document.querySelector('.stage');
    const paper = view?.querySelector(`[data-pdf-page="${page}"]`);
    if (!paper) return null;
    const bounds = paper.getBoundingClientRect();
    const stage = view.getBoundingClientRect();
    return { page, zoom: document.querySelector('.zoom-value').value, x: bounds.x - stage.x, y: bounds.y - stage.y };
  });
}

async function verifyReadingPositions(workbench, { visible, background }) {
  for (const saved of visible) await verifyReadingPosition(workbench, saved);
  await tabInGroup(workbench, background.group, background.name).click();
  await verifyReadingPosition(workbench, background);
  console.log('Restored independent pages, zoom and both scroll axes in split and background PDF tabs');
}

async function verifyReadingPosition(workbench, saved) {
  const frame = await pdfFrame(workbench, saved.name, saved.group);
  let actual;
  await poll(async () => {
    actual = await readingPosition(frame);
    return actual?.page === saved.page && actual.zoom === saved.zoom &&
      Math.abs(actual.x - saved.x) <= 2 && Math.abs(actual.y - saved.y) <= 2;
  }, `${saved.name} in group ${saved.group + 1} restores page ${saved.page} at ${saved.zoom}`)
    .catch(error => { throw new Error(`${error.message}. Expected ${JSON.stringify(saved)}, got ${JSON.stringify(actual)}`); });
}

async function openLegacyWorkspace() {
  const legacy = join(run, 'Legacy Project.code-workspace');
  await writeFile(legacy, JSON.stringify({ folders: [{ path: dirname(files[0]) }] }));
  const secondaryArgs = portableArg ? ['--new-window', legacy] : workbenchArgs([legacy]);
  const secondary = spawn(executable, secondaryArgs, { env: launchEnv, stdio: 'ignore' });
  const exited = new Promise((resolve, reject) => {
    secondary.on('error', reject);
    secondary.on('exit', code => code === 0 ? resolve() : reject(new Error(`Workspace launch exited with ${code}`)));
  });
  await Promise.all([exited, poll(async () => {
    const titles = await Promise.all(app.windows().map(window => window.title()));
    return titles.some(title => title.includes('Legacy Project'));
  }, 'Legacy saved workspace was open before restart')]);
}

async function seedUntitledWorkspace() {
  const untitled = join(profile, 'Workspaces', 'legacy-untitled');
  await mkdir(untitled, { recursive: true });
  await writeFile(join(untitled, 'workspace.json'), JSON.stringify({ folders: [{ path: dirname(files[0]) }] }));
}

async function verifyRestoredSession(workbench, layout) {
  await poll(async () => JSON.stringify(await tabLayout(workbench)) === JSON.stringify(layout),
    'Restored group positions, tab order and active tab');
  assert.equal(app.windows().length, 1, 'Neither saved nor untitled legacy workspace was restored');
  assert.doesNotMatch(await workbench.title(), /Workspace|Legacy Project/);
  const frame = await pdfFrame(workbench, basename(copyPath));
  await waitForImage(frame.locator('[data-pdf-page="1"]'));
  await assertDocumentLayout(workbench);
  await workbench.screenshot({ path: join(run, 'restored.png') });
  console.log('Restored PDF tabs and split layout without reopening saved or untitled workspaces');
}

async function assertDocumentLayout(workbench) {
  await workbench.locator('.part.sidebar').waitFor();
  assert.equal(await workbench.locator('.part.activitybar').isVisible(), false, 'No activity strip');
  assert.equal(await workbench.getByText(/Restricted Mode/).first().isVisible(), false, 'No project trust indicator for loose PDFs');
}

async function expectSavedPdf(frame) {
  await frame.getByText('Saved review-copy.pdf', { exact: true }).waitFor();
  assert.ok((await readFile(copyPath)).subarray(0, 5).equals(Buffer.from('%PDF-')));
}

async function checkReopenedCopy(frame) {
  const panel = await openPageComments(frame);
  await panel.getByText('Verified review comment', { exact: true }).waitFor();
  await panel.getByRole('button').filter({ hasText: 'Verified review comment' }).getByText(currentUser, { exact: true }).waitFor();
  console.log('Comment round-tripped through a PDF copy');
}

async function splitTab(tab, page, direction) {
  await tab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Split & Move/ }).hover();
  const items = page.getByRole('menuitem', { name: new RegExp(`Split ${direction}`) });
  await items.last().waitFor();
  // Code-OSS ignores mouse-up on menu items for 100 ms after mounting them.
  await new Promise(resolve => setTimeout(resolve, 140));
  await items.last().click();
}

async function pdfFrame(page, name, group) {
  const groupBounds = group === undefined ? null :
    await page.locator('.editor-group-container:not(.empty)').nth(group).boundingBox();
  let active;
  await poll(async () => {
    active = undefined;
    for (const frame of page.frames().reverse()) {
      const viewer = frame.getByRole('main', { name, exact: true });
      if (!await viewer.isVisible()) continue;
      const host = await frame.parentFrame()?.frameElement().catch(() => null);
      if (host && !await host.isVisible()) continue;
      if (groupBounds) {
        const bounds = await viewer.boundingBox();
        if (!bounds || bounds.x < groupBounds.x - 2 || bounds.x >= groupBounds.x + groupBounds.width ||
            bounds.y < groupBounds.y - 2 || bounds.y >= groupBounds.y + groupBounds.height) continue;
      }
      active = frame;
      return true;
    }
    return false;
  }, 'Active PDF webview');
  return active;
}

async function closeSearch(frame) {
  const overlay = frame.locator('.search-overlay');
  if (await overlay.getAttribute('data-visible') === 'true') {
    const pin = frame.getByRole('button', { name: 'Pin search panel' });
    if (await pin.getAttribute('aria-pressed') === 'true') await pin.click();
    const box = await frame.locator('.preview').boundingBox();
    assert.ok(box);
    await frame.page().mouse.move(box.x + 4, box.y + box.height - 8);
  }
  await overlay.waitFor({ state: 'hidden' });
}

async function openPdfTools(frame) {
  await frame.locator('.preview').focus();
  await frame.page().keyboard.press('Control+f');
  await frame.getByRole('searchbox', { name: 'Find text' }).waitFor();
}

async function openPageComments(frame) {
  const panel = frame.getByRole('region', { name: 'Comments on current page' });
  if (!await panel.isVisible()) {
    await frame.locator('.preview').focus();
    await frame.page().keyboard.press('Control+Shift+m');
    await panel.waitFor();
  }
  return panel;
}

async function closePageComments(frame) {
  const close = frame.getByRole('button', { name: 'Close page comments' });
  if (await close.isVisible()) await close.click();
}

async function findInPdf(frame, text) {
  await openPdfTools(frame);
  const field = frame.getByRole('searchbox', { name: 'Find text' });
  if (await field.inputValue() === text) await field.fill('');
  await field.fill(text);
  await field.press('Enter');
}

async function verifySinglePageSearch(frame) {
  assert.equal(await frame.getByRole('form', { name: 'Current page' }).count(), 0);
  await findInPdf(frame, 'LEDGER');
  await frame.getByText('1 of 1', { exact: true }).waitFor();
  await frame.getByRole('button', { name: 'Search matches' }).click();
  const matches = frame.getByRole('list', { name: 'All matches' });
  await matches.getByRole('button').waitFor();
  assert.equal(await matches.getByText('Page 1', { exact: true }).count(), 0);
  await closeSearch(frame);
}

async function verifyIndependentZoom(workbench, frame) {
  const measureWorkbench = () => workbench.evaluate(() => devicePixelRatio);
  const measurePdf = () => frame.evaluate(() => {
    const page = document.querySelector('.page-paper').getBoundingClientRect();
    return { width: page.width * devicePixelRatio, zoom: document.querySelector('.zoom-value').value };
  });
  const wheel = async (target, delta) => {
    await target.hover();
    await workbench.keyboard.down('Control');
    try {
      await workbench.mouse.wheel(0, delta);
    } finally {
      await workbench.keyboard.up('Control');
    }
  };
  await openPdfTools(frame);
  const field = frame.getByRole('textbox', { name: 'Zoom percent' });
  await field.fill('100');
  await field.press('Enter');
  await poll(async () => (await measurePdf()).zoom === '100%', 'Set a fixed PDF zoom');
  const before = await measurePdf();
  const baseScale = await measureWorkbench();
  const header = workbench.getByRole('heading', { name: 'Pinned Folders', exact: true });
  await wheel(header, -120);
  await poll(async () => await measureWorkbench() > baseScale, 'Ctrl+wheel over the navigator enlarges the interface');
  const enlargedScale = await measureWorkbench();
  await poll(async () => {
    const after = await measurePdf();
    return after.zoom === before.zoom && Math.abs(after.width - before.width) < 2;
  }, 'Interface zoom preserves both the PDF zoom and the apparent size of the page');
  await wheel(frame.locator('.stage'), -120);
  await poll(async () => (await measurePdf()).width > before.width + 5, 'Ctrl+wheel over the preview zooms the PDF');
  assert.equal(await measureWorkbench(), enlargedScale);
  await wheel(header, 120);
  await poll(async () => await measureWorkbench() === baseScale, 'Ctrl+wheel zooms the interface back out');
  await frame.getByRole('button', { name: 'Fit page' }).click();
  await closeSearch(frame);
  console.log('Ctrl+wheel scales the workbench and the PDF preview independently');
}

async function verifyPageIndicatorPosition(frame) {
  const indicator = frame.getByRole('form', { name: 'Current page' });
  await indicator.waitFor();
  const offsets = await indicator.evaluate(node => {
    const bounds = node.getBoundingClientRect();
    const preview = node.closest('.preview').getBoundingClientRect();
    return [preview.right - bounds.right, preview.bottom - bounds.bottom];
  });
  assert.deepEqual(offsets, [8, 8], 'The page counter stays in the bottom-right corner of its preview');
}

async function jumpToPage(frame, target) {
  const indicator = frame.getByRole('form', { name: 'Current page' });
  await indicator.getByRole('button', { name: /Go to page$/ }).click();
  const field = indicator.getByRole('textbox', { name: 'Page number' });
  await field.fill(String(target));
  await field.press('Enter');
  await indicator.getByRole('button', { name: `Page ${target} of 2. Go to page` }).waitFor();
}

async function verifyPageIndicator(frame) {
  await verifyPageIndicatorPosition(frame);
  const indicator = frame.getByRole('form', { name: 'Current page' });
  assert.equal(await frame.getByRole('toolbar', { name: 'PDF tools' }).getByLabel('Current page').count(), 0);
  const stage = frame.locator('.stage');
  const originalBounds = await stage.boundingBox();
  await jumpToPage(frame, 2);
  await poll(() => frame.locator('[data-pdf-page="2"]').evaluate(node => {
    const page = node.getBoundingClientRect();
    const viewport = node.closest('.stage').getBoundingClientRect();
    return page.top >= viewport.top && page.top < viewport.bottom;
  }), 'The requested page is visible in the PDF preview');
  const pageTwoPosition = await readingPosition(frame);
  assert.ok(pageTwoPosition);
  async function assertPageUnchanged() {
    const actual = await readingPosition(frame);
    // The renderer may snap a settled page to the pixel grid after navigation.
    assert.ok(actual && actual.page === pageTwoPosition.page && actual.zoom === pageTwoPosition.zoom &&
      Math.abs(actual.x - pageTwoPosition.x) <= 1 && Math.abs(actual.y - pageTwoPosition.y) <= 1,
      'Invalid or cancelled input preserves the PDF position and zoom');
  }
  await indicator.getByRole('button', { name: /Go to page$/ }).click();
  const field = indicator.getByRole('textbox', { name: 'Page number' });
  assert.ok(await field.evaluate(node => document.activeElement === node && node.selectionStart === 0 && node.selectionEnd === node.value.length));
  assert.deepEqual(await stage.boundingBox(), originalBounds, 'Editing the page number preserves the PDF viewport');
  for (const invalid of ['0', '3', '1.5']) {
    await field.fill(invalid);
    await field.press('Enter');
    await indicator.getByRole('alert').waitFor();
    assert.equal(await field.getAttribute('aria-invalid'), 'true');
    await assertPageUnchanged();
  }
  await field.press('Escape');
  await indicator.getByRole('button', { name: 'Page 2 of 2. Go to page' }).waitFor();
  await assertPageUnchanged();
  await jumpToPage(frame, 1);
  assert.equal((await readingPosition(frame)).zoom, pageTwoPosition.zoom);
  await verifyPageIndicatorPosition(frame);
  console.log('Page counter overlays the preview, jumps on Enter, validates the page number and cancels with Escape');
}

async function verifySearchPanel(frame, nativeTab) {
  const page = frame.page();
  const overlay = frame.locator('.search-overlay');
  const preview = frame.locator('.preview');
  const stage = frame.locator('.stage');
  const pin = frame.getByRole('button', { name: 'Pin search panel' });
  const field = frame.getByRole('searchbox', { name: 'Find text' });
  const box = await preview.boundingBox();
  assert.ok(box);
  const originalStage = await stage.boundingBox();
  await stage.hover();
  await overlay.waitFor({ state: 'hidden' });
  const triggerBottom = await overlay.evaluate(node => node.offsetTop + node.offsetHeight);
  await page.mouse.move(box.x + box.width - 8, box.y + triggerBottom - 2);
  assert.equal(await overlay.getAttribute('data-visible'), 'false', 'Search waits before appearing on hover');
  await overlay.waitFor();
  assert.equal(await pin.getAttribute('aria-pressed'), 'false');
  assert.ok(!await field.evaluate(node => document.activeElement === node), 'Hover leaves keyboard focus alone');
  const geometry = await overlay.evaluate(node => ({
    edges: [node.offsetLeft, node.offsetTop, node.parentElement.clientWidth - node.offsetLeft - node.offsetWidth],
    radius: getComputedStyle(node).borderTopLeftRadius,
  }));
  assert.deepEqual(geometry, { edges: [4, 4, 4], radius: '999px' });
  assert.deepEqual(await stage.boundingBox(), originalStage, 'The overlay preserves the PDF viewport');
  await verifyPdfToolLayout(frame);
  assert.equal(await frame.getByRole('toolbar', { name: 'PDF tools' }).count(), 0);
  assert.equal(await overlay.locator('[title="Hide panel"]').count(), 0);
  const background = await stage.evaluate(node => {
    const style = getComputedStyle(node);
    const tabColor = style.getPropertyValue('--vscode-tab-inactiveBackground').trim();
    const probe = document.createElement('span');
    probe.style.backgroundColor = tabColor || style.getPropertyValue('--vscode-editorGroupHeader-tabsBackground').trim() || '#2d2d2d';
    document.body.append(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { actual: style.backgroundColor, expected, tabColor };
  });
  if (nativeTab) assert.ok(background.tabColor, 'Code-OSS supplies the inactive tab color');
  assert.equal(background.actual, background.expected, 'The preview background matches the inactive tab color');
  await stage.hover();
  assert.equal(await overlay.getAttribute('data-visible'), 'true', 'Search waits before hiding');
  await overlay.waitFor({ state: 'hidden' });
  await page.mouse.move(box.x + box.width / 2, box.y + 3);
  await overlay.waitFor();
  await pin.click();
  await stage.hover();
  await new Promise(resolve => setTimeout(resolve, 525));
  assert.equal(await overlay.getAttribute('data-visible'), 'true', 'The Pin button keeps the overlay open');
  await closeSearch(frame);

  async function assertPinnedAndFocused() {
    await overlay.waitFor();
    await poll(async () => await pin.getAttribute('aria-pressed') === 'true' &&
      await field.evaluate(node => document.activeElement === node), 'Search is pinned and the input has focus');
  }

  await preview.focus();
  await page.keyboard.press('Control+f');
  await assertPinnedAndFocused();
  await stage.click();
  await new Promise(resolve => setTimeout(resolve, 525));
  assert.equal(await overlay.getAttribute('data-visible'), 'true', 'Pinned search survives pointer and focus leaving');
  await pin.click();
  assert.equal(await pin.getAttribute('aria-pressed'), 'false');
  await stage.hover();
  await overlay.waitFor({ state: 'hidden' });

  const cdp = await page.context().newCDPSession(page);
  async function russianFind() {
    const key = { modifiers: 2, code: 'KeyF', key: 'а', windowsVirtualKeyCode: 0 };
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    await assertPinnedAndFocused();
    await closeSearch(frame);
  }
  try {
    await preview.focus();
    await russianFind();
    if (nativeTab) {
      await nativeTab.focus();
      await page.keyboard.press('Control+f');
      await assertPinnedAndFocused();
      await closeSearch(frame);
      await nativeTab.focus();
      await russianFind();
    }
    const comments = frame.getByRole('region', { name: 'Comments on current page' });
    for (const focus of nativeTab ? [preview, nativeTab] : [preview]) {
      await focus.focus();
      await page.keyboard.press('Control+Shift+m');
      await comments.waitFor();
      await focus.focus();
      const key = { modifiers: 10, code: 'KeyM', key: 'Ь', windowsVirtualKeyCode: 0 };
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
      await comments.waitFor({ state: 'hidden' });
    }
  } finally {
    await cdp.detach();
  }
  console.log('The full toolbar area activates on hover; Ctrl+F and Ctrl+Shift+M work in English and Russian');
}

async function verifyPdfToolLayout(frame) {
  const layout = await frame.locator('.search-overlay').evaluate(bar => {
    const bounds = bar.getBoundingClientRect();
    const controls = [...bar.querySelectorAll('button, input')].map(node => node.getBoundingClientRect()).filter(rect => rect.width);
    return {
      contained: controls.every(rect => rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom),
      fieldRatio: bar.querySelector('.search-field').getBoundingClientRect().width / bounds.width,
      zoomInside: !!bar.querySelector('.zoom-value'),
    };
  });
  assert.ok(layout.contained && layout.zoomInside, 'Search and zoom controls fit in the same panel');
  assert.ok(layout.fieldRatio <= 0.55, 'The search field is compact');
}

async function verifySearchOptions(frame) {
  await openPdfTools(frame);
  const field = frame.getByRole('searchbox', { name: 'Find text' });
  const options = frame.getByRole('button', { name: 'Search options' });
  const menu = frame.getByRole('group', { name: 'Search options' });
  assert.ok(!await menu.isVisible());

  for (const { query, label, before, after } of [
    { query: 'ledger', label: 'Match case', before: '1 of 3', after: 'No matches' },
    { query: 'LEDG', label: 'Whole word', before: '1 of 3', after: 'No matches' },
    { query: 'L.DGER', label: 'Regular expression', before: 'No matches', after: '1 of 3' },
  ]) {
    await field.fill(query);
    await frame.getByText(before, { exact: true }).waitFor();
    await options.click();
    const option = menu.getByRole('checkbox', { name: label });
    await option.check();
    await frame.getByText(after, { exact: true }).waitFor();
    assert.equal(await options.getAttribute('data-active'), 'true');
    await option.uncheck();
    await frame.getByText(before, { exact: true }).waitFor();
    await option.press('Escape');
    await menu.waitFor({ state: 'hidden' });
  }
  console.log('Each search option is available and applies from a separate dropdown');
}

async function verifyPdf(frame) {
  await verifySearchOptions(frame);
  await findInPdf(frame, 'Third LEDGER detail');
  await frame.getByText('1 of 1', { exact: true }).waitFor();
  await frame.getByLabel('Current page').filter({ hasText: '2 / 2' }).waitFor();
  const find = frame.getByRole('searchbox', { name: 'Find text' });
  const matches = frame.getByRole('list', { name: 'All matches' });
  const chevron = frame.getByRole('button', { name: 'Search matches' });
  const overlay = frame.locator('.search-overlay');
  const fixedPosition = await overlay.boundingBox();
  await find.fill('LEDGER');
  await find.press('Enter');
  await frame.getByText('1 of 3', { exact: true }).waitFor();
  await frame.getByLabel('Current page').filter({ hasText: '1 / 2' }).waitFor();
  for (const index of [2, 3, 1]) {
    await find.press('Enter');
    await frame.getByText(`${index} of 3`, { exact: true }).waitFor();
    assert.equal(await chevron.getAttribute('aria-expanded'), 'false');
    assert.ok(!await matches.isVisible());
    if (index === 3) await frame.getByLabel('Current page').filter({ hasText: '2 / 2' }).waitFor();
  }
  assert.deepEqual(await overlay.boundingBox(), fixedPosition, 'Search stays fixed as the PDF scrolls across pages');

  const zoomField = frame.getByRole('textbox', { name: 'Zoom percent' });
  const searchZoom = await zoomField.inputValue();
  const beforeOpening = await readingPosition(frame);
  await chevron.click();
  await matches.waitFor();
  assert.deepEqual(await readingPosition(frame), beforeOpening, 'Opening the match list leaves the PDF exactly in place');
  const rows = matches.getByRole('button');
  assert.equal(await rows.count(), 3);
  assert.ok(await find.evaluate(node => document.activeElement === node));
  await find.press('Shift+Enter');
  await frame.getByText('3 of 3', { exact: true }).waitFor();
  await verifyUncoveredMatch(frame);
  await frame.getByLabel('Current page').filter({ hasText: '2 / 2' }).waitFor();
  await find.press('Enter');
  await frame.getByText('1 of 3', { exact: true }).waitFor();
  await verifyUncoveredMatch(frame);
  const beforeVisibleMatch = await readingPosition(frame);
  assert.notDeepEqual(beforeVisibleMatch, beforeOpening, 'The first hit needs a different position to clear the open list');
  await find.press('Enter');
  await frame.getByText('2 of 3', { exact: true }).waitFor();
  await verifyUncoveredMatch(frame);
  assert.deepEqual(await readingPosition(frame), beforeVisibleMatch, 'Enter leaves the PDF in place when the next match is already visible');

  for (const dismiss of [() => chevron.click(), () => find.press('Escape')]) {
    await dismiss();
    await matches.waitFor({ state: 'hidden' });
    assert.deepEqual(await readingPosition(frame), beforeVisibleMatch, 'Closing results preserves the PDF position set by Enter');
    await chevron.click();
    await matches.waitFor();
    assert.deepEqual(await readingPosition(frame), beforeVisibleMatch, 'Reopening results preserves the PDF position');
  }

  await frame.getByRole('button', { name: 'Pin search panel' }).click();
  await frame.locator('.stage').hover();
  await overlay.waitFor({ state: 'hidden' });
  assert.deepEqual(await readingPosition(frame), beforeVisibleMatch, 'Auto-hiding the whole panel leaves the PDF in place');
  await openPdfTools(frame);
  assert.equal(await find.inputValue(), 'LEDGER');
  await chevron.click();
  await matches.waitFor();

  // Force overflow even with a short fixture so the current row must scroll into view.
  await matches.evaluate(node => { node.style.maxHeight = '56px'; });
  for (const index of [3, 1, 2]) {
    await frame.page().keyboard.press('Enter');
    await poll(() => rows.nth(index - 1).evaluate(row => {
      const { top, bottom } = row.getBoundingClientRect();
      const viewport = row.closest('ol').getBoundingClientRect();
      return row.getAttribute('aria-current') === 'true' && top >= viewport.top && bottom <= viewport.bottom;
    }), `Match ${index} is current and scrolled into the open list`);
    assert.equal(await matches.locator('[aria-current="true"]').count(), 1);
    await verifyUncoveredMatch(frame);
  }
  await matches.evaluate(node => { node.style.removeProperty('max-height'); });
  await rows.first().click();
  await verifyUncoveredMatch(frame);
  const rowColor = row => row.evaluate(node => getComputedStyle(node).backgroundColor);
  assert.notEqual(await rowColor(rows.first()), await rowColor(rows.last()), 'The current result has a visible selection color');
  await frame.getByRole('button', { name: 'Previous match' }).click();
  assert.equal(await rows.last().getAttribute('aria-current'), 'true');
  await frame.getByRole('button', { name: 'Next match' }).click();
  assert.equal(await rows.first().getAttribute('aria-current'), 'true');
  await rows.last().click();
  assert.equal(await rows.last().getAttribute('aria-current'), 'true');
  await rows.first().click();
  await verifyUncoveredMatch(frame);
  assert.equal(await zoomField.inputValue(), searchZoom);
  await frame.page().screenshot({ path: join(run, 'search.png') });
  await find.press('Escape');
  await matches.waitFor({ state: 'hidden' });

  const pageImage = frame.locator('[data-pdf-page="1"]');
  await waitForImage(pageImage);
  await poll(async () => {
    const colors = await pageImage.evaluate(node => Array.from(node.querySelectorAll('.search-background div > div, .search-background polygon')).map(shape => {
      const style = getComputedStyle(shape);
      return [style.backgroundColor, style.fill];
    }).flat());
    return colors.includes('rgb(188, 255, 56)') && colors.includes('rgb(255, 139, 33)');
  }, 'Both match colors painted on page');
  await checkHighlightPixels(frame, pageImage);
  await find.press('Escape');
  assert.equal(await frame.getByRole('button', { name: 'Pin search panel' }).getAttribute('aria-pressed'), 'true');
  await closeSearch(frame);
  console.log('Opening or closing the list and stepping to an already visible match keep the PDF in place');

  await addReviewComment(frame, pageImage, 44, 'Verified review comment');
  await frame.getByRole('button', { name: 'Close comment card' }).click();
  console.log('Selected text with the mouse and added a PDF highlight comment');

  await openPdfTools(frame);
  await frame.getByRole('button', { name: 'Zoom out' }).click();
  await poll(async () => Number.parseInt(await zoomField.inputValue(), 10) < Number.parseInt(searchZoom, 10), 'Zoom out from the floating panel');
  await frame.getByRole('button', { name: 'Zoom in' }).click();
  await poll(async () => await zoomField.inputValue() === searchZoom, 'Zoom in from the floating panel');
  for (const percent of ['25', '4000']) {
    await zoomField.fill(percent);
    await poll(async () => await zoomField.inputValue() === percent, `Typed zoom ${percent}%`);
    await zoomField.press('Enter');
    await poll(async () => await zoomField.inputValue() === `${percent}%`, `Applied zoom ${percent}%`);
  }
  await findInPdf(frame, 'LEDGER');
  await frame.getByText('1 of 3', { exact: true }).waitFor();
  const tiles = () => frame.locator('.page-art img').evaluateAll(images => images.filter(img => img.style.width.endsWith('px')).map(img => ({
    complete: img.complete, width: img.naturalWidth, height: img.naturalHeight, styleWidth: img.style.width,
  })));
  await poll(async () => (await tiles()).some(tile => tile.complete && tile.width > 0 && tile.height > 0), 'Rendered high zoom image tiles');
  console.log(`Tile at 4000%: ${JSON.stringify((await tiles()).find(tile => tile.complete && tile.width > 0))}`);
  await frame.page().screenshot({ path: join(run, 'zoom-4000.png') });
  await chevron.click();
  await find.press('Enter');
  await frame.getByText('2 of 3', { exact: true }).waitFor();
  await verifyUncoveredMatch(frame, { allowClipping: true });
  assert.equal(await zoomField.inputValue(), '4000%');
  await closeSearch(frame);
  console.log('25% and 4000% with rendered PDF tiles');
}

async function verifyUncoveredMatch(frame, { allowClipping = false } = {}) {
  await poll(() => frame.evaluate(allowClipping => {
    const stage = document.querySelector('.stage').getBoundingClientRect();
    const bar = document.querySelector('.search-overlay').getBoundingClientRect();
    const list = document.querySelector('.search-results').getBoundingClientRect();
    const match = Array.from(document.querySelectorAll('.search-background div > div'))
      .find(node => getComputedStyle(node).backgroundColor === 'rgb(255, 139, 33)');
    if (!list.height || !match) return false;
    const { top, bottom, left, right } = match.getBoundingClientRect();
    const disjoint = box => left >= box.right || right <= box.left || top >= box.bottom || bottom <= box.top;
    if (!disjoint(bar) || !disjoint(list)) return false;
    if (allowClipping) return top < stage.bottom && bottom > stage.top && right > stage.left && left < stage.right;
    return top >= stage.top && bottom <= stage.bottom && left >= stage.left && right <= stage.right;
  }, allowClipping), 'The orange PDF match is visible with the results open');
}

async function addReviewComment(frame, pageImage, y, text) {
  await selectReviewText(frame, pageImage, y);
  await frame.getByRole('button', { name: 'Comment on selection' }).click();
  const card = frame.getByRole('region', { name: 'Comment card' });
  await card.getByRole('textbox', { name: 'Comment text' }).fill(text);
  await card.getByRole('button', { name: 'Add comment' }).click();
  await card.getByText(text, { exact: true }).waitFor();
}

async function selectReviewText(frame, pageImage, y) {
  await waitForImage(pageImage);
  const box = await pageImage.boundingBox();
  assert.ok(box);
  const scale = box.width / 440;
  const mouse = frame.page().mouse;
  await mouse.move(box.x + 37 * scale, box.y + y * scale);
  await mouse.down();
  await mouse.move(box.x + 137 * scale, box.y + (y + 3) * scale, { steps: 10 });
  await mouse.up();
}

async function checkHighlightPixels(frame, pageImage) {
  const matchShapes = pageImage.locator('.search-background div > div, .search-background polygon');
  const visible = frame.page().viewportSize() ?? await frame.page().evaluate(() => ({ width: innerWidth, height: innerHeight }));
  for (const [red, green, blue] of [[255, 139, 33], [188, 255, 56]]) {
    const rgb = `rgb(${red}, ${green}, ${blue})`;
    let clip;
    for (const shape of await matchShapes.all()) {
      const matches = await shape.evaluate((node, color) => {
        const style = getComputedStyle(node);
        return style.fill === color || style.backgroundColor === color;
      }, rgb);
      if (!matches) continue;
      const box = await shape.boundingBox();
      if (box && box.y >= 0 && box.x >= 0 && box.y + box.height <= visible.height && box.x + box.width <= visible.width) {
        clip = box;
        break;
      }
    }
    assert.ok(clip, `Visible highlight shape ${rgb}`);
    const screenshot = await frame.page().screenshot({ clip });
    const pixels = await frame.evaluate(async ({ bytes, rgb }) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let color = 0;
      let black = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (rgb.every((value, channel) => Math.abs(data[i + channel] - value) <= 2)) color++;
        if (data[i] < 20 && data[i + 1] < 20 && data[i + 2] < 20) black++;
      }
      return { color, black };
    }, { bytes: Array.from(screenshot), rgb: [red, green, blue] });
    assert.ok(pixels.color > 0 && pixels.black > 0, `${rgb} must coexist with black glyph pixels: ${JSON.stringify(pixels)}`);
  }
}

async function waitForImage(page) {
  await poll(async () => page.evaluate(node => Array.from(node.querySelectorAll('img')).some(img => img.complete && img.naturalWidth > 0)), 'PDF bitmap loaded');
}

async function poll(check, description, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out: ${description}`);
}
