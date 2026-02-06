# SARdine Competitive Analysis

> **Browser-native NISAR HDF5 Viewer — Competitive Landscape**
> Research date: February 2026

---

## 1 — Browser-Based HDF5 Viewers

### H5Web (ESRF / silx-kit)
| | |
|:---|:---|
| **What it does** | React component library for visualizing data stored in HDF5 files. Provides `LineVis`, `HeatmapVis`, matrix views, and a file-tree explorer. Three packages: `@h5web/lib` (viz components), `@h5web/app` (explorer + data providers), `@h5web/h5wasm` (in-browser reading). |
| **Browser or server** | **Both.** Can run fully in-browser via `H5WasmLocalFileProvider` / `H5WasmBufferProvider`, or with a Python backend via `H5GroveProvider` or `HsdsProvider`. |
| **HDF5 native** | Yes — reads HDF5 natively via h5wasm (WASM) in browser, or via h5py on the server side through h5grove. |
| **SAR features** | ❌ None. General-purpose scientific data viewer. No dB scaling, no polarimetric composites, no colormap selection for SAR, no geospatial awareness. |
| **Key limitations** | Must load entire file into WASM memory for browser mode (no streaming). No tiling / viewport-aware loading. No geospatial coordinate system handling. Designed for neutron/synchrotron science, not Earth observation. |
| **Stars** | ~249 |
| **Ecosystem** | myHDF5, jupyterlab-h5web, vscode-h5web, h5whale (Docker) |

### jupyterlab-h5web (silx-kit)
| | |
|:---|:---|
| **What it does** | JupyterLab extension wrapping H5Web. Double-click `.h5` files to browse groups and visualize datasets. Also provides a notebook widget (`H5Web('<path>')`) for inline viewing. |
| **Browser or server** | **Server-required** — JupyterLab server extension reads HDF5 via h5grove (h5py), serves data to the React frontend. |
| **HDF5 native** | Yes, via h5py on the server. |
| **SAR features** | ❌ None. |
| **Key limitations** | Requires a running Jupyter server. No streaming. No SAR-specific visualization. Supports many HDF5-based formats (.h5, .nc, .nexus, etc.) but has no concept of SAR products. |
| **Stars** | ~86 |

### jupyterlab-hdf5 (JupyterLab org) — ⚠️ DEPRECATED
| | |
|:---|:---|
| **What it does** | Earlier JupyterLab extension for HDF5 file browsing. Could handle TB-scale files via lazy/paginated loading. |
| **Browser or server** | **Server-required.** |
| **HDF5 native** | Yes, via h5py on server. |
| **SAR features** | ❌ None. |
| **Key limitations** | **No longer maintained.** Does not work with JupyterLab 4+. Recommends jupyterlab-h5web as replacement. |
| **Stars** | ~119 |

### myHDF5 (HDF Group)
| | |
|:---|:---|
| **What it does** | Online HDF5 file viewing service. Upload a file, browse it in the browser. Uses H5Web under the hood. |
| **Browser or server** | **Cloud service** (file upload required). |
| **HDF5 native** | Yes. |
| **SAR features** | ❌ None. |
| **Key limitations** | Must upload file. No streaming. No geospatial features. |

### HSDS — Highly Scalable Data Service (HDF Group)
| | |
|:---|:---|
| **What it does** | REST-based web service for HDF5 data stored in object storage (S3, Azure Blob, MinIO) or POSIX. Provides an h5py-compatible Python client (`h5pyd`). |
| **Browser or server** | **Heavy server infrastructure** — Docker/Kubernetes deployment, multi-container architecture. |
| **HDF5 native** | Yes, serves HDF5 content via REST API. |
| **SAR features** | ❌ None. Pure data access service. |
| **Key limitations** | Significant DevOps overhead. Requires cloud infrastructure deployment. No visualization — only data access. |
| **Stars** | ~153 |

### h5grove (silx-kit)
| | |
|:---|:---|
| **What it does** | Python utilities to build backends that serve HDF5 file content (attributes, metadata, data). Supports Flask, FastAPI, Tornado. |
| **Browser or server** | **Server-only** — Python library for building HDF5 backends. |
| **HDF5 native** | Yes, via h5py. |
| **SAR features** | ❌ None. |
| **Key limitations** | Building block, not a complete solution. Requires server deployment. |
| **Stars** | ~22 |

---

## 2 — Browser-Based SAR Viewers

