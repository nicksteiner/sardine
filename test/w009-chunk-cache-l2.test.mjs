#!/usr/bin/env node

/**
 * W009 — IndexedDB L2 chunk cache tests
 *
 * `indexedDB` is undefined under Node, so these tests prove:
 *   - complete no-op fallback (get → null, put resolves, nothing throws)
 *   - the real L2 path via a fake in-memory IDB shim (injectable idbFactory):
 *       put/get Float32 round-trip, key isolation, persistence across
 *       "reloads" (new ChunkCacheL2 on the same shim), LRU eviction past the
 *       byte bound (last-access order, not insertion order), oversized and
 *       non-Float32 payloads ignored, open failure degrades silently
 *   - L1 miss → L2 hit avoids the fetch stub (single-chunk and batch
 *     patterns mirroring nisar-loader's getStreamChunk/readDataChunksBatch)
 *   - MERGE_GAP raised to 2 MB as a named h5chunk export
 *   - nisar-loader wiring (source checks: IDB import, layered batch helper,
 *     URL-only scoping)
 *
 * Runs standalone under Node — no network, no browser, no data files.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const {
  ChunkCacheL2,
  createPersistentChunkCache,
  chunkCacheKey,
  L2_MAX_BYTES,
} = await import(join(rootDir, 'src/loaders/chunk-cache-idb.js'));

// ─── Fake in-memory IndexedDB shim ───────────────────────────────────────────
// Implements exactly the IDB surface chunk-cache-idb.js uses:
//   factory.open → onupgradeneeded/onsuccess; createObjectStore + createIndex;
//   transaction().objectStore(); get/put/delete/clear; openCursor (store +
//   index, ascending by index keyPath); cursor.value/.delete()/.continue().
// Events fire on microtasks (like real IDB, handlers attach before delivery)
// and records are structured-clone copied on read/write (ArrayBuffers cloned).

class FakeRequest {
  constructor() {
    this.onsuccess = null;
    this.onerror = null;
    this.onupgradeneeded = null;
    this.result = undefined;
    this.error = null;
  }
  _resolve(result) {
    this.result = result;
    queueMicrotask(() => this.onsuccess && this.onsuccess({ target: this }));
  }
  _reject(error) {
    this.error = error;
    queueMicrotask(() => this.onerror && this.onerror({ target: this }));
  }
}

function cloneRecord(rec) {
  const out = { ...rec };
  if (out.data instanceof ArrayBuffer) out.data = out.data.slice(0);
  return out;
}

function cursorRequest(data, sortKeyFn) {
  const req = new FakeRequest();
  const entries = [...data.records.entries()];
  if (sortKeyFn) {
    entries.sort((a, b) => {
      const ka = sortKeyFn(a[1]), kb = sortKeyFn(b[1]);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }
  let i = -1;
  const advance = () => {
    i++;
    if (i >= entries.length) {
      req._resolve(null);
      return;
    }
    const [key, value] = entries[i];
    req._resolve({
      value: cloneRecord(value),
      delete() {
        data.records.delete(key);
        const r = new FakeRequest();
        r._resolve(undefined);
        return r;
      },
      continue: advance,
    });
  };
  advance();
  return req;
}

class FakeStore {
  constructor(data) {
    this.data = data; // { keyPath, records: Map, indexes: Map(name → keyPath) }
  }
  get(key) {
    const req = new FakeRequest();
    const rec = this.data.records.get(key);
    req._resolve(rec === undefined ? undefined : cloneRecord(rec));
    return req;
  }
  put(value) {
    const req = new FakeRequest();
    const key = value[this.data.keyPath];
    this.data.records.set(key, cloneRecord(value));
    req._resolve(key);
    return req;
  }
  delete(key) {
    const req = new FakeRequest();
    this.data.records.delete(key);
    req._resolve(undefined);
    return req;
  }
  clear() {
    const req = new FakeRequest();
    this.data.records.clear();
    req._resolve(undefined);
    return req;
  }
  createIndex(name, keyPath) {
    this.data.indexes.set(name, keyPath);
    return { name };
  }
  index(name) {
    const keyPath = this.data.indexes.get(name);
    if (!keyPath) throw new Error(`No such index: ${name}`);
    return { openCursor: () => cursorRequest(this.data, (rec) => rec[keyPath]) };
  }
  openCursor() {
    return cursorRequest(this.data, null);
  }
}

class FakeDB {
  constructor() {
    this.stores = new Map();
    this.objectStoreNames = { contains: (n) => this.stores.has(n) };
  }
  createObjectStore(name, { keyPath }) {
    const data = { keyPath, records: new Map(), indexes: new Map() };
    this.stores.set(name, data);
    return new FakeStore(data);
  }
  transaction(_names, _mode) {
    return { objectStore: (n) => new FakeStore(this.stores.get(n)) };
  }
  close() {}
}

class FakeIDBFactory {
  constructor() {
    this.dbs = new Map();
  }
  open(name, _version) {
    const req = new FakeRequest();
    queueMicrotask(() => {
      let db = this.dbs.get(name);
      const isNew = !db;
      if (isNew) {
        db = new FakeDB();
        this.dbs.set(name, db);
      }
      req.result = db;
      if (isNew && req.onupgradeneeded) req.onupgradeneeded({ target: req });
      req._resolve(db);
    });
    return req;
  }
}

/** Factory whose open() always throws (simulates blocked/broken IDB). */
const brokenFactory = {
  open() {
    throw new Error('IDB unavailable');
  },
};

