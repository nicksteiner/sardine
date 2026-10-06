import { TileLayer } from '@deck.gl/geo-layers';
import { computeRGBBands } from '../utils/sar-composites.js';
import { SARGPULayer } from './SARGPULayer.js';
import { debugLog } from '../utils/debug-log.js';

/**
 * SARTileLayer - A deck.gl TileLayer specialized for SAR imagery
 *
 * Raw float data is cached in getTileData; rendering (dB, colormap, contrast)
 * is applied in renderSubLayers so prop changes are instant without refetching.
 *
 * Speckle filtering is handled by SARGPULayer via WebGL2 FBO render-to-texture
 * passes — the filter runs entirely on the GPU with no CPU readback.
 * The WebGPU compute path (spatial-filter.js) is retained for the export pipeline.
 */
export class SARTileLayer extends TileLayer {
  static componentName = 'SARTileLayer';

  constructor(props) {
    const {
      getTile,
      getTileData: externalGetTileData,
      bounds,
      contrastLimits = [-25, 0],
      useDecibels = true,
      colormap = 'grayscale',
      reverseColormap = false,
      gamma = 1.0,
      stretchMode = 'linear',
      rgbSaturation = 1.0,
      colorblindMode = 'off',
      opacity = 1,
      multiLook = false,
      maskInvalid = false,
      maskLayoverShadow = false,
      useCoherenceMask = false,
      coherenceThreshold = 0.3,
      coherenceThresholdMax = 1.0,
      coherenceMaskMode = 0,
      incidenceAngleData = null,
      verticalDisplacement = false,
      valueScale = 1.0, // unit conversion, e.g. λ/4π for phase(rad) → LOS meters
      correctionLayers = null, // {ionosphere, troposphereWet, ...} each {data, width, height}
      enabledCorrections = null, // Set of enabled correction keys
      speckleFilterType = 'none',
      speckleKernelSize = 7,
      pixelMode = false,
      classMode = false,
      classPalette = null,
      classPaletteEntries = 0,
      minZoom,
      maxZoom = 20,
      tileSize = 256,
      ...otherProps
    } = props;

    let computedMinZoom = minZoom;
    if (computedMinZoom === undefined && bounds) {
      const [minX, minY, maxX, maxY] = bounds;
      const maxSpan = Math.max(maxX - minX, maxY - minY);
      // Use negative zoom for large extents so the whole image can be
      // covered by a manageable number of tiles at the outermost zoom level.
      // At minZoom, each tile covers tileSize * 2^(-minZoom) world units.
      computedMinZoom = -Math.ceil(Math.log2(maxSpan / tileSize));
    }
    if (computedMinZoom === undefined) computedMinZoom = -8;

    // No filter suffix in layer ID — filter changes no longer trigger tile re-fetch.
    // Filter params are passed to SARGPULayer and applied via WebGL2 FBO on the GPU.
    const layerId = `${props.id || 'sar-tile-layer'}-${multiLook ? 'ml' : 'nn'}`;

    // Use external getTileData if provided (stable reference from SARViewer),
    // otherwise create a default closure from getTile + multiLook.
    const getTileDataFn = externalGetTileData || (async (tile) => {
      const { bbox } = tile;
      const tileData = await getTile({
        x: tile.index.x,
        y: tile.index.y,
        z: tile.index.z,
        bbox,
        multiLook,
      });
      if (!tileData) return null;
      return tileData;
    });

    super({
      id: layerId,

      // getTileData caches RAW float data (not rendered textures)
      getTileData: getTileDataFn,

      extent: bounds,
      minZoom: computedMinZoom,
      maxZoom,
      tileSize,
      opacity,

      // Force sublayer re-render when rendering or filter params change
      updateTriggers: {
        renderSubLayers: [contrastLimits, useDecibels, colormap, reverseColormap, gamma, stretchMode, rgbSaturation, colorblindMode, maskInvalid, maskLayoverShadow, useCoherenceMask, coherenceThreshold, coherenceThresholdMax, coherenceMaskMode, incidenceAngleData, verticalDisplacement, valueScale, correctionLayers, enabledCorrections, speckleFilterType, speckleKernelSize, pixelMode, classMode, classPalette, classPaletteEntries, opacity],
      },

      renderSubLayers: (subProps) => {
        const tileData = subProps.data;
        if (!tileData) return null;

        const { bbox } = subProps.tile;
        const tileBounds = bbox.west !== undefined
          ? [bbox.west, bbox.south, bbox.east, bbox.north]
          : [bbox.left, Math.min(bbox.top, bbox.bottom), bbox.right, Math.max(bbox.top, bbox.bottom)];

        // Mask data (if available from tile)
        const maskProps = tileData.mask ? { dataMask: tileData.mask, maskInvalid, maskLayoverShadow } : { maskInvalid: false, maskLayoverShadow: false };

        // Speckle filter props — SARGPULayer handles filtering via WebGL2 FBO.
        // Class-map props ride along here too (single-band only; ignored for RGB).
        const filterProps = {
          speckleFilterType,
          speckleKernelSize,
          pixelMode,
          classMode,
          classPalette,
          classPaletteEntries,
        };

        // RGB composite mode - GPU accelerated (3x R32F textures)
        if (tileData.bands && tileData.compositeId) {
          // Cache computeRGBBands on the tile data — only recompute when
          // bands or compositeId change, not on every visual prop update
          // (contrast, colormap, stretch). This avoids ~65K Float32Array
          // operations per tile on every slider drag.
          if (!tileData._rgbCache || tileData._rgbCache.compositeId !== tileData.compositeId) {
            tileData._rgbCache = {
              compositeId: tileData.compositeId,
              bands: computeRGBBands(tileData.bands, tileData.compositeId, tileData.width),
            };
          }
          const rgbBands = tileData._rgbCache.bands;

          return new SARGPULayer({
            id: `${subProps.id}-gpu-rgb`,
            mode: 'rgb',
            data: {length: 0},  // deck.gl requires non-null data object
            dataR: rgbBands.R,
            dataG: rgbBands.G,
            dataB: rgbBands.B,
            width: tileData.width,
            height: tileData.height,
            bounds: tileBounds,
            mesh: tileData._mesh || null,
            contrastLimits,
            useDecibels,
            colormap,
            reverseColormap,
            gamma,
            stretchMode,
            rgbSaturation,
            colorblindMode,
            opacity,
            ...maskProps,
            ...filterProps,
          });
        } else if (tileData.data) {
          // Auxiliary mask props: coherence (GUNW) or incidence angle (GCOV)
          const cohProps = tileData.coherenceData ? {
            dataCoherence: tileData.coherenceData,
            coherenceWidth: tileData.width,
            coherenceHeight: tileData.height,
            useCoherenceMask,
            coherenceThreshold,
            coherenceThresholdMax,
            coherenceMaskMode,
          } : (incidenceAngleData ? {
            dataCoherence: incidenceAngleData.data,
            coherenceWidth: incidenceAngleData.width,
            coherenceHeight: incidenceAngleData.height,
            useCoherenceMask,
            coherenceThreshold,
            coherenceThresholdMax,
            coherenceMaskMode,
          } : {});

          // Incidence angle props for vertical displacement correction
          // Incidence angle is a full-extent grid — needs imageBounds for UV remap
          const incProps = (verticalDisplacement && incidenceAngleData) ? {
            dataIncidence: incidenceAngleData.data,
            incidenceWidth: incidenceAngleData.width,
            incidenceHeight: incidenceAngleData.height,
            verticalDisplacement,
            imageBounds: bounds,
          } : {};

          // Phase correction props — ionosphere is per-tile; cube corrections are full-extent
          const corProps = {};
          if (enabledCorrections?.size > 0) {
            // Ionosphere: per-tile data (same grid as phase), fetched in getTileData
            if (enabledCorrections.has('ionosphere') && tileData.ionosphereData) {
              corProps.dataCorIono = tileData.ionosphereData;
              corProps.corIonoWidth = tileData.width;
              corProps.corIonoHeight = tileData.height;
              corProps.corIono = true;
              // Debug: log first tile's iono stats
              if (subProps.tile.index.x === 0 && subProps.tile.index.y === 0) {
                const d = tileData.ionosphereData;
                let min = Infinity, max = -Infinity, nanCount = 0;
                for (let i = 0; i < d.length; i++) {
                  if (isNaN(d[i])) { nanCount++; continue; }
                  if (d[i] < min) min = d[i];
                  if (d[i] > max) max = d[i];
                }
                debugLog(`[SARTileLayer] iono tile(0,0): min=${min.toFixed(3)} max=${max.toFixed(3)} nan=${nanCount}/${d.length}`);
                const pd = tileData.data;
                let pmin = Infinity, pmax = -Infinity, pnan = 0;
                for (let i = 0; i < pd.length; i++) {
                  if (isNaN(pd[i])) { pnan++; continue; }
                  if (pd[i] < pmin) pmin = pd[i];
                  if (pd[i] > pmax) pmax = pd[i];
                }
                debugLog(`[SARTileLayer] phase tile(0,0): min=${pmin.toFixed(3)} max=${pmax.toFixed(3)} nan=${pnan}/${pd.length}`);
              }
            }
            // Full-extent cube corrections: tropo, SET, ramp — need imageBounds for UV remap
            if (correctionLayers) {
              const cubeMap = {
                troposphereWet: { data: 'dataCorTropo', w: 'corTropoWidth', h: 'corTropoHeight', flag: 'corTropo' },
                troposphereHydrostatic: { data: 'dataCorTropo', w: 'corTropoWidth', h: 'corTropoHeight', flag: 'corTropo' },
                solidEarthTides: { data: 'dataCorSET', w: 'corSETWidth', h: 'corSETHeight', flag: 'corSET' },
                planarRamp: { data: 'dataCorRamp', w: 'corRampWidth', h: 'corRampHeight', flag: 'corRamp' },
              };
              for (const key of enabledCorrections) {
                const slot = cubeMap[key];
                const layer = correctionLayers[key];
                if (slot && layer?.data) {
                  corProps[slot.data] = layer.data;
                  corProps[slot.w] = layer.width;
                  corProps[slot.h] = layer.height;
                  corProps[slot.flag] = true;
                }
              }
            }
            // Pass full image bounds for UV remapping of full-extent corrections
            if (bounds) corProps.imageBounds = bounds;
            // Debug: log which corrections are active and their stats
            if (subProps.tile.index.x === 0 && subProps.tile.index.y === 0) {
              const active = Object.entries(corProps).filter(([k, v]) => k.startsWith('cor') && v === true).map(([k]) => k);
              debugLog(`[SARTileLayer] corrections active:`, active, 'imageBounds:', bounds);
              for (const [k, v] of Object.entries(corProps)) {
                if (v instanceof Float32Array) {
                  let mn = Infinity, mx = -Infinity, nn = 0;
                  for (let i = 0; i < Math.min(v.length, 10000); i++) {
                    if (isNaN(v[i])) { nn++; continue; }
                    if (v[i] < mn) mn = v[i];
                    if (v[i] > mx) mx = v[i];
                  }
                  debugLog(`[SARTileLayer] ${k}: min=${mn.toFixed(3)} max=${mx.toFixed(3)} nan=${nn}`);
                }
              }
            }
          }

          return new SARGPULayer({
            id: `${subProps.id}-gpu`,
            data: tileData.data,  // Raw Float32Array - uploaded as R32F texture
            width: tileData.width,
            height: tileData.height,
            bounds: tileBounds,
            mesh: tileData._mesh || null,
            contrastLimits,
            useDecibels,
            colormap,
            reverseColormap,
            gamma,
            stretchMode,
            opacity,
            valueScale,
            ...maskProps,
            ...filterProps,
            ...cohProps,
            ...incProps,
            ...corProps,
          });
        } else {
          return null;
        }
      },

      ...otherProps,
    });
  }

  _createR32FTexture(gl, data, width, height) {
    const expectedSize = width * height;
    let texData = data;

    // Pad undersized arrays (edge tiles at dataset boundary)
    if (data.length < expectedSize) {
      texData = new Float32Array(expectedSize);
      texData.fill(NaN); // NaN → transparent in shader
      texData.set(data);
    }

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R32F,
      width, height, 0,
      gl.RED, gl.FLOAT, texData
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return texture;
  }
}

export default SARTileLayer;
