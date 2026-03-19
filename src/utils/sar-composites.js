/**
 * SAR RGB Composite Presets
 *
 * Standard SAR polarimetric color combinations for GCOV power data.
 * GCOV datasets contain backscatter power values:
 *   HHHH = |HH|², HVHV = |HV|², VHVH = |VH|², VVVV = |VV|²
 *
 * Off-diagonal terms (complex):
 *   HHVV = <SHH·SVV*> — stored as CFloat32 in NISAR, de-interleaved
 *   to HHVV_re (real) and HHVV_im (imaginary) by the loader.
 *
 * Includes Cloude-Pottier H/Alpha/Entropy decomposition (eigenanalysis of
 * the 3×3 coherency matrix T3 derived from the full covariance matrix C3).
 */

import { applyStretch } from './stretch.js';
import { computeHAlphaGPU, canUseGPUHAlpha } from '../gpu/polsar-compute.js';

/**
 * Colorblind-safe color matrices for RGB composites.
 * Each matrix maps [dataR, dataG, dataB] → [displayR, displayG, displayB].
 * Rows = output channels, columns = input channels.
 */
export const COLORBLIND_MATRICES = {
  // Deuteranopia / Protanopia (red-green): Orange / Blue / Light
  deuteranopia: [
    [1.0, 0.0, 0.85],   // displayR = 1.0*R + 0.0*G + 0.85*B
    [0.5, 0.35, 0.85],  // displayG = 0.5*R + 0.35*G + 0.85*B
    [0.0, 1.0, 0.75],   // displayB = 0.0*R + 1.0*G + 0.75*B
  ],
  protanopia: [
    [1.0, 0.0, 0.85],
    [0.5, 0.35, 0.85],
    [0.0, 1.0, 0.75],
  ],
  // Tritanopia (blue-yellow): Red / Green / Magenta
  tritanopia: [
    [1.0, 0.1, 0.7],    // displayR
    [0.1, 1.0, 0.0],    // displayG
    [0.1, 0.1, 0.7],    // displayB
  ],
};

/**
 * Freeman-Durden 3-component decomposition (per-pixel).
 *
 * Decomposes the 3×3 covariance matrix into:
 *   Ps — surface (single-bounce Bragg)
 *   Pd — double-bounce (dihedral)
 *   Pv — volume (random canopy)
 *
 * Uses the random-dipole-cloud volume model (Freeman & Durden 1998, IEEE TGRS).
 *
 * @param {number} c11 - <|SHH|²>      (HHHH)
 * @param {number} c22 - <|SHV|²>      (HVHV)
 * @param {number} c33 - <|SVV|²>      (VVVV)
 * @param {number} c13re - Re(<SHH·SVV*>) (Re(HHVV))
 * @param {number} c13im - Im(<SHH·SVV*>) (Im(HHVV))
 * @returns {{Ps: number, Pd: number, Pv: number}}
 */
function freemanDurden(c11, c22, c33, c13re, c13im) {
  const span = c11 + 2 * c22 + c33;
  if (span <= 1e-20) return { Ps: 0, Pd: 0, Pv: 0 };

  // Volume: random dipole cloud model
  // Cv_22 = fv/4 → fv = 4·C22
  // Cv_11 = Cv_33 = fv/2, Cv_13 = fv/4
  // Volume power in span: fv/2 + 2·fv/4 + fv/2 = 3fv/2
  const fv = 4 * c22;

  // Residual co-pol after removing volume contribution
  const c11r = c11 - fv / 2;     // C11 - 2·C22
  const c33r = c33 - fv / 2;     // C33 - 2·C22
  const c13r_re = c13re - c22;   // Re(C13) - C22  (fv/4 = C22)
  const c13r_im = c13im;

  let Ps, Pd, Pv;

  if (c11r <= 0 || c33r <= 0) {
    // Volume over-estimated — assign all power to volume
    return { Ps: 0, Pd: 0, Pv: span };
  }

  const c13r_sq = c13r_re * c13r_re + c13r_im * c13r_im;
  const det = c11r * c33r;

  if (c13r_re >= 0) {
    // Surface dominant: fix α = -1
    // Ps from C33 residual, Pd from remainder
    Ps = c33r;
    Pd = (det > c13r_sq) ? c11r - c13r_sq / c33r : 0;
  } else {
    // Double-bounce dominant: fix β = 1
    // Pd from C11 residual, Ps from remainder
    Pd = c11r;
    Ps = (det > c13r_sq) ? c33r - c13r_sq / c11r : 0;
  }

  if (Ps < 0) Ps = 0;
  if (Pd < 0) Pd = 0;
  Pv = span - Ps - Pd;
  if (Pv < 0) Pv = 0;

  return { Ps, Pd, Pv };
}

