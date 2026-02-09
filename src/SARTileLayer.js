/**
 * @module SARTileLayer
 */

import { BitmapLayer } from '@deck.gl/layers';
import { canUseGPURendering } from './utils/gpu-detect.js';
import { createRGBTexture } from './sar-composites.js';
import { SARGPUBitmapLayer } from './SARGPUBitmapLayer.js';
import { Layer } from '@deck.gl/core';

/**
 * SAR Tile Layer for rendering SAR data tiles.
 * @extends {Layer}
 */
export class SARTileLayer extends Layer {
  constructor(props) {
    super(props);
    if (!canUseGPURendering() && !_gpuWarningLogged) {
      _gpuWarningLogged = true;
      console.warn(
        '[SARTileLayer] GPU rendering unavailable (missing WebGL2 or float textures). ' +
        'Falling back to CPU compositing — parameter changes will be slower (~1–4 FPS).'
      );
    }
  }

  // ...existing code...

  renderSubLayers(props) {
    if (canUseGPURendering()) {
      // GPU path (SARGPUBitmapLayer)
      return this._renderGPUSubLayers(props);
    }

    // CPU fallback — BitmapLayer with pre-composited RGBA bitmap
    const { tile } = props;
    const { data, bounds } = tile;
    if (!data) return null;

    const image = createSARTexture(data, this.props);
    return new BitmapLayer({
      ...props,
      id: `${props.id}-cpu`,
      image,
      bounds,
    });
  }

  // ...existing code...
}

/**
 * Create an RGBA ImageData / bitmap from SAR tile data using CPU compositing.
 * Used as the fallback when GPU rendering is unavailable.
 */
function createSARTexture(data, props) {
  // ...existing code (lines ~143-173 unchanged)...
}

let _gpuWarningLogged = false;