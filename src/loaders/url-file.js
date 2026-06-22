/**
 * Minimal `File`-shaped adapter backed by HTTP Range requests.
 *
 * Implements the subset of the Blob/File interface used by the loaders:
 *   - .name, .size
 *   - .slice(start, end) → returns a sub-blob whose .arrayBuffer() reads
 *     exactly that byte range from the server.
 *
 * Use this anywhere a loader takes a `File` and you want to back it with
 * a remote URL instead. Example:
 *
 *   const urlFile = await URLFile.open(url);
 *   const data = await loadNITF(urlFile, onProgress);
 *
 * Pre-rewrite URLs through the CORS proxy *before* calling URLFile.open()
 * — the adapter itself is dumb about CORS; it just fetches whatever URL
 * you give it.
 */

class URLBlob {
  constructor(url, start, end, fetchHeaders) {
    this._url = url;
    this._start = start;
    this._end = end; // exclusive
    this._fetchHeaders = fetchHeaders || null;
  }

  get size() { return Math.max(0, this._end - this._start); }

  async arrayBuffer() {
    const total = this.size;
    if (total === 0) return new ArrayBuffer(0);

    // Single Range request for small reads. AWS S3 will serve a 5 GB body in
    // one shot but browsers (and intermediate proxies) often choke past a few
    // hundred MB — the response stream stalls or gets silently truncated. So
    // for anything larger than CHUNK_BYTES, split into back-to-back ranges
    // and reassemble. Sequential keeps us within S3 per-connection bandwidth
    // limits and avoids the request-coalescing-headache of parallel ranges
    // through the dev CORS proxy.
    const CHUNK_BYTES = 64 * 1024 * 1024; // 64 MB
    if (total <= CHUNK_BYTES) {
      return this._fetchRange(this._start, this._end);
    }

    const out = new Uint8Array(total);
    let written = 0;
    for (let off = this._start; off < this._end; off += CHUNK_BYTES) {
      const chunkEnd = Math.min(off + CHUNK_BYTES, this._end);
      const buf = await this._fetchRange(off, chunkEnd);
      const view = new Uint8Array(buf);
      out.set(view, written);
      written += view.byteLength;
      if (view.byteLength !== chunkEnd - off) {
        throw new Error(`URLFile: short read at offset ${off}: got ${view.byteLength} of ${chunkEnd - off} bytes`);
      }
    }
    return out.buffer;
  }

  async _fetchRange(start, end) {
    const headers = { ...(this._fetchHeaders || {}) };
    // HTTP Range is inclusive on both ends.
    headers['Range'] = `bytes=${start}-${end - 1}`;
    const resp = await fetch(this._url, { headers });
    if (!resp.ok && resp.status !== 206) {
      throw new Error(`URLFile range fetch failed: ${resp.status} ${resp.statusText} for ${this._url}`);
    }
    return resp.arrayBuffer();
  }
}

export class URLFile {
  constructor(url, size, { name, fetchHeaders } = {}) {
    this._url = url;
    this.size = size;
    this.name = name || (() => {
      try { return new URL(url).pathname.split('/').pop() || 'remote-file'; }
      catch { return 'remote-file'; }
    })();
    this._fetchHeaders = fetchHeaders || null;
  }

  /**
   * Open a URL as a File-like adapter and learn the total size.
   *
   * Tries HEAD first. Many real-world hosts (CloudFront, some S3 presigned
   * URLs, dev CORS proxies) reject HEAD or omit Content-Length on it while
   * still serving Range GETs — so we fall back to a single-byte
   * `Range: bytes=0-0` GET and parse the total length out of the
   * `Content-Range: bytes 0-0/<total>` response header. This is the same
   * trick geotiff.js uses to size remote COGs.
   */
  static async open(url, { fetchHeaders } = {}) {
    const headers = fetchHeaders || {};

    // 1. HEAD — cheapest path when the host cooperates.
    let acceptRangesNone = false;
    try {
      const head = await fetch(url, { method: 'HEAD', headers });
      if (head.ok) {
        const ar = head.headers.get('accept-ranges');
        if (ar && ar.toLowerCase() === 'none') acceptRangesNone = true;
        const cl = head.headers.get('content-length');
        const size = cl == null ? NaN : parseInt(cl, 10);
        if (!acceptRangesNone && Number.isFinite(size) && size > 0) {
          return new URLFile(url, size, { fetchHeaders });
        }
      }
    } catch (_) {
      // HEAD blocked by CORS or network — fall through to the Range probe.
    }
    if (acceptRangesNone) {
      throw new Error(`URLFile.open: server does not support Range requests (${url})`);
    }

    // 2. Range probe — GET one byte and read the total from Content-Range.
    const probe = await fetch(url, { headers: { ...headers, Range: 'bytes=0-0' } });
    if (!probe.ok && probe.status !== 206) {
      throw new Error(`URLFile.open: HEAD gave no size and Range probe failed: ${probe.status} ${probe.statusText} for ${url}`);
    }
    const contentRange = probe.headers.get('content-range'); // "bytes 0-0/12345"
    if (contentRange) {
      const m = /\/(\d+)\s*$/.exec(contentRange);
      const size = m ? parseInt(m[1], 10) : NaN;
      if (Number.isFinite(size) && size > 0) {
        return new URLFile(url, size, { fetchHeaders });
      }
    }
    // A 200 (not 206) to a Range request means the server ignored Range and
    // would stream the whole body — unusable for chunked reads.
    if (probe.status === 200) {
      throw new Error(`URLFile.open: server ignored Range request (returned 200, not 206) for ${url}`);
    }
    throw new Error(`URLFile.open: could not determine size (no Content-Length, no Content-Range) for ${url}`);
  }

  slice(start, end) {
    // Math.floor, NOT `| 0` — bitwise ops coerce to 32-bit signed int and
    // wrap negative past 2 GB, which is exactly the multi-GB regime (SAR
    // SLC/SICD, 5 GB S3 bodies) this adapter exists to serve.
    const s = Math.max(0, Math.min(this.size, Math.floor(start)));
    const e = Math.max(s, Math.min(this.size, end == null ? this.size : Math.floor(end)));
    return new URLBlob(this._url, s, e, this._fetchHeaders);
  }

  // arrayBuffer() on the whole "file" is intentionally not implemented —
  // pulling multi-GB files into memory defeats the point. Loaders should
  // always use .slice().
}
