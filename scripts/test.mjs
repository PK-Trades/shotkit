// Bundles test/*.test.ts with esbuild and runs them with Node's built-in test runner.
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const out = '.test-dist';
fs.rmSync(out, { recursive: true, force: true });
const entries = fs
  .readdirSync('test')
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => path.join('test', f));

await esbuild.build({
  entryPoints: entries,
  outdir: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
});

const files = fs.readdirSync(out).map((f) => path.join(out, f));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