const f32 = (...vals) => new Float32Array(vals);
const URL_A = 'https://example.com/scene.h5';
const DS_A = '/science/LSAR/GCOV/grids/frequencyA/HHHH';

console.log('\n━━━ W009: no-op fallback (Node, indexedDB undefined) ━━━');

await check('Node environment has no global indexedDB', () => {
  assert(typeof indexedDB === 'undefined', 'expected indexedDB to be undefined under Node');
});

await check('default ChunkCacheL2 is unavailable and fully inert', async () => {
  const cache = new ChunkCacheL2();
  assert(cache.available === false, 'available should be false without indexedDB');
  const hit = await cache.get(URL_A, DS_A, 0, 0);
  assert(hit === null, 'get should resolve null in no-op mode');
  await cache.put(URL_A, DS_A, 0, 0, f32(1, 2, 3)); // must not throw or reject
  assert(cache.totalBytes === 0, 'no bytes accounted in no-op mode');
});

await check('createPersistentChunkCache no-ops without indexedDB', async () => {
  const pc = createPersistentChunkCache(URL_A, DS_A);
  assert((await pc.get(1, 2)) === null, 'scoped get should resolve null');
  await pc.put(1, 2, f32(9)); // fire-and-forget, never rejects
});

await check('IDB open failure degrades silently to no-op', async () => {
  const cache = new ChunkCacheL2({ idbFactory: brokenFactory });
  assert(cache.available === true, 'not disabled before first use');
  await cache.put(URL_A, DS_A, 0, 0, f32(1));
  assert((await cache.get(URL_A, DS_A, 0, 0)) === null, 'get resolves null after open failure');
  assert(cache.available === false, 'cache disabled after open failure');
});

console.log('\n━━━ W009: L2 path via fake IDB shim ━━━');

await check('chunkCacheKey scopes by (sourceUrl, datasetPath, row, col)', () => {
  const k = chunkCacheKey(URL_A, DS_A, 3, 7);
  assert(k.includes(URL_A) && k.includes(DS_A) && k.includes('3,7'), 'key missing components');
  assert(chunkCacheKey(URL_A, DS_A, 3, 7) === k, 'key not deterministic');
  assert(chunkCacheKey(URL_A, '/other', 3, 7) !== k, 'datasetPath not scoping the key');
  assert(chunkCacheKey('https://other.com/f.h5', DS_A, 3, 7) !== k, 'sourceUrl not scoping the key');
});

await check('put → get round-trips Float32 data bit-exact', async () => {
  const cache = new ChunkCacheL2({ idbFactory: new FakeIDBFactory() });
  const data = f32(0.5, -1.25, 3e-7, NaN, 42);
  await cache.put(URL_A, DS_A, 3, 7, data);
  const out = await cache.get(URL_A, DS_A, 3, 7);
  assert(out instanceof Float32Array, 'expected Float32Array');
  assert(out.length === data.length, `length ${out?.length} != ${data.length}`);
  for (let i = 0; i < data.length; i++) {
    const same = out[i] === data[i] || (Number.isNaN(out[i]) && Number.isNaN(data[i]));
    assert(same, `value[${i}] ${out[i]} != ${data[i]}`);
  }
  assert(cache.totalBytes === data.byteLength, `totalBytes ${cache.totalBytes} != ${data.byteLength}`);
});

