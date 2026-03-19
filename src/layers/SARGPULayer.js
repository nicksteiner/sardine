import { Layer, project32, picking } from '@deck.gl/core';
import { Model, Geometry } from '@luma.gl/core';
import GL from '@luma.gl/constants';
import { getColormapId, getStretchModeId, glslColormaps } from './shaders.js';
import { applyWebGLFilter, FILTER_TYPE_IDS } from '../gpu/webgl-spatial-filter.js';

/**
 * Colorblind mode IDs for shader uniform.
 * 0 = off, 1 = deuteranopia, 2 = protanopia, 3 = tritanopia
 */
export const COLORBLIND_MODE_IDS = {
  off: 0,
  deuteranopia: 1,
  protanopia: 2,
  tritanopia: 3,
};


/**
 * Simple vertex shader using deck.gl's project module
 */
const vs = `#version 300 es
#define SHADER_NAME sar-gpu-layer-vertex

in vec3 positions;
in vec2 texCoords;

out vec2 vTexCoord;

void main() {
  // Convert LNGLAT world coordinates to clip space using deck.gl's projection
  // positions is [longitude, latitude, 0] in world coordinates
  vec3 position64Low = vec3(0.0);  // No 64-bit precision needed for now
  vec3 offset = vec3(0.0);          // No offset
  vec4 commonPosition;              // Output from projection

  gl_Position = project_position_to_clipspace(positions, position64Low, offset, commonPosition);
  vTexCoord = texCoords;
}
`;

/**
 * Fragment shader - SAR processing (dB, colormap, stretch)
 * Supports both single-band (colormap) and RGB (3-band composite) modes.
 */
