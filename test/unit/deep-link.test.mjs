/**
 * deep-link.test.mjs — W008 granule deep links: serializer/parser round-trip,
 * generic ?url= extension routing, and long-form param aliases.
 *
 * Run: node test/unit/deep-link.test.mjs
 */

import { suite } from './harness.mjs';
import {
  parseShareLink,
  buildShareLink,
  buildCompareLink,
  inferDataTypeFromUrl,
} from '../../src/utils/deep-link.js';

const { test, assert, run } = suite('deep-link (W008)');

const BASE = 'https://example.com/sardine/';
const COG_URL = 'https://data.example.com/scenes/flood_vv.tif';
const NISAR_URL = 'https://datapool.asf.alaska.edu/GCOV/NISAR_L2_GCOV_001.h5';
const NITF_URL = 'https://host.example.com/sicd/capella_123.ntf';

// ---------------------------------------------------------------------------
// inferDataTypeFromUrl — extension routing for the generic ?url= param
// ---------------------------------------------------------------------------

test('infers cog from .tif/.tiff/.geotiff (case-insensitive)', () => {
  assert.equal(inferDataTypeFromUrl(COG_URL), 'cog');
  assert.equal(inferDataTypeFromUrl('https://x/y.TIFF'), 'cog');
  assert.equal(inferDataTypeFromUrl('https://x/y.geotiff'), 'cog');
});

test('infers nisar from HDF5 extensions', () => {
  assert.equal(inferDataTypeFromUrl(NISAR_URL), 'nisar');
  assert.equal(inferDataTypeFromUrl('https://x/y.he5'), 'nisar');
  assert.equal(inferDataTypeFromUrl('https://x/y.HDF5'), 'nisar');
});

test('infers nitf from .ntf/.nitf', () => {
  assert.equal(inferDataTypeFromUrl(NITF_URL), 'nitf');
  assert.equal(inferDataTypeFromUrl('https://x/y.NITF'), 'nitf');
});

test('ignores query string and fragment for extension detection', () => {
  assert.equal(inferDataTypeFromUrl(`${COG_URL}?X-Amz-Signature=abc.h5`), 'cog');
  assert.equal(inferDataTypeFromUrl(`${NISAR_URL}#section.tif`), 'nisar');
});

test('returns null for unknown extensions', () => {
  assert.equal(inferDataTypeFromUrl('https://x/y.dat'), null);
  assert.equal(inferDataTypeFromUrl(''), null);
  assert.equal(inferDataTypeFromUrl(null), null);
});

// ---------------------------------------------------------------------------
// parseShareLink — generic ?url= param
// ---------------------------------------------------------------------------

test('?url= routes .tif to cog', () => {
  const { dataUrl, dataType } = parseShareLink(`?url=${encodeURIComponent(COG_URL)}`);
  assert.equal(dataUrl, COG_URL);
  assert.equal(dataType, 'cog');
});

test('?url= routes .h5 to nisar', () => {
  const { dataUrl, dataType } = parseShareLink(`?url=${encodeURIComponent(NISAR_URL)}`);
  assert.equal(dataUrl, NISAR_URL);
  assert.equal(dataType, 'nisar');
});

test('?url= routes .ntf to nitf', () => {
  const { dataType } = parseShareLink(`?url=${encodeURIComponent(NITF_URL)}`);
  assert.equal(dataType, 'nitf');
});

test('?url= with unknown extension falls back to nisar (matches direct-URL input)', () => {
  const { dataType } = parseShareLink('?url=https%3A%2F%2Fx%2Fy.dat');
  assert.equal(dataType, 'nisar');
});

test('explicit type params win over ?url=', () => {
  const { dataUrl, dataType } = parseShareLink(
    `?url=${encodeURIComponent(COG_URL)}&nisar=${encodeURIComponent(NISAR_URL)}`);
  assert.equal(dataType, 'nisar');
  assert.equal(dataUrl, NISAR_URL);
});

test('legacy ?cog= / ?sicd= params still parse', () => {
  assert.equal(parseShareLink(`?cog=${encodeURIComponent(COG_URL)}`).dataType, 'cog');
  assert.equal(parseShareLink(`?sicd=${encodeURIComponent(NITF_URL)}`).dataType, 'nitf');
});

test('no source param → dataUrl null', () => {
  const { dataUrl, dataType } = parseShareLink('?cmap=viridis');
  assert.equal(dataUrl, null);
  assert.equal(dataType, null);
});

// ---------------------------------------------------------------------------
// parseShareLink — long-form render param aliases (acceptance-criterion URL)
// ---------------------------------------------------------------------------

