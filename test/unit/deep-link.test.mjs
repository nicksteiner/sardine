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

await run();
