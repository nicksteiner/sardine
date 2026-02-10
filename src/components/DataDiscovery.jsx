/**
 * DataDiscovery — Paged directory tree browser for S3 / HTTP buckets.
 *
 * Simple panel: enter a bucket URL, browse directories, click .h5/.tif files to load.
 * Paged results with "Load More" for large directories.
 */
import React, { useState, useCallback, useRef, useMemo } from 'react';
import {
  listBucket,
  buildFileUrl,
  displayName,
  formatSize,
  isNISARFile,
  isCOGFile,
  parseNISARFilename,
  extractFilterOptions,
  PRESET_BUCKETS,
  resolvePresetUrl,
} from '../utils/bucket-browser.js';

/**
 * DataDiscovery component — goes inside the controls panel.
 *
 * @param {Object} props
 * @param {function} props.onSelectFile — Called with {url, name, type} when user clicks a file
 * @param {function} [props.onStatus] — Called with (type, message) for status logging
 */
export function DataDiscovery({ onSelectFile, onStatus }) {
  // Bucket URL
  const [bucketUrl, setBucketUrl] = useState('');

  // Current directory state
  const [prefix, setPrefix] = useState('');
  const [directories, setDirectories] = useState([]);
  const [files, setFiles] = useState([]);
  const [isTruncated, setIsTruncated] = useState(false);
  const [nextToken, setNextToken] = useState(null);
  const [totalKeys, setTotalKeys] = useState(0);

  // Navigation breadcrumbs (stack of prefixes)
  const [pathStack, setPathStack] = useState([]);

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  // Filename filters (empty string = show all)
  const [filterCycle, setFilterCycle] = useState('');
  const [filterTrack, setFilterTrack] = useState('');
  const [filterDirection, setFilterDirection] = useState('');
  const [filterPol, setFilterPol] = useState('');
  const [filterFrame, setFilterFrame] = useState('');
  const [filterMode, setFilterMode] = useState('');

  const inputRef = useRef(null);

  const log = useCallback((type, msg) => {
    if (onStatus) onStatus(type, msg);
  }, [onStatus]);

  // ── Connect to bucket ──
  const handleConnect = useCallback(async () => {
    const url = bucketUrl.trim();
    if (!url) return;

    setLoading(true);
    setError(null);
    log('info', `Connecting to: ${url}`);

    try {
      const result = await listBucket(url, { prefix: '', maxKeys: 100 });
      setDirectories(result.directories);
      setFiles(result.files);
      setIsTruncated(result.isTruncated);
      setNextToken(result.nextToken);
      setTotalKeys(result.totalKeys);
      setPrefix('');
      setPathStack([]);
      setConnected(true);
      log('success', `Connected — ${result.directories.length} dirs, ${result.files.length} files`);
    } catch (e) {
      setError(e.message);
      setConnected(false);
      log('error', `Connection failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [bucketUrl, log]);

  // ── Navigate into a directory ──
  const handleNavigate = useCallback(async (dirPrefix) => {
    setLoading(true);
    setError(null);

    try {
      const result = await listBucket(bucketUrl, { prefix: dirPrefix, maxKeys: 100 });
      setDirectories(result.directories);
      setFiles(result.files);
      setIsTruncated(result.isTruncated);
      setNextToken(result.nextToken);
      setTotalKeys(result.totalKeys);
      setPathStack(prev => [...prev, prefix]);
      setPrefix(dirPrefix);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [bucketUrl, prefix]);

  // ── Navigate up ──
  const handleBack = useCallback(async () => {
    if (pathStack.length === 0) return;

    const parentPrefix = pathStack[pathStack.length - 1];
    setLoading(true);
    setError(null);

    try {
      const result = await listBucket(bucketUrl, { prefix: parentPrefix, maxKeys: 100 });
      setDirectories(result.directories);
      setFiles(result.files);
      setIsTruncated(result.isTruncated);
      setNextToken(result.nextToken);
      setTotalKeys(result.totalKeys);
      setPathStack(prev => prev.slice(0, -1));
      setPrefix(parentPrefix);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [bucketUrl, pathStack]);

  // ── Navigate to breadcrumb ──
  const handleBreadcrumb = useCallback(async (targetPrefix, stackIndex) => {
    setLoading(true);
    setError(null);

    try {
      const result = await listBucket(bucketUrl, { prefix: targetPrefix, maxKeys: 100 });
      setDirectories(result.directories);
      setFiles(result.files);
      setIsTruncated(result.isTruncated);
      setNextToken(result.nextToken);
      setTotalKeys(result.totalKeys);
      setPathStack(prev => prev.slice(0, stackIndex));
      setPrefix(targetPrefix);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [bucketUrl]);

  // ── Load more (pagination) ──
  const handleLoadMore = useCallback(async () => {
    if (!nextToken) return;

    setLoading(true);
    setError(null);

    try {
      const result = await listBucket(bucketUrl, {
        prefix,
        maxKeys: 100,
        continuationToken: nextToken,
      });
      // Append new results to existing
      setDirectories(prev => [...prev, ...result.directories]);
      setFiles(prev => [...prev, ...result.files]);
      setIsTruncated(result.isTruncated);
      setNextToken(result.nextToken);
      setTotalKeys(prev => prev + result.totalKeys);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [bucketUrl, prefix, nextToken]);

  // ── Select a file for loading ──
  const handleFileClick = useCallback((file) => {
    const url = buildFileUrl(bucketUrl, file.key);
    const name = displayName(file.key);

    let type = 'unknown';
    if (isNISARFile(file.key)) type = 'nisar';
    else if (isCOGFile(file.key)) type = 'cog';

    log('info', `Selected: ${name} (${formatSize(file.size)})`);
    onSelectFile({ url, name, size: file.size, type, key: file.key });
  }, [bucketUrl, onSelectFile, log]);

  // ── Apply a preset ──
  const handlePreset = useCallback((preset) => {
    setBucketUrl(resolvePresetUrl(preset.url));
    setConnected(false);
    setDirectories([]);
    setFiles([]);
    setPathStack([]);
    setPrefix('');
  }, []);

  // ── Disconnect ──
  const handleDisconnect = useCallback(() => {
    setConnected(false);
    setDirectories([]);
    setFiles([]);
    setPathStack([]);
    setPrefix('');
    setNextToken(null);
    setError(null);
  }, []);

  // Parse all NISAR filenames in the current listing
  const parsedMap = useMemo(() => {
    const map = new Map();
    for (const f of files) {
      if (isNISARFile(f.key)) {
        const parsed = parseNISARFilename(displayName(f.key));
        if (parsed) map.set(f.key, parsed);
      }
    }
    return map;
  }, [files]);

  // Extract available filter options from parsed filenames
  const filterOptions = useMemo(() => {
    const parsed = [...parsedMap.values()];
    if (parsed.length === 0) return null;
    return extractFilterOptions(parsed);
  }, [parsedMap]);

  // Apply filters to the file list
  const filteredFiles = useMemo(() => {
    const hasFilter = filterCycle || filterTrack || filterDirection || filterPol || filterFrame || filterMode;
    if (!hasFilter) return files;

    return files.filter(f => {
      const p = parsedMap.get(f.key);
      // Non-NISAR files always pass through
      if (!p) return true;
      if (filterCycle     && p.cycle     !== parseInt(filterCycle))   return false;
      if (filterTrack     && p.track     !== parseInt(filterTrack))   return false;
      if (filterDirection && p.direction !== filterDirection)          return false;
      if (filterPol       && p.polCode   !== filterPol)               return false;
      if (filterFrame     && p.frame     !== parseInt(filterFrame))   return false;
      if (filterMode      && p.mode      !== filterMode)              return false;
      return true;
    });
  }, [files, parsedMap, filterCycle, filterTrack, filterDirection, filterPol, filterFrame, filterMode]);

  // Count active filters
  const activeFilterCount = [filterCycle, filterTrack, filterDirection, filterPol, filterFrame, filterMode]
    .filter(Boolean).length;

  // Reset all filters
  const resetFilters = useCallback(() => {
    setFilterCycle('');
    setFilterTrack('');
    setFilterDirection('');
    setFilterPol('');
    setFilterFrame('');
    setFilterMode('');
  }, []);

  // Build breadcrumb segments
  const breadcrumbs = [];
  if (connected) {
    breadcrumbs.push({ label: '/', prefix: '', index: 0 });
    if (prefix) {
      const parts = prefix.replace(/\/$/, '').split('/');
      let cumulative = '';
      parts.forEach((part, i) => {
        cumulative += part + '/';
        breadcrumbs.push({ label: part, prefix: cumulative, index: i + 1 });
      });
    }
  }

  return (
    <div className="data-discovery">
      {/* URL input + presets */}
      {!connected ? (
        <>
          <div className="control-group">
            <label>Bucket / Endpoint URL</label>
            <input
              ref={inputRef}
              type="text"
              value={bucketUrl}
              onChange={(e) => setBucketUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
              placeholder="https://bucket.s3.amazonaws.com"
              style={{ fontSize: '0.75rem' }}
            />
          </div>

          {PRESET_BUCKETS.length > 0 && (
            <div className="control-group" style={{ fontSize: '0.7rem' }}>
              <label style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Presets</label>
              {PRESET_BUCKETS.map((p, i) => (
                <button
                  key={i}
                  className="btn-secondary discovery-preset-btn"
                  onClick={() => handlePreset(p)}
                  title={p.description}
                >
                  {p.label}
                  {p.requiresAuth && <span className="discovery-auth-badge">🔒</span>}
                </button>
              ))}
            </div>
          )}

          <button onClick={handleConnect} disabled={loading || !bucketUrl.trim()}>
            {loading ? 'Connecting...' : 'Connect'}
          </button>
        </>
      ) : (
        <>
          {/* Connected header */}
          <div className="discovery-header">
            <span className="discovery-url" title={bucketUrl}>
              {bucketUrl.replace(/^https?:\/\//, '').substring(0, 30)}
              {bucketUrl.length > 38 ? '…' : ''}
            </span>
            <button
              className="btn-secondary discovery-disconnect-btn"
              onClick={handleDisconnect}
              title="Disconnect"
            >✕</button>
          </div>

          {/* Breadcrumbs */}
          <div className="discovery-breadcrumbs">
            {breadcrumbs.map((b, i) => (
              <span key={i}>
                {i > 0 && <span className="discovery-sep">›</span>}
                <button
                  className="discovery-crumb"
                  onClick={() => handleBreadcrumb(b.prefix, b.index)}
                  disabled={b.prefix === prefix}
                >
                  {b.label}
                </button>
              </span>
            ))}
          </div>

          {/* Filter bar (only when NISAR files are present) */}
          {filterOptions && (
            <div className="discovery-filter-bar">
              <button
                className={`discovery-filter-toggle ${showFilters ? 'active' : ''}`}
                onClick={() => setShowFilters(v => !v)}
              >
                <span>⚙ Filter</span>
                {activeFilterCount > 0 && (
                  <span className="discovery-filter-badge">{activeFilterCount}</span>
                )}
              </button>
              {activeFilterCount > 0 && (
                <button className="discovery-filter-reset" onClick={resetFilters}>Clear</button>
              )}
            </div>
          )}

          {/* Filter dropdowns */}
          {showFilters && filterOptions && (
            <div className="discovery-filters">
              {/* Cycle */}
              {filterOptions.cycles.length > 1 && (
                <div className="discovery-filter-group">
                  <label>Cycle</label>
                  <select value={filterCycle} onChange={e => setFilterCycle(e.target.value)}>
                    <option value="">All ({filterOptions.cycles.length})</option>
                    {filterOptions.cycles.map(c => (
                      <option key={c} value={c}>{String(c).padStart(3, '0')}</option>
                    ))}
                  </select>
                </div>
              )}
              {/* Track */}
              {filterOptions.tracks.length > 1 && (
                <div className="discovery-filter-group">
                  <label>Track</label>
                  <select value={filterTrack} onChange={e => setFilterTrack(e.target.value)}>
                    <option value="">All ({filterOptions.tracks.length})</option>
                    {filterOptions.tracks.map(t => (
                      <option key={t} value={t}>{String(t).padStart(3, '0')}</option>
                    ))}
                  </select>
                </div>
              )}
              {/* Direction */}
              {filterOptions.directions.length > 1 && (
                <div className="discovery-filter-group">
                  <label>Dir</label>
                  <select value={filterDirection} onChange={e => setFilterDirection(e.target.value)}>
                    <option value="">All</option>
                    {filterOptions.directions.map(d => (
                      <option key={d} value={d}>{d === 'A' ? 'Asc' : 'Desc'}</option>
                    ))}
                  </select>
                </div>
              )}
              {/* Polarization */}
              {filterOptions.polCodes.length > 1 && (
                <div className="discovery-filter-group">
                  <label>Pol</label>
                  <select value={filterPol} onChange={e => setFilterPol(e.target.value)}>
                    <option value="">All ({filterOptions.polCodes.length})</option>
                    {filterOptions.polCodes.map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>
              )}
              {/* Frame */}
              {filterOptions.frames.length > 1 && (
                <div className="discovery-filter-group">
                  <label>Frame</label>
                  <select value={filterFrame} onChange={e => setFilterFrame(e.target.value)}>
                    <option value="">All ({filterOptions.frames.length})</option>
                    {filterOptions.frames.map(f => (
                      <option key={f} value={f}>{String(f).padStart(3, '0')}</option>
                    ))}
                  </select>
                </div>
              )}
              {/* Mode */}
              {filterOptions.modes.length > 1 && (
                <div className="discovery-filter-group">
                  <label>Mode</label>
                  <select value={filterMode} onChange={e => setFilterMode(e.target.value)}>
                    <option value="">All ({filterOptions.modes.length})</option>
                    {filterOptions.modes.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* Directory listing */}
          <div className="discovery-listing">
            {/* Back button */}
            {pathStack.length > 0 && (
              <div className="discovery-item discovery-dir" onClick={handleBack}>
                <span className="discovery-icon">⬆</span>
                <span className="discovery-name">..</span>
              </div>
            )}

            {/* Directories */}
            {directories.map((dir, i) => (
              <div
                key={`d-${i}`}
                className="discovery-item discovery-dir"
                onClick={() => handleNavigate(dir)}
              >
                <span className="discovery-icon">📁</span>
                <span className="discovery-name">{displayName(dir)}</span>
              </div>
            ))}

            {/* Files (filtered) */}
            {filteredFiles.map((file, i) => {
              const name = displayName(file.key);
              const isNisar = isNISARFile(file.key);
              const isCog = isCOGFile(file.key);
              const isLoadable = isNisar || isCog;
              const parsed = parsedMap.get(file.key);

              return (
                <div
                  key={`f-${i}`}
                  className={`discovery-item discovery-file ${isLoadable ? 'discovery-loadable' : ''} ${isNisar ? 'discovery-nisar' : ''}`}
                  onClick={isLoadable ? () => handleFileClick(file) : undefined}
                  title={
                    parsed
                      ? `Cyc ${parsed.cycle} · Trk ${parsed.track} · ${parsed.directionName} · Frm ${parsed.frame} · ${parsed.polCode}\n${parsed.startStr} → ${parsed.endStr}\nClick to load`
                      : (isLoadable ? `Click to load: ${name}` : name)
                  }
                >
                  <span className="discovery-icon">
                    {isNisar ? '🛰️' : isCog ? '🗺️' : '📄'}
                  </span>
                  <span className="discovery-name">{name}</span>
                  <span className="discovery-size">{formatSize(file.size)}</span>
                </div>
              );
            })}

            {/* Empty state */}
            {directories.length === 0 && filteredFiles.length === 0 && !loading && (
              <div className="discovery-empty">
                {files.length > 0 && activeFilterCount > 0
                  ? `No files match filters (${files.length} hidden)`
                  : 'Empty directory'}
              </div>
            )}

            {/* Loading indicator */}
            {loading && (
              <div className="discovery-loading">Loading…</div>
            )}
          </div>

          {/* Pagination */}
          {isTruncated && (
            <button
              className="btn-secondary"
              onClick={handleLoadMore}
              disabled={loading}
              style={{ width: '100%', marginTop: '4px', fontSize: '0.7rem' }}
            >
              {loading ? 'Loading...' : `Load More (${directories.length + files.length} shown)`}
            </button>
          )}

          {/* Count */}
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '2px', textAlign: 'right' }}>
            {directories.length} dirs · {filteredFiles.length}{filteredFiles.length !== files.length ? `/${files.length}` : ''} files
            {isTruncated && ' (truncated)'}
          </div>
        </>
      )}

      {/* Error display */}
      {error && (
        <div className="discovery-error">{error}</div>
      )}
    </div>
  );
}
