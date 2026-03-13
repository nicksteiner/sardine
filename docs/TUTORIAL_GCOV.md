# Exploring NISAR GCOV Products with SARdine

A science-oriented tutorial for loading, interpreting, and analyzing NISAR L2 GCOV (Geocoded Polarimetric Covariance) products in SARdine.

---

## 1. What Is a GCOV Product?

GCOV is NISAR's primary **backscatter** product. It tells you how much radar energy bounced back from each point on the ground, broken down by polarization.

### The physics in one paragraph

NISAR transmits L-band microwave pulses (wavelength ~24 cm) and records the echoes. The radar alternates between horizontal (H) and vertical (V) transmit polarizations and receives both, producing up to four channels: HH, HV, VH, VV. Each channel measures the complex scattering amplitude. GCOV takes the outer product of the scattering vector with its conjugate — the **polarimetric covariance matrix** — averages (multiloooks) it, corrects for terrain slope effects (**radiometric terrain correction**), and projects everything onto a map grid. The result is a set of 2-D rasters representing backscatter power and cross-polarization correlations.

### Key terms

| Term | Definition |
|:-----|:-----------|
| **Backscatter (σ⁰ or γ⁰)** | The fraction of radar energy scattered back toward the sensor, normalized by illuminated area. GCOV stores **γ⁰** (gamma-nought), which normalizes by the area projected perpendicular to the look direction, reducing terrain slope bias. |
| **Covariance matrix** | A Hermitian matrix formed from the outer product of the scattering vector: C = ⟨k · k†⟩. Diagonal elements are real-valued backscatter powers; off-diagonal elements are complex cross-correlations between polarization channels. |
| **Polarization** | The orientation of the radar's electric field. **HH** = transmit H, receive H. **HV** = transmit H, receive V (cross-pol). Cross-pol is sensitive to volume scattering (vegetation canopy). |
| **Radiometric Terrain Correction (RTC)** | Compensates for the fact that slopes facing the radar appear brighter (foreshortening). RTC uses a DEM to compute the true scattering area per pixel and normalizes accordingly. |
| **Multilooking** | Averaging neighboring pixels to reduce speckle noise at the cost of spatial resolution. GCOV applies adaptive multilooking during processing; SARdine applies additional box-filter multilooking for display. |
| **Decibels (dB)** | Logarithmic scale: dB = 10 · log₁₀(linear power). Backscatter spans several orders of magnitude, so dB compresses the range for visualization. Typical SAR backscatter: -30 dB (smooth water) to +10 dB (urban corner reflectors). |
| **Speckle** | Granular noise inherent to coherent imaging. Not sensor noise — it arises from constructive/destructive interference of scatterers within a resolution cell. Multilooking and spatial filtering reduce it. |

---

## 2. What's Inside a GCOV File?

A single GCOV HDF5 file covers a **~240 × 240 km granule** at 10–80 m pixel spacing (depending on radar mode). It contains:

### Diagonal terms — backscatter power

These are the workhorses. Each pixel stores γ⁰ in **linear power** (unitless ratio).

| Dataset | What it measures | Typical use |
|:--------|:-----------------|:------------|
| **HHHH** | Co-pol backscatter (H transmit, H receive) | Surface roughness, soil moisture, urban structures |
| **HVHV** | Cross-pol backscatter (H transmit, V receive) | Vegetation structure, biomass, forest/non-forest |
| **VVVV** | Co-pol backscatter (V transmit, V receive) | Similar to HH but with different sensitivity to dielectric/geometry |
| **VHVH** | Cross-pol (V transmit, H receive) | Reciprocal to HV in monostatic radar; available in quad-pol mode |

### Off-diagonal terms — polarimetric correlations

Complex-valued cross-products between channels (e.g., HHVV = ⟨S_HH · S_VV*⟩). These encode **scattering mechanism information** beyond what power alone reveals. Used for advanced decompositions (Pauli, Freeman-Durden, H/A/α).

### Ancillary layers