test('acceptance URL: ?url=<cog>&colormap=viridis&contrastMin=-20&contrastMax=0', () => {
  const { dataUrl, dataType, view } = parseShareLink(
    `?url=${encodeURIComponent(COG_URL)}&colormap=viridis&contrastMin=-20&contrastMax=0`);
  assert.equal(dataUrl, COG_URL);
  assert.equal(dataType, 'cog');
  assert.equal(view.colormap, 'viridis');
  assert.equal(view.contrastMin, -20);
  assert.equal(view.contrastMax, 0);
});

test('all long-form aliases parse', () => {
  const { view } = parseShareLink(
    '?url=' + encodeURIComponent(NISAR_URL) +
    '&colormap=inferno&contrastMin=-25.5&contrastMax=-2&useDecibels=0' +
    '&stretchMode=sigmoid&gamma=1.6&compositeId=dual-pol-h' +
    '&frequency=A&polarization=HVHV&multilook=4');
  assert.deepEqual(view, {
    colormap: 'inferno',
    contrastMin: -25.5,
    contrastMax: -2,
    useDecibels: false,
    stretchMode: 'sigmoid',
    gamma: 1.6,
    compositeId: 'dual-pol-h',
    selectedFrequency: 'A',
    selectedPolarization: 'HVHV',
    multiLook: 4,
  });
});

test('short keys take precedence over long aliases when both present', () => {
  const { view } = parseShareLink('?url=' + encodeURIComponent(COG_URL) +
    '&cmap=plasma&colormap=viridis&min=-30&contrastMin=-10');
  assert.equal(view.colormap, 'plasma');
  assert.equal(view.contrastMin, -30);
});

test('non-numeric contrast values are ignored, not NaN', () => {
  const { view } = parseShareLink('?url=' + encodeURIComponent(COG_URL) + '&contrastMin=abc&max=5');
  assert.equal(view.contrastMin, undefined);
  assert.equal(view.contrastMax, 5);
});

// ---------------------------------------------------------------------------
// buildShareLink → parseShareLink round-trip
// ---------------------------------------------------------------------------

test('round-trip preserves source URL, type, and full render state', () => {
  const view = {
    colormap: 'viridis',
    reverseColormap: true,
    useDecibels: false,
    contrastMin: -22.5,
    contrastMax: -1,
    stretchMode: 'gamma',
    gamma: 1.4,
    selectedPolarization: 'HHHH',
    selectedFrequency: 'B',
    multiLook: 8,
    compositeId: 'pauli',
    displayMode: 'rgb',
    viewCenter: [-91.18345, 30.45872],
    viewZoom: 11.37,
  };
  const link = buildShareLink({ baseUrl: BASE, dataUrl: NISAR_URL, dataType: 'nisar', view });
  assert.ok(link.startsWith(`${BASE}?`), 'link uses the given base URL');

  const parsed = parseShareLink(new URL(link).search);
  assert.equal(parsed.dataUrl, NISAR_URL);
  assert.equal(parsed.dataType, 'nisar');
  assert.equal(parsed.view.colormap, view.colormap);
  assert.equal(parsed.view.reverseColormap, true);
  assert.equal(parsed.view.useDecibels, false);
  assert.equal(parsed.view.contrastMin, view.contrastMin);
  assert.equal(parsed.view.contrastMax, view.contrastMax);
  assert.equal(parsed.view.stretchMode, view.stretchMode);
  assert.equal(parsed.view.gamma, view.gamma);
  assert.equal(parsed.view.selectedPolarization, view.selectedPolarization);
  assert.equal(parsed.view.selectedFrequency, view.selectedFrequency);
  assert.equal(parsed.view.multiLook, view.multiLook);
  assert.equal(parsed.view.compositeId, view.compositeId);
  assert.equal(parsed.view.displayMode, view.displayMode);
  // Center serialized at 5 dp, zoom at 2 dp
  assert.deepEqual(parsed.view.viewCenter, view.viewCenter);
  assert.equal(parsed.view.viewZoom, view.viewZoom);
});

test('round-trip of cog link (emits generic ?url= when extension matches type)', () => {
  const link = buildShareLink({
    baseUrl: BASE, dataUrl: COG_URL, dataType: 'cog',
    view: { colormap: 'viridis', contrastMin: -20, contrastMax: 0 },
  });
  const u = new URL(link);
  assert.equal(u.searchParams.get('url'), COG_URL);
  assert.equal(u.searchParams.has('cog'), false);

  const parsed = parseShareLink(u.search);
  assert.equal(parsed.dataUrl, COG_URL);
  assert.equal(parsed.dataType, 'cog');
  assert.deepEqual(parsed.view, { colormap: 'viridis', contrastMin: -20, contrastMax: 0 });
});

