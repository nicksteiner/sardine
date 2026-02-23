import { CompositeLayer } from '@deck.gl/core';
import { SARBitmapLayer } from './SARBitmapLayer.js';
import { fromUrl } from 'geotiff';
import { normalizeUrl } from '../loaders/cog-loader.js';
import { smartToneMap } from '../utils/tone-mapping.js';

/**
 * SARTiledCOGLayer - A deck.gl layer for COGs in arbitrary projections
 * Dynamically loads tiles from different overview levels based on zoom
 */
export class SARTiledCOGLayer extends CompositeLayer {
  static componentName = 'SARTiledCOGLayer';

  initializeState() {
    this.state = {
      tiff: null,
      imageCount: 0,
      mainImage: null,
      bounds: null,
      width: 0,
      height: 0,
      tileCache: new Map(),
      tileAccessTime: new Map(), // Track last access time for LRU eviction
      loadingTiles: new Set(),
      viewportInitialized: false,
      lastOverview: -1, // Track last overview to optimize cache cleanup
      maxCacheSize: 100, // Max tiles to keep in cache
    };
  }

  async finalizeState() {
    // Clean up resources
    this.state.tileCache.clear();
    this.state.tileAccessTime.clear();
    this.state.loadingTiles.clear();
  }

  shouldUpdateState({ changeFlags }) {
    // Update on data changes or viewport changes
    return changeFlags.somethingChanged;
  }

  updateState({ changeFlags }) {
    if (changeFlags.dataChanged || !this.state.tiff) {
      this._loadCOG();
    }
  }

  async _loadCOG() {
    const { url } = this.props;
    if (!url) return;

    try {
      const normalizedUrl = normalizeUrl(url);
      const tiff = await fromUrl(normalizedUrl);
      const mainImage = await tiff.getImage(0);
      const imageCount = await tiff.getImageCount();

      const width = mainImage.getWidth();
      const height = mainImage.getHeight();

      // Get bounds from props or calculate from image
      let bounds = this.props.bounds;
      if (!bounds) {
        try {
          const bbox = mainImage.getBoundingBox();
          bounds = [bbox[0], bbox[1], bbox[2], bbox[3]];
        } catch (e) {
          console.error('[SARTiledCOGLayer] Could not get bounds:', e);
          return;
        }
      }

      this.setState({
        tiff,
        mainImage,
        imageCount,
        width,
        height,
        bounds,
        tileCache: new Map(),
        tileAccessTime: new Map(),
      });
    } catch (error) {
      console.error('[SARTiledCOGLayer] Failed to load COG:', error);
    }
  }

  /**
   * Calculate which overview level to use based on viewport zoom
   */
  _getOverviewIndex(zoom) {
    const { width, height, imageCount, bounds } = this.state;
    if (!width || !height || !imageCount || !bounds) return 0;

    // Strategy: Pick the overview where the overview pixels roughly match
    // the screen pixels needed to display the image at this zoom level

    // At zoom Z, we render pixels at 2^Z scale
    // We want to pick the overview closest to this scale
    // Overview 0 = full res = scale 1
    // Overview 1 = 1/2 res = scale 0.5
    // Overview 2 = 1/4 res = scale 0.25
    // Overview N = 1/(2^N) res = scale 2^(-N)

    // At zoom Z, ideal scale = 2^Z pixels per world unit
    // But our image has (width pixels / worldWidth units) native resolution
    const [minX, , maxX] = bounds;
    const worldWidth = maxX - minX;
    const nativePixelsPerUnit = width / worldWidth;

    // At this zoom, we need pixelsPerUnit in screen space
    const pixelsPerUnit = Math.pow(2, zoom);

    // Ratio: how much detail do we need vs native?
    // If ratio > 1, we need more detail than native (use overview 0)
    // If ratio = 0.5, overview 1 is perfect
    // If ratio = 0.25, overview 2 is perfect
    const detailRatio = pixelsPerUnit / nativePixelsPerUnit;

    // Convert ratio to overview index
    // detailRatio = 2^(-overviewIndex)
    // overviewIndex = -log2(detailRatio)
    let bestOverview = Math.round(-Math.log2(detailRatio));

    // Clamp to available range
    bestOverview = Math.max(0, Math.min(imageCount - 1, bestOverview));

    const selectedWidth = Math.floor(width / Math.pow(2, bestOverview));
    const selectedHeight = Math.floor(height / Math.pow(2, bestOverview));

    // Only log on overview change
    if (bestOverview !== this.state.lastOverview) {
      console.log(`[SARTiledCOGLayer] Overview ${bestOverview}/${imageCount - 1} (${selectedWidth}x${selectedHeight} px)`);
    }

    return bestOverview;
  }

