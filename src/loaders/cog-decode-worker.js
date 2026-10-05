/**
 * cog-decode-worker.js — Web Worker entry for the COG tile decoder pool.
 *
 * Re-exports @developmentseed/geotiff's built-in worker so Vite can bundle it
 * through the usual `new Worker(new URL('./cog-decode-worker.js',
 * import.meta.url), { type: 'module' })` pattern (see cog-tile-reader.js).
 * The package's own `defaultDecoderPool()` resolves its worker relative to
 * node_modules, which the dev-server pre-bundler does not follow.
 */
import '@developmentseed/geotiff/pool/worker';