test('build pins explicit type param when extension does not round-trip', () => {
  const oddUrl = 'https://x/api/granule?id=42'; // no useful extension
  const link = buildShareLink({ baseUrl: BASE, dataUrl: oddUrl, dataType: 'cog', view: {} });
  const u = new URL(link);
  assert.equal(u.searchParams.get('cog'), oddUrl);
  assert.equal(u.searchParams.has('url'), false);
  assert.equal(parseShareLink(u.search).dataType, 'cog');
});

test('defaults are omitted from built links (short URLs)', () => {
  const link = buildShareLink({
    baseUrl: BASE, dataUrl: COG_URL, dataType: 'cog',
    view: { colormap: 'grayscale', stretchMode: 'linear', gamma: 1, useDecibels: true, multiLook: 1, displayMode: 'single' },
  });
  const u = new URL(link);
  assert.deepEqual([...u.searchParams.keys()], ['url']);
});

test('buildShareLink throws without dataUrl/dataType', () => {
  assert.throws(() => buildShareLink({ baseUrl: BASE, dataUrl: COG_URL }));
  assert.throws(() => buildShareLink({ baseUrl: BASE, dataType: 'cog' }));
});

// ---------------------------------------------------------------------------
// Local-file state links: ?file= + render params, no data URL
// ---------------------------------------------------------------------------

test('local-file state link round-trips filename + render state', () => {
  const link = buildShareLink({
    baseUrl: BASE,
    localFile: 'scene_hh.tif',
    view: { colormap: 'rdbu', contrastMin: -20, contrastMax: 0, viewCenter: [-150.1, 61.2], viewZoom: 3 },
  });
  const u = new URL(link);
  assert.equal(u.searchParams.get('file'), 'scene_hh.tif');
  assert.equal(u.searchParams.has('url'), false);

  const parsed = parseShareLink(u.search);
  assert.equal(parsed.localFile, 'scene_hh.tif');
  assert.equal(parsed.dataUrl, null);
  assert.equal(parsed.view.colormap, 'rdbu');
  assert.equal(parsed.view.contrastMin, -20);
  assert.equal(parsed.view.contrastMax, 0);
  assert.deepEqual(parsed.view.viewCenter, [-150.1, 61.2]);
  assert.equal(parsed.view.viewZoom, 3);
});

test('localFile is null on URL links; dataUrl wins when both present', () => {
  assert.equal(parseShareLink(`?url=${encodeURIComponent(COG_URL)}`).localFile, null);
  const both = parseShareLink(`?url=${encodeURIComponent(COG_URL)}&file=x.tif`);
  assert.equal(both.dataUrl, COG_URL); // URL link takes the normal path
});

// ---------------------------------------------------------------------------
// Spatial subset params (W016): ?bbox= / ?wkt=
// ---------------------------------------------------------------------------

// Silence the expected malformed-param warnings during these tests.
function quietly(fn) {
  const orig = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = orig; }
}

test('?bbox=w,s,e,n parses to view.roiBbox (WGS84)', () => {
  const { view } = parseShareLink(
    `?url=${encodeURIComponent(NISAR_URL)}&bbox=-91.4,30.2,-91.0,30.6`);
  assert.deepEqual(view.roiBbox, [-91.4, 30.2, -91.0, 30.6]);
  assert.equal(view.roiWkt, undefined, 'no wkt when only bbox given');
});

test('malformed bbox values are ignored with a warning, never thrown', () => {
  quietly(() => {
    // wrong count
    assert.equal(parseShareLink(`?url=x.h5&bbox=1,2,3`).view.roiBbox, undefined);
    // non-numeric
    assert.equal(parseShareLink(`?url=x.h5&bbox=a,b,c,d`).view.roiBbox, undefined);
    // inverted (w >= e)
    assert.equal(parseShareLink(`?url=x.h5&bbox=10,0,5,1`).view.roiBbox, undefined);
    // inverted (s >= n)
    assert.equal(parseShareLink(`?url=x.h5&bbox=0,10,5,10`).view.roiBbox, undefined);
    // empty
    assert.equal(parseShareLink(`?url=x.h5&bbox=`).view.roiBbox, undefined);
  });
});

