/**
 * SAR Scalar Indices
 *
 * Single-band derived indices computed from GCOV backscatter power terms.
 * Unlike the RGB composites in sar-composites.js, these produce ONE scalar
 * band that renders through the single-band colormap path (not dB-scaled).
 *
 * GCOV diagonal power terms:
 *   HHHH = |SHH|², HVHV = |SHV|², VVVV = |SVV|²
 */

/**
 * Radar Vegetation Index (RVI).
 *
 * A measure of the randomness of scattering — near 0 for smooth/bare surfaces
 * (dominant single-bounce), approaching 1 for dense volume-scattering canopy.
 *
 * Two forms depending on available polarizations:
 *   quad-pol: RVI = 8·HV / (HH + VV + 2·HV)   (Kim & van Zyl 2009)
 *   dual-pol: RVI = 4·HV / (HH + HV)          (dual-pol approximation)
 *
 * NISAR's primary GCOV mode is dual-pol HH/HV, so the dual-pol form applies
 * to most products; the quad-pol form is used when VV is also present.
 */

/**
 * Determine which RVI form is possible for a set of available polarizations.
 * @param {Set<string>|Array<string>} pols - Polarization term names
 * @returns {'quad'|'dual'|null}
 */
export function selectRVIForm(pols) {
  const set = pols instanceof Set ? pols : new Set(pols);
  if (set.has('HHHH') && set.has('HVHV') && set.has('VVVV')) return 'quad';
  if (set.has('HHHH') && set.has('HVHV')) return 'dual';
  // V-transmit dual-pol (Sentinel-1 style): treat VV/VH analogously
  if (set.has('VVVV') && set.has('VHVH')) return 'dual-v';
  return null;
}

/**
 * Polarization datasets required for a given RVI form.
 * @param {'quad'|'dual'|'dual-v'} form
 * @returns {string[]}
 */
export function rviRequiredPols(form) {
  switch (form) {
    case 'quad': return ['HHHH', 'HVHV', 'VVVV'];
    case 'dual': return ['HHHH', 'HVHV'];
    case 'dual-v': return ['VVVV', 'VHVH'];
    default: return [];
  }
}

/**
 * Compute RVI as a single Float32Array from raw power bands.
 *
 * Nodata handling: any pixel where an input is NaN, or the denominator is
 * ≤ 0, is set to NaN so it masks to transparent downstream (matching the
 * 0/NaN masking used elsewhere in the pipeline).
 *
 * @param {Object} bands - Map of pol term → Float32Array (e.g. {HHHH, HVHV, VVVV})
 * @param {'quad'|'dual'|'dual-v'} form
 * @returns {Float32Array} RVI values, typically in [0, ~1]
 */
export function computeRVI(bands, form) {
  if (form === 'quad') {
    const hh = bands['HHHH'], hv = bands['HVHV'], vv = bands['VVVV'];
    const n = hh.length;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = hh[i], b = hv[i], c = vv[i];
      // NaN check (x !== x) or non-positive span
      if (a !== a || b !== b || c !== c) { out[i] = NaN; continue; }
      const denom = a + c + 2 * b;
      out[i] = denom > 0 ? (8 * b) / denom : NaN;
    }
    return out;
  }

  // dual-pol forms: 4·cross / (co + cross)
  const coKey = form === 'dual-v' ? 'VVVV' : 'HHHH';
  const crossKey = form === 'dual-v' ? 'VHVH' : 'HVHV';
  const co = bands[coKey], cross = bands[crossKey];
  const n = co.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = co[i], b = cross[i];
    if (a !== a || b !== b) { out[i] = NaN; continue; }
    const denom = a + b;
    out[i] = denom > 0 ? (4 * b) / denom : NaN;
  }
  return out;
}

/**
 * Registry of scalar indices. Mirrors SAR_COMPOSITES in shape so the app can
 * surface them in a picker, but these render single-band + colormap.
 */
export const SAR_INDICES = {
  rvi: {
    id: 'rvi',
    name: 'RVI (Radar Vegetation Index)',
    description: 'Volume-scattering randomness; 0 (bare) → ~1 (dense canopy)',
    defaultColormap: 'viridis',
    range: [0, 1],
    useDecibels: false,
    selectForm: selectRVIForm,
    requiredPols: rviRequiredPols,
    compute: computeRVI,
  },
};

/**
 * Get the indices available for a set of polarizations.
 * @param {Array<{polarization: string}>} availableDatasets
 * @returns {Array<{id, name, description, form}>}
 */
export function getAvailableIndices(availableDatasets) {
  const pols = new Set(availableDatasets.map(d => d.polarization));
  const out = [];
  for (const idx of Object.values(SAR_INDICES)) {
    const form = idx.selectForm(pols);
    if (form) {
      out.push({ id: idx.id, name: idx.name, description: idx.description, form });
    }
  }
  return out;
}
