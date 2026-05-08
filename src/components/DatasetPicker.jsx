import React, { useMemo } from 'react';

/**
 * Unified dataset picker. Driven entirely off the Dataset[] returned
 * by listDatasets() — works identically for HDF5/NISAR, NITF/SICD,
 * COG/GeoTIFF, and any future loader.
 *
 * Modes:
 *   - "single"  → one dropdown, callback fires `onSelect(datasetId)`
 *   - "rgb"     → three dropdowns (R/G/B), callback fires
 *                 `onSelectRGB({R, G, B})` with the chosen ids
 *
 * If `datasets.length <= 1`, the picker renders nothing — single-
 * dataset files (most COGs, single-image NITFs) auto-load without
 * showing an extra UI step. The parent calls onSelect with the lone
 * id directly.
 *
 * Presets: optional list of `{id, name, slots: {R,G,B}}` where each
 * slot is either a Dataset.id, or a predicate `(d) => boolean` that
 * picks the first matching descriptor (used for things like
 * Pauli/dual-pol where slot assignments depend on what's available).
 */
export function DatasetPicker({
  datasets,
  mode = 'single',
  selectedId,
  selectedRGB,
  onSelect,
  onSelectRGB,
  onModeChange,
  presets = [],
  presetId,
  onPresetChange,
  // Optional grouping function: (dataset) => groupKey. When provided,
  // the dropdown is split into <optgroup>s. NISAR uses this to group
  // by frequency.
  groupBy,
  showRGBToggle = true,
}) {
  // Hooks must run unconditionally — early returns happen below.
  const groups = useMemo(() => {
    if (!groupBy || !datasets) return null;
    const map = new Map();
    for (const d of datasets) {
      const k = groupBy(d) ?? '';
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(d);
    }
    return [...map.entries()];
  }, [datasets, groupBy]);

  // Hide entirely for zero datasets. For one dataset, render a tiny
  // label so the user can confirm what loaded — no dropdown, no clicks.
  if (!datasets || datasets.length === 0) return null;

  const renderOptions = () => {
    if (groups) {
      return groups.map(([key, items]) => (
        <optgroup key={key || '_'} label={key || 'Datasets'}>
          {items.map(d => (
            <option key={d.id} value={d.id}>{d.label}</option>
          ))}
        </optgroup>
      ));
    }
    return datasets.map(d => (
      <option key={d.id} value={d.id}>{d.label}</option>
    ));
  };

  if (datasets.length === 1) {
    const only = datasets[0];
    return (
      <div className="control-group" style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
        {only.label}
        {only.shape?.[0] > 0 && (
          <span style={{ marginLeft: '6px' }}>
            {only.shape[1]}×{only.shape[0]}
            {only.isComplex && ' · complex'}
          </span>
        )}
      </div>
    );
  }

  if (mode === 'rgb') {
    const slots = ['R', 'G', 'B'];
    const labelColor = { R: '#ff6464', G: '#64ff64', B: '#6496ff' };
    return (
      <>
        {showRGBToggle && (
          <div className="control-group">
            <label>Display Mode</label>
            <select value="rgb" onChange={(e) => onModeChange?.(e.target.value)}>
              <option value="single">Single Band</option>
              <option value="rgb">RGB Composite</option>
            </select>
          </div>
        )}
        {presets.length > 0 && (
          <div className="control-group">
            <label>Preset</label>
            <select value={presetId || ''} onChange={(e) => onPresetChange?.(e.target.value || null)}>
              <option value="">Custom…</option>
              {presets.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        )}
        {slots.map(slot => (
          <div key={slot} className="control-group">
            <label style={{ color: labelColor[slot] }}>{slot}</label>
            <select
              value={selectedRGB?.[slot] || ''}
              onChange={(e) => onSelectRGB?.({ ...selectedRGB, [slot]: e.target.value })}
            >
              <option value="">— None —</option>
              {renderOptions()}
            </select>
          </div>
        ))}
      </>
    );
  }

  return (
    <>
      {showRGBToggle && (
        <div className="control-group">
          <label>Display Mode</label>
          <select value="single" onChange={(e) => onModeChange?.(e.target.value)}>
            <option value="single">Single Band</option>
            <option value="rgb">RGB Composite</option>
          </select>
        </div>
      )}
      <div className="control-group">
        <label>Dataset</label>
        <select
          value={selectedId || ''}
          onChange={(e) => onSelect?.(e.target.value)}
        >
          {renderOptions()}
        </select>
      </div>
    </>
  );
}

export default DatasetPicker;
