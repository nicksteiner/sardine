# W006 — Web Worker pool for chunk decompression

wave: 1
status: branch-ready (commit 40fe086, stacked on W003 9b4f090)
blocked_by: [W003]
branch: w006-decode-workers

## Findings (from implementation)

- Premise was stale: an inline worker pool already existed in h5chunk.js (commit
  `bcc428f`) — but with real defects this order fixed: eager spawn at startup, and
  **silent all-zero Float32 decode when `Worker` is undefined** (Node/older browsers;
  the reason W003's tests forced `useWorkerPool=false`). Fallback is now bit-exact via
  shared `decode-core.js`, unit-verified including NaN/±0/Inf.
- The deflate→shuffle+deflate retry heuristic was silently lost on the old worker path
  (buffer detached after transfer); retry now travels with the job.
- pako throws plain strings — normalized to Errors in `inflateSync`.
- Order preservation: results Map pre-seeded in request order (tested with scrambled
  completion). Build emits `dist/assets/decode-worker-*.js`. 22 new checks; full suite
  259+5+22 green. Manual remote-streaming check deferred to PR checklist (headless env).

## Objective

pako inflate + shuffle runs serially on the main thread (7–17 ms/chunk) and is the real
streaming bottleneck — it blocks pan/zoom frames. Move decompress+unshuffle into a pool
of 2–4 Web Workers with transferable ArrayBuffers.

## Scope

- New `src/loaders/decode-worker.js` (worker script: receives {compressedBuffer,
  filters, dtype, dims}, returns decoded Float32Array buffer, transferred) and
  `src/loaders/decode-pool.js` (pool manager: `decode(job) -> Promise`, round-robin,
  lazy spawn, `navigator.hardwareConcurrency`-capped at 4, graceful fallback to
  synchronous main-thread decode when Workers unavailable — Node test env, older
  browsers).
- Wire into `src/loaders/h5chunk.js` chunk decode path (`readChunk`/`readChunksBatch`
  post-fetch decompression). The decode step must remain awaitable per chunk; batch
  order must be preserved.
- Vite: worker must build under `npm run build` (use `new Worker(new URL('./decode-worker.js', import.meta.url), {type:'module'})` — Vite's supported pattern).

## Out of scope

- No OffscreenCanvas/render workers. No WASM codec swap. No h5chunk metadata parsing
  in workers.

## Acceptance criteria

- `npm test` + `npm run build` pass (build emits the worker chunk).
- Node fallback path unit-tested: pool with Workers unavailable decodes identically to
  pako inline (bit-exact on a synthetic deflate+shuffle buffer).
- Manual check documented in PR: streaming a remote NISAR file still renders (no
  regression in `npm run dev`).