await check('put copies the buffer (later caller mutation does not corrupt L2)', async () => {
  const cache = new ChunkCacheL2({ idbFactory: new FakeIDBFactory() });
  const data = f32(1, 2, 3);
  const putPromise = cache.put(URL_A, DS_A, 0, 0, data);
  data.fill(99); // mutate immediately, before the async write lands
  await putPromise;
  const out = await cache.get(URL_A, DS_A, 0, 0);
  assert(out[0] === 1 && out[2] === 3, 'stored data was corrupted by caller mutation');
});

await check('keys are isolated across datasetPath and sourceUrl', async () => {
  const cache = new ChunkCacheL2({ idbFactory: new FakeIDBFactory() });
  await cache.put(URL_A, DS_A, 0, 0, f32(1));
  await cache.put(URL_A, '/science/LSAR/GCOV/grids/frequencyA/HVHV', 0, 0, f32(2));
  await cache.put('https://other.com/b.h5', DS_A, 0, 0, f32(3));
  assert((await cache.get(URL_A, DS_A, 0, 0))[0] === 1, 'dataset A collided');
  assert((await cache.get(URL_A, '/science/LSAR/GCOV/grids/frequencyA/HVHV', 0, 0))[0] === 2, 'HVHV collided');
  assert((await cache.get('https://other.com/b.h5', DS_A, 0, 0))[0] === 3, 'other URL collided');
});

await check('entries persist across "reload" (new instance, same IDB)', async () => {
  const factory = new FakeIDBFactory();
  const first = new ChunkCacheL2({ idbFactory: factory });
  await first.put(URL_A, DS_A, 5, 6, f32(7, 8));
  // "Reload": fresh ChunkCacheL2 over the same backing store
  const second = new ChunkCacheL2({ idbFactory: factory });
  const out = await second.get(URL_A, DS_A, 5, 6);
  assert(out && out[0] === 7 && out[1] === 8, 'chunk did not survive reload');
  assert(second.totalBytes === 8, `size rescan ${second.totalBytes} != 8`);
});

await check('non-Float32 payloads (e.g. uint8 masks) are ignored', async () => {
  const cache = new ChunkCacheL2({ idbFactory: new FakeIDBFactory() });
  await cache.put(URL_A, DS_A, 0, 0, new Uint8Array([1, 2, 3]));
  assert((await cache.get(URL_A, DS_A, 0, 0)) === null, 'uint8 payload should not be stored');
  assert(cache.totalBytes === 0, 'no bytes should be accounted');
});

await check('oversized chunk (> maxBytes) is skipped without evicting others', async () => {
  const cache = new ChunkCacheL2({ idbFactory: new FakeIDBFactory(), maxBytes: 1000 });
  await cache.put(URL_A, DS_A, 0, 0, new Float32Array(100)); // 400 B, kept
  await cache.put(URL_A, DS_A, 0, 1, new Float32Array(500)); // 2000 B > bound, skipped
  assert((await cache.get(URL_A, DS_A, 0, 1)) === null, 'oversized chunk should not be stored');
  assert((await cache.get(URL_A, DS_A, 0, 0)) !== null, 'existing chunk wrongly evicted');
  assert(cache.totalBytes === 400, `totalBytes ${cache.totalBytes} != 400`);
});

console.log('\n━━━ W009: LRU eviction by last access ━━━');

await check('LRU evicts past the byte bound in last-access order', async () => {
  // maxBytes=1000; each chunk = Float32Array(100) = 400 bytes
  const cache = new ChunkCacheL2({ idbFactory: new FakeIDBFactory(), maxBytes: 1000 });
  await cache.put(URL_A, DS_A, 0, 0, new Float32Array(100).fill(1)); // A
  await cache.put(URL_A, DS_A, 0, 1, new Float32Array(100).fill(2)); // B
  assert(cache.totalBytes === 800, `pre-evict total ${cache.totalBytes} != 800`);

  await cache.put(URL_A, DS_A, 0, 2, new Float32Array(100).fill(3)); // C → 1200 > 1000
  assert(cache.totalBytes <= 1000, `total ${cache.totalBytes} exceeds 1000 bound`);
  assert((await cache.get(URL_A, DS_A, 0, 0)) === null, 'A (least recent) should be evicted');
  assert((await cache.get(URL_A, DS_A, 0, 2)) !== null, 'C (just written) must survive');

  // Access order now: B, then C touched by the gets above... make it explicit:
  await cache.flush();
  await cache.get(URL_A, DS_A, 0, 2); // touch C
  await cache.get(URL_A, DS_A, 0, 1); // touch B (B is now most recent)
  await cache.flush(); // let fire-and-forget touches settle

  await cache.put(URL_A, DS_A, 0, 3, new Float32Array(100).fill(4)); // D → evicts C (LRU)
  assert((await cache.get(URL_A, DS_A, 0, 2)) === null, 'C should be evicted (least recently accessed)');
  assert((await cache.get(URL_A, DS_A, 0, 1)) !== null, 'B was recently accessed — must survive');
  assert((await cache.get(URL_A, DS_A, 0, 3)) !== null, 'D (just written) must survive');
  assert(cache.totalBytes === 800, `post-evict total ${cache.totalBytes} != 800`);
});