const fs = `#version 300 es
#define SHADER_NAME sar-gpu-layer-fragment

precision highp float;

// Single-band texture (always bound)
uniform sampler2D uTexture;
// RGB-mode textures (only used when uMode > 0.5)
uniform sampler2D uTextureG;
uniform sampler2D uTextureB;
// Mask texture (NISAR §4.3.3: 0=invalid, 1-5=valid, 255=fill)
uniform sampler2D uTextureMask;
// Coherence mask texture (GUNW: threshold low-coherence pixels)
uniform sampler2D uTextureCoherence;
// Incidence angle texture (for vertical displacement correction)
uniform sampler2D uTextureIncidence;
// Phase correction textures — individual layers, subtracted independently on GPU
uniform sampler2D uTexCorIono;       // unit 6: ionosphere (per-tile, same grid as data)
uniform sampler2D uTexCorTropo;      // unit 7: troposphere (full-extent, needs UV remap)
uniform sampler2D uTexCorSET;        // unit 8: solid earth tides (full-extent, needs UV remap)
uniform sampler2D uTexCorRamp;       // unit 9: planar ramp (full-extent, needs UV remap)
// Bounds for UV remapping: full-extent corrections cover imageBounds, tile covers tileBounds
uniform vec4 uImageBounds;          // [minX, minY, maxX, maxY] of full image
uniform vec4 uTileBounds;           // [minX, minY, maxX, maxY] of this tile

uniform float uMin;
uniform float uMax;
uniform float uUseDecibels;
uniform float uColormap;
uniform float uGamma;
uniform float uStretchMode;
uniform float uMode;  // 0 = single-band + colormap, 1 = RGB composite, 2 = H/Alpha/Entropy
uniform float uMaskInvalid;        // > 0.5 = hide invalid (0) and fill (255) pixels
uniform float uMaskLayoverShadow;  // > 0.5 = hide layover/shadow (mask < 100)
uniform float uUseCoherenceMask;  // > 0.5 = apply coherence/auxiliary mask
uniform float uCoherenceThreshold;  // Lower threshold (mask below this)
uniform float uCoherenceThresholdMax;  // Upper threshold (mask above this, for range mode)
uniform float uCoherenceMaskMode;  // 0 = mask below min, 1 = mask outside [min,max]
uniform float uVerticalDisplacement;  // > 0.5 = divide by cos(incidence angle)
// Per-correction enable flags (> 0.5 = subtract this correction)
uniform float uCorIono;
uniform float uCorTropo;
uniform float uCorSET;
uniform float uCorRamp;
// Per-channel min/max for RGB mode (falls back to uMin/uMax if equal)
uniform float uMinR;
uniform float uMaxR;
uniform float uMinG;
uniform float uMaxG;
uniform float uMinB;
uniform float uMaxB;
uniform float uSaturation;  // RGB saturation multiplier (1.0 = no change)
uniform float uColorblindMode;  // 0=off, 1=deuteranopia, 2=protanopia, 3=tritanopia

in vec2 vTexCoord;
out vec4 fragColor;

// ─── Shared: dB scaling + contrast + stretch ─────────────────────────

float processChannel(float amplitude, float cMin, float cMax) {
  float value;
  if (uUseDecibels > 0.5) {
    float db = 10.0 * log2(max(amplitude, 1e-10)) * 0.30103;
    value = (db - cMin) / (cMax - cMin);
  } else {
    value = (amplitude - cMin) / (cMax - cMin);
  }

  value = clamp(value, 0.0, 1.0);

  int stretchMode = int(uStretchMode + 0.5);
  if (stretchMode == 1) {
    value = sqrt(value);
  } else if (stretchMode == 2) {
    value = pow(value, uGamma);
  } else if (stretchMode == 3) {
    float gain = uGamma * 8.0;
    float raw = 1.0 / (1.0 + exp(-gain * (value - 0.5)));
    float lo = 1.0 / (1.0 + exp(gain * 0.5));
    float hi = 1.0 / (1.0 + exp(-gain * 0.5));
    value = (raw - lo) / (hi - lo);
  }

  return value;
}

// ─── Colormaps (imported from shaders.js - single source of truth) ──
${glslColormaps}

// ─── H/Alpha/Entropy: Cloude-Pottier eigendecomposition on GPU ───────
// Computes H (entropy), α (alpha angle), A (anisotropy) per fragment
// from 9 covariance matrix textures uploaded to units 0-8.
// Texture mapping in h-alpha mode:
//   unit 0 (uTexture)          → C11 (HHHH)
//   unit 1 (uTextureG)         → C22 (HVHV)
//   unit 2 (uTextureB)         → C33 (VVVV)
//   unit 3 (uTextureMask)      → C12_re (Re(HHHV))
//   unit 4 (uTextureCoherence) → C12_im (Im(HHHV))
//   unit 5 (uTextureIncidence) → C13_re (Re(HHVV))
//   unit 6 (uTexCorIono)       → C13_im (Im(HHVV))
//   unit 7 (uTexCorTropo)      → C23_re (Re(HVVV))
//   unit 8 (uTexCorSET)        → C23_im (Im(HVVV))

const float HA_SQRT2 = 1.41421356;
const float HA_LOG3  = 1.09861229;
const float HA_R2D   = 57.29577951;
const float HA_2PI3  = 2.09439510;

// Eigenvector alpha angle via cofactor of (T - λI), column 0.
// Returns angle in degrees [0, 90].
float haAlpha(float t11, float t22, float t33,
              vec2 t12, vec2 t13, vec2 t23,
              float absT23sq, float lam) {
  float v0 = (t22 - lam) * (t33 - lam) - absT23sq;
  // v1 = conj(t13)·t23 - conj(t12)·(t33-λ)
  vec2 v1 = vec2(
    t13.x*t23.x + t13.y*t23.y - t12.x*(t33 - lam),
    t13.x*t23.y - t13.y*t23.x + t12.y*(t33 - lam)
  );
  // v2 = conj(t12·t23) - conj(t13)·(t22-λ)
  vec2 v2 = vec2(
    t12.x*t23.x - t12.y*t23.y - t13.x*(t22 - lam),
    -(t12.x*t23.y + t12.y*t23.x) + t13.y*(t22 - lam)
  );
  float normSq = v0*v0 + dot(v1,v1) + dot(v2,v2);
  if (normSq <= 1e-20) return 45.0;
  return acos(min(abs(v0) / sqrt(normSq), 1.0)) * HA_R2D;
}

// ─── Main ────────────────────────────────────────────────────────────

void main() {
  if (uMode > 2.5) {
    // ── Dual-pol H/α/γ: 2×2 eigendecomposition + coherence passthrough ──
    // Texture layout: unit 0=C11(HHHH), 1=C22(HVHV), 2=γ(coherence),
    //                 3=C12_re(Re(HHHV)), 4=C12_im(Im(HHHV))
    float c11   = texture(uTexture, vTexCoord).r;           // HHHH
    float c22   = texture(uTextureG, vTexCoord).r;           // HVHV
    float c12re = texture(uTextureMask, vTexCoord).r;        // Re(HHHV)
    float c12im = texture(uTextureCoherence, vTexCoord).r;   // Im(HHHV)

    // Coherence: may need UV remap if full-extent texture (like incidence angle)
    // When imageBounds != tileBounds, remap UV from tile space to image space
    float gamma;
    vec4 ib = uImageBounds;
    vec4 tb = uTileBounds;
    bool needsRemap = (ib.x != tb.x || ib.y != tb.y || ib.z != tb.z || ib.w != tb.w);
    if (needsRemap) {
      vec2 geoPos = vec2(
        mix(tb.x, tb.z, vTexCoord.x),
        mix(tb.w, tb.y, vTexCoord.y)
      );
      vec2 cohUV = clamp(vec2(
        (geoPos.x - ib.x) / (ib.z - ib.x),
        (ib.w - geoPos.y) / (ib.w - ib.y)
      ), 0.0, 1.0);
      gamma = texture(uTextureB, cohUV).r;
    } else {
      gamma = texture(uTextureB, vTexCoord).r;
    }

    // Nodata: both diagonal terms zero
    if (c11 <= 0.0 && c22 <= 0.0) {
      fragColor = vec4(0.0);
      return;
    }

    // 2×2 eigenvalues via quadratic formula
    float trace = c11 + c22;
    float diff = (c11 - c22) / 2.0;
    float absC12sq = c12re * c12re + c12im * c12im;
    float disc = sqrt(diff * diff + absC12sq);
    float l1 = max(trace / 2.0 + disc, 0.0);
    float l2 = max(trace / 2.0 - disc, 0.0);

    float span = l1 + l2;
    if (span <= 1e-20) { fragColor = vec4(0.0); return; }

    // Pseudo-probabilities
    float p1 = l1 / span;
    float p2 = l2 / span;

    // Entropy: H = -Σ pi·log₂(pi)  — log base 2 for 2×2
    const float HA_LN2 = 0.693147180;
    float H = 0.0;
    if (p1 > 1e-10) H -= p1 * log(p1) / HA_LN2;
    if (p2 > 1e-10) H -= p2 * log(p2) / HA_LN2;

    // Eigenvector alpha: v = [l - C22, C12*], alpha = acos(|v0|/||v||)
    float v0_1 = l1 - c22;
    float normSq1 = v0_1 * v0_1 + absC12sq;
    float alpha1 = (normSq1 > 1e-20)
      ? acos(min(abs(v0_1) / sqrt(normSq1), 1.0)) * HA_R2D : 45.0;

    float v0_2 = l2 - c22;
    float normSq2 = v0_2 * v0_2 + absC12sq;
    float alpha2 = (normSq2 > 1e-20)
      ? acos(min(abs(v0_2) / sqrt(normSq2), 1.0)) * HA_R2D : 45.0;

    float alpha = p1 * alpha1 + p2 * alpha2;

    // Map H/α/γ through per-channel contrast + stretch
    vec3 rgb = vec3(
      processChannel(H, uMinR, uMaxR),
      processChannel(alpha, uMinG, uMaxG),
      processChannel(gamma, uMinB, uMaxB)
    );

    fragColor = vec4(rgb, 1.0);

  } else if (uMode > 1.5) {
    // ── H/Alpha/Entropy: full eigendecomposition in fragment shader ──
    // Read 9 covariance matrix elements from texture units 0–8
    float c11   = texture(uTexture, vTexCoord).r;           // HHHH
    float c22   = texture(uTextureG, vTexCoord).r;          // HVHV
    float c33   = texture(uTextureB, vTexCoord).r;          // VVVV
    float c12re = texture(uTextureMask, vTexCoord).r;       // Re(HHHV)
    float c12im = texture(uTextureCoherence, vTexCoord).r;  // Im(HHHV)
    float c13re = texture(uTextureIncidence, vTexCoord).r;  // Re(HHVV)
    float c13im = texture(uTexCorIono, vTexCoord).r;        // Im(HHVV)
    float c23re = texture(uTexCorTropo, vTexCoord).r;       // Re(HVVV)
    float c23im = texture(uTexCorSET, vTexCoord).r;         // Im(HVVV)

    // Nodata: all diagonal power == 0
    if (c11 <= 0.0 && c22 <= 0.0 && c33 <= 0.0) {
      fragColor = vec4(0.0);
      return;
    }

    // Build coherency matrix T3 = U·C·U†  (Pauli basis)
    float t11 = (c11 + c33 + 2.0*c13re) / 2.0;
    float t22v = (c11 + c33 - 2.0*c13re) / 2.0;
    float t33v = c22;
    vec2  t12 = vec2((c11 - c33) / 2.0, -c13im);
    vec2  t13 = vec2((c12re + c23re) / HA_SQRT2, (c12im - c23im) / HA_SQRT2);
    vec2  t23 = vec2((c12re - c23re) / HA_SQRT2, (c12im + c23im) / HA_SQRT2);

    float trace = t11 + t22v + t33v;
    if (trace <= 1e-20) { fragColor = vec4(0.0); return; }

    // Eigenvalues via Cardano's trigonometric method
    float absT12sq = dot(t12, t12);
    float absT13sq = dot(t13, t13);
    float absT23sq = dot(t23, t23);

    float m = trace / 3.0;
    float d1 = t11 - m, d2 = t22v - m, d3 = t33v - m;
    float p = (d1*d1 + d2*d2 + d3*d3 + 2.0*(absT12sq + absT13sq + absT23sq)) / 6.0;

    float l1, l2, l3;
    if (p <= 1e-20) {
      l1 = m; l2 = m; l3 = m;
    } else {
      // det(T - mI) via cofactor expansion
      float reT12T23T13c = (t12.x*t23.x - t12.y*t23.y)*t13.x
                         + (t12.x*t23.y + t12.y*t23.x)*t13.y;
      float detS = d1*(d2*d3 - absT23sq) - absT12sq*d3 - absT13sq*d2 + 2.0*reT12T23T13c;
      float q = detS / 2.0;
      float sqrtP = sqrt(p);
      float r = clamp(q / (p * sqrtP), -1.0, 1.0);
      float phi = acos(r) / 3.0;
      l1 = m + 2.0*sqrtP*cos(phi);
      l2 = m + 2.0*sqrtP*cos(phi - HA_2PI3);
      l3 = m + 2.0*sqrtP*cos(phi + HA_2PI3);
    }

    // Sort descending
    if (l1 < l2) { float t = l1; l1 = l2; l2 = t; }
    if (l1 < l3) { float t = l1; l1 = l3; l3 = t; }
    if (l2 < l3) { float t = l2; l2 = l3; l3 = t; }
    l1 = max(l1, 0.0); l2 = max(l2, 0.0); l3 = max(l3, 0.0);

    float span = l1 + l2 + l3;
    if (span <= 1e-20) { fragColor = vec4(0.0); return; }

    // Eigenvector alpha angles
    float a1 = haAlpha(t11, t22v, t33v, t12, t13, t23, absT23sq, l1);
    float a2 = haAlpha(t11, t22v, t33v, t12, t13, t23, absT23sq, l2);
    float a3 = haAlpha(t11, t22v, t33v, t12, t13, t23, absT23sq, l3);

    // Pseudo-probabilities
    float p1 = l1/span, p2 = l2/span, p3 = l3/span;

    // Entropy H = -Σ pi·log₃(pi)
    float H = 0.0;
    if (p1 > 1e-10) H -= p1 * log(p1) / HA_LOG3;
    if (p2 > 1e-10) H -= p2 * log(p2) / HA_LOG3;
    if (p3 > 1e-10) H -= p3 * log(p3) / HA_LOG3;

    // Mean alpha
    float alpha = p1*a1 + p2*a2 + p3*a3;

    // Anisotropy
    float A = (l2 + l3 > 1e-20) ? (l2 - l3) / (l2 + l3) : 0.0;

    // Map H/α/A through per-channel contrast + stretch (reuse processChannel)
    vec3 rgb = vec3(
      processChannel(H, uMinR, uMaxR),
      processChannel(alpha, uMinG, uMaxG),
      processChannel(A, uMinB, uMaxB)
    );

    fragColor = vec4(rgb, 1.0);

  } else if (uMode > 0.5) {
    // ── RGB composite mode: 3 separate R32F textures ──
    float ampR = texture(uTexture, vTexCoord).r;
    float ampG = texture(uTextureG, vTexCoord).r;
    float ampB = texture(uTextureB, vTexCoord).r;

    vec3 rgb = vec3(
      processChannel(ampR, uMinR, uMaxR),
      processChannel(ampG, uMinG, uMaxG),
      processChannel(ampB, uMinB, uMaxB)
    );

    // Saturation stretch: scale away from per-pixel luminance
    if (uSaturation != 1.0) {
      float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
      rgb = clamp(vec3(luma) + (rgb - vec3(luma)) * uSaturation, 0.0, 1.0);
    }

    // Colorblind-safe remap: replace RGB color cube with CVD-distinguishable colors.
    // Each column is the display color for that data channel (R, G, B).
    int cvdMode = int(uColorblindMode + 0.5);
    if (cvdMode == 1 || cvdMode == 2) {
      // Deuteranopia / Protanopia (red-green): Orange / Blue / Light
      mat3 cvd = mat3(
        1.0, 0.5, 0.0,    // col0: data-R → Orange
        0.0, 0.35, 1.0,   // col1: data-G → Blue
        0.85, 0.85, 0.75  // col2: data-B → Warm light gray
      );
      rgb = clamp(cvd * rgb, 0.0, 1.0);
    } else if (cvdMode == 3) {
      // Tritanopia (blue-yellow): Red / Green / Magenta
      mat3 cvd = mat3(
        1.0, 0.1, 0.1,   // col0: data-R → Red
        0.1, 1.0, 0.1,   // col1: data-G → Green
        0.7, 0.0, 0.7    // col2: data-B → Magenta (not blue)
      );
      rgb = clamp(cvd * rgb, 0.0, 1.0);
    }

    // Any channel valid → visible
    bool anyValid = (ampR != 0.0 && !isnan(ampR)) ||
                    (ampG != 0.0 && !isnan(ampG)) ||
                    (ampB != 0.0 && !isnan(ampB));
    float alpha = anyValid ? 1.0 : 0.0;

    // Apply mask: NISAR uint8 mask
    // 0=invalid, 1=valid, 2+=layover/shadow flags, 255=fill
    if (uMaskInvalid > 0.5 || uMaskLayoverShadow > 0.5) {
      float maskVal = texture(uTextureMask, vTexCoord).r;
      if (uMaskInvalid > 0.5 && (maskVal < 0.5 || maskVal > 254.5)) alpha = 0.0;
      // Layover/shadow: mask > 1 (not pure-valid) and not fill
      if (uMaskLayoverShadow > 0.5 && maskVal > 1.5 && maskVal < 254.5) alpha = 0.0;
    }

    // Coherence/auxiliary mask (same logic as single-band path)
    if (uUseCoherenceMask > 0.5) {
      float auxVal = texture(uTextureCoherence, vTexCoord).r;
      if (isnan(auxVal)) {
        alpha = 0.0;
      } else if (uCoherenceMaskMode < 0.5) {
        if (auxVal < uCoherenceThreshold) alpha = 0.0;
      } else {
        if (auxVal < uCoherenceThreshold || auxVal > uCoherenceThresholdMax) alpha = 0.0;
      }
    }

    fragColor = vec4(rgb, alpha);
  } else {
    // ── Single-band mode: R32F texture + colormap ──
    float amplitude = texture(uTexture, vTexCoord).r;

    // Phase corrections: subtract each enabled correction directly from GPU textures
    // GUNW nodata is NaN (not zero) — zero phase is valid (no displacement)
    if (!isnan(amplitude)) {
      // Ionosphere: per-tile texture, same grid as data — use vTexCoord directly
      if (uCorIono > 0.5) {
        float v = texture(uTexCorIono, vTexCoord).r;
        if (!isnan(v)) amplitude -= v;
      }
      // Full-extent corrections: remap tile UV → image UV for proper sampling
      if (uCorTropo > 0.5 || uCorSET > 0.5 || uCorRamp > 0.5) {
        // vTexCoord mapping: x: 0→west(minX), 1→east(maxX)
        //                    y: 0→north(maxY), 1→south(minY) (image is north-up)
        vec2 geoPos = vec2(
          mix(uTileBounds.x, uTileBounds.z, vTexCoord.x),
          mix(uTileBounds.w, uTileBounds.y, vTexCoord.y)
        );
        // Map geo position to correction texture UV (correction also north-up: y=0 is north)
        vec2 corUV = vec2(
          (geoPos.x - uImageBounds.x) / (uImageBounds.z - uImageBounds.x),
          (uImageBounds.w - geoPos.y) / (uImageBounds.w - uImageBounds.y)
        );
        // Clamp to valid range (tiles at image edge may extend slightly)
        corUV = clamp(corUV, 0.0, 1.0);

        if (uCorTropo > 0.5) {
          float v = texture(uTexCorTropo, corUV).r;
          if (!isnan(v)) amplitude -= v;
        }
        if (uCorSET > 0.5) {
          float v = texture(uTexCorSET, corUV).r;
          if (!isnan(v)) amplitude -= v;
        }
        if (uCorRamp > 0.5) {
          float v = texture(uTexCorRamp, corUV).r;
          if (!isnan(v)) amplitude -= v;
        }
      }
    }

    // Vertical displacement: divide LOS by cos(θ) to get vertical component
    // Incidence angle is a full-extent grid — remap UV like cube corrections
    if (uVerticalDisplacement > 0.5) {
      vec2 incGeoPos = vec2(
        mix(uTileBounds.x, uTileBounds.z, vTexCoord.x),
        mix(uTileBounds.w, uTileBounds.y, vTexCoord.y)
      );
      vec2 incUV = clamp(vec2(
        (incGeoPos.x - uImageBounds.x) / (uImageBounds.z - uImageBounds.x),
        (uImageBounds.w - incGeoPos.y) / (uImageBounds.w - uImageBounds.y)
      ), 0.0, 1.0);
      float thetaDeg = texture(uTextureIncidence, incUV).r;
      if (!isnan(thetaDeg) && thetaDeg > 0.0) {
        float thetaRad = thetaDeg * 3.14159265 / 180.0;
        amplitude = amplitude / cos(thetaRad);
      }
    }

    float value = processChannel(amplitude, uMin, uMax);

    vec3 rgb;
    int colormapId = int(uColormap + 0.5);
    if (colormapId == 0) {
      rgb = grayscale(value);
    } else if (colormapId == 1) {
      rgb = viridis(value);
    } else if (colormapId == 2) {
      rgb = inferno(value);
    } else if (colormapId == 3) {
      rgb = plasma(value);
    } else if (colormapId == 4) {
      rgb = phaseColormap(value);
    } else if (colormapId == 5) {
      rgb = twilightMap(value);
    } else if (colormapId == 6) {
      rgb = sardineMap(value);
    } else if (colormapId == 7) {
      rgb = floodMap(value);
    } else if (colormapId == 8) {
      rgb = divergingMap(value);
    } else if (colormapId == 9) {
      rgb = polarimetricMap(value);
    } else if (colormapId == 10) {
      rgb = labelMap(value);
    } else if (colormapId == 11) {
      rgb = rdbuMap(value);
    } else if (colormapId == 12) {
      rgb = romaOMap(value);
    } else {
      rgb = grayscale(value);
    }

    float alpha = (amplitude == 0.0 || isnan(amplitude)) ? 0.0 : 1.0;

    // Apply mask: NISAR uint8 (0=invalid, 1=valid, 2+=layover/shadow, 255=fill)
    if (uMaskInvalid > 0.5 || uMaskLayoverShadow > 0.5) {
      float maskVal = texture(uTextureMask, vTexCoord).r;
      if (uMaskInvalid > 0.5 && (maskVal < 0.5 || maskVal > 254.5)) alpha = 0.0;
      if (uMaskLayoverShadow > 0.5 && maskVal > 1.5 && maskVal < 254.5) alpha = 0.0;
    }

    // Auxiliary mask (coherence for GUNW, incidence angle for GCOV)
    if (uUseCoherenceMask > 0.5) {
      float auxVal = texture(uTextureCoherence, vTexCoord).r;
      if (isnan(auxVal)) {
        alpha = 0.0;
      } else if (uCoherenceMaskMode < 0.5) {
        // Mode 0: mask below min threshold (coherence mode)
        if (auxVal < uCoherenceThreshold) alpha = 0.0;
      } else {
        // Mode 1: mask outside [min, max] range (incidence angle mode)
        if (auxVal < uCoherenceThreshold || auxVal > uCoherenceThresholdMax) alpha = 0.0;
      }
    }

    fragColor = vec4(rgb, alpha);
  }
}
`;