### ASF Data Search (search.asf.alaska.edu)
| | |
|:---|:---|
| **What it does** | Alaska Satellite Facility's data discovery portal. Search, browse, and download SAR data from Sentinel-1, ALOS PALSAR, NISAR, and other missions. Geographic/temporal filtering, polarization/beam mode filters. |
| **Browser or server** | **Web application with heavy backend.** The browser is only for search/download — no actual SAR data visualization. |
| **HDF5 native** | ❌ No in-browser HDF5 reading. Downloads files for offline processing. |
| **SAR features** | Search filters for polarization, beam mode, flight direction. Browse imagery thumbnails. But **no interactive pixel-level visualization**. |
| **Key limitations** | Discovery-only, not a viewer. Cannot open HDF5 products in the browser. Cannot render SAR data interactively. |

### Copernicus Browser (Sentinel Hub)
| | |
|:---|:---|
| **What it does** | Browse and visualize Sentinel-1/2/3 data with custom scripting (evalscript). Server-side rendering with client-side display. |
| **Browser or server** | **Server-side processing** (Sentinel Hub cloud rendering), browser for display. |
| **HDF5 native** | ❌ No. Works with their proprietary optimized data pipeline. |
| **SAR features** | Some. Can do VV/VH visualization, basic dB scaling via evalscript. But limited to Sentinel-1, no NISAR support, no polarimetric decomposition. |
| **Key limitations** | Vendor locked. Commercial pricing for heavy use. No HDF5. No NISAR. Server-dependent. |

### ESA SNAP Desktop + SNAP Web
| | |
|:---|:---|
| **What it does** | ESA's primary SAR processing toolbox. Java desktop app (SNAP) with extensive SAR processing capabilities. |
| **Browser or server** | **Desktop application** (Java). Some web-based tools emerging but not mature. |
| **HDF5 native** | Reads various SAR formats including some HDF5-based products. |
| **SAR features** | ✅ Full — polarimetric decomposition, interferometry, calibration, terrain correction, multilooking, filtering. The gold standard for SAR processing. |
| **Key limitations** | **Not browser-based.** Heavy install (~2 GB). Java dependency. Slow for large files. No cloud-native streaming. |

### No other browser-based SAR-specific viewer exists
After exhaustive search: **there is no browser-native tool that reads SAR HDF5 products and renders them interactively with GPU shaders.** The gap is total.

---

## 3 — NISAR Data Tools

### ISCE3 — InSAR Scientific Computing Environment (JPL)
| | |
|:---|:---|
| **What it does** | Open-source library for processing spaceborne/airborne InSAR data. Ground-up redesign of ISCE2. Core processing engine for NISAR SDS (Science Data System). Generates RSLC, GCOV, GUNW, GSLC products. |
| **Browser or server** | **Desktop/server only.** C++/Python/CUDA. Requires compilation. |
| **HDF5 native** | Yes — NISAR products are HDF5. ISCE3 reads/writes them. |
| **SAR features** | ✅ Full SAR processing pipeline — focusing, geocoding, interferometry, covariance estimation. |
| **Key limitations** | Processing tool, not a viewer. Complex installation (C++/CUDA). No browser capability. No interactive visualization. |
| **Stars** | ~189 |

### OPERA SDS (NASA/JPL)
| | |
|:---|:---|
| **What it does** | Operational pipeline for generating OPERA products (RTC-S1, CSLC-S1, DISP-S1) from Sentinel-1 data using ISCE3. |
| **Browser or server** | **Server-side pipeline.** No browser component. |
| **HDF5 native** | Uses HDF5/NetCDF products. |
| **SAR features** | Produces calibrated SAR products. |
| **Key limitations** | Production pipeline, not a viewer. Not NISAR-specific (Sentinel-1 focused). |

### NISAR Data User Guide (ASF/NSIDC)
| | |
|:---|:---|
| **What it does** | Documentation for NISAR data products. Describes formats, access methods, product specifications. |
| **Browser or server** | Documentation only. |
| **SAR features** | Describes all NISAR product levels (L0–L3). |
| **Key limitations** | No software tool — just documentation. |

### MintPy (Miami InSAR Time-series)
| | |
|:---|:---|
| **What it does** | Python-based InSAR time-series analysis. Works with NISAR GUNW products. |
| **Browser or server** | **Python desktop/server.** |
| **SAR features** | InSAR time-series, atmospheric correction, velocity estimation. |
| **Key limitations** | Desktop Python only. Not a general viewer. Focused on InSAR, not GCOV. |

---

## 4 — Cloud-Optimized HDF5 Approaches

