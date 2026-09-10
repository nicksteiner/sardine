/**
 * sar-grounding.js — W018 Phase 1.5: physical context for agent-facing views.
 *
 * WHY THIS EXISTS
 *
 * A screenshot of a SAR scene is not self-describing. A general-purpose agent
 * shown a grayscale or false-colour SAR image will read it with optical
 * intuitions — dark means water, bright means built-up — and will be
 * confidently wrong in specific, predictable ways. Dark is equally consistent
 * with radar shadow, a smooth dry surface, or a poorly-chosen stretch.
 *
 * So context is not decoration attached to the image; it is what makes the
 * image interpretable at all. This module builds that context, and — more
 * importantly — enumerates what the current view *cannot* resolve, so an
 * agent is constrained rather than merely informed.
 *
 * DESIGN RULE: report, never invent. Every field is derived from metadata
 * the loaders actually provide (imageData.identification, .pixelSpacing,
 * .polarization, …) or from render state. Unknown stays null. Absolute
 * backscatter thresholds are deliberately NOT asserted here: they are
 * site- and calibration-dependent, and a plausible-but-wrong dB threshold is
 * worse than none. Thresholds belong in an ATBD (e.g. DSWx-SAR), with this
 * module supplying only the physical frame and the ambiguity set.
 */

/** Radar band → wavelength and the interpretation consequences that follow. */
const BAND_PHYSICS = {
  L: {
    wavelengthCm: 24,
    penetration: 'high',
    note: 'L-band penetrates vegetation canopy; returns include ground and trunk interaction. Double-bounce over flooded forest is a known strong signature.',
  },
  S: {
    wavelengthCm: 10,
    penetration: 'moderate',
    note: 'S-band partially penetrates canopy; scattering mixes surface and volume contributions.',
  },
  C: {
    wavelengthCm: 5.6,
    penetration: 'low',
    note: 'C-band interacts mainly with the upper canopy; ground beneath dense vegetation is largely obscured.',
  },
  X: {
    wavelengthCm: 3.1,
    penetration: 'very low',
    note: 'X-band scatters from the canopy top and fine surface roughness; little ground penetration.',
  },
};

/** What a polarization channel is physically sensitive to. */
const POL_PHYSICS = {
  HH: 'Co-polarized. Sensitive to surface and double-bounce scattering; over flooded vegetation HH double-bounce is typically enhanced.',
  VV: 'Co-polarized. Sensitive to surface (Bragg) scattering; commonly used for open-water and soil-moisture work.',
  HV: 'Cross-polarized. Dominated by volume scattering (depolarization); a proxy for vegetation structure and biomass.',
  VH: 'Cross-polarized. Dominated by volume scattering (depolarization); a proxy for vegetation structure and biomass.',
};

/** NISAR GCOV covariance terms are named by their two contributing channels. */
function normalizePol(pol) {
  if (!pol) return null;
  const p = String(pol).toUpperCase();
  // GCOV diagonal terms: HHHH → HH, HVHV → HV.
  if (p.length === 4 && p.slice(0, 2) === p.slice(2)) return p.slice(0, 2);
  if (p.length === 2) return p;
  return p;
}

/**
 * Enumerate what this view genuinely cannot settle.
 *
 * This is the load-bearing half of the payload. Each entry names an
 * ambiguity, why it is unresolved *here*, and what would resolve it — so an
 * agent can defer or request a measurement instead of guessing.
 */
export function describeAmbiguities({ identification = {}, render = {}, hasTerrainMask = false }) {
  const out = [];
  const pol = normalizePol(render.polarization);

  // The canonical SAR error. Low backscatter has several distinct causes that
  // are visually identical in a rendered image.
  out.push({
    id: 'dark-target-ambiguity',
    question: 'Does a dark region indicate open water?',
    resolved: false,
    why: hasTerrainMask
      ? 'A layover/shadow mask is applied, which removes geometric shadow — but smooth dry surfaces (dry lakebeds, roads, bare smooth soil) still produce specular low backscatter indistinguishable from calm water in a single image.'
      : 'Low backscatter is consistent with open water (specular reflection away from the sensor), radar shadow (terrain occlusion), AND smooth dry surfaces. No layover/shadow mask is applied in this view, so terrain shadow is not excluded.',
    resolveWith: hasTerrainMask
      ? ['ROI statistics (open water is low-variance)', 'multi-temporal change', 'ancillary land cover']
      : ['enable the layover/shadow mask', 'ROI statistics', 'a DEM or second look geometry'],
  });

  // Speckle is multiplicative and can be mistaken for texture or change.
  if (!render.multiLook && render.speckleFilterType === 'none') {
    out.push({
      id: 'speckle-vs-texture',
      question: 'Is fine-scale brightness variation real?',
      resolved: false,
      why: 'Neither multilooking nor speckle filtering is applied. Speckle is coherent fading, not sensor noise, and produces pixel-scale variation that can be mistaken for genuine texture or change.',
      resolveWith: ['increase multilook', 'apply a speckle filter', 'compare ROI variance against an expected ENL'],
    });
  }

  // Cross-pol alone cannot separate surface roughness from volume.
  if (pol === 'HV' || pol === 'VH') {
    out.push({
      id: 'single-channel-mechanism',
      question: 'Which scattering mechanism dominates?',
      resolved: false,
      why: 'A single cross-polarized channel indicates depolarization but cannot separate volume scattering from rough-surface or double-bounce contributions.',
      resolveWith: ['co-pol channel for comparison', 'a polarimetric decomposition (e.g. Pauli)', 'an RGB composite'],
    });
  }

  return out;
}