/**
 * SARGPULayer - Custom GPU-accelerated SAR rendering layer
 *
 * Pure GPU pipeline: R32F texture upload → shader processing → display
 * No CPU preprocessing - all dB/colormap/stretch done in fragment shader
 */
export class SARGPULayer extends Layer {
  getShaders() {
    return {
      vs,
      fs,
      modules: [project32, picking]  // Use deck.gl's projection and picking modules
    };
  }

  initializeState() {
    // Initialize state - create geometry in updateState when we have bounds
    this.setState({ needsGeometryUpdate: true });

    // Setup WebGL context loss/restore handlers
    const { gl } = this.context;
    if (gl && gl.canvas) {
      // Store bound handlers so we can remove them in finalizeState
      this.handleContextLost = (event) => {
        event.preventDefault(); // Prevent default context loss behavior
        console.warn('[SARGPULayer] WebGL context lost');
        this.setState({ contextLost: true });
      };

      this.handleContextRestored = () => {
        console.log('[SARGPULayer] WebGL context restored, recreating resources');
        this.setState({
          contextLost: false,
          needsGeometryUpdate: true,
          model: null,
          texture: null,
          textureG: null,
          textureB: null,
          textureMask: null,
          textureCoherence: null,
          textureIncidence: null,
          texCorIono: null,
          texCorTropo: null,
          texCorSET: null,
          texCorRamp: null,
          texCov12Re: null,
          texCov12Im: null,
          texCov13Re: null,
          texCov13Im: null,
          texCov23Re: null,
          texCov23Im: null,
        });
        // Trigger re-render by setting needsUpdate
        this.setNeedsUpdate();
      };

      gl.canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
      gl.canvas.addEventListener('webglcontextrestored', this.handleContextRestored, false);
    }
  }

