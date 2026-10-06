/**
 * scene-brief.js — "Copy scene for agent": the push half of W018.
 *
 * The agent bridge lets an agent *pull* the view (get_view_state +
 * screenshot). This is the same payload for the other direction: a user
 * copies the scene and pastes it into any chat. The clipboard gets a PNG of
 * the canvas plus a Markdown brief carrying the grounding, so the physical
 * frame and the view's unresolvable questions travel with the picture.
 *
 * Secrets never travel: URLs are reduced to origin + path, which drops
 * presigned credentials and Earthdata tokens (same rule as deep links).
 */

import { buildGrounding } from './sar-grounding.js';

/** Strip query/fragment from a URL so presign credentials never leave. */
export function redactSource(src) {
  if (!src || typeof src !== 'string') return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) return src; // local filename
  try {
    const u = new URL(src);
    return `${u.origin}${u.pathname}`;
  } catch (_) {
    return src.split(/[?#]/)[0];
  }
}

const fmt = (v, digits = 4) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : null);

const isGeographic = (crs) => /^EPSG:4326$|^OGC:CRS84$/i.test(String(crs || 'EPSG:4326'));

/** Loaders report spacing as a number, {x, y}, or a preformatted string. */
function formatSpacing(ps, crs) {
  if (ps == null) return null;
  if (typeof ps === 'string') return ps;
  const unit = isGeographic(crs) ? '°' : ' m';
  // Three significant figures: 9.994373 → 9.99, 0.000277778 → 0.000278.
  const sig = (v) => Number(v.toPrecision(3));
  if (typeof ps === 'number') return `${sig(ps)}${unit}`;
  if (Number.isFinite(ps.x) && Number.isFinite(ps.y)) {
    const [x, y] = [sig(ps.x), sig(ps.y)];
    return x === y ? `${x}${unit}` : `${x}${unit} × ${y}${unit} (x × y)`;
  }
  return null;
}

/** Colormap band: a value range recoloured over the base render. */
function formatColormapBand(band, isDb) {
  if (!band || !Number.isFinite(band.min) || !Number.isFinite(band.max)) return null;
  const u = isDb ? ' dB' : '';
  return `values ${band.min}${u} to ${band.max}${u} are highlighted with the ${band.colormap || 'band'} colormap${band.reverse ? ' (reversed)' : ''}; everything else uses the base colormap. The colour is a user-chosen value range, not a classification.`;
}

/**
 * Format the scene brief as Markdown.
 *
 * @param {object} p
 * @param {object} p.render     - serializeViewerState() output
 * @param {object} [p.imageData] - loader output (for grounding)
 * @param {object} [p.bounds]   - {minLon, minLat, maxLon, maxLat}
 * @param {object} [p.image]    - {width, height} of the attached screenshot
 * @returns {string}
 */