/**
 * Compute Freeman-Durden RGB bands for an entire tile.
 *
 * Standard convention: R = Pd (double-bounce, red in urban areas),
 *                      G = Pv (volume, green in forests),
 *                      B = Ps (surface, blue over water / bare soil).
 *
 * @param {Object} bands - {HHHH, HVHV, VVVV, HHVV_re, HHVV_im} Float32Arrays
 * @returns {{R: Float32Array, G: Float32Array, B: Float32Array}}
 */
function computeFreemanDurdenRGB(bands) {
  const hh = bands['HHHH'];
  const hv = bands['HVHV'];
  const vv = bands['VVVV'];
  const re = bands['HHVV_re'];
  const im = bands['HHVV_im'];
  const n = hh.length;

  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const c11 = hh[i];
    const c22 = hv[i];
    const c33 = vv[i];
    const c13re = re ? re[i] : 0;
    const c13im = im ? im[i] : 0;

    if (c11 <= 0 && c22 <= 0 && c33 <= 0) continue; // nodata

    const { Ps, Pd, Pv } = freemanDurden(c11, c22, c33, c13re, c13im);
    R[i] = Pd;  // double-bounce → red (urban)
    G[i] = Pv;  // volume → green (vegetation)
    B[i] = Ps;  // surface → blue (water/soil)
  }

  return { R, G, B };
}

/**
 * Cloude-Pottier H/Alpha/Entropy decomposition.
 *
 * Eigenanalysis of the 3×3 coherency matrix T3, derived from the covariance
 * matrix C3 via the Pauli basis transformation:
 *   T = U · C · U†,  U = (1/√2) [[1,0,1],[1,0,-1],[0,√2,0]]
 *
 * Outputs per pixel:
 *   H  — Entropy (0–1):     randomness of scattering mechanism
 *   α  — Alpha angle (0–90°): dominant scattering type
 *   A  — Anisotropy (0–1):   relative importance of 2nd vs 3rd mechanism
 *
 * Reference: Cloude & Pottier 1997, IEEE TGRS 35(1).
 *
 * @param {number} c11 - HHHH (|SHH|²)
 * @param {number} c12re - Re(HHHV)
 * @param {number} c12im - Im(HHHV)
 * @param {number} c13re - Re(HHVV)
 * @param {number} c13im - Im(HHVV)
 * @param {number} c22 - HVHV (|SHV|²)
 * @param {number} c23re - Re(HVVV)
 * @param {number} c23im - Im(HVVV)
 * @param {number} c33 - VVVV (|SVV|²)
 * @returns {{H: number, alpha: number, A: number}}
 */
