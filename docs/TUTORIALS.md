# SARdine tutorials and interface reference

Step-by-step workflows for the SARdine viewer. For the method definitions behind each
operation see the [README](../README.md#methods); for URL parameters see
[DEEP_LINKS.md](DEEP_LINKS.md).

### Tutorial 1 — RGB Composite

RGB mode assigns polarization channels to color, which makes land cover patterns easier to see. The most common case is a dual-pol file (HH + HV), which gives you two independent channels — SARdine fills the third using a ratio.

**You need:** A NISAR GCOV file with at least two polarizations (e.g. `HHHH` and `HVHV`).

1. Load your file (**File Type** → **NISAR GCOV HDF5 (Local File)**, click **Choose File**)
2. In the **Mode** selector, switch from **Single Polarization** to **RGB Composite**
3. Set **Preset** to **dual-pol-h** (HH+HV) or **dual-pol-v** (VV+VH) depending on your file
4. Click **Load Dataset** — SARdine loads both bands and renders the composite
5. Press `R` to auto-stretch contrast across all channels
6. Open the histogram (`H`) — you'll see three overlapping distributions, one per channel
7. Drag per-channel contrast handles to balance the composite if one color dominates
8. Press `Ctrl+S` to export a figure PNG with the RGB triangle colorbar

**Tips:**
- Water appears dark in all channels — usually a deep blue-black
- Vegetation is bright in cross-pol (HV) — shows as green
- Urban double-bounce is bright in co-pol (HH) — shows as red/orange
- Switch **Stretch** to `sqrt` or `gamma` to bring out low-backscatter features

---

### Tutorial 2 — Land Cover Classification

The feature space classifier lets you define land cover classes by drawing regions on a 2D scatter plot of two polarimetric channels. Classification updates on the map in real time.

**You need:** A NISAR GCOV file with at least two polarizations (e.g. `HHHH` and `HVHV`).

1. Load a single-pol dataset first (e.g. `HHHH`) so the basemap is visible
2. **Draw an ROI** — click and drag on the map to define your analysis region. Keep it focused on your area of interest; large ROIs are slower to scatter.
3. Press `C` to open the **Feature Space** panel
4. Set the **X axis** to `HH dB` and **Y axis** to `HV dB` using the axis dropdowns
5. The scatter plot populates with one point per pixel in your ROI
6. Click **+ Add Class** and give it a name (e.g. "Water")
7. Draw a rectangle on the scatter plot by clicking and dragging — pixels within that dB range light up on the map in the class color
8. Repeat for additional classes (e.g. "Vegetation", "Urban")
9. To filter by incidence angle (NISAR only): expand **Incidence Angle** and set a min/max range
10. Export options:
    - **SVG** button → publication-quality scatter plot with class regions
    - **Map** button → classification raster as a georeferenced PNG
    - **GeoTIFF** → rendered classification as an RGBA GeoTIFF

**Tips:**
- Zoom in on the scatter plot to draw precise class boundaries
- Water typically clusters at very low HH and HV (bottom-left corner)
- Urban double-bounce is high HH, low HV (right side, low on Y axis)
- Vegetation is high HV relative to HH (upper-left to center)

---

### Tutorial 3 — Time Series: ROI Plot and Multi-Date RGB Mosaic

SARdine supports two time series workflows: plotting backscatter over time for a fixed ROI, and compositing multiple dates into a single RGB image for change detection.

**You need:** Two or more NISAR GCOV files from the same track, different acquisition dates.

#### ROI Time Series Plot

1. Load your first date as usual (**Load Dataset**)
2. Draw an **ROI** over your target area (e.g. a field, wetland, or urban block)
3. In the **Time Series** panel, click **Add Date** and load a second `.h5` file
4. Repeat for all dates you want to include
5. SARdine extracts the mean backscatter (dB) within the ROI for each date and plots it as a time series
6. Click **Export SVG** to export the time series chart as a vector figure

**Tips:**
- Use a small, homogeneous ROI for cleaner signal — a 1 km² patch of a single land cover type
- Multi-look averaging is applied before extraction, matching on-screen rendering
- Add multiple ROIs to compare two land cover types on the same chart

#### Multi-Date RGB Mosaic (Change Detection)

This workflow assigns each of three acquisition dates to a color channel (R, G, B). Pixels that appear white have not changed; colored pixels changed between dates. Magenta or cyan patches often indicate flooding or vegetation change.

1. In **Mode**, select **RGB Composite** → **Preset: Multi-Date**
2. In the **Red channel** slot, load your earliest date
3. In the **Green channel** slot, load your middle date
4. In the **Blue channel** slot, load your latest date
5. Click **Load Dataset** — SARdine reads the same polarization from all three files and composites them
6. Press `R` to auto-stretch each channel independently
7. Zoom into areas of interest — colored patches indicate change, white/grey indicates stable backscatter
8. Export via `Ctrl+S` for a figure PNG, or use **GeoTIFF** → **RGB Composite** for a 3-band georeferenced export

**Tips:**
- Use the same polarization (e.g. `HHHH`) across all dates for a fair comparison
- Flood detection: flooded areas go dark in SAR — they appear as a single-channel dropout (pure R, G, or B color)
- For subtle change, try adjusting stretch to `sigmoid` to compress the dynamic range

---

## Controls

| Control | Description |
|:---|:---|
| **Colormap** | Grayscale, viridis, inferno, plasma, phase, sardine, flood, diverging, polarimetric |
| **Contrast** | Min/max dB range — drag sliders or use **Auto** for percentile-based stretch |
| **Stretch** | Linear, sqrt, gamma, sigmoid transfer function |
| **Multi-look** | Data reduction (box-filter averaging in linear power) |
| **Histogram** | Floating viewport histogram — auto-updates on pan/zoom, SVG export |
| **Classifier** | 2D/1D feature space scatter with class region drawing and incidence angle filter |
| **Overture** | Overlay boundaries, roads, or places from Overture Maps |

### Keyboard Shortcuts

| Key | Action |
|:---|:---|
| `H` | Toggle histogram overlay |
| `C` | Toggle feature space classifier |
| `F` | Fit view to data bounds |
| `R` | Reset contrast to auto |
| `G` | Toggle coordinate grid |
| `M` | Toggle overview map |
| `Ctrl+S` | Save figure (PNG) |

---

## Classification Workflow

1. Draw an **ROI** on the map (click and drag)
2. Press `C` to open the **Feature Space** scatter plot
3. Click **+ Add Class** to define a land cover class
4. Draw a rectangle on the scatter plot to assign pixels in that dB range
5. Pixels within the class region are colored on the map in real time
6. Export: **SVG** for the scatter plot, **Map** for the classification raster

---

## Export

### GeoTIFF

- **Raw Float32** — linear power values with CRS and tiepoints
- **Rendered RGBA** — what you see on screen (dB, colormap, contrast) as a 4-band GeoTIFF
- **RGB Composite** — 3-band GeoTIFF when in composite mode

Draw an ROI to export a subregion, or export the full extent.

### Figure PNG

Canvas capture with overlays: scale bar, corner coordinates, colorbar (or RGB triangle for composites), and classification overlay.

### Publication SVG

Vector graphics:
- **Scatter plot** — density heatmap with class regions, open L-axes, outward ticks, Helvetica
- **Histogram** — filled distribution with contrast limit markers and legend
- **Classification map** — embedded raster with vector legend and pixel counts
