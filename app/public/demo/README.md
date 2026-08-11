# Hosted demo COGs

Pre-staged subsets served by GitHub Pages so the README hero link renders
instantly — no Earthdata Login, no CMR search, no HDF5 metadata walk. The
live-streaming NISAR links in the README exercise the real DAAC path.

## solimoes_hh.tif / solimoes_hv.tif

Solimões River floodplain west of Manaus — the same region as the README hero
deep link (`bbox=-63.55,-3.6,-62.55,-2.6`).

- **Source granule**: `NISAR_L2_PR_GCOV_004_060_A_176_2005_DHDH_A_20251102T095440_20251102T095514_X05009_N_F_J_001`
  (NISAR L2 GCOV Beta, ASF DAAC, acquired 2025-11-02)
- **Content**: frequency B `HHHH` / `HVHV` gamma0 backscatter, raw power
  (float32), 80 m posting, EPSG:32720, 1396×1387 px, NaN nodata,
  subswath mask applied
- **Format**: COG, DEFLATE + floating-point predictor, 512-px blocks,
  2 overview levels
- **Produced with**: openSEPPO `seppo_nisar_gcov_convert 0.7.0`
  (`-vars HHHH HVHV -f B -pwr -of COG -projwin -63.55 -2.6 -62.55 -3.6
  -projwin_srs EPSG:4326`)

Deep link (dual-pol RGB composite):

```
https://nicksteiner.github.io/sardine/?cog=demo/solimoes_hh.tif,demo/solimoes_hv.tif&comp=dual-pol-h&mode=rgb&db=1&stretch=sigmoid&c=750,400&z=0.3
```

NISAR data courtesy NASA/JPL-Caltech and ASF DAAC; NASA data are open —
these subsets are redistributed here for demonstration.
