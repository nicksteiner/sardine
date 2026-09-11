/**
 * The viewport/ROI histogram must not run while the scene is still streaming.
 *
 * handleRecomputeHistogram calls imageData.getTile — the same path the load
 * uses — so recomputing mid-load issues tile reads that contend with the load
 * for chunk fetches and decode workers, and every result is superseded by the
 * next tile anyway. On a 1.2-gigapixel GCOV this showed up as six
 * "Recomputing histogram (viewport)" lines in three seconds.
 *
 * Source-shape test: the effects live inside a 9k-line component that cannot be
 * mounted headlessly here, and the defect is a missing guard, not a wrong
 * computation. Three things must hold, and each is asserted separately so a
 * regression names itself:
 *   1. both effects bail while `loading || tilesLoading > 0`
 *   2. `tilesLoading` is in both dependency arrays — without it the effect
 *      never re-runs when streaming settles, and the histogram never computes
 *   3. SARViewer actually reports tilesLoading upward, and main.jsx subscribes
 */

import { suite } from './harness.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { test, assert, run } = suite('histogram load gate');

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const main = readFileSync(join(rootDir, 'app', 'main.jsx'), 'utf8');
const viewer = readFileSync(join(rootDir, 'src', 'viewers', 'SARViewer.jsx'), 'utf8');

/** Extract a useEffect whose body contains `marker`, up to its dependency array. */
function effectContaining(src, marker) {
  const at = src.indexOf(marker);
  if (at === -1) return null;
  const start = src.lastIndexOf('useEffect(() => {', at);
  if (start === -1) return null;
  // Walk parens from `useEffect(` to its match so the slice ends at this
  // effect's dependency array rather than at the first `});` in the file.
  let i = start + 'useEffect'.length;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

test('the viewport histogram effect bails while a load is in flight', () => {
  const eff = effectContaining(main, "histogramScope !== 'viewport'");
  assert(eff, 'viewport histogram effect not found');
  assert(/if \(loading \|\| tilesLoading > 0\) return;/.test(eff),
    'viewport histogram must not run while loading or while tiles are streaming');
});

test('the ROI histogram effect bails too — it also goes through getTile', () => {
  const eff = effectContaining(main, "histogramScope !== 'roi'");
  assert(eff, 'ROI histogram effect not found');
  assert(/if \(loading \|\| tilesLoading > 0\) return;/.test(eff),
    'ROI histogram must not run while loading or while tiles are streaming');
});

test('both effects depend on tilesLoading, so they fire when streaming settles', () => {
  // This is the half that is easy to lose: gating without the dependency means
  // the histogram is suppressed during the load and then never computed.
  for (const [name, marker] of [['viewport', "histogramScope !== 'viewport'"],
                                ['roi', "histogramScope !== 'roi'"]]) {
    const eff = effectContaining(main, marker);
    assert(eff, `${name} effect not found`);
    const deps = eff.slice(eff.lastIndexOf('}, ['));
    assert(/tilesLoading/.test(deps),
      `${name} effect must list tilesLoading as a dependency, got: ${deps.slice(0, 120)}`);
    assert(/\bloading\b/.test(deps),
      `${name} effect must list loading as a dependency`);
  }
});

test('SARViewer reports tiles-in-flight and main.jsx subscribes', () => {
  assert(/onTilesLoadingChange/.test(viewer),
    'SARViewer must accept an onTilesLoadingChange prop');
  assert(/onTilesLoadingRef\.current\?\.\(status\?\.tilesLoading \?\? 0\)/.test(viewer),
    'SARViewer must report tilesLoading from its loading-status callback');
  assert(/onTilesLoadingChange=\{setTilesLoading\}/.test(main),
    'main.jsx must wire onTilesLoadingChange to its tilesLoading state');
  assert(/const \[tilesLoading, setTilesLoading\] = useState\(0\)/.test(main),
    'main.jsx must hold tilesLoading state');
});

await run();