function hAlphaDecomposition(c11, c12re, c12im, c13re, c13im, c22, c23re, c23im, c33) {
  // ── Build coherency matrix T3 from covariance C3 ──────────────────
  // T = U · C · U† with Pauli basis transformation
  const SQRT2 = Math.SQRT2;
  const t11 = (c11 + c33 + 2 * c13re) / 2;
  const t12re = (c11 - c33) / 2;
  const t12im = -c13im;
  const t13re = (c12re + c23re) / SQRT2;
  const t13im = (c12im - c23im) / SQRT2;
  const t22 = (c11 + c33 - 2 * c13re) / 2;
  const t23re = (c12re - c23re) / SQRT2;
  const t23im = (c12im + c23im) / SQRT2;
  const t33 = c22;

  const trace = t11 + t22 + t33;
  if (trace <= 1e-20) return { H: 0, alpha: 0, A: 0 };

  // ── Eigenvalues via Cardano's trigonometric method ─────────────────
  // Characteristic eq: λ³ - trace·λ² + s2·λ - det = 0
  // All 3 roots real (Hermitian matrix guaranteed)
  const absT12sq = t12re * t12re + t12im * t12im;
  const absT13sq = t13re * t13re + t13im * t13im;
  const absT23sq = t23re * t23re + t23im * t23im;

  const m = trace / 3;
  const d11 = t11 - m;
  const d22 = t22 - m;
  const d33 = t33 - m;

  // p = tr((T - m·I)²) / 6
  const p = (d11 * d11 + d22 * d22 + d33 * d33 + 2 * (absT12sq + absT13sq + absT23sq)) / 6;

  if (p <= 1e-30) {
    // Degenerate: all eigenvalues equal → max entropy, undefined alpha
    return { H: 1, alpha: 45, A: 0 };
  }

  // q = det(T - m·I) / 2
  const reT12T23T13conj = (t12re * t23re - t12im * t23im) * t13re
                        + (t12re * t23im + t12im * t23re) * t13im;
  const detShifted = d11 * (d22 * d33 - absT23sq)
                   - absT12sq * d33 - absT13sq * d22
                   + 2 * reT12T23T13conj;
  const q = detShifted / 2;

  const p32 = p * Math.sqrt(p);
  const r = Math.max(-1, Math.min(1, q / p32));  // clamp for numerics
  const phi = Math.acos(r) / 3;
  const sqrtP = Math.sqrt(p);

  let l1 = m + 2 * sqrtP * Math.cos(phi);
  let l2 = m + 2 * sqrtP * Math.cos(phi - 2.094395102393195);  // -2π/3
  let l3 = m + 2 * sqrtP * Math.cos(phi + 2.094395102393195);  // +2π/3

  // Sort descending: l1 ≥ l2 ≥ l3
  if (l1 < l2) { const tmp = l1; l1 = l2; l2 = tmp; }
  if (l1 < l3) { const tmp = l1; l1 = l3; l3 = tmp; }
  if (l2 < l3) { const tmp = l2; l2 = l3; l3 = tmp; }

  // Clamp negative eigenvalues (numerical noise)
  l1 = Math.max(l1, 0);
  l2 = Math.max(l2, 0);
  l3 = Math.max(l3, 0);

  const span = l1 + l2 + l3;
  if (span <= 1e-20) return { H: 0, alpha: 0, A: 0 };

  // ── Eigenvectors via cofactor method ──────────────────────────────
  // For each λi, eigenvector from first column of adj(T - λi·I):
  //   v0 = (t22-λ)(t33-λ) - |t23|²          [real]
  //   v1 = t13*·t23 - t12*·(t33-λ)           [complex]
  //   v2 = t12*·t23* - t13*·(t22-λ)          [complex]
  // Alpha angle: αi = acos(|v0| / ||v||)

  const lambdas = [l1, l2, l3];
  const alphas = new Array(3);

  for (let k = 0; k < 3; k++) {
    const lam = lambdas[k];

    // v0 (real)
    const v0 = (t22 - lam) * (t33 - lam) - absT23sq;

    // v1 = conj(t13)·t23 - conj(t12)·(t33-λ)
    // conj(t13)·t23 = (t13re - i·t13im)(t23re + i·t23im)
    //               = (t13re·t23re + t13im·t23im) + i·(t13re·t23im - t13im·t23re)
    const v1re = (t13re * t23re + t13im * t23im) - t12re * (t33 - lam);
    const v1im = (t13re * t23im - t13im * t23re) + t12im * (t33 - lam);

    // v2 = conj(t12)·conj(t23) - conj(t13)·(t22-λ)
    // conj(t12)·conj(t23) = (t12re - i·t12im)(t23re - i·t23im)
    //                      = (t12re·t23re + t12im·t23im) - i·(t12re·t23im - t12im·t23re) ... wait

    // Actually: conj(t12)·conj(t23) = (t12re - i·t12im)(t23re - i·t23im)
    //   re: t12re·t23re + t12im·t23im (wait, minus times minus...)
    //   re: t12re·t23re - t12im·(-t23im) = t12re·t23re + t12im·t23im  ... no
    //   (a-bi)(c-di) = (ac - bd) - i(ad + bc) ... wait no:
    //   (a-bi)(c-di) = ac - adi - bci + bdi² = (ac-bd) - i(ad+bc)

    // Hmm, let me be careful:
    // (t12re - i·t12im)(t23re - i·t23im)
    // = t12re·t23re - i·t12re·t23im - i·t12im·t23re + i²·t12im·t23im
    // = (t12re·t23re - t12im·t23im) - i·(t12re·t23im + t12im·t23re)
    const v2re = (t12re * t23re - t12im * t23im) - t13re * (t22 - lam);
    const v2im = -(t12re * t23im + t12im * t23re) + t13im * (t22 - lam);

    const normSq = v0 * v0 + v1re * v1re + v1im * v1im + v2re * v2re + v2im * v2im;

    if (normSq > 1e-30) {
      const cosAlpha = Math.abs(v0) / Math.sqrt(normSq);
      alphas[k] = Math.acos(Math.min(1, cosAlpha)) * (180 / Math.PI); // degrees
    } else {
      // Degenerate eigenvector — use fallback from other cofactor columns
      alphas[k] = 45; // isotropic assumption
    }
  }

  // ── Pseudo-probabilities & derived parameters ─────────────────────
  const p1 = l1 / span;
  const p2 = l2 / span;
  const p3 = l3 / span;

  // Entropy: H = -Σ pi·log₃(pi),  range [0, 1]
  const LOG3 = Math.log(3);
  let H = 0;
  if (p1 > 1e-10) H -= p1 * Math.log(p1) / LOG3;
  if (p2 > 1e-10) H -= p2 * Math.log(p2) / LOG3;
  if (p3 > 1e-10) H -= p3 * Math.log(p3) / LOG3;

  // Mean alpha angle: ᾱ = Σ pi·αi,  range [0°, 90°]
  const alpha = p1 * alphas[0] + p2 * alphas[1] + p3 * alphas[2];

  // Anisotropy: A = (λ2 - λ3) / (λ2 + λ3),  range [0, 1]
  const A = (l2 + l3 > 1e-20) ? (l2 - l3) / (l2 + l3) : 0;

  return { H, alpha, A };
}