  /**
   * Get visible tiles for the current viewport
   */
  _getVisibleTiles(viewport) {
    const { bounds, width, height } = this.state;
    if (!bounds || !width || !height) return [];

    const [minX, minY, maxX, maxY] = bounds;

    // Get viewport bounds in world coordinates
    const viewportBounds = this._getViewportBounds(viewport);

    // Check if viewport bounds are valid
    if (!viewportBounds.every(v => isFinite(v))) {
      return [];
    }

    // Check if viewport is roughly centered on the image
    // If viewport is still at origin but image is far away, skip rendering
    if (!this.state.viewportInitialized) {
      const viewportCenterX = (viewportBounds[0] + viewportBounds[2]) / 2;
      const viewportCenterY = (viewportBounds[1] + viewportBounds[3]) / 2;
      const imageCenterX = (minX + maxX) / 2;
      const imageCenterY = (minY + maxY) / 2;
      const distanceToImage = Math.sqrt(
        Math.pow(viewportCenterX - imageCenterX, 2) +
        Math.pow(viewportCenterY - imageCenterY, 2)
      );
      const imageSize = Math.max(maxX - minX, maxY - minY);

      // If viewport is more than 10x the image size away, it's not initialized yet
      if (distanceToImage > imageSize * 10) {
        // Trigger a re-render but don't spam
        setTimeout(() => this.setNeedsUpdate(), 100);
        return [];
      } else {
        this.state.viewportInitialized = true;
      }
    }

    // Calculate zoom from viewport scale
    const worldWidth = viewportBounds[2] - viewportBounds[0];
    const zoom = Math.log2(viewport.width / worldWidth);

    // Find which overview to use
    const overviewIndex = this._getOverviewIndex(zoom);

    // Calculate tile size in world coordinates (aim for ~512 pixels per tile)
    const tilePixelSize = 512;
    const pixelsPerUnit = Math.pow(2, zoom);
    const tileWorldSize = tilePixelSize / pixelsPerUnit;

    // Calculate tile grid dimensions
    const tilesX = Math.ceil((maxX - minX) / tileWorldSize);
    const tilesY = Math.ceil((maxY - minY) / tileWorldSize);

    // Find tiles that intersect the viewport
    const tiles = [];
    const [vMinX, vMinY, vMaxX, vMaxY] = viewportBounds;

    // Calculate viewport tile range for early culling
    const startTileX = Math.max(0, Math.floor((vMinX - minX) / tileWorldSize));
    const endTileX = Math.min(tilesX, Math.ceil((vMaxX - minX) / tileWorldSize));
    const startTileY = Math.max(0, Math.floor((vMinY - minY) / tileWorldSize));
    const endTileY = Math.min(tilesY, Math.ceil((vMaxY - minY) / tileWorldSize));

    for (let ty = startTileY; ty < endTileY; ty++) {
      for (let tx = startTileX; tx < endTileX; tx++) {
        const tileMinX = minX + tx * tileWorldSize;
        const tileMinY = minY + ty * tileWorldSize;
        const tileMaxX = Math.min(maxX, tileMinX + tileWorldSize);
        const tileMaxY = Math.min(maxY, tileMinY + tileWorldSize);

        tiles.push({
          x: tx,
          y: ty,
          overview: overviewIndex,
          bounds: [tileMinX, tileMinY, tileMaxX, tileMaxY],
          key: `${overviewIndex}-${tx}-${ty}`,
        });
      }
    }

    return tiles;
  }

  /**
   * Get viewport bounds in world coordinates
   */
  _getViewportBounds(viewport) {
    // Use deck.gl's unproject to get world coordinates for viewport corners
    const { width, height } = viewport;

    // Unproject the four corners of the viewport
    const topLeft = viewport.unproject([0, 0]);
    const bottomRight = viewport.unproject([width, height]);

    const bounds = [
      topLeft[0],     // minX
      bottomRight[1], // minY (Y is inverted in screen space)
      bottomRight[0], // maxX
      topLeft[1],     // maxY
    ];

    return bounds;
  }