  // Override: we draw a static quad, not instanced rendering.
  // Return 0 so deck.gl skips attribute buffer management entirely.
  // Our draw() renders the geometry directly via model.draw().
  getNumInstances() {
    return 0;
  }

  updateState({ props, oldProps }) {
    const { gl } = this.context;
    const { data, width, height, bounds } = props;

    // Skip updates if WebGL context is lost
    if (this.state.contextLost) {
      console.warn('[SARGPULayer] Skipping update while WebGL context is lost');
      return;
    }

    // Create or update model geometry when bounds change.
    // Shader program is compiled only once; subsequent bounds changes just
    // update the vertex attributes via setGeometry() to avoid recompilation.
    if (this.state.needsGeometryUpdate || bounds !== oldProps.bounds) {
      if (!bounds || bounds.length !== 4) {
        console.error('[SARGPULayer] Cannot create geometry without valid bounds');
        return;
      }

      const [minX, minY, maxX, maxY] = bounds;

      const positions = new Float32Array([
        minX, minY, 0,  maxX, minY, 0,  maxX, maxY, 0,
        minX, minY, 0,  maxX, maxY, 0,  minX, maxY, 0
      ]);

      const texCoords = new Float32Array([
        0, 1,  1, 1,  1, 0,
        0, 1,  1, 0,  0, 0
      ]);

      const geometry = new Geometry({
        topology: 'triangle-list',
        attributes: {
          positions: { size: 3, value: positions },
          texCoords: { size: 2, value: texCoords }
        }
      });

      if (this.state.model && !this.state.needsGeometryUpdate) {
        // Model exists and shader hasn't changed — just update geometry
        this.state.model.setGeometry(geometry);
      } else {
        // First creation or context restore — compile shader + create model
        if (this.state.model) {
          this.state.model.delete();
        }

        let model;
        try {
          model = new Model(gl, {
            ...this.getShaders(),
            geometry,
            parameters: {
              blend: true,
              blendFunc: [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA],
              depthTest: false
            }
          });
        } catch (err) {
          console.error('[SARGPULayer] Shader compilation failed:', err.message);
          const infoLog = err.infoLog || err.shaderLog || '';
          if (infoLog) console.error('[SARGPULayer] Shader log:', infoLog);
          return;
        }

        this.setState({ model, needsGeometryUpdate: false });
      }
    }

    // Upload R32F texture(s) when data changes
    const { dataR, dataG, dataB, mode = 'single' } = props;
    const isRGB = mode === 'rgb';
    const isHAlpha = mode === 'h-alpha';
    const isDualPolHAlpha = mode === 'dual-pol-h-alpha';

    if (isRGB || isHAlpha || isDualPolHAlpha) {
      // RGB / H-Alpha mode: upload 3 separate R32F textures (diagonal covariance or RGB bands)
      const rChanged = dataR !== oldProps.dataR;
      const gChanged = dataG !== oldProps.dataG;
      const bChanged = dataB !== oldProps.dataB;
      const sizeChanged = width !== oldProps.width || height !== oldProps.height;

      if (dataR && dataG && dataB && (rChanged || gChanged || bChanged || sizeChanged)) {
        const texR = this._createR32FTexture(dataR, width, height);
        const texG = this._createR32FTexture(dataG, width, height);
        const texB = this._createR32FTexture(dataB, width, height);

        if (texR && texG && texB) {
          // Clean up old textures
          if (this.state.texture) gl.deleteTexture(this.state.texture);
          if (this.state.textureG) gl.deleteTexture(this.state.textureG);
          if (this.state.textureB) gl.deleteTexture(this.state.textureB);

          this.setState({ texture: texR, textureG: texG, textureB: texB });
        } else {
          console.error('[SARGPULayer] Failed to create one or more RGB textures');
        }
      }
    } else if (data && (data !== oldProps.data || width !== oldProps.width || height !== oldProps.height)) {
      const texture = this._createR32FTexture(data, width, height);

      if (texture) {
        if (this.state.texture) gl.deleteTexture(this.state.texture);
        this.setState({ texture });
      }
    }

    // ── Speckle filter (WebGL2 FBO pass — no CPU readback) ─────────────
    const { speckleFilterType, speckleKernelSize = 7, speckleENL = 4, speckleDamping = 1.0 } = props;
    const filterActive = speckleFilterType && speckleFilterType !== 'none';
    const filterChanged = speckleFilterType !== oldProps.speckleFilterType ||
      speckleKernelSize !== oldProps.speckleKernelSize ||
      (speckleENL || 4) !== (oldProps.speckleENL || 4) ||
      (speckleDamping || 1) !== (oldProps.speckleDamping || 1);

    // Detect whether any raw texture was just (re-)uploaded this cycle
    const singleDataChanged = !isRGB && data && (data !== oldProps.data || width !== oldProps.width || height !== oldProps.height);
    const rgbDataChanged = isRGB && dataR && dataG && dataB &&
      (dataR !== oldProps.dataR || dataG !== oldProps.dataG || dataB !== oldProps.dataB ||
       width !== oldProps.width || height !== oldProps.height);
    const anyDataChanged = singleDataChanged || rgbDataChanged;

    // Clean up old filtered textures when filter is deactivated or params change
    if (filterChanged || anyDataChanged) {
      if (this.state.filteredTexture) { gl.deleteTexture(this.state.filteredTexture); }
      if (this.state.filteredTextureG) { gl.deleteTexture(this.state.filteredTextureG); }
      if (this.state.filteredTextureB) { gl.deleteTexture(this.state.filteredTextureB); }
      this.setState({ filteredTexture: null, filteredTextureG: null, filteredTextureB: null });
    }

    // Run filter if active and data or params changed
    if (filterActive && (anyDataChanged || filterChanged)) {
      const filterOpts = {
        type: speckleFilterType,
        kernelSize: speckleKernelSize,
        enl: speckleENL || 4,
        damping: speckleDamping || 1.0,
      };

      if (isRGB && this.state.texture && this.state.textureG && this.state.textureB) {
        const fR = applyWebGLFilter(gl, this.state.texture, width, height, filterOpts);
        const fG = applyWebGLFilter(gl, this.state.textureG, width, height, filterOpts);
        const fB = applyWebGLFilter(gl, this.state.textureB, width, height, filterOpts);
        if (fR) this.setState({ filteredTexture: fR });
        if (fG) this.setState({ filteredTextureG: fG });
        if (fB) this.setState({ filteredTextureB: fB });
      } else if (!isRGB && this.state.texture) {
        const fTex = applyWebGLFilter(gl, this.state.texture, width, height, filterOpts);
        if (fTex) this.setState({ filteredTexture: fTex });
      }
    }

    // Upload mask texture when dataMask changes
    const { dataMask } = props;
    if (dataMask && (dataMask !== oldProps.dataMask || width !== oldProps.width || height !== oldProps.height)) {
      const texMask = this._createR32FTexture(dataMask, width, height, true);
      if (texMask) {
        if (this.state.textureMask) gl.deleteTexture(this.state.textureMask);
        this.setState({ textureMask: texMask });
      }
    }

    // Upload coherence texture when dataCoherence changes
    const { dataCoherence, coherenceWidth, coherenceHeight } = props;
    const cohW = coherenceWidth || width;
    const cohH = coherenceHeight || height;
    if (dataCoherence && (dataCoherence !== oldProps.dataCoherence || cohW !== (oldProps.coherenceWidth || oldProps.width) || cohH !== (oldProps.coherenceHeight || oldProps.height))) {
      const texCoh = this._createR32FTexture(dataCoherence, cohW, cohH);
      if (texCoh) {
        if (this.state.textureCoherence) gl.deleteTexture(this.state.textureCoherence);
        this.setState({ textureCoherence: texCoh });
      }
    }

    // Upload incidence angle texture (for vertical displacement correction)
    const { dataIncidence, incidenceWidth, incidenceHeight } = props;
    const incW = incidenceWidth || width;
    const incH = incidenceHeight || height;
    if (dataIncidence && (dataIncidence !== oldProps.dataIncidence || incW !== (oldProps.incidenceWidth || oldProps.width) || incH !== (oldProps.incidenceHeight || oldProps.height))) {
      const texInc = this._createR32FTexture(dataIncidence, incW, incH);
      if (texInc) {
        if (this.state.textureIncidence) gl.deleteTexture(this.state.textureIncidence);
        this.setState({ textureIncidence: texInc });
      }
    }

    // Upload individual phase correction textures (each at its own native resolution)
    const corSlots = [
      { prop: 'dataCorIono', state: 'texCorIono', wProp: 'corIonoWidth', hProp: 'corIonoHeight' },
      { prop: 'dataCorTropo', state: 'texCorTropo', wProp: 'corTropoWidth', hProp: 'corTropoHeight' },
      { prop: 'dataCorSET', state: 'texCorSET', wProp: 'corSETWidth', hProp: 'corSETHeight' },
      { prop: 'dataCorRamp', state: 'texCorRamp', wProp: 'corRampWidth', hProp: 'corRampHeight' },
    ];
    for (const slot of corSlots) {
      const data = props[slot.prop];
      const oldData = oldProps[slot.prop];
      const w = props[slot.wProp] || width;
      const h = props[slot.hProp] || height;
      if (data && (data !== oldData || w !== (oldProps[slot.wProp] || oldProps.width) || h !== (oldProps[slot.hProp] || oldProps.height))) {
        const tex = this._createR32FTexture(data, w, h);
        if (tex) {
          if (this.state[slot.state]) gl.deleteTexture(this.state[slot.state]);
          this.setState({ [slot.state]: tex });
        }
      }
      // Clear when removed
      if (!data && oldData && this.state[slot.state]) {
        gl.deleteTexture(this.state[slot.state]);
        this.setState({ [slot.state]: null });
      }
    }

    // Upload off-diagonal covariance textures for GPU eigendecomposition modes
    // H/Alpha uses 6 textures (units 3-8), dual-pol uses 2 (units 3-4)
    if (isHAlpha || isDualPolHAlpha) {
      const covSlots = [
        { prop: 'dataCov12Re', state: 'texCov12Re' },
        { prop: 'dataCov12Im', state: 'texCov12Im' },
        { prop: 'dataCov13Re', state: 'texCov13Re' },
        { prop: 'dataCov13Im', state: 'texCov13Im' },
        { prop: 'dataCov23Re', state: 'texCov23Re' },
        { prop: 'dataCov23Im', state: 'texCov23Im' },
      ];
      for (const slot of covSlots) {
        const covData = props[slot.prop];
        const oldCovData = oldProps[slot.prop];
        if (covData && (covData !== oldCovData || width !== oldProps.width || height !== oldProps.height)) {
          const tex = this._createR32FTexture(covData, width, height);
          if (tex) {
            if (this.state[slot.state]) gl.deleteTexture(this.state[slot.state]);
            this.setState({ [slot.state]: tex });
          }
        }
      }
    }
  }

