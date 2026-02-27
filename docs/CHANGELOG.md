# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-beta.2] - 2026-02-18

### Changed
- Rewrote README for beta release with step-by-step usage instructions
- Added clear workflows for local HDF5 files, presigned S3 URLs, and COG URLs
- Added Node.js/npm install instructions for macOS, Windows, and Linux
- Added CORS setup guide for S3, GCS, and Azure
- Added controls reference, export documentation, and keyboard shortcuts
- Bumped version to 1.0.0-beta.2

## [1.0.0-beta.1] - 2026-02-01

### Added
- NISAR GCOV HDF5 local and remote streaming via h5chunk
- Cloud Optimized GeoTIFF loading
- GPU-accelerated dB scaling, colormaps, stretch modes (WebGL2 GLSL)
- RGB polarimetric composites (Pauli, dual-pol, quad-pol)
- Freeman-Durden decomposition
- Per-channel histogram with auto-contrast
- GeoTIFF export (raw Float32 + rendered RGBA + RGB composite)
- Figure export (PNG with scale bar, coordinates, colorbar)
- Overture Maps vector overlay (buildings, roads, places)
- MapLibre basemap integration
- State-as-markdown editing
- STAC catalog search
- Scene catalog (GeoJSON) browsing
- Multi-band and temporal COG stacking
- JupyterHub server mode (launch.cjs)

## [0.1.0] - 2026-01-31

### Added
- Initial release of SARdine
- Core `SARdine` viewer class for SAR imagery visualization
- Custom `SARImageLayer` based on deck.gl's BitmapLayer
- GeoTIFF loading and parsing utilities
- Support for ArrayBuffer and URL-based GeoTIFF loading
- Data normalization and color mapping utilities
- Viewport control methods (pan, zoom, fit bounds)
- Layer management (add, remove, update, clear)
- TypeScript type definitions
- Comprehensive documentation and examples
- Build system using Rollup
- Test infrastructure with Jest

### Features
- Lightweight architecture (no Viv dependency)
- deck.gl-powered WebGL rendering
- Native GeoTIFF support via geotiff.js
- Customizable opacity and color mapping
- Interactive viewport controls
- Multiple layer support

[0.1.0]: https://github.com/nicksteiner/sardine/releases/tag/v0.1.0
