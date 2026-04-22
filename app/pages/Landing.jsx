/**
 * Landing chooser — grid of cards, one per planned SARdine route.
 *
 * Per S291: `/explore/gcov` is live; other routes show a "coming soon"
 * badge pointing at the directive that delivers them. Styling uses theme
 * variables only (S290 R7 — no per-page overrides).
 */
import React from 'react';
import { Link } from 'wouter';

const ROUTES = [
  {
    href: '/explore/gcov',
    title: 'GCOV Explorer',
    blurb: 'NISAR L2 GCOV HDF5: polarimetric composites, histograms, ROI exports.',
    directive: 'S291',
    live: true,
  },
  {
    href: '/inundation',
    title: 'Inundation ATBD',
    blurb: 'NISAR GCOV stack → open-water / flooded-vegetation / flooded-bare classification.',
    directive: 'S292',
    live: true,
  },
  {
    href: '/crop',
    title: 'Crop Coefficient of Variation',
    blurb: 'Temporal backscatter CV → crop type + phenology signatures.',
    directive: 'S293',
    live: false,
  },
  {
    href: '/disturbance',
    title: 'Disturbance Detection',
    blurb: 'CUSUM step-change detection on NISAR time series.',
    directive: 'S293',
    live: false,
  },
  {
    href: '/explore/gunw',
    title: 'GUNW Explorer',
    blurb: 'NISAR L2 GUNW: interferograms, coherence, unwrapped phase.',
    directive: 'S294',
    live: false,
  },
  {
    href: '/explore/cog',
    title: 'COG Explorer',
    blurb: 'Cloud Optimized GeoTIFF from any URL — single or time-series.',
    directive: 'S295',
    live: false,
  },
  {
    href: '/local',
    title: 'Local File Explorer',
    blurb: 'Drop a .h5 / .tif from your machine; delegates to the right explorer.',
    directive: 'S295',
    live: false,
  },
];

function RouteCard({ href, title, blurb, directive, live }) {
  return (
    <Link href={href}>
      <a
        className="landing-card"
        data-testid={`route-card-${href}`}
        style={{
          display: 'block',
          padding: '1.25rem 1.5rem',
          border: '1px solid var(--sardine-border, #2a3140)',
          borderRadius: '8px',
          background: 'var(--sardine-panel, #151a24)',
          color: 'var(--sardine-ink, #e0e0e0)',
          textDecoration: 'none',
          transition: 'border-color 120ms',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--sardine-cyan, #4ec9d4)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--sardine-border, #2a3140)'; }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
          <span style={{ fontWeight: 600, fontSize: '1rem', color: 'var(--sardine-cyan, #4ec9d4)' }}>{title}</span>
          <span
            style={{
              fontSize: '0.7rem',
              fontFamily: 'monospace',
              padding: '2px 6px',
              borderRadius: '3px',
              background: live ? 'rgba(78, 201, 212, 0.15)' : 'rgba(245, 166, 35, 0.15)',
              color: live ? 'var(--sardine-cyan, #4ec9d4)' : 'var(--sardine-amber, #f5a623)',
            }}
          >
            {live ? 'live' : `soon · ${directive}`}
          </span>
        </div>
        <div style={{ fontSize: '0.85rem', color: 'var(--sardine-muted, #9aa5b8)', lineHeight: 1.45 }}>{blurb}</div>
        <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', fontFamily: 'monospace', color: 'var(--sardine-muted, #9aa5b8)' }}>{href}</div>
      </a>
    </Link>
  );
}

export default function Landing() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--sardine-bg, #0f1419)',
        color: 'var(--sardine-ink, #e0e0e0)',
        fontFamily: 'system-ui, sans-serif',
        padding: '3rem 2rem',
      }}
    >
      <div style={{ maxWidth: '960px', margin: '0 auto' }}>
        <header style={{ marginBottom: '2.5rem' }}>
          <h1
            style={{
              fontSize: '2.2rem',
              fontWeight: 700,
              letterSpacing: '-0.02em',
              margin: 0,
              color: 'var(--sardine-cyan, #4ec9d4)',
            }}
          >
            SARdine
          </h1>
          <p style={{ margin: '0.4rem 0 0', color: 'var(--sardine-muted, #9aa5b8)', fontSize: '1rem' }}>
            SAR Data INspection and Exploration — pick a workflow.
          </p>
        </header>

        <div
          data-testid="landing-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '1rem',
          }}
        >
          {ROUTES.map((r) => (
            <RouteCard key={r.href} {...r} />
          ))}
        </div>
      </div>
    </div>
  );
}