/**
 * Compute H/Alpha/Entropy RGB bands for an entire tile.
 *
 * Convention: R = Entropy (H), G = Alpha (α), B = Anisotropy (A)
 * H ∈ [0, 1], α ∈ [0°, 90°], A ∈ [0, 1]
 *
 * @param {Object} bands - {HHHH, HVHV, VVVV, HHHV_re, HHHV_im, HHVV_re, HHVV_im, HVVV_re, HVVV_im}
 * @returns {{R: Float32Array, G: Float32Array, B: Float32Array}}
 */
function computeHAlphaEntropyRGB(bands) {
  const c11 = bands['HHHH'];
  const c22 = bands['HVHV'];
  const c33 = bands['VVVV'];
  const c12re = bands['HHHV_re'];
  const c12im = bands['HHHV_im'];
  const c13re = bands['HHVV_re'];
  const c13im = bands['HHVV_im'];
  const c23re = bands['HVVV_re'];
  const c23im = bands['HVVV_im'];
  const n = c11.length;

  const R = new Float32Array(n);  // H (entropy)
  const G = new Float32Array(n);  // α (alpha angle)
  const B = new Float32Array(n);  // A (anisotropy)

  for (let i = 0; i < n; i++) {
    const hh = c11[i];
    const hv = c22[i];
    const vv = c33[i];

    if (hh <= 0 && hv <= 0 && vv <= 0) continue; // nodata

    const { H, alpha, A } = hAlphaDecomposition(
      hh,
      c12re ? c12re[i] : 0, c12im ? c12im[i] : 0,
      c13re ? c13re[i] : 0, c13im ? c13im[i] : 0,
      hv,
      c23re ? c23re[i] : 0, c23im ? c23im[i] : 0,
      vv
    );

    R[i] = H;
    G[i] = alpha;
    B[i] = A;
  }

  return { R, G, B };
}

/**
 * SAR composite preset definitions
 * Each preset maps R/G/B channels to polarization datasets or formulas.
 */
