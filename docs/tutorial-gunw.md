# Tutorial: Exploring NISAR GUNW Interferometric Products

A hands-on guide to understanding and working with NISAR L2 GUNW (Geocoded Unwrapped Interferogram) products — from the science fundamentals to practical exploration workflows in SARdine.

---

## 1. What is InSAR and Why Does It Matter?

**Interferometric Synthetic Aperture Radar (InSAR)** exploits the phase difference between two SAR images acquired at different times to measure ground surface displacement with millimeter-to-centimeter precision.

### The core idea

A SAR satellite transmits microwave pulses and records the reflected signal. Each pixel records both **amplitude** (how much energy bounced back) and **phase** (the fractional wavelength of the round-trip path). When the satellite revisits the same area, the ground may have moved — shifting the round-trip distance and changing the phase. By differencing the phase of two acquisitions, we isolate the displacement signal.

### Key terms

| Term | Definition |
|:-----|:-----------|
| **Reference image** | The first (earlier) SAR acquisition in the pair |
| **Secondary image** | The second (later) SAR acquisition |
| **Interferogram** | The pixel-by-pixel phase difference between reference and secondary |
| **Wrapped phase** | Raw phase difference, confined to [-π, +π] — one full cycle ("fringe") = half a wavelength of ground motion along the line-of-sight |
| **Unwrapped phase** | Continuous phase after resolving 2π ambiguities — directly proportional to displacement |
| **Coherence** | A measure [0, 1] of how stable the scattering surface is between acquisitions. High coherence (>0.5) = reliable phase measurement |
| **Line-of-Sight (LOS)** | The direction from the satellite to the ground. InSAR measures displacement projected onto this direction |
| **Temporal baseline** | Time between the two acquisitions (days) |
| **Perpendicular baseline** | Spatial separation of satellite orbits, perpendicular to LOS (meters) |
| **Fringe** | One complete color cycle in the wrapped interferogram, representing λ/2 ≈ 11.9 cm of LOS displacement for NISAR L-band |

### What can InSAR detect?

- **Earthquakes**: Co-seismic displacement fields showing fault rupture geometry
- **Volcanic deformation**: Inflation/deflation of magma chambers (cm-scale uplift over months)
- **Land subsidence**: Groundwater pumping, mining, oil/gas extraction causing ground sinking
- **Landslides**: Slow-moving slope failures (mm/year to cm/year)
- **Glacier flow**: Ice sheet velocity via pixel offset tracking
- **Infrastructure monitoring**: Bridge, dam, or building settlement

---

## 2. Anatomy of a GUNW Product

A GUNW file is a single HDF5 file containing everything derived from one interferometric pair, geocoded onto a map grid.

### What's inside

The product contains three major layer groups at two spatial resolutions:

```
GUNW file
├── Unwrapped Interferogram (80 m posting)
│   ├── unwrappedPhase          — continuous displacement phase (radians)
│   ├── coherenceMagnitude      — signal quality [0, 1]
│   ├── connectedComponents     — unwrapping region labels
│   ├── ionospherePhaseScreen   — ionospheric delay estimate
│   └── mask                    — validity mask
│
├── Wrapped Interferogram (20 m posting, 4x finer)
│   ├── wrappedInterferogram    — complex fringe pattern
│   ├── coherenceMagnitude      — signal quality at full resolution
│   └── mask
│
├── Pixel Offsets (80 m posting)
│   ├── slantRangeOffset        — range displacement (meters)
│   ├── alongTrackOffset        — azimuth displacement (meters)
│   ├── correlationSurfacePeak  — matching quality [0, 1]
│   └── mask
│
└── Metadata
    ├── orbit (reference + secondary ephemeris)
    ├── radarGrid (incidence angle, baselines, troposphere/tides)
    └── processingInformation
```

### How it differs from GCOV

| | GCOV (Backscatter) | GUNW (Interferometry) |
|:-|:---|:---|
| **Input** | Single SAR acquisition | Pair of acquisitions |
| **Measures** | Surface reflectivity (power) | Surface displacement (phase) |
| **Units** | Linear power → display in dB | Radians or meters → display linear |
| **Colormaps** | Sequential (viridis, inferno) | Diverging (blue-white-red) or cyclic (phase wheel) |
| **Key use** | Land cover, biomass, floods | Earthquakes, subsidence, volcanoes |

