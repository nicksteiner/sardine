import { BitmapLayer } from '@deck.gl/layers';
import type { BitmapLayerProps } from '@deck.gl/layers';
import { loadGeoTIFF, readGeoTIFFData, normalizeData, applyColorMap } from '../utils/geotiff';
import type { ColorMap } from '../types';

export interface SARImageLayerProps extends Partial<BitmapLayerProps> {
  id: string;
  data: ArrayBuffer | string;
  colormap?: ColorMap;
  bounds?: [number, number, number, number];
  opacity?: number;
  visible?: boolean;
}

/**
 * Custom deck.gl layer for rendering SAR imagery from GeoTIFF files
 */
export class SARImageLayer extends BitmapLayer<any> {
  static layerName = 'SARImageLayer';

  initializeState(): void {
    super.initializeState();
    this._loadImage();
  }

  updateState({ props, oldProps }: any): void {
    super.updateState({ props, oldProps });
    if (props.data !== oldProps.data) {
      this._loadImage();
    }
  }

  private async _loadImage(): Promise<void> {
    const { data, colormap, bounds } = this.props as SARImageLayerProps;

    try {
      // Load the GeoTIFF
      const tiff = await loadGeoTIFF(data);
      
      // Read the image data
      const imageData = await readGeoTIFFData(tiff);

      // Normalize the data
      const normalizedData = normalizeData(
        imageData.data,
        colormap?.min,
        colormap?.max
      );

      // Apply color mapping
      const rgbaData = applyColorMap(normalizedData);

      // Create a canvas and draw the image
      const canvas = document.createElement('canvas');
      canvas.width = imageData.width;
      canvas.height = imageData.height;
      const ctx = canvas.getContext('2d');
      
      if (ctx) {
        // Create ImageData object with the canvas API
        const imageDataObj = ctx.createImageData(imageData.width, imageData.height);
        imageDataObj.data.set(rgbaData);
        ctx.putImageData(imageDataObj, 0, 0);
      }

      // Update the layer props for BitmapLayer
      this.internalState = {
        ...this.internalState,
        imageData: canvas,
        imageBounds: bounds || imageData.bounds,
      };

      // Trigger a redraw
      this.setNeedsRedraw();
    } catch (error) {
      console.error('Error loading GeoTIFF:', error);
    }
  }

  // Return the props for the parent BitmapLayer
  draw(params: any): void {
    const { imageData, imageBounds } = this.internalState || {};
    
    if (imageData && imageBounds) {
      // Update props for BitmapLayer rendering
      this.props.image = imageData;
      this.props.bounds = imageBounds;
    }
    
    super.draw(params);
  }
}