await check('re-putting the same key replaces without double-counting', async () => {
  const cache = new ChunkCacheL2({ idbFactory: new FakeIDBFactory(), maxBytes: 1000 });
  await cache.put(URL_A, DS_A, 0, 0, new Float32Array(100).fill(1));
  await cache.put(URL_A, DS_A, 0, 0, new Float32Array(100).fill(9));
  assert(cache.totalBytes === 400, `totalBytes ${cache.totalBytes} != 400 after replace`);
  const out = await cache.get(URL_A, DS_A, 0, 0);
  assert(out[0] === 9, 'replacement data not returned');
});

await check('clear() empties the store and resets accounting', async () => {
  const cache = new ChunkCacheL2({ idbFactory: new FakeIDBFactory() });
  await cache.put(URL_A, DS_A, 0, 0, f32(1, 2));
  await cache.clear();
  assert((await cache.get(URL_A, DS_A, 0, 0)) === null, 'entry survived clear()');
  assert(cache.totalBytes === 0, 'totalBytes not reset');
});

console.log('\n━━━ W009: L1 miss → L2 hit avoids the fetch stub ━━━');

await check('single-chunk path (getStreamChunk pattern): L2 hit skips fetch', async () => {
  const factory = new FakeIDBFactory();
  let fetchCalls = 0;
  const fetchStub = async (cr, cc) => {
    fetchCalls++;
    return f32(cr, cc, 42);
  };

  // Mirrors nisar-loader getStreamChunk: L1 Map → L2 IDB → fetch
  const makeSession = (l2) => {
    const pc = createPersistentChunkCache(URL_A, DS_A, l2);
    const l1 = new Map();
    return async (cr, cc) => {
      const key = `${cr},${cc}`;
      if (l1.has(key)) return l1.get(key);
      const cached = await pc.get(cr, cc);
      if (cached) {
        l1.set(key, cached);
        return cached;
      }
      const data = await fetchStub(cr, cc);
      l1.set(key, data);
      pc.put(cr, cc, data).catch(() => {}); // fire-and-forget
      return data;
    };
  };

  // Session 1: cold — must fetch once, L1 absorbs the repeat
  const l2a = new ChunkCacheL2({ idbFactory: factory });
  const getChunkA = makeSession(l2a);
  const first = await getChunkA(3, 7);
  assert(fetchCalls === 1, `cold read should fetch once (got ${fetchCalls})`);
  await getChunkA(3, 7);
  assert(fetchCalls === 1, 'L1 hit should not fetch');
  await l2a.flush(); // let the fire-and-forget put land

  // Session 2 ("page reload"): fresh L1 + fresh ChunkCacheL2, same IDB
  const l2b = new ChunkCacheL2({ idbFactory: factory });
  const getChunkB = makeSession(l2b);
  const out = await getChunkB(3, 7);
  assert(fetchCalls === 1, `L2 hit must avoid the fetch stub (fetch called ${fetchCalls}×)`);
  assert(out[0] === first[0] && out[1] === first[1] && out[2] === first[2], 'L2 data mismatch');
});