### Kerchunk (fsspec)
| | |
|:---|:---|
| **What it does** | Python library that extracts byte-range metadata from HDF5/NetCDF/GRIB files and creates a virtual Zarr store via reference filesystem. Enables reading archival HDF5 as if it were cloud-optimized Zarr — without copying or converting the original files. |
| **Browser or server** | **Python only.** Requires fsspec, xarray, zarr ecosystem. Server/desktop. |
| **HDF5 native** | Yes — scans HDF5 internal structure (B-trees, chunk offsets) to build reference manifests. |
| **SAR features** | ❌ None. Generic cloud-optimized access layer. |
| **Key limitations** | Python-only. No browser runtime. Requires pre-processing step to generate reference JSONs. Does not handle reading/decompression itself (delegates to zarr/fsspec). Not real-time/interactive. |
| **Stars** | ~359 |

### VirtualiZarr
| | |
|:---|:---|
| **What it does** | Successor/complement to Kerchunk. Creates virtual Zarr stores from existing files using xarray. Being integrated into xarray as the standard approach. |
| **Browser or server** | **Python only.** |
| **Key limitations** | Same as Kerchunk — Python ecosystem, no browser. |

### Pangeo Forge
| | |
|:---|:---|
| **What it does** | ETL pipelines to convert archival data (including HDF5) into analysis-ready, cloud-optimized formats (Zarr). |
| **Browser or server** | **Python pipelines.** |
| **Key limitations** | Converts data — doesn't read in place. Requires running cloud infrastructure. ⚠️ Not under active development. |
| **Stars** | ~135 |

### NSIDC Cloud-Optimization Strategy (ICESat-2 / NISAR)
| | |
|:---|:---|
| **What it does** | The approach NISAR adopted: consolidating all HDF5 metadata at the front of the file in paged aggregation, using large chunk sizes (2–10 MiB), minimizing variable-length types. Enables HTTP range-GET access without converting to a different format. |
| **Browser or server** | Format specification, not a tool. |
| **Key limitations** | Requires HDF5 files to be created with these conventions. No standard tooling to read them — **SARdine's h5chunk is the first JavaScript implementation of this pattern.** |

---

## 5 — COG Viewers in Browser

### TiTiler (Development Seed)
| | |
|:---|:---|
| **What it does** | Python dynamic tile server built on FastAPI + Rasterio/GDAL. Serves COG, STAC, MosaicJSON, and xarray datasets as map tiles. Multiple projections via morecantile. Multiple output formats (JPEG, PNG, WebP, GTIFF). OGC WMTS support. |
| **Browser or server** | **Server required.** Python backend does all raster processing. Browser receives pre-rendered tiles. |
| **HDF5 native** | Only via xarray extension for NetCDF/Zarr. Not for raw HDF5. |
| **SAR features** | ❌ None built-in. Can serve any raster, but no SAR-specific rendering (no dB conversion, no polarimetric composites). |
| **Key limitations** | Requires server deployment (FastAPI + GDAL). Browser is just a tile consumer. Does not support HDF5 directly. |
| **Stars** | ~1,000 |

### OpenLayers COG Support
| | |
|:---|:---|
| **What it does** | OpenLayers has built-in `ol/source/GeoTIFF` that loads COGs directly in the browser via geotiff.js. WebGL tile rendering. |
| **Browser or server** | ✅ **Browser-native COG loading.** No server needed. |
| **HDF5 native** | ❌ No. COG/GeoTIFF only. |
| **SAR features** | ❌ None. Raw pixel display or basic band math. No dB scaling, no SAR colormaps. |
| **Key limitations** | COG only. No HDF5. No SAR-specific visualization. Limited to what WebGL tile layer can do. |

### Leaflet + georaster-layer-for-leaflet
| | |
|:---|:---|
| **What it does** | Leaflet plugin that can display GeoTIFFs (including COGs) using geotiff.js + georaster. |
| **Browser or server** | ✅ **Browser-native.** |
| **HDF5 native** | ❌ No. |
| **SAR features** | ❌ None. |
| **Key limitations** | Canvas-based (not WebGL), slower for large rasters. No HDF5. |

### NASA VEDA Dashboard (NASA-IMPACT)
| | |
|:---|:---|
| **What it does** | NASA's VEDA data exploration dashboard. TypeScript frontend for browsing, analyzing and visualizing Earth science data. Works with COGs via titiler backend. |
| **Browser or server** | **Server-dependent** — titiler backend for tile serving. |
| **HDF5 native** | ❌ No. |
| **SAR features** | ❌ None. General Earth science dashboard. |
| **Stars** | ~39 |