---

## 3. Science Workflows

### Workflow 1: Visualizing Ground Displacement

**Goal**: See where and how much the ground moved between two SAR acquisitions.

**Steps**:

1. **Load the unwrapped phase layer** — `unwrappedPhase` at 80 m posting
2. **Apply a diverging colormap** (e.g., `RdBu` or `coolwarm`) centered on zero
   - Blue = motion toward the satellite (uplift or westward motion on descending passes)
   - Red = motion away from the satellite (subsidence or eastward motion)
3. **Convert phase to LOS displacement**:
   ```
   LOS_displacement_m = unwrappedPhase × λ / (4π)
   where λ = 0.2384 m (NISAR L-band wavelength)
   ```
   One fringe (2π radians) = **11.9 cm** of LOS motion.

4. **Convert LOS to vertical displacement** — Most InSAR applications (subsidence, uplift) assume purely vertical motion. To recover vertical displacement from the LOS measurement, divide by the cosine of the incidence angle at each pixel:
   ```
   vertical_displacement = LOS_displacement / cos(θ)
   ```
   where θ is the local incidence angle from the `radarGrid/incidenceAngle` metadata cube. For NISAR's typical incidence angles (30°-45°), this scales the LOS value by a factor of ~1.15-1.41:

   | Incidence angle (θ) | cos(θ) | Scale factor 1/cos(θ) |
   |:--------------------|:-------|:----------------------|
   | 30° | 0.866 | 1.15 |
   | 35° | 0.819 | 1.22 |
   | 40° | 0.766 | 1.31 |
   | 45° | 0.707 | 1.41 |

   This correction varies across the swath (incidence angle increases from near to far range), so it should be applied **per-pixel** using the incidence angle grid rather than a single scalar.

5. **Assess quality** — overlay or threshold the `coherenceMagnitude` layer. Mask pixels with coherence < 0.3-0.5 as unreliable.

**What to look for**:
- Smooth gradients = broad tectonic deformation or subsidence bowls
- Sharp discontinuities = fault traces
- Concentric bull's-eye patterns = point-source inflation/deflation (volcanic, fluid injection)
- Noisy areas with low coherence = vegetation, water, snow (decorrelated)

### Workflow 2: Reading the Wrapped Interferogram (Fringe Counting)

**Goal**: Interpret the raw fringe pattern to understand displacement magnitude and spatial distribution.

**Steps**:

1. **Load the wrapped interferogram** — `wrappedInterferogram` at 20 m posting (4x higher resolution than unwrapped)
2. **Extract phase**: the data is complex (real + imaginary). Phase = `atan2(imag, real)`
3. **Apply a cyclic colormap** (HSV phase wheel) with range [-π, π]
4. **Count fringes**: each full color cycle = λ/2 ≈ 11.9 cm of LOS displacement

**What to look for**:
- Dense, tightly-spaced fringes = rapid displacement gradient (near a fault, at the edge of a subsidence bowl)
- Wide, smoothly-varying fringes = gentle deformation
- Noisy / speckled fringes = decorrelation (the phase measurement is unreliable there)

**Why use wrapped when unwrapped exists?** The wrapped interferogram is at 20 m (vs 80 m unwrapped), preserving fine spatial detail. It also avoids unwrapping errors — the raw fringes are the "ground truth" of the measurement.

### Workflow 3: Coherence Analysis

**Goal**: Map where the interferometric measurement is reliable vs. where the surface has changed too much between acquisitions.

**Steps**:

1. **Load `coherenceMagnitude`** (available at both 20 m and 80 m)
2. **Apply a sequential colormap** (viridis or grayscale) with range [0, 1]
3. **Interpret**:
   - **> 0.7**: Excellent — urban areas, bare rock, dry desert. Phase is very reliable.
   - **0.3 – 0.7**: Moderate — sparse vegetation, agricultural fields between growing seasons. Phase is usable with caution.
   - **< 0.3**: Poor — dense forest, water, snow. Phase is unreliable; mask these pixels.

**Science applications of coherence itself**:
- **Damage mapping**: After an earthquake or flood, coherence drops sharply in damaged areas. Comparing pre-event and co-event coherence maps highlights destruction.
- **Land cover proxy**: Persistent high coherence = urban/bare; persistent low = forest/water.
- **Temporal decorrelation studies**: How fast does coherence decay with temporal baseline? This tells you about surface dynamics.