| Layer | Purpose |
|:------|:--------|
| **numberOfLooks** | How many independent samples were averaged per pixel. More looks = less speckle. |
| **rtcGammaToSigmaFactor** | Multiply γ⁰ by this to get σ⁰ (sigma-nought), useful when comparing to legacy datasets. |
| **mask** | Validity flags: shadow, layover, out-of-swath. |

---

## 3. Getting Started in SARdine

### Step 1: Load a GCOV file

Drag and drop a `.h5` GCOV file into SARdine (or use File → Open). SARdine will:

1. Parse the HDF5 superblock and metadata (~4–8 MB read)
2. Detect the product as `L2_GCOV`
3. Enumerate available polarization bands
4. Apply sensible defaults: **dB scaling**, **grayscale** colormap, **auto-contrast**

You'll see the first available band (typically HHHH) rendered immediately.

### Step 2: Understand what you're seeing

The default view shows backscatter in **decibels** with auto-stretched contrast. Dark areas = low backscatter (smooth surfaces, water). Bright areas = high backscatter (rough surfaces, vegetation, urban).

**Quick orientation check:**
- Water bodies should appear **very dark** (< -20 dB)
- Forests should be **medium gray** (-15 to -8 dB in HH, -20 to -12 dB in HV)
- Cities/urban areas may have **bright spots** from corner reflectors (> 0 dB)

### Step 3: Switch polarizations

Use the polarization selector to compare channels:

- **HH → HV**: Watch forests brighten relative to bare ground. Cross-pol is dominated by volume scattering in vegetation canopies.
- **HH → VV**: Subtle differences reveal dielectric and geometric properties. VV is more sensitive to vertical structures and Bragg scattering on water.

---

## 4. Science Workflows

### 4.1 Forest / Non-Forest Discrimination

**Why it works:** Forest canopies cause volume scattering that randomizes polarization, producing strong HV backscatter. Bare ground, water, and low vegetation produce weak HV.

**Steps:**
1. Load GCOV → select **HVHV** band
2. Set colormap to **viridis** or **inferno** for perceptual uniformity
3. Adjust contrast to **[-25, -8] dB** — this range separates forest (bright) from non-forest (dark)
4. Optionally apply **sqrt** stretch to enhance contrast in the forest class

**What to look for:**
- Forest: -18 to -10 dB in HV (L-band penetrates canopy, strong volume scattering)
- Cropland: -22 to -16 dB (shorter vegetation, less volume scattering)
- Water: < -25 dB (specular reflection away from sensor)
- Urban: variable, but typically -18 to -5 dB with bright outliers

### 4.2 RGB Composite for Land Cover

**Why it works:** Different polarization channels respond to different scattering mechanisms. Mapping them to RGB creates a color image where hue encodes scattering type.

**Steps:**
1. Load GCOV (need at least dual-pol: HH + HV)
2. Enable **RGB Composite** mode
3. Select the **Dual-pol-H** preset: R = HH, G = HV, B = HH/HV ratio
4. Adjust per-channel contrast for good color balance

**Interpreting the colors:**

| Color | Dominant channel | Scattering mechanism | Typical surface |
|:------|:-----------------|:---------------------|:----------------|
| **Red** | High HH, low HV | Surface/double-bounce | Bare soil, urban |
| **Green** | High HV | Volume scattering | Dense vegetation |
| **Blue** | High HH/HV ratio | Strong co-pol dominance | Water, smooth surfaces |
| **Yellow** | High HH + HV | Mixed surface + volume | Flooded vegetation |
| **Cyan** | High HV + high ratio | — | Unusual; check data |
| **White** | All channels high | Very strong total backscatter | Urban corner reflectors |

### 4.3 Pauli Decomposition (Quad-Pol)

**Why it works:** The Pauli basis decomposes the scattering matrix into three physically meaningful components: single-bounce (surface), double-bounce (dihedral), and volume scattering.

**Requires:** Quad-pol data (HH, HV, VH, VV all available)

**Steps:**
1. Load quad-pol GCOV
2. Enable RGB Composite → select **Pauli** preset
3. Color mapping:
   - **R** = |HH - VV|² → double-bounce (dihedral corners, flooded forest)
   - **G** = |HV|² → volume scattering (forest canopy)
   - **B** = |HH + VV|² → single-bounce (bare surface, water)