### geotiff.js (geotiffjs)
| | |
|:---|:---|
| **What it does** | Pure JavaScript GeoTIFF/COG parser. Reads metadata, does tiled/stripped reading, handles compressions (Deflate, LZW, JPEG, Packbits), supports web workers for parallel decoding. Automatic overview selection. |
| **Browser or server** | ✅ **Browser-native.** Also works in Node.js. |
| **HDF5 native** | ❌ No. GeoTIFF only. |
| **SAR features** | ❌ None. Raw pixel arrays. No rendering. |
| **Key limitations** | Parser only — no visualization. No HDF5. |
| **Stars** | ~800+ (main repo) |

---

## 6 — deck.gl for Geospatial / Scientific Imagery

### deck.gl (vis.gl / OpenJS Foundation)
| | |
|:---|:---|
| **What it does** | GPU-powered, high-performance large-scale data visualization framework. WebGL2/WebGPU based. Composable layers for maps, 3D, tiles. Used by Uber, CARTO, Foursquare. |
| **Browser or server** | ✅ **Browser-native.** React + vanilla JS + Python (pydeck). |
| **HDF5 native** | ❌ No. |
| **SAR features** | ❌ None built-in. Extensible for custom layers. |
| **Stars** | ~13,800 |

### deck.gl-raster (Kyle Barron / Development Seed) — ⚠️ ARCHIVED
| | |
|:---|:---|
| **What it does** | deck.gl layers + WebGL modules for client-side satellite imagery processing on the GPU. Custom GLSL shaders for band math, vegetation indices (NDVI, MSAVI), colormaps. |
| **Browser or server** | ✅ **Browser-native.** GPU computation. |
| **HDF5 native** | ❌ No. Loads pre-tiled imagery. |
| **SAR features** | ❌ None. Focused on optical satellite imagery (Landsat). No dB scaling, no SAR-specific colormaps or composites. |
| **Key limitations** | **Archived** (Jan 2026). Superseded by @developmentseed/deck.gl-raster (also minimal activity). Not SAR-aware. |
| **Stars** | ~90 |

### Who else uses deck.gl for scientific imagery?
- **CARTO** — business intelligence, not science
- **Foursquare Studio** — location data visualization
- **kepler.gl** — geospatial data exploration (no raster/SAR)
- **earthengine-layers** — Google Earth Engine on deck.gl (server-rendered)
- **flowmap.blue** — flow visualization

**Nobody uses deck.gl for SAR imagery with HDF5 input and GPU dB scaling.** SARdine is the first.

---

## 7 — JavaScript HDF5 Libraries

### h5wasm (NIST — Brian Maranville)
| | |
|:---|:---|
| **What it does** | Zero-dependency WebAssembly-powered HDF5 reader/writer. Based on the HDF5 C API compiled to WASM via Emscripten. Full read/write support. Slicing, compression filters, SWMR. |
| **Browser or server** | ✅ **Browser + Node.js.** |
| **Chunked streaming** | ❌ No. Requires entire file loaded into WASM virtual filesystem (Emscripten FS). |
| **SAR features** | ❌ None. Low-level data access. |
| **Key limitations** | Must load entire file into memory (WASM FS). No HTTP range-request support. No streaming. No partial/on-demand loading from remote URLs. Cannot handle multi-GB NISAR files over the network without downloading the whole file first. |
| **Stars** | ~132 |

### jsfive (NIST — Brian Maranville)
| | |
|:---|:---|
| **What it does** | Pure JavaScript HDF5 reader (no WASM). Port of Python's `pyfive`. Supports chunked data, deflate compression via pako. Read-only. |
| **Browser or server** | ✅ **Browser + Node.js.** |
| **Chunked streaming** | ❌ No. Requires entire file as ArrayBuffer. |
| **SAR features** | ❌ None. |
| **Key limitations** | Read-only. Must load full file into ArrayBuffer (limited to ~9 PB theoretically, but practically constrained by browser memory). No partial/range-based reading. Limited datatype support. Single contributor. |
| **Stars** | ~116 |

### Summary: JS HDF5 ecosystem is minimal
| Library | Approach | Read | Write | Streaming | Stars |
|:---|:---|:---|:---|:---|:---|
| h5wasm | WASM (C API) | ✅ | ✅ | ❌ | 132 |
| jsfive | Pure JS | ✅ | ❌ | ❌ | 116 |
| **SARdine h5chunk** | **Pure JS** | **✅** | **❌** | **✅ Range requests** | **—** |

---

## 8 — Competitive Matrix

