/**
 * CropApp — guided ATBD app for temporal-CV cropland masking.
 *
 * Thin wrapper around `AtbdAppShell`. Crop-specific bits:
 *   - Default date range: last 120 days (phenological cycle window).
 *   - Single tunable: CV threshold τ (default 0.25). Above τ → cropland.
 *   - Policy (atbd-auto-stack ALGORITHM_POLICIES.crop): >=6 frames, >=60d span.
 *
 * The slider persists to `?cv=` in the URL so deep-links round-trip.
 */
import React, { useEffect, useMemo, useState } from 'react';
import AtbdAppShell from '../shared/AtbdAppShell.jsx';
import { readSearchQuery, writeSearchQuery } from '../shared/urlState.js';

const DEFAULT_CV_THRESHOLD = 0.25;
const CROP_WINDOW_DAYS = 120;

function daysAgoISO(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function CropApp() {
  const initial = readSearchQuery();
  const [cvThreshold, setCvThreshold] = useState(() => {
    const n = Number(initial.cv);
    return Number.isFinite(n) && n >= 0.1 && n <= 1.0 ? n : DEFAULT_CV_THRESHOLD;
  });

  useEffect(() => {
    writeSearchQuery({ cv: cvThreshold === DEFAULT_CV_THRESHOLD ? null : cvThreshold.toFixed(2) });
  }, [cvThreshold]);

  // Stable opts — polarization pinned to HHHH since the runner picks the first
  // pol key otherwise (non-deterministic across composite bands).
  const algorithmOpts = useMemo(
    () => ({ cvThreshold, polarization: 'HHHH' }),
    [cvThreshold],
  );

  // Computed once on mount — default date range is "last 120 days ending today".
  // Kept in refs via useMemo so the shell sees stable strings.
  const defaultStartDate = useMemo(() => daysAgoISO(CROP_WINDOW_DAYS), []);
  const defaultEndDate = useMemo(() => todayISO(), []);

  const algorithmControls = (
    <label
      data-testid="crop-cv-label"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.3rem',
        fontSize: '0.85rem',
        maxWidth: '22rem',
      }}
    >
      <span>
        CV threshold:{' '}
        <code data-testid="crop-cv-value">{cvThreshold.toFixed(2)}</code>
      </span>
      <input
        data-testid="crop-cv-slider"
        type="range"
        min={0.1}
        max={1.0}
        step={0.01}
        value={cvThreshold}
        onChange={(e) => setCvThreshold(Number(e.target.value))}
      />
      <span style={{ fontSize: '0.7rem', color: 'var(--sardine-muted, #9aa5b8)' }}>
        Higher τ → fewer pixels marked as cropland. Default 0.25.
      </span>
    </label>
  );

  return (
    <AtbdAppShell
      algorithm="crop"
      testIdPrefix="crop"
      title="Crop Coefficient of Variation"
      blurb={`NISAR GCOV time-series → temporal backscatter CV → cropland mask at the chosen τ. Needs >=6 frames over >=${CROP_WINDOW_DAYS / 2}+ days for a meaningful phenology signal.`}
      compositeId="dual-pol-h"
      defaultStartDate={defaultStartDate}
      defaultEndDate={defaultEndDate}
      polNote="HHHH backscatter. Dual-pol NISAR granules (DHDH) are the common case; any HH-containing stack works."
      algorithmOpts={algorithmOpts}
      algorithmControls={algorithmControls}
      exportFilenamePrefix="crop"
    />
  );
}
