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
 * Terrain geometry — the imaging model, not an optional enrichment.
 *
 * Radar is a side-looking ranging instrument, so terrain is not context
 * around the measurement; it participates in forming it. Layover, shadow and
 * foreshortening are terrain effects, and sigma-0 is defined against the
 * LOCAL incidence angle, which is a function of slope. A backscatter value
 * read without terrain is not a calibrated measurement.
 *
 * NISAR GCOV carries this in-product, so no external DEM fetch is needed:
 *   - a metadata cube (JPL D-102274 §5.8) with per-pixel incidenceAngle
 *     and elevationAngle, interpolated at the pixel's height
 *   - a `mask` layer flagging shadow / layover / out-of-swath
 *   - power values of exactly 0, meaning zero illuminated area — which is
 *     itself a shadow/layover indicator (docs/NISAR_GCOV.md)
 *
 * For products WITHOUT these (a plain COG), terrain is unknown, and that
 * absence must be reported rather than papered over: an unknown-terrain view
 * cannot exclude shadow, and the ambiguity set must say so.
 */
export function describeTerrain(imageData = {}, render = {}) {
  const cube = imageData?.metadataCube || null;
  const hasCube = !!cube && typeof cube.getIncidenceAngle === 'function';
  const hasMask = !!imageData?.hasMask;
  const maskApplied = !!render.maskLayoverShadow;

  // Report only what the product actually provides.
  const source = hasCube
    ? 'NISAR metadata cube (per-pixel incidence/elevation angle)'
    : null;

  return {
    available: hasCube || hasMask,
    source,
    // Per-pixel incidence angle is the quantity sigma-0 is defined against.
    incidenceAngleAvailable: hasCube,
    // A shadow/layover flag layer exists in the product.
    terrainMaskAvailable: hasMask,
    // ...and whether the user is currently applying it.
    terrainMaskApplied: maskApplied,
    // GCOV encodes zero-illuminated-area as exactly 0, so even without the
    // mask layer applied, zero-valued pixels indicate shadow/layover.
    zeroMeansNoIllumination: !!imageData?.isGCOV,
    note: hasCube
      ? 'Per-pixel incidence angle is available from the product metadata cube; sigma-0 is defined against the local incidence angle, so slope-driven brightness variation can be distinguished from surface change.'
      : 'No terrain geometry accompanies this product. Local incidence angle is unknown, so brightness variation caused by slope cannot be separated from variation caused by surface properties. Radar shadow cannot be excluded.',
  };
}

/**
 * Enumerate what this view genuinely cannot settle.
 *
 * This is the load-bearing half of the payload. Each entry names an
 * ambiguity, why it is unresolved *here*, and what would resolve it — so an
 * agent can defer or request a measurement instead of guessing.
 */
export function describeAmbiguities({ identification = {}, render = {}, terrain = {} }) {
  const out = [];
  const pol = normalizePol(render.polarization);
  const shadowExcluded = !!terrain.terrainMaskApplied;

  // The canonical SAR error. Low backscatter has several distinct causes that
  // are visually identical in a rendered image. Terrain determines how much of
  // that ambiguity can actually be retired.
  out.push({
    id: 'dark-target-ambiguity',
    question: 'Does a dark region indicate open water?',
    resolved: false,
    candidateCauses: shadowExcluded
      ? ['open water (specular reflection)', 'smooth dry surface (playa, road, bare smooth soil)']
      : ['open water (specular reflection)', 'radar shadow (terrain occlusion)', 'smooth dry surface'],
    why: shadowExcluded
      ? 'A layover/shadow mask is applied, so geometric shadow is excluded — but smooth dry surfaces (dry lakebeds, roads, bare smooth soil) still produce specular low backscatter indistinguishable from calm water in a single image.'
      : terrain.terrainMaskAvailable
        ? 'Low backscatter is consistent with open water, radar shadow, AND smooth dry surfaces. This product carries a shadow/layover mask but it is NOT currently applied, so terrain shadow is not excluded.'
        : 'Low backscatter is consistent with open water, radar shadow, AND smooth dry surfaces. No terrain geometry accompanies this product, so radar shadow cannot be excluded at all.',
    resolveWith: shadowExcluded
      ? ['ROI statistics (open water is low-variance)', 'multi-temporal change', 'ancillary land cover (as comparison, not ground truth)']
      : terrain.terrainMaskAvailable
        ? ['enable the layover/shadow mask (available in this product)', 'ROI statistics', 'multi-temporal change']
        : ['a DEM or terrain mask', 'a second look geometry', 'ROI statistics'],
  });

  // Without local incidence angle, slope and surface change are confounded.
  if (!terrain.incidenceAngleAvailable) {
    out.push({
      id: 'slope-vs-surface',
      question: 'Is a brightness difference caused by terrain or by the surface?',
      resolved: false,
      why: 'Sigma-0 is defined against the LOCAL incidence angle, which depends on slope. Without per-pixel incidence angle, slope-driven brightness variation cannot be separated from genuine surface change.',
      resolveWith: ['a product with a metadata cube (NISAR GCOV)', 'an external DEM to derive local incidence angle', 'radiometric terrain correction'],
    });
  }

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

  const terrain = describeTerrain(imageData, render);
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

    // ── The imaging geometry (terrain is part of the measurement) ───
    terrain,

    // ── What this view cannot settle ────────────────────────────────
    ambiguities: describeAmbiguities({
      identification: id,
      render: {
        polarization: pol,
        multiLook: render.multiLook,
        speckleFilterType: render.speckleFilterType,
      },
      terrain,
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
