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
await fs.writeFile('dist/index.html', html);
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
