/**
 * DisturbanceApp — guided ATBD app for CUSUM step-change disturbance mapping.
 *
 * Thin wrapper around `AtbdAppShell`. Disturbance-specific bits:
 *   - Window selector: last 30 / 60 / 90 / 180 / 365 days (default 90). The
 *     window drives the shell's default start date — end date is "today".
 *   - Percentile tunable: sdiffThresholdPercentile (default 80, range 50-99).
 *     Higher pct → fewer pixels flagged as disturbed.
 *   - Policy (atbd-auto-stack ALGORITHM_POLICIES.disturbance): >=3 frames,
 *     no span floor (user-picked window already filters temporally).
 *
 * Both the window (`win`) and the percentile (`pct`) persist to the URL.
 */
import React, { useEffect, useMemo, useState } from 'react';
import AtbdAppShell from '../shared/AtbdAppShell.jsx';
import { readSearchQuery, writeSearchQuery } from '../shared/urlState.js';

const WINDOW_OPTIONS = [30, 60, 90, 180, 365];
const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_PERCENTILE = 80;

function daysAgoISO(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function DisturbanceApp() {
  const initial = readSearchQuery();
  const [windowDays, setWindowDays] = useState(() => {
    const n = Number(initial.win);
    return WINDOW_OPTIONS.includes(n) ? n : DEFAULT_WINDOW_DAYS;
  });
  const [percentile, setPercentile] = useState(() => {
    const n = Number(initial.pct);
    return Number.isFinite(n) && n >= 50 && n <= 99 ? n : DEFAULT_PERCENTILE;
  });

  useEffect(() => {
    writeSearchQuery({
      win: windowDays === DEFAULT_WINDOW_DAYS ? null : String(windowDays),
      pct: percentile === DEFAULT_PERCENTILE ? null : String(percentile),
    });
  }, [windowDays, percentile]);

  const algorithmOpts = useMemo(
    () => ({ sdiffThresholdPercentile: percentile, polarization: 'HHHH' }),
    [percentile],
  );

  // Window control drives the shell's default start-date. Bumping the
  // selector shifts the default, but if the user has already edited the
  // date pickers their value takes precedence (shell reads URL `start`
  // first). useMemo keeps the string identity stable per-windowDays.
  const defaultStartDate = useMemo(() => daysAgoISO(windowDays), [windowDays]);
  const defaultEndDate = useMemo(() => todayISO(), []);

  const algorithmControls = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.85rem', maxWidth: '22rem' }}>
      <label data-testid="disturbance-window-label" style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
        <span>
          Detection window:{' '}
          <code data-testid="disturbance-window-value">{windowDays}d</code>
        </span>
        <select
          data-testid="disturbance-window-select"
          value={windowDays}
          onChange={(e) => setWindowDays(Number(e.target.value))}
          style={{
            background: 'var(--sardine-bg, #0f1419)',
            color: 'var(--sardine-ink, #e0e0e0)',
            border: '1px solid var(--sardine-border, #2a3140)',
            borderRadius: '3px',
            padding: '0.35rem 0.5rem',
            fontFamily: 'monospace',
            fontSize: '0.85rem',
          }}
        >
          {WINDOW_OPTIONS.map((d) => (
            <option key={d} value={d}>last {d} days</option>
          ))}
        </select>
      </label>

      <label data-testid="disturbance-pct-label" style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
        <span>
          Threshold percentile:{' '}
          <code data-testid="disturbance-pct-value">{percentile}</code>
        </span>
        <input
          data-testid="disturbance-pct-slider"
          type="range"
          min={50}
          max={99}
          step={1}
          value={percentile}
          onChange={(e) => setPercentile(Number(e.target.value))}
        />
        <span style={{ fontSize: '0.7rem', color: 'var(--sardine-muted, #9aa5b8)' }}>
          Higher pct → fewer pixels flagged. Default 80.
        </span>
      </label>
    </div>
  );

  return (
    <AtbdAppShell
      algorithm="disturbance"
      testIdPrefix="disturbance"
      title="Disturbance Detection (CUSUM)"
      blurb="NISAR GCOV time-series → cumulative-sum step change at the chosen percentile. Needs >=3 frames inside the detection window."
      compositeId="dual-pol-h"
      defaultStartDate={defaultStartDate}
      defaultEndDate={defaultEndDate}
      polNote="HHHH backscatter. Defaults look back 90 days — widen the window if you don't find a stack."
      algorithmOpts={algorithmOpts}
      algorithmControls={algorithmControls}
      exportFilenamePrefix="disturbance"
    />
  );
}
