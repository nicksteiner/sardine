# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