  _createR32FTexture(data, width, height, nearest = false) {
    const { gl } = this.context;

    try {
      const expected = width * height;
      let texData = data;

      // Pad undersized data (edge tiles may have fewer pixels than width×height)
      if (data.length < expected) {
        texData = new Float32Array(expected);
        texData.set(data);
      }

      // Create R32F texture using raw WebGL2 API
      // luma.gl Texture2D wrapper doesn't support R32F well in v8.5
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);

      // Upload float data as R32F
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,              // mipmap level
        gl.R32F,        // internal format
        width,
        height,
        0,              // border (must be 0)
        gl.RED,         // format
        gl.FLOAT,       // type
        texData         // Float32Array
      );

      // Set texture filtering parameters
      const filter = nearest ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);

      // Check for GL errors (VRAM exhaustion won't throw, it sets an error flag)
      const glErr = gl.getError();
      if (glErr !== gl.NO_ERROR) {
        console.error(`[SARGPULayer] GL error 0x${glErr.toString(16)} after texImage2D (${width}x${height})`);
        gl.deleteTexture(texture);
        return null;
      }

      // Return raw WebGL texture (compatible with luma.gl's model.setUniforms)
      return texture;
    } catch (err) {
      console.error('[SARGPULayer] Texture creation failed:', err);
      return null;
    }
  }

  draw({ uniforms }) {
    const { model, texture, textureG, textureB, textureMask, textureCoherence,
            textureIncidence, texCorIono, texCorTropo, texCorSET, texCorRamp,
            filteredTexture, filteredTextureG, filteredTextureB,
            texCov12Re, texCov12Im, texCov13Re, texCov13Im, texCov23Re, texCov23Im } = this.state;

    if (!model || !texture) return;

    // Use filtered textures when available (GPU FBO filter output)
    const displayTex = filteredTexture || texture;
    const displayTexG = filteredTextureG || textureG;
    const displayTexB = filteredTextureB || textureB;

    const {
      contrastLimits = [-25, 0],
      useDecibels = true,
      colormap = 'grayscale',
      gamma = 1.0,
      stretchMode = 'linear',
      rgbSaturation = 1.0,
      colorblindMode = 'off',
      mode = 'single',
      maskInvalid = false,
      maskLayoverShadow = false,
      useCoherenceMask = false,
      coherenceThreshold = 0.3,
      coherenceThresholdMax = 1.0,
      coherenceMaskMode = 0,
      verticalDisplacement = false,
      corIono = false,
      corTropo = false,
      corSET = false,
      corRamp = false,
      bounds = [-180, -90, 180, 90],
      imageBounds = null,
    } = this.props;

    const isRGB = mode === 'rgb';
    const isHAlpha = mode === 'h-alpha';
    const isDualPolHAlpha = mode === 'dual-pol-h-alpha';

    try {
      const { gl } = this.context;

      // Bind R texture to unit 0 (always) — use filtered if available
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, displayTex);

      // Resolve per-channel contrast limits
      // contrastLimits can be [min, max] (uniform) or {R: [min,max], G: [min,max], B: [min,max]}
      let uMin, uMax, uMinR, uMaxR, uMinG, uMaxG, uMinB, uMaxB;

      if ((isRGB || isHAlpha || isDualPolHAlpha) && contrastLimits && !Array.isArray(contrastLimits)) {
        // Per-channel object: {R: [min,max], G: [min,max], B: [min,max]}
        const rLim = contrastLimits.R || [-25, 0];
        const gLim = contrastLimits.G || [-25, 0];
        const bLim = contrastLimits.B || [-25, 0];
        uMinR = rLim[0]; uMaxR = rLim[1];
        uMinG = gLim[0]; uMaxG = gLim[1];
        uMinB = bLim[0]; uMaxB = bLim[1];
        // Set single-band min/max to R channel as fallback
        uMin = uMinR; uMax = uMaxR;
      } else {
        // Uniform array: [min, max]
        const lim = Array.isArray(contrastLimits) ? contrastLimits : [-25, 0];
        uMin = lim[0]; uMax = lim[1];
        uMinR = uMin; uMaxR = uMax;
        uMinG = uMin; uMaxG = uMax;
        uMinB = uMin; uMaxB = uMax;
      }

      const layerUniforms = {
        ...uniforms,
        uTexture: 0,
        uMin, uMax,
        uMinR, uMaxR,
        uMinG, uMaxG,
        uMinB, uMaxB,
        uSaturation: rgbSaturation,
        uColorblindMode: COLORBLIND_MODE_IDS[colorblindMode] || 0,
        uUseDecibels: (useDecibels && !isHAlpha && !isDualPolHAlpha) ? 1.0 : 0.0,
        uColormap: getColormapId(colormap),
        uGamma: gamma,
        uStretchMode: getStretchModeId(stretchMode),
        uMode: isDualPolHAlpha ? 3.0 : (isHAlpha ? 2.0 : (isRGB ? 1.0 : 0.0)),
        uMaskInvalid: (maskInvalid && textureMask) ? 1.0 : 0.0,
        uMaskLayoverShadow: (maskLayoverShadow && textureMask) ? 1.0 : 0.0,
        uTextureMask: 3,
        uUseCoherenceMask: (useCoherenceMask && textureCoherence) ? 1.0 : 0.0,
        uCoherenceThreshold: coherenceThreshold,
        uCoherenceThresholdMax: coherenceThresholdMax,
        uCoherenceMaskMode: coherenceMaskMode,
        uTextureCoherence: 4,
        uVerticalDisplacement: (verticalDisplacement && textureIncidence) ? 1.0 : 0.0,
        uTextureIncidence: 5,
        // Individual phase correction textures
        uCorIono: (corIono && texCorIono) ? 1.0 : 0.0,
        uTexCorIono: 6,
        uCorTropo: (corTropo && texCorTropo) ? 1.0 : 0.0,
        uTexCorTropo: 7,
        uCorSET: (corSET && texCorSET) ? 1.0 : 0.0,
        uTexCorSET: 8,
        uCorRamp: (corRamp && texCorRamp) ? 1.0 : 0.0,
        uTexCorRamp: 9,
        // Bounds for full-extent correction UV remapping
        uTileBounds: bounds,
        uImageBounds: imageBounds || bounds,
      };

      if ((isRGB || isHAlpha || isDualPolHAlpha) && displayTexG && displayTexB) {
        // Bind G and B textures to units 1 and 2
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, displayTexG);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, displayTexB);

        layerUniforms.uTextureG = 1;
        layerUniforms.uTextureB = 2;
      }

      // Dual-pol H/α/γ mode: bind C12_re and C12_im to units 3-4
      if (isDualPolHAlpha && texCov12Re && texCov12Im) {
        gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, texCov12Re);
        gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, texCov12Im);
        layerUniforms.uTextureMask = 3;
        layerUniforms.uTextureCoherence = 4;
      }

      // H/Alpha mode: bind 6 off-diagonal covariance textures to units 3–8
      if (isHAlpha && texCov12Re && texCov12Im && texCov13Re && texCov13Im && texCov23Re && texCov23Im) {
        gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, texCov12Re);
        gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, texCov12Im);
        gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, texCov13Re);
        gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, texCov13Im);
        gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, texCov23Re);
        gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, texCov23Im);
        layerUniforms.uTextureMask = 3;
        layerUniforms.uTextureCoherence = 4;
        layerUniforms.uTextureIncidence = 5;
        layerUniforms.uTexCorIono = 6;
        layerUniforms.uTexCorTropo = 7;
        layerUniforms.uTexCorSET = 8;
      }

      // Bind mask texture to unit 3
      if (textureMask) {
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, textureMask);
      }

      // Bind coherence texture to unit 4
      if (textureCoherence) {
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, textureCoherence);
      }

      // Bind incidence angle texture to unit 5
      if (textureIncidence) {
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, textureIncidence);
      }

      // Bind individual phase correction textures to units 6–9
      if (texCorIono) { gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, texCorIono); }
      if (texCorTropo) { gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, texCorTropo); }
      if (texCorSET) { gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, texCorSET); }
      if (texCorRamp) { gl.activeTexture(gl.TEXTURE9); gl.bindTexture(gl.TEXTURE_2D, texCorRamp); }

      model.setUniforms(layerUniforms);
      model.draw();

      // Unbind textures
      if (texCorRamp) { gl.activeTexture(gl.TEXTURE9); gl.bindTexture(gl.TEXTURE_2D, null); }
      if (texCorSET) { gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, null); }
      if (texCorTropo) { gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, null); }
      if (texCorIono) { gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, null); }
      if (textureIncidence) {
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      if (textureCoherence) {
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      if (textureMask) {
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      if (isDualPolHAlpha) {
        // Unbind covariance textures from units 3–4
        gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, null);
      }
      if (isHAlpha) {
        // Unbind covariance textures from units 3–8
        for (let u = 8; u >= 3; u--) {
          gl.activeTexture(gl.TEXTURE0 + u);
          gl.bindTexture(gl.TEXTURE_2D, null);
        }
      }
      if (isRGB || isHAlpha || isDualPolHAlpha) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
    } catch (err) {
      console.error('[SARGPULayer] Draw error:', err);
    }
  }

  finalizeState() {
    super.finalizeState();

    // Remove WebGL context loss/restore event listeners
    const { gl } = this.context;
    if (gl && gl.canvas) {
      if (this.handleContextLost) {
        gl.canvas.removeEventListener('webglcontextlost', this.handleContextLost, false);
      }
      if (this.handleContextRestored) {
        gl.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored, false);
      }
    }

    // Clean up resources
    if (this.state.model) this.state.model.delete();
    if (gl) {
      if (this.state.texture) gl.deleteTexture(this.state.texture);
      if (this.state.textureG) gl.deleteTexture(this.state.textureG);
      if (this.state.textureB) gl.deleteTexture(this.state.textureB);
      if (this.state.textureMask) gl.deleteTexture(this.state.textureMask);
      if (this.state.textureCoherence) gl.deleteTexture(this.state.textureCoherence);
      if (this.state.textureIncidence) gl.deleteTexture(this.state.textureIncidence);
      if (this.state.texCorIono) gl.deleteTexture(this.state.texCorIono);
      if (this.state.texCorTropo) gl.deleteTexture(this.state.texCorTropo);
      if (this.state.texCorSET) gl.deleteTexture(this.state.texCorSET);
      if (this.state.texCorRamp) gl.deleteTexture(this.state.texCorRamp);
      // Clean up FBO-filtered textures
      if (this.state.filteredTexture) gl.deleteTexture(this.state.filteredTexture);
      if (this.state.filteredTextureG) gl.deleteTexture(this.state.filteredTextureG);
      if (this.state.filteredTextureB) gl.deleteTexture(this.state.filteredTextureB);
      // Clean up H/Alpha covariance textures
      if (this.state.texCov12Re) gl.deleteTexture(this.state.texCov12Re);
      if (this.state.texCov12Im) gl.deleteTexture(this.state.texCov12Im);
      if (this.state.texCov13Re) gl.deleteTexture(this.state.texCov13Re);
      if (this.state.texCov13Im) gl.deleteTexture(this.state.texCov13Im);
      if (this.state.texCov23Re) gl.deleteTexture(this.state.texCov23Re);
      if (this.state.texCov23Im) gl.deleteTexture(this.state.texCov23Im);
    }
  }
}

