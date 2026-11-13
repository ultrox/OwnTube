import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

process.chdir(fileURLToPath(new URL('.', import.meta.url)));
await fs.rm('dist', { recursive: true, force: true });
await fs.mkdir('dist', { recursive: true });
execFileSync(process.env.ELM_BINARY ?? path.resolve('node_modules/elm/bin/elm'),
  ['make', 'history/Main.elm', '--optimize', '--output=dist/dashboard.js'], { stdio: 'inherit' });
for (const file of ['index.html', 'style.css', 'init.js', 'android-integration.html', 'diagnostics.html', 'diagnostics.js', 'fonts.css']) {
  await fs.copyFile(`history/${file}`, `dist/${file}`);
}
await fs.cp('history/fonts', 'dist/fonts', { recursive: true });
// Keep the existing content-addressed asset URLs and server routes.
let html = await fs.readFile('dist/index.html', 'utf8');
for (const file of ['style.css', 'dashboard.js', 'init.js']) {
  const contents = await fs.readFile(`dist/${file}`);
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 16);
  const versioned = file.replace(/(\.[^.]+)$/, `.${hash}$1`);
  await fs.writeFile(`dist/${versioned}`, contents);
  html = html.replace(`/${file}`, `/${versioned}`);
}
await fs.mkdir('dist/legacy', { recursive: true });
await fs.writeFile('dist/legacy/index.html', html);
const diagnostics = await fs.readFile('dist/diagnostics.js');
const diagnosticsName = `diagnostics.${createHash('sha256').update(diagnostics).digest('hex').slice(0, 16)}.js`;
await fs.writeFile(`dist/${diagnosticsName}`, diagnostics);
await fs.writeFile('dist/diagnostics.html',
  (await fs.readFile('dist/diagnostics.html', 'utf8')).replace('/diagnostics.js', `/${diagnosticsName}`));

// Optional modules have separate entry pages and fetch only their own APIs.
// Ship runtime assets, not test fixtures or preview tooling.
async function copyModule(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!['tests', 'artifacts', 'node_modules'].includes(entry.name)) {
        await copyModule(`${source}/${entry.name}`, `${destination}/${entry.name}`);
      }
    } else if (/\.(html|css|js|svg|woff2)$/.test(entry.name)) {
      await fs.copyFile(`${source}/${entry.name}`, `${destination}/${entry.name}`);
    }
  }
}
await copyModule('modules', 'dist/modules');
await copyModule('shared', 'dist/shared');
const versionsSource = await fs.readFile('shared/recorded-versions.js');
const versionsName = `recorded-versions.${createHash('sha256').update(versionsSource).digest('hex').slice(0, 16)}.js`;
await fs.writeFile(`dist/shared/${versionsName}`, versionsSource);
const sharedImports = (source) => source.replaceAll('/shared/recorded-versions.js', `/shared/${versionsName}`);

// Version the complete module graph: an updated import must also change the
// entry URL, so browser/CDN caches cannot mix releases.
const languageRoot = 'dist/modules/languages';
async function versionLanguageAsset(file, contents) {
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 16);
  const versioned = file.replace(/(\.[^.]+)$/, `.${hash}$1`);
  await fs.writeFile(`${languageRoot}/${versioned}`, contents);
  return versioned;
}
let languageScript = sharedImports(await fs.readFile(`${languageRoot}/languages.js`, 'utf8'));
for (const file of ['api.js', 'demo.js']) {
  const name = await versionLanguageAsset(file, await fs.readFile(`${languageRoot}/${file}`));
  languageScript = languageScript.replaceAll(`./${file}`, `./${name}`);
}
let languageHtml = await fs.readFile(`${languageRoot}/index.html`, 'utf8');
for (const [file, contents] of [
  ['languages.js', languageScript],
  ['languages.css', await fs.readFile(`${languageRoot}/languages.css`)],
]) {
  const name = await versionLanguageAsset(file, contents);
  languageHtml = languageHtml.replaceAll(`"${file}"`, `"${name}"`);
}
await fs.writeFile(`${languageRoot}/index.html`, languageHtml);

// The live History desk owns the root; the existing Elm dashboard stays at
// /legacy/. Hash dependencies before their importer to invalidate the full graph.
async function versionDeskAsset(file, contents) {
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 16);
  const versioned = file.replace(/(\.[^.]+)$/, `.${hash}$1`);
  await fs.writeFile(`dist/${versioned}`, contents);
  return versioned;
}
const deskApi = await versionDeskAsset('api.js', await fs.readFile('desk/api.js'));
const deskScript = sharedImports(await fs.readFile('desk/desk.js', 'utf8')).replaceAll('./api.js', `./${deskApi}`);
let deskHtml = await fs.readFile('desk/index.html', 'utf8');
for (const [file, contents] of [
  ['desk.js', deskScript],
  ['desk.css', await fs.readFile('desk/desk.css')],
]) {
  const name = await versionDeskAsset(file, contents);
  deskHtml = deskHtml.replaceAll(`"${file}"`, `"${name}"`);
}
await fs.writeFile('dist/index.html', deskHtml);