export function formatSceneBrief({ render = {}, imageData = {}, bounds = null, image = null } = {}) {
  const g = buildGrounding(imageData, render);
  const a = g.acquisition;
  const m = g.measurement;
  const lines = [];

  lines.push('# SAR scene from SARdine');
  lines.push('');
  lines.push('The image is a rendered SAR view. Read it with the physical context below — it is radar backscatter, not an optical photo.');
  lines.push('');

  lines.push('## Scene');
  const source = redactSource(render.filename);
  if (source) lines.push(`- Source: \`${source}\``);
  if (a.platform || a.productLevel) lines.push(`- Product: ${[a.platform, a.productLevel].filter(Boolean).join(' ')}`);
  if (a.acquisitionStart) lines.push(`- Acquired: ${a.acquisitionStart}`);
  if (a.radarBand) lines.push(`- Band: ${a.radarBand}${a.wavelengthCm ? ` (~${a.wavelengthCm} cm)` : ''}${a.canopyPenetration ? `, canopy penetration: ${a.canopyPenetration}` : ''}`);
  if (a.polarization) lines.push(`- Polarization: ${a.polarization}${a.polarizationNote ? ` — ${a.polarizationNote}` : ''}`);
  if (a.lookDirection || a.orbitPass) lines.push(`- Geometry: ${[a.orbitPass && `${a.orbitPass} pass`, a.lookDirection && `${a.lookDirection}-looking`].filter(Boolean).join(', ')}`);
  if (bounds) {
    lines.push(`- Product extent (WGS84, whole file — not the visible view): lon ${fmt(bounds.minLon)} to ${fmt(bounds.maxLon)}, lat ${fmt(bounds.minLat)} to ${fmt(bounds.maxLat)}`);
  }
  if (Array.isArray(render.viewCenter)) {
    // The viewer runs in the product's CRS, so the centre is in its map units.
    const units = isGeographic(m.crs) ? 'lon, lat' : `${m.crs} map units`;
    lines.push(`- View center (${units}): [${render.viewCenter.map(v => fmt(v)).join(', ')}]`);
  }
  if (image) lines.push(`- Image: ${image.width}×${image.height} px viewer screenshot (left of this panel)`);
  lines.push('');

  lines.push('## What the pixels are');
  lines.push(`- Quantity: ${m.quantity}${m.units === 'dB' ? ' (dB)' : ''}`);
  const spacing = formatSpacing(m.pixelSpacing, m.crs);
  if (spacing) lines.push(`- Pixel spacing: ${spacing}`);
  if (m.crs) lines.push(`- CRS: ${m.crs}`);
  const renderBits = [
    m.displayMode && `mode ${m.displayMode}`,
    m.compositeId && `composite ${m.compositeId}`,
    m.colormap && `colormap ${m.colormap}`,
    m.stretchMode && `stretch ${m.stretchMode}`,
    m.multiLook ? `multilook ${m.multiLook}` : 'no multilook',
    `speckle filter ${m.speckleFilter}`,
  ].filter(Boolean);
  lines.push(`- Rendering: ${renderBits.join(', ')}`);
  const band = formatColormapBand(render.colormapBand, m.units === 'dB');
  if (band) lines.push(`- Colormap band: ${band}`);
  lines.push(`- Display range: ${m.displayRangeNote}`);
  lines.push('');

  lines.push('## Terrain');
  lines.push(`- ${g.terrain.note}`);
  if (g.terrain.terrainMaskAvailable) {
    lines.push(`- Layover/shadow mask: available, ${g.terrain.terrainMaskApplied ? 'applied' : 'NOT applied'}`);
  }
  if (g.terrain.zeroMeansNoIllumination) lines.push('- Zero-valued pixels mean no illumination (shadow/layover).');
  lines.push('');

  if (g.ambiguities.length) {
    lines.push('## What this view cannot settle');
    for (const amb of g.ambiguities) {
      lines.push(`- **${amb.question}** ${amb.why}`);
      if (amb.resolveWith?.length) lines.push(`  - Resolve with: ${amb.resolveWith.join('; ')}`);
    }
    lines.push('');
  }

  lines.push('## How to interpret');
  // The contract names the JSON field; point at this brief's heading instead.
  for (const rule of g.interpretationContract.rules) {
    lines.push(`- ${rule.replace('`ambiguities`', '"What this view cannot settle"')}`);
  }

  return lines.join('\n');
}

/**
 * Wrap the Markdown brief into styled, width-bounded lines for a canvas.
 * Markdown markers are stripped; headings and bold lead-ins keep weight.
 * Pure given a `measure(text, font) → width` function, so it is testable.
 */