/**
 * Build the full grounding payload that accompanies a view sent to an agent.
 *
 * @param {object} imageData - loader output (identification, pixelSpacing, …)
 * @param {object} render    - serializeViewerState() output
 * @returns {object} physical frame + ambiguities + interpretation contract
 */
export function buildGrounding(imageData = {}, render = {}) {
  const id = imageData?.identification || {};
  const band = id.radarBand || null;
  const physics = band ? BAND_PHYSICS[String(band).toUpperCase()] || null : null;
  const pol = normalizePol(render.selectedPolarization || imageData?.polarization);

  const isDb = render.useDecibels !== false;
  const lo = Number.isFinite(render.contrastMin) ? render.contrastMin : null;
  const hi = Number.isFinite(render.contrastMax) ? render.contrastMax : null;

  return {
    // ── What the instrument measured ────────────────────────────────
    acquisition: {
      radarBand: band,
      wavelengthCm: physics?.wavelengthCm ?? null,
      canopyPenetration: physics?.penetration ?? null,
      bandNote: physics?.note ?? null,
      polarization: pol,
      polarizationNote: pol ? POL_PHYSICS[pol] || null : null,
      lookDirection: id.lookDirection || null,
      orbitPass: id.orbitPassDirection || null,
      acquisitionStart: id.zeroDopplerStartTime || null,
      platform: id.platformName || null,
      productLevel: id.productLevel || null,
    },

    // ── What the pixels are, physically ─────────────────────────────
    measurement: {
      quantity: isDb ? 'radar backscatter coefficient (sigma-0)' : 'linear radar power',
      units: isDb ? 'dB' : 'linear power (unitless ratio)',
      // Stated explicitly: brightness is a render choice, not a measurement.
      displayRange: lo !== null && hi !== null ? [lo, hi] : null,
      displayRangeNote: lo !== null && hi !== null
        ? `Black maps to ${lo}${isDb ? ' dB' : ''} and white//max-colour to ${hi}${isDb ? ' dB' : ''}. Values outside this range are clipped, so apparent brightness is a render choice and NOT an absolute measurement.`
        : 'Contrast range unknown; apparent brightness cannot be converted to a value.',
      // Loaders disagree on the name: NISAR exposes pixelSpacing, COG
      // exposes resolution ([x, y] in CRS units). Report whichever exists
      // rather than silently dropping the scale of the scene.
      pixelSpacing: imageData?.pixelSpacing
        ?? (Array.isArray(imageData?.resolution) ? Math.abs(imageData.resolution[0]) : null)
        ?? null,
      crs: imageData?.crs ?? imageData?.projection ?? null,
      colormap: render.colormap || null,
      stretchMode: render.stretchMode || null,
      multiLook: render.multiLook ?? null,
      speckleFilter: render.speckleFilterType || 'none',
      displayMode: render.displayMode || null,
      compositeId: render.compositeId || null,
    },

    // ── What this view cannot settle ────────────────────────────────
    ambiguities: describeAmbiguities({
      identification: id,
      render: {
        polarization: pol,
        multiLook: render.multiLook,
        speckleFilterType: render.speckleFilterType,
      },
      hasTerrainMask: !!render.maskLayoverShadow,
    }),

    // ── How the agent is expected to behave ─────────────────────────
    interpretationContract: {
      rules: [
        'This is radar backscatter, not an optical image. Do not apply optical intuitions: brightness is surface roughness, geometry and dielectric properties — not colour or albedo.',
        'Any reading of the image is a HYPOTHESIS. Verify it against numbers (ROI statistics, histogram, transect) before stating it as a finding.',
        'Do not assert absolute dB thresholds for a class. Thresholds are site- and calibration-specific and must come from an ATBD or local calibration, not from general knowledge.',
        'If an item in `ambiguities` bears on the question asked, say so and name the measurement that would resolve it. Deferring is the correct answer, not a failure.',
        'Distinguish what is measured (backscatter) from what is rendered (colormap, stretch, clipping). Report the former; treat the latter as a display artifact.',
      ],
    },
  };
}