| Capability | H5Web | jupyterlab-h5web | HSDS | Kerchunk | TiTiler | OpenLayers COG | deck.gl-raster | SNAP | SARdine |
|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|
| Runs in browser (no backend) | ⚠️ Partial | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ |
| Reads HDF5 natively | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ⚠️ | ✅ |
| Streams HDF5 (range requests) | ❌ | ❌ | ❌ | ⚠️ (Python) | ❌ | ❌ | ❌ | ❌ | ✅ |
| NISAR GCOV product support | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| GPU dB scaling | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Polarimetric RGB composites | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| SAR colormaps (viridis, etc.) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ | ✅ | ✅ |
| Cloud Optimized GeoTIFF | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| GeoTIFF export | ❌ | ❌ | ❌ | ❌ | ⚠️ | ❌ | ❌ | ✅ | ✅ |
| Zero install | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ |
| No Python dependency | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ |

---

## 9 — SARdine's Unique Differentiators

### Things NO other tool does:

#### 1. **JavaScript-native cloud-optimized HDF5 chunking (`h5chunk`)**
SARdine's `h5chunk` module is the **world's first JavaScript implementation of the Kerchunk pattern**. It parses HDF5 superblocks, object headers, and B-trees in pure JavaScript, builds a chunk index, and fetches only the chunks intersecting the viewport via HTTP Range requests. Kerchunk does this in Python for server-side pipelines. h5chunk does it in the browser for real-time interactive viewing. **No other JavaScript tool can stream HDF5 chunks on demand.**

#### 2. **Browser-native NISAR GCOV product loading**
No other browser-based tool can open a NISAR Level-2 GCOV HDF5 file, discover frequency bands and polarization channels, and render the data. The existing ecosystem (ISCE3, ASF tools) is entirely Python/C++ desktop software.

#### 3. **GPU-accelerated SAR rendering pipeline (dB + colormaps at 60 fps)**
SARdine does `linear power → σ° dB → colormap → contrast adjustment` entirely in GLSL shaders on the GPU. No existing browser tool combines HDF5 reading with GPU-based SAR-specific rendering. deck.gl-raster had GPU rendering but for optical imagery (NDVI) — never for SAR, and is now archived.

#### 4. **Polarimetric RGB composites in the browser**
Pauli power decomposition, HH/HV/VV composites, dual-pol ratios — computed and rendered client-side. SNAP does this on the desktop. No web tool has ever done it.

#### 5. **HDF5 + COG in one viewer**
SARdine handles both NISAR HDF5 (via h5wasm + h5chunk) and Cloud Optimized GeoTIFF (via geotiff.js), with the same rendering pipeline. Every other tool handles one or the other, never both with unified SAR-specific rendering.

#### 6. **Zero backend, zero install**
Unlike H5Web (needs h5grove server), jupyterlab-h5web (needs Jupyter), HSDS (needs Docker/Kubernetes), TiTiler (needs FastAPI), and SNAP (needs Java desktop install), SARdine is `npm install && npm run dev`. Or drag-and-drop a file. Or paste a URL. No Python. No server. No cloud infrastructure.

#### 7. **Per-channel histogram with auto-contrast for SAR data**
Interactive per-band histogram with percentile-based contrast stretching, specifically tuned for SAR's log-normal intensity distributions. H5Web has basic heatmap rendering but no SAR-aware contrast.

#### 8. **GeoTIFF export of RGB composites from HDF5 source**
Load an HDF5 GCOV, create a Pauli RGB composite, export as a georeferenced 3-band GeoTIFF with CRS and tiepoints — all in the browser. No server. No GDAL.

---

## 10 — Summary Positioning

```
                    Requires Server ←——————————————→ Browser-Native
                    
    HSDS ●                                                      
    TiTiler ●                                                   
    jupyterlab-h5web ●                                          
    SNAP ●  (desktop)                                           
    Kerchunk ● (Python)                                         
    ISCE3 ● (desktop)                                           
                        H5Web ◐ (partial browser)               
                        ASF Search ● (search only)              
                                                   OpenLayers ●  (COG only)
                                                   deck.gl-raster ● (optical only, archived)
                                                                
                                                   SARdine ★  (HDF5 + COG + SAR + GPU)
                                                                
    ← No SAR ————————————————————————————————————→ Full SAR →   
```

**SARdine occupies a unique position**: the only tool that is simultaneously:
- ✅ Browser-native (no server)
- ✅ HDF5-aware (reads NISAR GCOV natively)
- ✅ Cloud-optimized (streams chunks via Range requests)
- ✅ SAR-specific (dB scaling, polarimetric composites, SAR colormaps)
- ✅ GPU-accelerated (GLSL shaders, 60 fps)
- ✅ Multi-format (HDF5 + COG in one tool)

The nearest competitors would need to combine: H5Web's HDF5 reading + Kerchunk's cloud-optimization + deck.gl-raster's GPU rendering + SNAP's SAR processing — and port it all to JavaScript. SARdine does this in one package.
