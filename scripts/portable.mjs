import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { defaultSettings, electronVersion, productDisplay, root } from './code-oss.mjs';

const targets = {
  win32: {
    name: 'windows-x64',
    binary: 'PDFUtl.exe',
    format: 'zip',
    sha256: '2ba6223afa9121f42831fefe92c434334907540165294fc56697449d12e7cfe9',
  },
  linux: {
    name: 'linux-x64',
    binary: 'pdfutl',
    format: 'tar.gz',
    sha256: 'e1d077c7a087d7e344350ea0c5cd2b7dc5af3d9bf7979474f38e0fc1a560b875',
  },
};
const target = targets[process.platform];
const [checkout, bundle, runtimeZip, outputDir] = process.argv.slice(2);
if (!target || process.arch !== 'x64' || !checkout || !bundle || !runtimeZip || !outputDir) {
  throw new Error('Usage on Windows or Linux x64: node scripts/portable.mjs <Code-OSS checkout with native dependencies> <desktop bundle> <Electron ZIP> <output directory>');
}

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const sha256 = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });

const source = resolve(checkout);
const output = resolve(outputDir);
const runtime = resolve(runtimeZip);
if (await sha256(runtime) !== target.sha256) {
  throw new Error(`Expected the official Electron ${electronVersion} ${target.name} archive: ${runtime}`);
}

const manifest = await readJson(join(root, 'package.json'));
const upstreamPkg = await readJson(join(source, 'package.json'));
if (upstreamPkg.nativeBuild.target !== electronVersion) {
  throw new Error(`Code-OSS dependencies must be built for Electron ${electronVersion}`);
}
const product = await readJson(join(source, 'product.json'));
const { getProductionDependencies } = await import(pathToFileURL(join(source, 'build', 'lib', 'dependencies.ts')));
const releaseName = `PDFUtl-${manifest.version}-${target.name}`;
await mkdir(output, { recursive: true });
const staging = await mkdtemp(join(tmpdir(), 'pdfutl-package-'));
try {
  const distribution = join(staging, releaseName);
  await mkdir(distribution);
  if (process.platform === 'win32') {
    run('tar', ['-xf', runtime, '-C', distribution]);
  } else {
    run('unzip', ['-q', runtime, '-d', distribution]);
  }
  const executable = join(distribution, target.binary);
  await rename(join(distribution, process.platform === 'win32' ? 'electron.exe' : 'electron'), executable);
  if (process.platform === 'linux') await chmod(executable, 0o755);
  await rm(join(distribution, 'resources', 'default_app.asar'), { force: true });

  const app = join(distribution, 'resources', 'app');
  await mkdir(app, { recursive: true });
  const out = resolve(bundle);
  await cp(out, join(app, 'out'), { recursive: true, filter: file => !file.endsWith('.map') });
  if (process.platform === 'linux') {
    await mkdir(join(app, 'resources', 'linux'), { recursive: true });
    await copyFile(join(source, 'resources', 'linux', 'code.png'), join(app, 'resources', 'linux', 'code.png'));
  }
  await writeJson(join(app, 'package.json'), {
    name: 'pdfutl',
    type: upstreamPkg.type,
    main: upstreamPkg.main,
    version: upstreamPkg.version,
    desktopName: 'pdfutl.desktop',
  });
  await writeJson(join(app, 'product.json'), {
    ...product,
    ...productDisplay,
    version: upstreamPkg.version,
    applicationName: 'pdfutl',
    dataFolderName: '.pdfutl',
    sharedDataFolderName: '.pdfutl-shared',
    win32MutexName: 'pdfutl',
    win32AppUserModelId: 'PDFUtl',
    linuxDesktopName: 'pdfutl',
    urlProtocol: 'pdfutl',
    builtInExtensions: [],
  });

  const extensions = join(app, 'extensions');
  const viewer = join(extensions, 'pdfutl-viewer');
  await mkdir(viewer, { recursive: true });
  await copyFile(join(root, 'extension', 'package.json'), join(viewer, 'package.json'));
  await cp(join(root, 'extension', 'dist'), join(viewer, 'dist'), { recursive: true });
  for (const extension of await readdir(join(source, 'extensions'), { withFileTypes: true })) {
    if (extension.isDirectory() && extension.name.startsWith('theme-')) {
      await cp(join(source, 'extensions', extension.name), join(extensions, extension.name), { recursive: true });
    }
  }

  for (const dependency of getProductionDependencies(source)) {
    const destination = join(app, relative(source, dependency.folder));
    await cp(dependency.source, destination, {
      recursive: true,
      filter(file) {
        const parts = relative(dependency.source, file).split(sep);
        return !parts.some(part => ['node_modules', '.git', 'obj', 'obj.target', '.deps'].includes(part))
          && !/\.(?:map|pdb|iobj|ipdb|obj|lib|exp|ilk|a|o|tlog)$/i.test(file);
      },
    });
  }

  for (const name of ['LICENSE.txt', 'ThirdPartyNotices.txt']) {
    await copyFile(join(source, name), join(app, name));
  }
  const notices = join(app, 'licenses', 'viewer');
  const modules = join(root, 'node_modules');
  const embedpdf = await readdir(join(modules, '@embedpdf'));
  for (const name of [...embedpdf.filter(name => !name.startsWith('engine-runtime-') || name === 'engine-runtime-wasm32')
    .map(name => join('@embedpdf', name)), 'react', 'react-dom', 'scheduler']) {
    const installed = join(modules, name);
    const files = (await readdir(installed)).filter(file => /^(LICENSE|NOTICE)(\.|$)/i.test(file));
    if (files.length) {
      const destination = join(notices, name);
      await mkdir(destination, { recursive: true });
      for (const file of files) await copyFile(join(installed, file), join(destination, file));
    }
  }
  const user = join(distribution, 'data', 'user-data', 'User');
  await mkdir(user, { recursive: true });
  await writeJson(join(user, 'settings.json'), defaultSettings);
  await copyFile(join(root, 'INSTALL.md'), join(distribution, 'INSTALL.md'));

  const archive = join(staging, `${releaseName}.${target.format}`);
  if (process.platform === 'win32') {
    const upstreamRequire = createRequire(join(source, 'package.json'));
    const { ZipFile } = upstreamRequire('yazl');
    const zip = new ZipFile();
    const entries = await readdir(distribution, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name);
        zip.addFile(path, relative(staging, path).split(sep).join('/'));
      }
    }
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(archive));
  } else {
    run('tar', ['-zcf', archive, '-C', dirname(distribution), basename(distribution)]);
  }
  const final = join(output, basename(archive));
  const pending = join(output, `.${basename(staging)}.part`);
  try {
    await copyFile(archive, pending);
    await rename(pending, final);
  } finally {
    await rm(pending, { force: true });
  }
  console.log(`${await sha256(final)}  ${basename(final)}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