### Workflow 4: Connected Components and Unwrapping Quality

**Goal**: Identify regions where phase unwrapping may have introduced errors.

**Steps**:

1. **Load `connectedComponents`** — integer labels, one per unwrapping region
2. **Display with a categorical/discrete colormap** — each label gets a distinct color
3. **Interpret**:
   - Label `0` = invalid (masked out, not unwrapped)
   - Each non-zero label = a contiguous region where phase was successfully unwrapped
   - **Within** a connected component, relative phase differences are reliable
   - **Between** components, there may be an unknown integer multiple of 2π offset

**Why this matters**: If your area of interest spans two different connected components, the displacement values cannot be directly compared — there is an ambiguity of n × 11.9 cm between them. Large numbers of small disconnected components indicate difficult unwrapping conditions (low coherence, steep topography).

### Workflow 5: Ionospheric Correction

**Goal**: Remove ionospheric phase delays that contaminate the displacement signal, especially at L-band.

**Steps**:

1. **Load `ionospherePhaseScreen`** — estimated ionospheric delay (radians)
2. **Load `unwrappedPhase`** — total phase including ionosphere
3. **Corrected phase** = `unwrappedPhase - ionospherePhaseScreen`
4. **Check uncertainty** via `ionospherePhaseScreenUncertainty`

**Background**: The ionosphere is a layer of charged particles 80-1000 km above Earth. It introduces a frequency-dependent phase delay. At L-band (1.2 GHz), ionospheric effects can be significant — adding fringes that mimic ground deformation. NISAR uses **split-spectrum** processing: separating the signal into sub-bands to estimate and remove the dispersive ionospheric component.

**When to apply**: Always check the ionosphere layer. If it shows strong gradients (especially at low/equatorial latitudes or during geomagnetic storms), subtract it. Note: the ionosphere phase screen is **not** subtracted from `unwrappedPhase` by default — you must apply the correction yourself.

### Workflow 6: Pixel Offset Tracking

**Goal**: Measure large displacements that exceed the InSAR measurement range (where fringes are too dense to unwrap).

**Steps**:

1. **Load `slantRangeOffset`** — range displacement in meters
2. **Load `alongTrackOffset`** — azimuth displacement in meters
3. **Apply a diverging colormap** centered on zero
4. **Check quality** via `correlationSurfacePeak` — values close to 1 = good match

**When to use**: Pixel offset tracking works by cross-correlating image patches rather than using phase. It measures displacements in **meters** (not fractions of a wavelength), so it captures:
- Large co-seismic offsets near fault ruptures (meters of slip)
- Glacier flow velocities (meters/year)
- Fast landslides
- Any motion too large for phase-based InSAR

**Trade-off**: Offset tracking is ~10-100x less precise than phase-based InSAR, but handles arbitrarily large displacements.

---

## 4. Understanding the Metadata

### Temporal baseline

Found at `/science/LSAR/GUNW/metadata/orbit/temporalBaseline` (days between acquisitions). NISAR's repeat cycle is 12 days, so most GUNW products will have baselines of 12, 24, 36 days, etc.

- **Short baselines** (12 days): Better coherence, smaller displacement signals
- **Long baselines** (months): More accumulated displacement, but potentially lower coherence

### Perpendicular baseline

Found in the `radarGrid/perpendicularBaseline` cube. This is the orbital separation perpendicular to the line of sight.

- **Small perpendicular baseline** (< 200 m): Minimal topographic phase contribution
- **Large perpendicular baseline** (> 500 m): Stronger sensitivity to topography; residual DEM errors appear in the interferogram

### Incidence angle

Found in `radarGrid/incidenceAngle`. The angle between the radar beam and the local vertical.

- Typical range: 30°-45° for NISAR
- Affects the sensitivity direction: InSAR is most sensitive to vertical displacement when incidence angle is small, and to horizontal displacement when it is large
- **Vertical sensitivity** ≈ cos(θ), **horizontal sensitivity** ≈ sin(θ)

### Tropospheric phase screens

The `radarGrid` group contains `wetTroposphericPhaseScreen` and `hydrostaticTroposphericPhaseScreen`. These capture atmospheric delay variations that can masquerade as deformation — particularly in mountainous areas where tropospheric delay correlates with elevation.

---

## 5. Tips for Interpretation