await check('batch path (readDataChunksBatch pattern): only L2 misses reach the batch stub', async () => {
  const factory = new FakeIDBFactory();
  const l2 = new ChunkCacheL2({ idbFactory: factory });
  const pc = createPersistentChunkCache(URL_A, DS_A, l2);

  // Pre-populate L2 with 2 of 4 chunks (a previous session)
  await l2.put(URL_A, DS_A, 0, 0, f32(100));
  await l2.put(URL_A, DS_A, 0, 1, f32(101));

  const batchCalls = [];
  const readChunksBatchStub = async (coords) => {
    batchCalls.push(coords.map(([r, c]) => `${r},${c}`));
    return new Map(coords.map(([r, c]) => [`${r},${c}`, f32(r * 10 + c)]));
  };

  // Mirrors nisar-loader readDataChunksBatch: filter through L2, batch the rest
  const l1 = new Map();
  async function readDataChunksBatch(coords) {
    const results = new Map();
    const missing = [];
    await Promise.all(coords.map(async ([cr, cc]) => {
      const cached = await pc.get(cr, cc);
      if (cached) {
        l1.set(`${cr},${cc}`, cached);
        results.set(`${cr},${cc}`, cached);
      } else {
        missing.push([cr, cc]);
      }
    }));
    if (missing.length > 0) {
      const batchMap = await readChunksBatchStub(missing);
      for (const [key, data] of batchMap) {
        l1.set(key, data);
        const [cr, cc] = key.split(',').map(Number);
        pc.put(cr, cc, data).catch(() => {});
        results.set(key, data);
      }
    }
    return results;
  }

  const out = await readDataChunksBatch([[0, 0], [0, 1], [0, 2], [0, 3]]);
  assert(out.size === 4, `expected 4 results, got ${out.size}`);
  assert(batchCalls.length === 1, `expected 1 batch call, got ${batchCalls.length}`);
  assert(batchCalls[0].length === 2, `batch should only see 2 misses, saw ${batchCalls[0].length}`);
  assert(!batchCalls[0].includes('0,0') && !batchCalls[0].includes('0,1'),
    'L2-cached coords leaked into the batch fetch');
  assert(out.get('0,0')[0] === 100 && out.get('0,1')[0] === 101, 'L2 hits returned wrong data');
  assert(out.get('0,2')[0] === 2 && out.get('0,3')[0] === 3, 'fetched chunks returned wrong data');
});

console.log('\n━━━ W009: MERGE_GAP + loader wiring (source checks) ━━━');

await check('h5chunk exports MERGE_GAP = 2 MB', async () => {
  const { MERGE_GAP } = await import(join(rootDir, 'src/loaders/h5chunk.js'));
  assert(MERGE_GAP === 2 * 1024 * 1024, `MERGE_GAP ${MERGE_GAP} != ${2 * 1024 * 1024}`);
});

await check('readChunksBatch merges ranges using the module-level MERGE_GAP', () => {
  const src = readFileSync(join(rootDir, 'src/loaders/h5chunk.js'), 'utf8');
  assert(src.includes('export const MERGE_GAP'), 'MERGE_GAP must be a named module-level export');
  // The merge gap may be overridden per call (mergeGap option, added for strided
  // sampling), but the module constant must remain the default.
  assert(
    /mergeGap\s*\?\?\s*MERGE_GAP/.test(src) || src.includes('current.end + MERGE_GAP'),
    'range merging must default to the module-level MERGE_GAP'
  );
  const defs = (src.match(/const MERGE_GAP\s*=/g) || []).length;
  assert(defs === 1, `MERGE_GAP defined ${defs}× (stale function-local copy shadows the constant)`);
});

await check('default L2 bound is ~200 MB', () => {
  assert(L2_MAX_BYTES === 200 * 1024 * 1024, `L2_MAX_BYTES ${L2_MAX_BYTES} != 200 MB`);
});

await check('nisar-loader wires the IDB cache for URL sources only', () => {
  const src = readFileSync(join(rootDir, 'src/loaders/nisar-loader.js'), 'utf8');
  assert(src.includes("from './chunk-cache-idb.js'"), 'nisar-loader must import chunk-cache-idb.js');
  // Exactly one construction site — inside loadNISARGCOVFromUrl, gated on the URL
  const sites = src.match(/createPersistentChunkCache\(/g) || [];
  assert(sites.length === 1, `expected exactly 1 createPersistentChunkCache call site, found ${sites.length}`);
  assert(/resolvedUrl\s*\?\s*createPersistentChunkCache\(/.test(src),
    'persistent cache must be gated on a resolved URL (skip local File sources)');
  assert(src.includes('async function readDataChunksBatch'),
    'layered batch helper readDataChunksBatch missing');
  // Within the URL loader, every data-chunk batch fetch must flow through the
  // layered helper: the only direct readChunksBatch(selectedDatasetId, ...)
  // call allowed is the one inside readDataChunksBatch itself.
  const urlLoader = src.slice(src.indexOf('export async function loadNISARGCOVFromUrl'));
  const direct = (urlLoader.match(/readChunksBatch\(selectedDatasetId/g) || []).length;
  assert(direct === 1, `URL loader has ${direct} direct data batch fetches (expected 1, inside the helper)`);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
