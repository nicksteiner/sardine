# Hosted demo COGs

Demo data behind the README hero link — no Earthdata Login, no CMR search,
no HDF5 metadata walk. The live-streaming NISAR links in the README exercise
the real DAAC path.

**The hero itself streams the full-frame 20 m pair (~1 GB) hosted on
Hugging Face**: [nicksteiner/sardine-demo-data](https://huggingface.co/datasets/nicksteiner/sardine-demo-data)
(`pacaya_full_{hh,hv}.tif`, same granule as below, whole 240×270 km frame,
COG overview pyramid so first paint reads only a few MB). A copy is attached
to the GitHub release `demo-data-pacaya` for download (release assets don't
serve CORS, so they can't be streamed by the browser). The small subset pair
in this folder is kept as a light same-origin fallback.

## pacaya_hh.tif / pacaya_hv.tif

Pacaya-Samiria National Reserve, Peru — Ucayali floodplain, 60×60 km centered
on (−74.42°, −5.28°).

- **Source granule**: `NISAR_L2_PR_GCOV_015_147_A_175_2005_DHDH_A_20260320T104408_20260320T104443_X05013_N_F_J_001`
  (NISAR L2 GCOV Beta, ASF DAAC, acquired 2026-03-20)
- **Content**: frequency A `HHHH` / `HVHV` gamma0 backscatter, raw power
  (float32), 20 m posting multilooked 2×2 → 40 m, EPSG:32718, 1500×1500 px,
  NaN nodata, subswath mask applied
- **Format**: COG, DEFLATE + floating-point predictor, 512-px blocks,
  overview pyramid
- **Produced with**: openSEPPO `seppo_nisar_gcov_convert 0.7.0`
  (`-vars HHHH HVHV -f A -d 2 -pwr -of COG
  -projwin 534338 9446526 594338 9386526`)

Deep link (dual-pol RGB composite):

```
https://nicksteiner.github.io/sardine/?cog=demo/pacaya_hh.tif,demo/pacaya_hv.tif&comp=dual-pol-h&mode=rgb&db=1&stretch=sigmoid
```

NISAR data courtesy NASA/JPL-Caltech and ASF DAAC; NASA data are open —
these subsets are redistributed here for demonstration.
