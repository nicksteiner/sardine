# Why SARdine Is a Web App

**Date:** 2026-03-04

---

## The Core Argument

SARdine is a browser-native application because the browser is the only environment that gives you all three of these at once:

1. **GPU rendering without installation** — Every modern browser ships WebGL2. No CUDA toolkit, no conda environment, no driver compatibility matrix.
2. **Streaming without downloading** — HTTP Range requests let h5chunk and geotiff.js fetch only the chunks that intersect the current viewport. A 4 GB GCOV file might need 20 MB to render a view.
3. **Zero server infrastructure** — No tile server, no GPU VM, no Docker orchestration for the visualization layer. The user's own hardware does the rendering.

This combination eliminates the two traditional bottlenecks in SAR visualization: downloading large files before viewing, and provisioning server-side rendering infrastructure.

---

## Data Stays Remote, Rendering Stays Local

A common objection: "Won't users need to download everything?" No.

```
                         ┌────────────────────┐
  S3 / NFS / local disk  │   SARdine Browser   │
  ┌──────────┐  Range    │                      │
  │ 4 GB     │  request  │  h5chunk parses      │
  │ GCOV     │◄─────────►│  chunk index (8 MB)  │
  │ .h5      │  (~20 MB  │                      │
  │          │  per view) │  Fetches only        │
  └──────────┘           │  viewport chunks     │
                         │                      │
                         │  GPU renders at      │
                         │  60 fps locally      │
                         └────────────────────┘
```

**What travels over the network:** Only the compressed chunks for the current viewport — typically 10-30 MB for a screen-filling view of a multi-GB file.

**What stays local:** All GPU computation — dB scaling, colormap application, contrast stretching, compositing. These run in GLSL shaders on the user's graphics hardware.

This is strictly better than:
- **Full download then view** — Wastes bandwidth and time. Users often only need one polarization at one zoom level.
- **Server-side tile rendering** — Requires provisioning GPU VMs or CPU rendering farms. Tiles are pre-rendered at fixed zoom levels, losing the ability to adjust contrast/colormap interactively without a round trip.
- **Remote desktop / RFB** — Streams every pixel of every frame. At 1920x1080 @ 60fps, that's ~370 MB/s uncompressed. Even with good compression, interactive panning is laggy and lossy.

---

## What About Scale?

The streaming architecture scales naturally with data size:

| Data size | Download-first | Server tile render | SARdine (Range stream) |
|-----------|---------------|--------------------|----------------------|
| 500 MB COG | 500 MB transfer | Server GPU + storage | ~15 MB per view |
| 4 GB GCOV | 4 GB transfer | Server GPU + storage | ~20 MB per view |
| 40 GB multi-frequency | 40 GB transfer | Large server GPU + storage | ~20 MB per view |
| 400 GB time series (10 dates) | Impractical | Cluster of GPU servers | ~20 MB per view per date |

The per-view cost is roughly constant regardless of file size because h5chunk and geotiff.js only fetch the chunks that intersect the viewport at the current zoom level. Larger files just have more chunks in the index — the index itself is small (metadata page is ~8 MB for NISAR GCOV).

---

## Deployment Models

SARdine supports multiple deployment models, all preserving the browser-rendering architecture:

### 1. Local File (Zero Infrastructure)
```
User's machine:  File picker → File.slice() → h5chunk → GPU
```
No network, no server. Analyst drops a file, views it immediately.

### 2. Remote Data, Local Browser (sardine-launch)
```
Data server:     sardine-launch proxies Range requests to NFS/S3
User's machine:  Browser fetches chunks over HTTP → GPU
```
Data stays on the server or in the cloud. Only viewport chunks travel to the browser. sardine-launch is a thin HTTP Range proxy — no rendering, no GPU needed on the server.

### 3. Cloud-Native (STAC + S3)
```
S3:              COGs and HDF5 with presigned URLs via STAC catalog
User's machine:  Browser fetches chunks directly from S3 → GPU
```
No proxy server needed at all. The browser talks directly to S3 using presigned URLs from the STAC API.

### What SARdine Does Not Target

**Remote desktop / VNC / RFB workflows** — If the browser itself runs on a remote VM accessed through a virtual desktop, then WebGL renders remotely and pixels stream via RFB. This negates SARdine's local-GPU advantage and is not a target use case. The solution is not to add server-side rendering — it's to run the browser locally and stream the data, not the pixels.

---

## Comparison with Alternatives

| Tool | Architecture | GPU | Streaming | Install |
|------|-------------|-----|-----------|---------|
| **SARdine** | Browser-native, client-side GPU | WebGL2 (user's GPU) | HTTP Range (chunks only) | None |
| **QGIS** | Native desktop app | OpenGL (user's GPU) | Limited (mostly full download) | Install + plugins |
| **ASF MapReady** | Desktop, CPU rendering | None | None (full download) | Install |
| **Titiler/TiTiler** | Server-side tile render | None (CPU) or GPU VM | Pre-rendered tiles | Server deploy |
| **GeoServer** | Server-side WMS/WMTS | None (CPU) | Pre-rendered tiles | Server deploy |
| **Jupyter + rioxarray** | Server-side, matplotlib | None | Full load into memory | conda env |

SARdine's position: **QGIS-class visualization with zero installation and cloud-native data streaming.**

---

## Why Not a Desktop App?

A native desktop app (Electron, Qt, etc.) could also do local GPU rendering. But:

1. **Installation friction** — SAR analysts work across agencies with locked-down machines, varying OS versions, and restricted admin rights. A URL works everywhere.
2. **No updates to push** — sardine-launch serves the latest build. No installer, no auto-updater, no version fragmentation.
3. **Shareable sessions** — A URL with query parameters can encode a view state (dataset, zoom, contrast settings). Copy-paste to a colleague.
4. **JupyterHub integration** — Many SAR teams already use JupyterHub. sardine-launch can run alongside JupyterLab on the same hub, sharing the same data mounts.

---

## Summary

SARdine is a web app because the web platform uniquely enables streaming large SAR data to a local GPU with zero installation. The data stays remote, only viewport chunks travel over the network, and the user's own graphics hardware does the rendering. This architecture scales with data size, avoids server GPU costs, and eliminates the download-before-view bottleneck that plagues traditional SAR tools.