### Common pitfalls

1. **Atmospheric fringes ≠ deformation**: Smooth, broad-scale fringes that correlate with topography are likely tropospheric delay, not ground motion. Compare multiple interferograms — atmospheric signals are different each time, while deformation is consistent.

2. **Unwrapping errors**: Look for "jumps" in the unwrapped phase that coincide with connected component boundaries. If the displacement looks physically implausible (sudden steps of ~12 cm), suspect an unwrapping error.

3. **Decorrelation bias**: Low-coherence areas don't just have noisy phase — they can have systematically biased unwrapped phase. Always mask low-coherence pixels.

4. **LOS ambiguity**: InSAR measures displacement along the satellite's line-of-sight direction, not purely vertical or horizontal. A single interferogram cannot rigorously distinguish between vertical and horizontal motion. Three approaches to handle this:
   - **Vertical displacement mode** (most common): Assume all motion is vertical and divide LOS by cos(θ) per-pixel using the incidence angle grid. This is the standard approach for subsidence, uplift, and most geohazard applications.
   - **Ascending + descending decomposition**: Combine interferograms from both orbit directions to solve for vertical and east-west components independently.
   - **Full 3-D decomposition**: Use the LOS unit vectors (`losUnitVectorX`, `losUnitVectorY`) from the metadata with multiple viewing geometries.

5. **Reference point**: Unwrapped phase is relative, not absolute. All displacements are measured relative to an arbitrary reference point. To get meaningful values, choose a stable reference area (known to have zero displacement) and subtract its phase from the entire image.

### Rules of thumb for NISAR L-band

| Quantity | Value |
|:---------|:------|
| Wavelength (λ) | 0.2384 m |
| One fringe (2π) | λ/2 ≈ 11.9 cm LOS displacement |
| 1 radian of phase | λ/(4π) ≈ 1.9 cm LOS displacement |
| LOS → vertical conversion | divide by cos(θ); ×1.15 at 30°, ×1.41 at 45° |
| Typical precision | ~1-2 cm for coherence > 0.5 |
| Maximum measurable gradient | ~1 fringe per pixel (11.9 cm / 80 m ≈ 0.15%) |
| Repeat cycle | 12 days |

### L-band vs C-band

NISAR uses L-band (λ ≈ 24 cm), which differs significantly from C-band missions like Sentinel-1 (λ ≈ 5.6 cm):

- **L-band penetrates vegetation**: Maintains coherence over forests and agricultural areas where C-band decorrelates
- **Longer wavelength = larger fringe spacing**: One L-band fringe = 11.9 cm vs 2.8 cm for C-band. Fewer fringes for the same displacement → easier to unwrap, but less sensitive to small signals
- **Stronger ionospheric effects**: Phase delay scales as 1/frequency, so L-band sees ~4x more ionospheric contamination than C-band

---

## 6. Quick-Start Checklist

When you open a new GUNW product, follow this sequence:

1. **Check the metadata**: What are the reference/secondary dates? What is the temporal baseline? Where is the scene (track/frame)?

2. **View coherence first**: This tells you where the data is trustworthy. If coherence is universally low (< 0.2), the interferogram may not be useful.

3. **View the wrapped interferogram**: Look at the fringe pattern at 20 m resolution. Count fringes to estimate displacement magnitude. Look for the spatial pattern — is it consistent with known geology/tectonics?

4. **View the unwrapped phase**: Check for unwrapping errors by comparing with the wrapped fringes. Apply a diverging colormap centered on zero.

5. **Check connected components**: Are there many small disconnected regions? If so, the unwrapping may be unreliable in those areas.

6. **Apply ionospheric correction**: Subtract `ionospherePhaseScreen` from `unwrappedPhase` if ionospheric fringes are present.

7. **Convert to vertical displacement**: Multiply corrected phase by λ/(4π) to get LOS meters, then divide by cos(θ) per-pixel using the incidence angle grid to get vertical displacement. Report as cm for readability.

8. **Mask low-quality pixels**: Threshold coherence (typically > 0.3) and exclude connected component 0.

9. **Consider atmospheric effects**: If deformation fringes correlate with topography, atmospheric delay may be present. Multiple interferograms or external atmospheric models are needed to separate atmosphere from deformation.

10. **Export**: Save the displacement map as a GeoTIFF for GIS integration or further analysis.