export const SAR_COMPOSITES = {
  'hh-hv-vv': {
    name: 'HH / HV / VV',
    description: 'Standard quad-pol RGB',
    required: ['HHHH', 'HVHV', 'VVVV'],
    channels: {
      R: { dataset: 'HHHH' },
      G: { dataset: 'HVHV' },
      B: { dataset: 'VVVV' },
    },
  },
  'pauli-power': {
    name: 'Pauli (power)',
    description: 'Approx Pauli decomposition from power data',
    required: ['HHHH', 'HVHV', 'VVVV'],
    channels: {
      R: {
        formula: (bands) => {
          const hh = bands['HHHH'];
          const vv = bands['VVVV'];
          const result = new Float32Array(hh.length);
          for (let i = 0; i < hh.length; i++) {
            result[i] = Math.abs(hh[i] - vv[i]);
          }
          return result;
        },
        datasets: ['HHHH', 'VVVV'],
        label: '|HH−VV|',
      },
      G: { dataset: 'HVHV' },
      B: {
        formula: (bands) => {
          const hh = bands['HHHH'];
          const vv = bands['VVVV'];
          const result = new Float32Array(hh.length);
          for (let i = 0; i < hh.length; i++) {
            result[i] = hh[i] + vv[i];
          }
          return result;
        },
        datasets: ['HHHH', 'VVVV'],
        label: 'HH+VV',
      },
    },
  },
  'dual-pol-v': {
    name: 'VV / VH / VV÷VH',
    description: 'Dual-pol V-transmit (Sentinel-1 style)',
    required: ['VVVV', 'VHVH'],
    channels: {
      R: { dataset: 'VVVV' },
      G: { dataset: 'VHVH' },
      B: {
        formula: (bands) => {
          const vv = bands['VVVV'];
          const vh = bands['VHVH'];
          const result = new Float32Array(vv.length);
          for (let i = 0; i < vv.length; i++) {
            result[i] = vv[i] / Math.max(vh[i], 1e-10);
          }
          return result;
        },
        datasets: ['VVVV', 'VHVH'],
        label: 'VV/VH',
      },
    },
  },
  'dual-pol-h': {
    name: 'HH / HV / HH÷HV',
    description: 'Dual-pol H-transmit',
    required: ['HHHH', 'HVHV'],
    channels: {
      R: { dataset: 'HHHH' },
      G: { dataset: 'HVHV' },
      B: {
        formula: (bands) => {
          const hh = bands['HHHH'];
          const hv = bands['HVHV'];
          const result = new Float32Array(hh.length);
          for (let i = 0; i < hh.length; i++) {
            result[i] = hh[i] / Math.max(hv[i], 1e-10);
          }
          return result;
        },
        datasets: ['HHHH', 'HVHV'],
        label: 'HH/HV',
      },
    },
  },
  'freeman-durden': {
    name: 'Freeman-Durden',
    description: 'Double-bounce / Volume / Surface decomposition',
    required: ['HHHH', 'HVHV', 'VVVV'],
    requiredComplex: ['HHVV'],
    computeAll: true,
    formula: computeFreemanDurdenRGB,
    channelLabels: { R: 'Pd (dbl-bounce)', G: 'Pv (volume)', B: 'Ps (surface)' },
  },
  'h-alpha-entropy': {
    name: 'H / α / A (Cloude-Pottier)',
    description: 'Entropy / Alpha angle / Anisotropy eigendecomposition',
    required: ['HHHH', 'HVHV', 'VVVV'],
    requiredComplex: ['HHHV', 'HHVV', 'HVVV'],
    computeAll: true,
    formula: computeHAlphaEntropyRGB,
    channelLabels: { R: 'H (entropy)', G: 'α (alpha °)', B: 'A (anisotropy)' },
    // H/α/A are normalized parameters, not power — disable dB scaling
    defaultUseDecibels: false,
    defaultContrastLimits: { R: [0, 1], G: [0, 90], B: [0, 1] },
  },
  // Multi-temporal: R/G/B come directly from 3 separate file loads.
  // Required uses sentinel values so getAvailableComposites never surfaces this preset
  // when scanning a single file's polarizations.
  'multi-temporal': {
    name: 'Multi-temporal RGB',
    description: 'Same dataset from 3 acquisitions mapped to R / G / B',
    required: ['__file_R__', '__file_G__', '__file_B__'],
    channels: {
      R: { dataset: 'R' },
      G: { dataset: 'G' },
      B: { dataset: 'B' },
    },
  },
};

