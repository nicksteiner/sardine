/**
 * check-dist.mjs — post-build guard for dist/.
 *
 * Fails the build when a Web Worker chunk is (near) empty. rollup silently
 * emits a 1-byte worker when the worker entry's only import is a package
 * that declares `sideEffects: false` (it happened to the COG decode worker:
 * the app loaded, opened the COG, spawned eight workers with no code in them,
 * and every tile decode waited forever). The dev server does no tree-shaking,
 * so this only ever shows in production builds — which is where the GitHub
 * Pages demo runs.
 *
 * Run: node test/check-dist.mjs   (wired into `npm run build`)
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const assets = join(process.cwd(), 'dist', 'assets');
const MIN_WORKER_BYTES = 1024;
let bad = 0;
for (const f of readdirSync(assets)) {
  if (!/worker.*\.js$/.test(f)) continue;
  const size = statSync(join(assets, f)).size;
  const ok = size >= MIN_WORKER_BYTES;
  console.log(`${ok ? '  ✓' : '  ✗'} ${f}  ${size} bytes`);
  if (!ok) bad++;
}
if (bad) {
  console.error(`\ncheck-dist: ${bad} worker chunk(s) under ${MIN_WORKER_BYTES} bytes — the worker entry was tree-shaken to nothing.`);
  process.exit(1);
}
console.log('check-dist: worker chunks OK');