**Interpreting Pauli colors:**

| Color | Component | Physical mechanism | Example |
|:------|:----------|:-------------------|:--------|
| **Red** | HH - VV | Double-bounce: ground-trunk or ground-wall dihedral | Flooded forest, urban buildings |
| **Green** | HV (cross-pol) | Volume: random canopy scattering | Dense forest, tall crops |
| **Blue** | HH + VV | Surface: single reflection from smooth interface | Calm water, bare soil, roads |
| **Magenta** | Double-bounce + surface | Mixed mechanisms | Urban areas with exposed ground |
| **Yellow** | Double-bounce + volume | Canopy over standing water | Wetlands, mangroves |

### 4.4 Flood Detection

**Why it works:** Water acts as a specular reflector, directing radar energy away from the sensor (very low backscatter). Flooded vegetation creates a ground-water dihedral (enhanced backscatter, especially in HH).

**Steps:**
1. Load GCOV → select **HHHH** band
2. Set contrast range to **[-25, -5] dB**
3. Look for anomalously dark patches (open water flooding) or anomalously bright patches (flooded vegetation)
4. Compare to a pre-flood acquisition of the same area if available
5. For open water: threshold around **-20 dB** in HH to create a binary flood mask
6. For flooded vegetation: compare HH to HV — flooded vegetation shows enhanced HH but similar HV

**Key signatures:**

| Surface condition | HH (dB) | HV (dB) | HH/HV ratio |
|:------------------|:---------|:---------|:-------------|
| Open water | < -22 | < -28 | High |
| Flooded vegetation (canopy over water) | ~ -12 | -18 to -12 | Very High (double-bounce enhancement) |
| Flooded vegetation (emergent/sparse) | ~ -5 | -18 to -12 | Moderate |
| Dry forest | -10 to -5 | -15 to -10 | Low-moderate |
| Dry bare soil | -15 to -5 | -25 to -18 | High |

### 4.5 Biomass Estimation (Qualitative)

**Why it works:** L-band HV backscatter correlates with above-ground biomass (AGB) up to a saturation point of ~100–150 Mg/ha. The long wavelength penetrates the canopy and interacts with branches and trunks, producing volume scattering proportional to woody biomass.

**Steps:**
1. Load GCOV → select **HVHV** band
2. Apply **dB scaling** (default) — the HV-to-biomass relationship is approximately linear in dB space
3. Set contrast to **[-25, -8] dB**
4. Use **viridis** colormap: dark = low biomass, bright = high biomass
5. Note that saturation occurs at high biomass — very dense tropical forest and moderately dense forest may look similar

**Approximate calibration (L-band HV):**

| HV γ⁰ (dB) | Approximate AGB (Mg/ha) | Vegetation type |
|:------------|:------------------------|:----------------|
| -22 to -20 | 0–10 | Grassland, sparse shrub |
| -18 to -16 | 10–50 | Young secondary forest, dense shrub |
| -15 to -13 | 50–100 | Mature secondary forest |
| -13 to -10 | 100–150+ | Dense tropical forest (saturation) |

*These are rough guidelines. Actual AGB retrieval requires local calibration, incidence angle correction, and accounting for moisture and terrain effects.*

### 4.6 Soil Moisture Sensitivity

**Why it works:** The dielectric constant of soil increases dramatically with water content, and backscatter is proportional to dielectric constant. HH and VV co-pol channels are most sensitive; the HH/VV ratio provides additional information about surface roughness.

**Steps:**
1. Load GCOV → select **HHHH** band
2. Over bare or sparsely vegetated areas, brighter backscatter = wetter soil
3. Compare with **VVVV** — the HH/VV ratio relates to surface roughness (independent of moisture)
4. For quantitative soil moisture, vegetation effects must be removed (requires time series or a vegetation model)

**Caveats:**
- Vegetation masks the soil signal; this works best over bare or low-vegetation areas
- Surface roughness also affects backscatter — a rough dry field can look similar to a smooth wet field
- Freeze/thaw state strongly affects L-band backscatter (frozen soil = low dielectric)

