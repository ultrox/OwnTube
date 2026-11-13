import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

process.chdir(fileURLToPath(new URL('.', import.meta.url)));
await fs.rm('dist', { recursive: true, force: true });
await fs.mkdir('dist', { recursive: true });
for (const file of ['manifest.json', 'popup.html', 'popup.css', 'pairing.html']) {
  await fs.copyFile(`src/${file}`, `dist/${file}`);
}
await build({
  entryPoints: Object.fromEntries(['page', 'content', 'sw', 'popup', 'pairing'].map(name => [name, `src/${name}.js`])),
  outdir: 'dist',
  bundle: true,
  minify: true,
  target: 'chrome120',
  define: { __DEV__: 'false' },
});