/**
 * Auto-select the best composite preset based on available polarization datasets.
 * @param {Array<{frequency: string, polarization: string}>} availableDatasets
 * @returns {string|null} Composite ID or null if only 1 pol available
 */
export function autoSelectComposite(availableDatasets) {
  const pols = new Set(availableDatasets.map(d => d.polarization));

  // Default pattern: R=co-pol, G=cross-pol, B=co-pol/cross-pol (ratio)
  // H-transmit (NISAR primary, ALOS)
  if (pols.has('HHHH') && pols.has('HVHV')) {
    return 'dual-pol-h';
  }

  // V-transmit (Sentinel-1 style)
  if (pols.has('VVVV') && pols.has('VHVH')) {
    return 'dual-pol-v';
  }

  // Not enough bands for RGB
  return null;
}

/**
 * Get the list of available composites for a set of polarizations.
 * @param {Array<{frequency: string, polarization: string}>} availableDatasets
 * @returns {Array<{id: string, name: string, description: string}>}
 */
export function getAvailableComposites(availableDatasets) {
  const pols = new Set(availableDatasets.map(d => d.polarization));

  return Object.entries(SAR_COMPOSITES)
    .filter(([, preset]) => preset.required.every(p => pols.has(p)))
    .map(([id, preset]) => {
      // Flag composites that need complex (off-diagonal) terms not yet confirmed
      const needsComplex = preset.requiredComplex && preset.requiredComplex.length > 0;
      const hasComplex = !needsComplex || preset.requiredComplex.every(p => pols.has(p));
      return {
        id,
        name: preset.name,
        description: preset.description,
        needsComplex: needsComplex && !hasComplex,
      };
    });
}

/**
 * Get the unique dataset polarizations needed for a composite (real-valued).
 * @param {string} compositeId
 * @returns {string[]} List of polarization names (e.g. ['HHHH', 'HVHV', 'VVVV'])
 */
export function getRequiredDatasets(compositeId) {
  const preset = SAR_COMPOSITES[compositeId];
  if (!preset) return [];
  return preset.required;
}

/**
 * Get the complex (off-diagonal) datasets needed for a composite.
 * @param {string} compositeId
 * @returns {string[]} List of complex term names (e.g. ['HHVV'])
 */
export function getRequiredComplexDatasets(compositeId) {
  const preset = SAR_COMPOSITES[compositeId];
  if (!preset) return [];
  return preset.requiredComplex || [];
}

/**
 * Compute RGB channel values from raw band data.
 *
 * @param {Object} bandData - Map of polarization name → Float32Array
 * @param {string} compositeId - Which composite preset to apply
 * @param {number} tileSize - Tile width (assumes square tile if numPixels not given)
 * @param {number} [numPixels] - Total pixel count (for non-square images)
 * @returns {{R: Float32Array, G: Float32Array, B: Float32Array}}
 */
export function computeRGBBands(bandData, compositeId, tileSize, numPixels) {
  const preset = SAR_COMPOSITES[compositeId];
  if (!preset) {
    throw new Error(`Unknown composite: ${compositeId}`);
  }

  if (numPixels === undefined) numPixels = tileSize * tileSize;

  // Decomposition presets compute all channels at once (e.g. Freeman-Durden)
  if (preset.computeAll && preset.formula) {
    return preset.formula(bandData);
  }

  const result = {};

  for (const channel of ['R', 'G', 'B']) {
    const chDef = preset.channels[channel];

    if (chDef.formula) {
      // Formula-based channel: pass all band data, get computed result
      result[channel] = chDef.formula(bandData);
    } else {
      // Direct dataset mapping
      const data = bandData[chDef.dataset];
      if (data) {
        result[channel] = data;
      } else {
        // Missing band — fill with zeros
        result[channel] = new Float32Array(numPixels);
      }
    }
  }

  return result;
}

/**
 * Async variant of computeRGBBands that uses WebGPU compute when available.
 * Falls back to synchronous CPU computation when GPU is unavailable.
 *
 * Currently accelerates: h-alpha-entropy (eigendecomposition is compute-heavy).
 *
 * @param {Object} bandData - Map of polarization name → Float32Array
 * @param {string} compositeId - Which composite preset to apply
 * @param {number} tileSize - Tile width (assumes square tile if numPixels not given)
 * @param {number} [numPixels] - Total pixel count (for non-square images)
 * @returns {Promise<{R: Float32Array, G: Float32Array, B: Float32Array}>}
 */