---

## 5. Adjusting the Display

### Stretch modes

| Mode | Effect | Best for |
|:-----|:-------|:---------|
| **Linear** | Direct mapping of dB range to color | General use |
| **Sqrt** | Expands dark end, compresses bright end | Enhancing low-backscatter detail (water, shadows) |
| **Gamma** | Power-law stretch; gamma < 1 brightens darks | Fine-tuning visual balance |
| **Sigmoid** | S-curve; enhances contrast around midpoint | High-dynamic-range scenes |

### Colormaps

| Colormap | Type | Recommended for |
|:---------|:-----|:----------------|
| **Grayscale** | Sequential | Single-band backscatter, publication figures |
| **Viridis** | Sequential (perceptual) | Quantitative analysis, biomass, coherence |
| **Inferno** | Sequential (perceptual) | High-contrast backscatter visualization |
| **Plasma** | Sequential (perceptual) | General SAR imagery |

### Auto-contrast

SARdine computes percentile-based contrast limits from a statistical sample of the data. The defaults (typically 2nd–98th percentile in dB) provide a good starting point. Adjust manually if:
- You want to emphasize a specific backscatter range (e.g., isolating water)
- The scene has extreme outliers (urban corner reflectors) pulling the range
- You're comparing multiple scenes and need consistent stretch

---

## 6. Exporting Results

### Raw GeoTIFF export

Exports the underlying **γ⁰ linear power** values as a Float32 GeoTIFF with proper CRS and geotransform. Use this for quantitative analysis in GIS or Python.

### Rendered GeoTIFF export

Exports the **displayed RGBA** image as a GeoTIFF — what you see on screen, including dB conversion, colormap, and contrast stretch. Good for presentations and overlaying in GIS.

### Figure export

Exports a publication-ready **PNG** with scale bar, coordinate labels, and colorbar overlay.

### RGB triangle colorbar

For composite modes, exports a **ternary diagram** showing the RGB channel mapping — useful for figure legends.

---

## 7. Understanding the Numbers

### Converting between units

```
γ⁰ (dB)    = 10 · log₁₀(γ⁰ linear)
γ⁰ (linear) = 10^(γ⁰ dB / 10)
σ⁰          = γ⁰ · rtcGammaToSigmaFactor
```

### Typical backscatter values (L-band, γ⁰)

| Surface | HH (dB) | HV (dB) |
|:--------|:---------|:---------|
| Calm ocean | -25 to -18 | < -30 |
| Rough ocean | -18 to -10 | -25 to -20 |
| Smooth bare soil | -18 to -12 | -28 to -22 |
| Rough bare soil | -12 to -5 | -22 to -18 |
| Grassland | -14 to -8 | -22 to -18 |
| Agricultural crops | -12 to -5 | -20 to -14 |
| Temperate forest | -10 to -5 | -16 to -10 |
| Tropical forest | -8 to -4 | -14 to -10 |
| Urban | -5 to +10 | -15 to -5 |
| Corner reflector | +10 to +30 | -10 to +5 |

---

## 8. Glossary of Scattering Mechanisms

**Surface (odd-bounce) scattering:** Radar wave reflects once off a smooth or moderately rough surface. Dominates over water, bare soil, roads. Co-pol (HH, VV) dominant; low cross-pol.

**Double-bounce (even-bounce) scattering:** Radar wave reflects off a horizontal surface then a vertical surface (or vice versa). Ground-trunk interaction in forests, ground-wall in urban areas. Strong HH, strong HH-VV correlation.

**Volume scattering:** Radar wave scatters multiple times within a random medium (vegetation canopy, dry snow). Depolarizes the signal, producing strong cross-pol (HV/VH). Signature of biomass.

**Bragg scattering:** Resonant scattering from periodic surface roughness (ocean waves, plowed fields). The backscatter depends on the wavelength-to-roughness ratio and incidence angle. Dominant mechanism for ocean backscatter.

**Specular reflection:** Mirror-like reflection from a smooth surface — energy reflects away from the sensor, producing very low backscatter. Classic signature of calm water and smooth ice.