SARGPULayer.layerName = 'SARGPULayer';
SARGPULayer.defaultProps = {
  // Single-band mode (use {length:0} not null — deck.gl's count() requires an object)
  data: { type: 'object', value: {length: 0}, compare: false },
  // RGB mode (3 separate Float32Arrays)
  dataR: { type: 'object', value: null, compare: false },
  dataG: { type: 'object', value: null, compare: false },
  dataB: { type: 'object', value: null, compare: false },
  // Mask data (Float32Array, uint8 values: 0=invalid, 1-5=valid, 255=fill)
  dataMask: { type: 'object', value: null, compare: false },
  maskInvalid: { type: 'boolean', value: false, compare: true },
  maskLayoverShadow: { type: 'boolean', value: false, compare: true },
  // Coherence mask (GUNW: Float32Array of coherence values 0–1)
  dataCoherence: { type: 'object', value: null, compare: false },
  coherenceWidth: { type: 'number', value: 0, min: 0 },
  coherenceHeight: { type: 'number', value: 0, min: 0 },
  useCoherenceMask: { type: 'boolean', value: false, compare: true },
  coherenceThreshold: { type: 'number', value: 0.3, min: 0, max: 90.0, compare: true },
  coherenceThresholdMax: { type: 'number', value: 1.0, min: 0, max: 90.0, compare: true },
  coherenceMaskMode: { type: 'number', value: 0, min: 0, max: 1, compare: true },
  // Incidence angle texture for vertical displacement correction
  dataIncidence: { type: 'object', value: null, compare: false },
  incidenceWidth: { type: 'number', value: 0, min: 0 },
  incidenceHeight: { type: 'number', value: 0, min: 0 },
  verticalDisplacement: { type: 'boolean', value: false, compare: true },
  // Individual phase correction textures (each at native resolution)
  dataCorIono: { type: 'object', value: null, compare: false },
  corIonoWidth: { type: 'number', value: 0, min: 0 },
  corIonoHeight: { type: 'number', value: 0, min: 0 },
  corIono: { type: 'boolean', value: false, compare: true },
  dataCorTropo: { type: 'object', value: null, compare: false },
  corTropoWidth: { type: 'number', value: 0, min: 0 },
  corTropoHeight: { type: 'number', value: 0, min: 0 },
  corTropo: { type: 'boolean', value: false, compare: true },
  dataCorSET: { type: 'object', value: null, compare: false },
  corSETWidth: { type: 'number', value: 0, min: 0 },
  corSETHeight: { type: 'number', value: 0, min: 0 },
  corSET: { type: 'boolean', value: false, compare: true },
  dataCorRamp: { type: 'object', value: null, compare: false },
  corRampWidth: { type: 'number', value: 0, min: 0 },
  corRampHeight: { type: 'number', value: 0, min: 0 },
  corRamp: { type: 'boolean', value: false, compare: true },
  mode: { type: 'string', value: 'single', compare: true },  // 'single' or 'rgb'
  width: { type: 'number', value: 256, min: 1 },
  height: { type: 'number', value: 256, min: 1 },
  bounds: { type: 'array', value: [-180, -90, 180, 90], compare: true },
  imageBounds: { type: 'array', value: null, compare: true },
  // type: 'object' to accept both [min,max] and {R:[],G:[],B:[]} formats
  contrastLimits: { type: 'object', value: [-25, 0], compare: true },
  useDecibels: { type: 'boolean', value: true, compare: true },
  colormap: { type: 'string', value: 'grayscale', compare: true },
  gamma: { type: 'number', value: 1.0, min: 0.1, max: 10.0, compare: true },
  stretchMode: { type: 'string', value: 'linear', compare: true },
  rgbSaturation: { type: 'number', value: 1.0, min: 0.0, max: 5.0, compare: true },
  colorblindMode: { type: 'string', value: 'off', compare: true },
  // Speckle filter (WebGL2 FBO pass — WebGPU compute retained for export pipeline)
  speckleFilterType: { type: 'string', value: 'none', compare: true },
  speckleKernelSize: { type: 'number', value: 7, min: 3, max: 15, compare: true },
  speckleENL: { type: 'number', value: 4, min: 1, compare: true },
  speckleDamping: { type: 'number', value: 1.0, min: 0, compare: true },
  // Note: coordinateSystem is NOT defined here - it will inherit from parent layer
};