  /**
   * Load tile data from COG
   */
  async _loadTile(tile) {
    const { tiff, bounds: imageBounds } = this.state;
    const { overview, bounds } = tile;

    const cacheKey = tile.key;

    // Check cache
    if (this.state.tileCache.has(cacheKey)) {
      // Update access time for LRU tracking
      this.state.tileAccessTime.set(cacheKey, Date.now());
      return this.state.tileCache.get(cacheKey);
    }

    // Check if already loading
    if (this.state.loadingTiles.has(cacheKey)) {
      return null;
    }

    this.state.loadingTiles.add(cacheKey);

    try {
      // Get the overview image
      const image = await tiff.getImage(overview);
      const imgWidth = image.getWidth();
      const imgHeight = image.getHeight();

      // Convert world bounds to pixel coordinates in this overview
      const [minX, minY, maxX, maxY] = imageBounds;
      const [tileMinX, tileMinY, tileMaxX, tileMaxY] = bounds;

      // Calculate pixel coordinates
      const scaleX = imgWidth / (maxX - minX);
      const scaleY = imgHeight / (maxY - minY);

      const pixelLeft = Math.floor((tileMinX - minX) * scaleX);
      const pixelTop = Math.floor((maxY - tileMaxY) * scaleY); // Y is inverted in image space
      const pixelRight = Math.ceil((tileMaxX - minX) * scaleX);
      const pixelBottom = Math.ceil((maxY - tileMinY) * scaleY);

      // Clamp to image bounds
      const left = Math.max(0, pixelLeft);
      const top = Math.max(0, pixelTop);
      const right = Math.min(imgWidth, pixelRight);
      const bottom = Math.min(imgHeight, pixelBottom);

      const tileWidth = right - left;
      const tileHeight = bottom - top;

      if (tileWidth <= 0 || tileHeight <= 0) {
        console.warn('[SARTiledCOGLayer] Invalid tile dimensions:', { left, top, right, bottom });
        this.state.loadingTiles.delete(cacheKey);
        return null;
      }

      // Read the tile data
      const rasters = await image.readRasters({
        window: [left, top, right, bottom],
      });

      let data = new Float32Array(rasters[0]);

      // Apply tone mapping if enabled
      const { toneMapping } = this.props;
      if (toneMapping && toneMapping.enabled) {
        const toneMapResult = smartToneMap(data, tileWidth, tileHeight, {
          method: toneMapping.method || 'auto',
          noDataValue: toneMapping.noDataValue || 0,
          ...toneMapping.params,
        });

        // Convert tone-mapped Uint8Array to Float32Array (normalized 0-1)
        // This allows the shader to still apply colormaps
        data = new Float32Array(toneMapResult.image.length);
        for (let i = 0; i < toneMapResult.image.length; i++) {
          data[i] = toneMapResult.image[i] / 255.0;
        }
      }

      const tileData = {
        data,
        width: tileWidth,
        height: tileHeight,
        bounds,
      };

      // Cache the tile and track access time
      this.state.tileCache.set(cacheKey, tileData);
      this.state.tileAccessTime.set(cacheKey, Date.now());
      this.state.loadingTiles.delete(cacheKey);

      // Trigger re-render
      this.setNeedsUpdate();

      return tileData;
    } catch (error) {
      console.error('[SARTiledCOGLayer] Failed to load tile:', tile.key, error);
      this.state.loadingTiles.delete(cacheKey);
      return null;
    }
  }

