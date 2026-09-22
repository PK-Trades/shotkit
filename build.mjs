import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const pages = ['overlay', 'quick', 'editor', 'pin', 'history', 'settings', 'scroll', 'countdown'];

fs.rmSync('dist', { recursive: true, force: true });

function copyStatic() {
  for (const page of pages) {
    const src = path.join('src/renderer', page);
    const out = path.join('dist/renderer', page);
    fs.mkdirSync(out, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      if (/\.(html|css)$/.test(f)) fs.copyFileSync(path.join(src, f), path.join(out, f));
    }
  }
  fs.mkdirSync('dist/renderer/shared', { recursive: true });
  fs.copyFileSync('src/renderer/shared/base.css', 'dist/renderer/shared/base.css');
}

const common = { bundle: true, sourcemap: true, target: 'es2022', logLevel: 'info' };

const configs = [
  {
    ...common,
    entryPoints: ['src/main/main.ts'],
    outfile: 'dist/main.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'koffi', 'electron-updater'],
  },
  {
    ...common,
    entryPoints: ['src/preload/preload.ts'],
    outfile: 'dist/preload.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: Object.fromEntries(pages.map((p) => [`${p}/${p}`, `src/renderer/${p}/${p}.ts`])),
    outdir: 'dist/renderer',
    platform: 'browser',
    format: 'iife',
  },
];

copyStatic();

if (watch) {
  for (const c of configs) {
    const ctx = await esbuild.context(c);
    await ctx.watch();
  }
  fs.watch('src/renderer', { recursive: true }, (_e, file) => {
    if (file && /\.(html|css)$/.test(file)) copyStatic();
  });
  console.log('Watching for changes...');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