test('?wkt=POLYGON parses to roiWkt + reduces to its bbox', () => {
  const wkt = 'POLYGON ((-91.4 30.2, -91.0 30.2, -91.0 30.6, -91.4 30.6, -91.4 30.2))';
  const { view } = parseShareLink(
    `?url=${encodeURIComponent(NISAR_URL)}&wkt=${encodeURIComponent(wkt)}`);
  assert.equal(view.roiWkt, wkt, 'original WKT preserved for the ROI input');
  assert.deepEqual(view.roiBbox, [-91.4, 30.2, -91.0, 30.6], 'wkt reduced to bbox');
});

test('?wkt=BBOX(...) shorthand parses', () => {
  const { view } = parseShareLink(
    `?url=x.h5&wkt=${encodeURIComponent('BBOX(-123, 44, -122, 45)')}`);
  assert.deepEqual(view.roiBbox, [-123, 44, -122, 45]);
});

test('wkt wins over bbox when both present', () => {
  const wkt = 'BBOX(-10, -5, 10, 5)';
  const { view } = parseShareLink(
    `?url=x.h5&bbox=0,0,1,1&wkt=${encodeURIComponent(wkt)}`);
  assert.deepEqual(view.roiBbox, [-10, -5, 10, 5], 'wkt bbox wins');
  assert.equal(view.roiWkt, wkt);
});

test('malformed wkt is ignored and falls back to a valid bbox param', () => {
  quietly(() => {
    const { view } = parseShareLink(
      `?url=x.h5&bbox=0,0,1,1&wkt=${encodeURIComponent('CIRCLE (0 0, 5)')}`);
    assert.equal(view.roiWkt, undefined, 'bad wkt dropped');
    assert.deepEqual(view.roiBbox, [0, 0, 1, 1], 'bbox fallback used');
  });
});

test('degenerate wkt (zero-area POINT) is rejected', () => {
  quietly(() => {
    const { view } = parseShareLink(`?url=x.h5&wkt=${encodeURIComponent('POINT (3 7)')}`);
    assert.equal(view.roiBbox, undefined, 'zero-area bbox rejected');
  });
});

test('buildShareLink emits bbox= from view.roiBbox and round-trips', () => {
  const roiBbox = [-91.43215, 30.21876, -91.01004, 30.62199];
  const link = buildShareLink({
    baseUrl: BASE, dataUrl: NISAR_URL, dataType: 'nisar', view: { roiBbox },
  });
  const u = new URL(link);
  assert.equal(u.searchParams.get('bbox'), '-91.43215,30.21876,-91.01004,30.62199');

  const parsed = parseShareLink(u.search);
  assert.deepEqual(parsed.view.roiBbox, roiBbox, 'bbox round-trips exactly at 5 dp');
});

test('buildShareLink omits bbox for missing/degenerate roiBbox', () => {
  for (const roiBbox of [undefined, null, [1, 2, 3], [5, 0, 5, 1], [0, 3, 1, 3], [NaN, 0, 1, 1]]) {
    const link = buildShareLink({ baseUrl: BASE, dataUrl: COG_URL, dataType: 'cog', view: { roiBbox } });
    assert.equal(new URL(link).searchParams.has('bbox'), false, `no bbox for ${JSON.stringify(roiBbox)}`);
  }
});

// ---------------------------------------------------------------------------
// Region-first links (W017): ?bbox= without a data param + t= / col=
// ---------------------------------------------------------------------------

test('W017: bbox alone is a valid link — no dataUrl, roiBbox parsed', () => {
  const { dataUrl, dataType, view } = parseShareLink('?bbox=-77.48,38.90,-77.26,39.01');
  assert.equal(dataUrl, null);
  assert.equal(dataType, null);
  assert.deepEqual(view.roiBbox, [-77.48, 38.90, -77.26, 39.01]);
});

test('W017: wkt alone is a valid link', () => {
  const { dataUrl, view } = parseShareLink(
    `?wkt=${encodeURIComponent('BBOX(-77.48, 38.90, -77.26, 39.01)')}`);
  assert.equal(dataUrl, null);
  assert.deepEqual(view.roiBbox, [-77.48, 38.90, -77.26, 39.01]);
});

test('W017: t=<start>/<end> parses to view.dateRange', () => {
  const { view } = parseShareLink('?bbox=0,0,1,1&t=2026-01-01/2026-02-01');
  assert.deepEqual(view.dateRange, { start: '2026-01-01', end: '2026-02-01' });
});