  renderLayers() {
    const { bounds, tiff } = this.state;
    const { contrastLimits, useDecibels, colormap, gamma, stretchMode, opacity, onLoadingChange, toneMapping, useMask = false } = this.props;

    // Wait for COG to be loaded before rendering
    if (!bounds || !tiff) {
      return [];
    }

    // When tone mapping is enabled, data is already preprocessed (0-1 range)
    // so we bypass dB conversion and use identity contrast limits
    const useToneMapping = toneMapping && toneMapping.enabled;
    const effectiveUseDecibels = useToneMapping ? false : useDecibels;
    const effectiveContrastLimits = useToneMapping ? [0, 1] : contrastLimits;

    const viewport = this.context.viewport;
    const visibleTiles = this._getVisibleTiles(viewport);
    const currentOverview = visibleTiles.length > 0 ? visibleTiles[0].overview : 0;

    // Clean up cache when overview changes (not on every render)
    if (currentOverview !== this.state.lastOverview) {
      this.state.lastOverview = currentOverview;

      // Remove tiles from other overview levels
      for (const [key] of this.state.tileCache) {
        const tileOverview = parseInt(key.split('-')[0]);
        if (tileOverview !== currentOverview) {
          this.state.tileCache.delete(key);
          this.state.tileAccessTime.delete(key);
        }
      }
    }

    // Enforce max cache size using LRU eviction
    if (this.state.tileCache.size > this.state.maxCacheSize) {
      // Sort tiles by access time (oldest first)
      const sortedKeys = Array.from(this.state.tileAccessTime.entries())
        .sort((a, b) => a[1] - b[1])
        .map(entry => entry[0]);

      // Remove oldest tiles until we're under the limit
      const numToRemove = this.state.tileCache.size - Math.floor(this.state.maxCacheSize * 0.75);
      for (let i = 0; i < numToRemove && i < sortedKeys.length; i++) {
        this.state.tileCache.delete(sortedKeys[i]);
        this.state.tileAccessTime.delete(sortedKeys[i]);
      }
    }

    // Sort tiles by distance from viewport center (load center tiles first)
    if (visibleTiles.length > 0) {
      const vpCenterX = (viewport.unproject([viewport.width / 2, viewport.height / 2])[0]);
      const vpCenterY = (viewport.unproject([viewport.width / 2, viewport.height / 2])[1]);

      visibleTiles.sort((a, b) => {
        const aCenterX = (a.bounds[0] + a.bounds[2]) / 2;
        const aCenterY = (a.bounds[1] + a.bounds[3]) / 2;
        const bCenterX = (b.bounds[0] + b.bounds[2]) / 2;
        const bCenterY = (b.bounds[1] + b.bounds[3]) / 2;

        const aDist = Math.pow(aCenterX - vpCenterX, 2) + Math.pow(aCenterY - vpCenterY, 2);
        const bDist = Math.pow(bCenterX - vpCenterX, 2) + Math.pow(bCenterY - vpCenterY, 2);

        return aDist - bDist;
      });
    }

    // Load visible tiles (center tiles first due to sorting), max 4 concurrent
    const MAX_CONCURRENT = 4;
    for (const tile of visibleTiles) {
      if (this.state.loadingTiles.size >= MAX_CONCURRENT) break;
      if (!this.state.tileCache.has(tile.key) && !this.state.loadingTiles.has(tile.key)) {
        this._loadTile(tile);
      }
    }

    // Report loading status
    if (onLoadingChange) {
      const tilesLoading = this.state.loadingTiles.size;
      const tilesLoaded = visibleTiles.filter(t => this.state.tileCache.has(t.key)).length;
      const totalTiles = visibleTiles.length;
      onLoadingChange({
        tilesLoading,
        tilesLoaded,
        totalTiles,
        currentOverview,
        totalOverviews: this.state.imageCount || 0,
      });
    }

    // Render loaded tiles from current overview only
    const layers = [];
    const now = Date.now();

    visibleTiles.forEach(tile => {
      const tileData = this.state.tileCache.get(tile.key);

      // Only render tiles from the current overview level
      if (tileData && tile.overview === currentOverview) {
        // Update access time for LRU tracking
        this.state.tileAccessTime.set(tile.key, now);

        layers.push(
          new SARBitmapLayer({
            id: `tile-${tile.key}`,
            data: tileData.data,
            width: tileData.width,
            height: tileData.height,
            bounds: tileData.bounds,
            contrastLimits: effectiveContrastLimits,
            useDecibels: effectiveUseDecibels,
            colormap,
            gamma,
            stretchMode,
            opacity,
            dataMask: tileData.mask || null,
            useMask,
          })
        );
      }
    });

    return layers;
  }
}

export default SARTiledCOGLayer;