export function layoutBrief(markdown, width, measure, { size = 14 } = {}) {
  const fonts = {
    h1: `bold ${size + 6}px system-ui, sans-serif`,
    h2: `bold ${size + 1}px system-ui, sans-serif`,
    body: `${size}px system-ui, sans-serif`,
  };
  const out = [];
  for (const raw of markdown.split('\n')) {
    if (!raw.trim()) { out.push({ text: '', font: fonts.body, gap: true, size }); continue; }
    let kind = 'body';
    let text = raw;
    let indent = 0;
    if (text.startsWith('# ')) { kind = 'h1'; text = text.slice(2); }
    else if (text.startsWith('## ')) { kind = 'h2'; text = text.slice(3); }
    else if (/^\s+- /.test(text)) { indent = 32; text = '– ' + text.trim().slice(2); }
    else if (text.startsWith('- ')) { indent = 12; text = '• ' + text.slice(2); }
    text = text.replace(/\*\*|`/g, '');
    const font = fonts[kind];
    const lineSize = kind === 'h1' ? size + 6 : kind === 'h2' ? size + 1 : size;
    // Wrapped bullet lines hang 12 px in, past the bullet glyph.
    const hang = indent ? 12 : 0;
    let line = '';
    let first = true;
    for (const word of text.split(' ')) {
      const trial = line ? `${line} ${word}` : word;
      const avail = width - indent - (first ? 0 : hang);
      if (line && measure(trial, font) > avail) {
        out.push({ text: line, font, indent: first ? indent : indent + hang, size: lineSize, heading: kind !== 'body' });
        line = word;
        first = false;
      } else {
        line = trial;
      }
    }
    if (line) out.push({ text: line, font, indent: first ? indent : indent + hang, size: lineSize, heading: kind !== 'body' });
  }
  return out;
}

/**
 * Compose one PNG-ready canvas: the viewer screenshot with the brief burned
 * into a side panel. One paste then carries both, in any chat app — many
 * keep only the image when the clipboard offers image + text.
 *
 * @param {HTMLCanvasElement} source - the live viewer canvas
 * @param {string} markdown
 * @param {object} [opts] - {maxDim=1024, panelWidth=620}
 * @returns {HTMLCanvasElement}
 */
export function composeSceneCard(source, markdown, { maxDim = 1024, panelWidth = 620 } = {}) {
  const scale = Math.min(1, maxDim / Math.max(source.width, source.height));
  const iw = Math.max(1, Math.round(source.width * scale));
  const ih = Math.max(1, Math.round(source.height * scale));
  const pad = 20;

  const out = document.createElement('canvas');
  const ctx = out.getContext('2d');
  const measure = (t, f) => { ctx.font = f; return ctx.measureText(t).width; };
  const lines = layoutBrief(markdown, panelWidth - 2 * pad, measure);
  const lineH = (l) => (l.gap ? l.size * 0.6 : Math.round(l.size * 1.4));
  const textH = lines.reduce((h, l) => h + lineH(l), 0) + 2 * pad;

  out.width = iw + panelWidth;
  out.height = Math.max(ih, textH);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, iw, out.height);
  ctx.drawImage(source, 0, 0, iw, ih);
  ctx.fillStyle = '#16181d';
  ctx.fillRect(iw, 0, panelWidth, out.height);

  ctx.textBaseline = 'top';
  let y = pad;
  for (const l of lines) {
    if (!l.gap) {
      ctx.font = l.font;
      ctx.fillStyle = l.heading ? '#ffffff' : '#d6d9e0';
      ctx.fillText(l.text, iw + pad + (l.indent || 0), y);
    }
    y += lineH(l);
  }
  return out;
}

/**
 * Put the scene on the clipboard: PNG + Markdown in one ClipboardItem when
 * the browser supports it, text only otherwise.
 *
 * Must be called from a user gesture, and with no await before it: the PNG
 * is taken as a Promise so the ClipboardItem is built synchronously inside
 * the gesture (Safari rejects clipboard writes made after an await).
 *
 * @param {Promise<Blob>|null} pngBlob
 * @param {string} text
 * @returns {Promise<'image+text'|'text'>}
 */
export async function writeSceneToClipboard(pngBlob, text) {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : null;
  if (!clip) throw new Error('Clipboard API unavailable');

  if (pngBlob && typeof ClipboardItem !== 'undefined' && clip.write) {
    try {
      await clip.write([new ClipboardItem({
        'image/png': pngBlob,
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
      return 'image+text';
    } catch (_) {
      // Fall through: some browsers refuse mixed items; text alone is still useful.
    }
  }
  await clip.writeText(text);
  return 'text';
}