test('W017: t= halves are optional (start-only, end-only, no slash)', () => {
  assert.deepEqual(parseShareLink('?bbox=0,0,1,1&t=2026-01-01/').view.dateRange,
    { start: '2026-01-01', end: null });
  assert.deepEqual(parseShareLink('?bbox=0,0,1,1&t=/2026-02-01').view.dateRange,
    { start: null, end: '2026-02-01' });
  // No slash → start-only (everything since that date).
  assert.deepEqual(parseShareLink('?bbox=0,0,1,1&t=2026-01-15').view.dateRange,
    { start: '2026-01-15', end: null });
});

test('W017: full ISO datetimes pass through in t=', () => {
  const { view } = parseShareLink('?bbox=0,0,1,1&t=2026-01-01T10:00:00Z/2026-01-01T11:00:00Z');
  assert.deepEqual(view.dateRange, { start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' });
});

test('W017: malformed t= is ignored with a warning, never thrown', () => {
  const origWarn = console.warn; console.warn = () => {};
  try {
    assert.equal(parseShareLink('?bbox=0,0,1,1&t=not-a-date/whenever').view.dateRange, undefined);
    assert.equal(parseShareLink('?bbox=0,0,1,1&t=/').view.dateRange, undefined, 'both halves empty');
  } finally { console.warn = origWarn; }
});

test('W017: col= collection override parses', () => {
  const { view } = parseShareLink('?bbox=0,0,1,1&col=NISAR_L2_GCOV_PROVISIONAL_V1');
  assert.equal(view.collection, 'NISAR_L2_GCOV_PROVISIONAL_V1');
  assert.equal(parseShareLink('?bbox=0,0,1,1').view.collection, undefined);
});

test('W017: t=/col= are harmless alongside an explicit data URL', () => {
  const { dataUrl, dataType, view } = parseShareLink(
    `?url=${encodeURIComponent(NISAR_URL)}&bbox=0,0,1,1&t=2026-01-01/&col=X`);
  assert.equal(dataUrl, NISAR_URL);
  assert.equal(dataType, 'nisar');
  assert.deepEqual(view.dateRange, { start: '2026-01-01', end: null });
  assert.equal(view.collection, 'X');
});

// ---------------------------------------------------------------------------
// Multi-panel compare (?compare=)
// ---------------------------------------------------------------------------

const C1 = 'https://d.example.com/a.tif';
const C2 = 'https://d.example.com/b.tif';

test('compare= parses a comma-separated URL list into ordered panels', () => {
  const { compare } = parseShareLink(`?compare=${C1},${C2}`);
  assert.equal(compare.length, 2);
  assert.equal(compare[0].url, C1);
  assert.equal(compare[0].label, null);
  assert.equal(compare[1].url, C2);
});

test('compare= supports label~url entries', () => {
  const { compare } = parseShareLink('?compare=C%20vs%20Planet~https://d/a.tif,L%20vs%20Planet~https://d/b.tif');
  assert.equal(compare[0].label, 'C vs Planet');
  assert.equal(compare[0].url, 'https://d/a.tif');
  assert.equal(compare[1].label, 'L vs Planet');
});

test('compare= caps at 4 panels (warns)', () => {
  const origWarn = console.warn; console.warn = () => {};
  try {
    const { compare } = parseShareLink('?compare=https://d/1.tif,https://d/2.tif,https://d/3.tif,https://d/4.tif,https://d/5.tif');
    assert.equal(compare.length, 4);
  } finally { console.warn = origWarn; }
});

test('no compare= → compare is an empty array', () => {
  assert.deepEqual(parseShareLink(`?url=${encodeURIComponent(COG_URL)}`).compare, []);
});

test('buildCompareLink round-trips through parseShareLink', () => {
  const link = buildCompareLink({ baseUrl: BASE, panels: [{ url: C1, label: 'C' }, { url: C2, label: 'L' }] });
  const { compare } = parseShareLink('?' + link.split('?')[1]);
  assert.equal(compare.length, 2);
  assert.equal(compare[0].url, C1);
  assert.equal(compare[0].label, 'C');
  assert.equal(compare[1].url, C2);
  assert.equal(compare[1].label, 'L');
});

test('buildCompareLink percent-encodes commas inside URLs so they do not split', () => {
  const withComma = 'https://d.example.com/scene,v2.tif';
  const link = buildCompareLink({ baseUrl: BASE, panels: [withComma, C2] });
  const { compare } = parseShareLink('?' + link.split('?')[1]);
  assert.equal(compare.length, 2, 'comma in URL must not create a third panel');
  assert.equal(compare[0].url, withComma);
});

await run();