export async function computeRGBBandsAsync(bandData, compositeId, tileSize, numPixels) {
  if (numPixels === undefined) numPixels = tileSize * tileSize;

  // Try GPU path for H/Alpha/Entropy
  if (compositeId === 'h-alpha-entropy' && canUseGPUHAlpha()) {
    const gpuResult = await computeHAlphaGPU(bandData, numPixels);
    if (gpuResult) return gpuResult;
  }

  // Fallback to sync CPU path
  return computeRGBBands(bandData, compositeId, tileSize, numPixels);
}

/**
 * Create an RGBA ImageData from three RGB Float32Array bands.
 * Applies per-channel dB scaling, contrast stretch, and optional gamma/stretch mode.
 *
 * @param {{R: Float32Array, G: Float32Array, B: Float32Array}} bands
 * @param {number} width
 * @param {number} height
 * @param {number[]} contrastLimits - [min, max] applied uniformly to all channels
 * @param {boolean} useDecibels - Whether to apply 10*log10 before stretching
 * @param {number} gamma - Gamma exponent (default 1.0)
 * @param {string} stretchMode - Stretch mode (default 'linear')
 * @param {Uint8Array|null} dataMask - Optional mask array (NISAR 3-digit encoding)
 * @param {boolean} maskInvalid - Hide invalid (0) and fill (255) pixels
 * @param {boolean} maskLayoverShadow - Hide layover/shadow pixels (mask < 100)
 * @returns {ImageData}
 */
export function createRGBTexture(bands, width, height, contrastLimits, useDecibels, gamma = 1.0, stretchMode = 'linear', dataMask = null, maskInvalid = false, maskLayoverShadow = false, colorblindMode = 'off') {
  // Support per-channel contrast: {R: [min,max], G: [min,max], B: [min,max]}
  // or uniform: [min, max]
  const channelKeys = ['R', 'G', 'B'];
  const limits = {};
  if (Array.isArray(contrastLimits)) {
    const [min, max] = contrastLimits;
    for (const ch of channelKeys) {
      limits[ch] = [min, max];
    }
  } else {
    for (const ch of channelKeys) {
      limits[ch] = contrastLimits[ch] || [-25, 0];
    }
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  const needsStretch = stretchMode !== 'linear' || gamma !== 1.0;
  const cvdMatrix = COLORBLIND_MATRICES[colorblindMode] || null;

  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    let anyValid = false;
    const vals = [0, 0, 0];

    for (let c = 0; c < 3; c++) {
      const channelKey = channelKeys[c];
      const raw = bands[channelKey][i];

      if (isNaN(raw) || raw === 0) continue;

      anyValid = true;

      const [chMin, chMax] = limits[channelKey];
      const range = chMax - chMin || 1;
      let value;
      if (useDecibels) {
        const db = 10 * Math.log10(Math.max(raw, 1e-10));
        value = (db - chMin) / range;
      } else {
        value = (raw - chMin) / range;
      }

      value = Math.max(0, Math.min(1, value));
      if (needsStretch) value = applyStretch(value, stretchMode, gamma);
      vals[c] = value;
    }

    // Apply colorblind-safe color matrix
    if (cvdMatrix) {
      const [r, g, b] = vals;
      for (let c = 0; c < 3; c++) {
        const row = cvdMatrix[c];
        vals[c] = Math.max(0, Math.min(1, row[0] * r + row[1] * g + row[2] * b));
      }
    }

    rgba[idx]     = Math.round(vals[0] * 255);
    rgba[idx + 1] = Math.round(vals[1] * 255);
    rgba[idx + 2] = Math.round(vals[2] * 255);

    let alpha = anyValid ? 255 : 0;
    if (dataMask && dataMask[i] !== undefined) {
      const maskVal = dataMask[i];
      if (maskInvalid && (maskVal < 0.5 || maskVal > 254.5)) alpha = 0;
      // Layover/shadow: mask > 1 (not pure-valid) and not fill
      if (maskLayoverShadow && maskVal > 1.5 && maskVal < 254.5) alpha = 0;
    }
    rgba[idx + 3] = alpha;
  }

  return new ImageData(rgba, width, height);
}
