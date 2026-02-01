import { Deck } from '@deck.gl/core';
import type { MapViewState } from '@deck.gl/core';
import { SARImageLayer } from './layers/SARImageLayer';
import type { SARdineOptions, ViewState, SARImageLayerOptions } from './types';

/**
 * SARdine - A lightweight SAR imagery viewer
 * 
 * Built on deck.gl and geotiff.js for high-performance
 * visualization of SAR (Synthetic Aperture Radar) imagery.
 */
export class SARdine {
  private deck: Deck;
  private layers: Map<string, SARImageLayer>;
  private container: HTMLElement;

  constructor(options: SARdineOptions) {
    // Get or create container element
    if (typeof options.container === 'string') {
      const element = document.getElementById(options.container);
      if (!element) {
        throw new Error(`Container element with id "${options.container}" not found`);
      }
      this.container = element;
    } else {
      this.container = options.container;
    }

    // Apply container styles
    if (options.style) {
      if (options.style.width) {
        this.container.style.width = options.style.width;
      }
      if (options.style.height) {
        this.container.style.height = options.style.height;
      }
    }

    // Set default styles if not specified
    if (!this.container.style.width) {
      this.container.style.width = '100%';
    }
    if (!this.container.style.height) {
      this.container.style.height = '600px';
    }
    this.container.style.position = 'relative';

    this.layers = new Map();

    // Initialize deck.gl
    this.deck = new Deck({
      parent: this.container,
      initialViewState: options.initialViewState || {
        longitude: 0,
        latitude: 0,
        zoom: 2,
        pitch: 0,
        bearing: 0,
      },
      controller: options.controller !== undefined ? options.controller : true,
      layers: [],
    });
  }

  /**
   * Add a SAR image layer to the viewer
   */
  async addLayer(options: SARImageLayerOptions): Promise<void> {
    const layer = new SARImageLayer({
      id: options.id,
      data: options.data,
      opacity: options.opacity ?? 1.0,
      visible: options.visible ?? true,
      colormap: options.colormap,
      bounds: options.bounds,
    });

    this.layers.set(options.id, layer);
    this._updateLayers();
  }

  /**
   * Remove a layer by ID
   */
  removeLayer(id: string): void {
    this.layers.delete(id);
    this._updateLayers();
  }

  /**
   * Update layer properties
   */
  updateLayer(id: string, props: Partial<SARImageLayerOptions>): void {
    const layer = this.layers.get(id);
    if (layer) {
      // Create new layer with updated props
      const updatedLayer = new SARImageLayer({
        ...layer.props,
        ...props,
      });
      this.layers.set(id, updatedLayer);
      this._updateLayers();
    }
  }

  /**
   * Get current viewport state
   */
  getViewState(): ViewState {
    const deckViewManager = (this.deck as any).viewManager;
    const view = deckViewManager?.getViewState();
    
    return {
      longitude: view?.longitude || 0,
      latitude: view?.latitude || 0,
      zoom: view?.zoom || 2,
      pitch: view?.pitch || 0,
      bearing: view?.bearing || 0,
    };
  }

  /**
   * Set viewport state
   */
  setViewState(viewState: Partial<ViewState>): void {
    const currentViewState = this.getViewState();
    this.deck.setProps({
      initialViewState: {
        ...currentViewState,
        ...viewState,
      },
    });
  }

  /**
   * Fit view to bounds
   */
  fitBounds(bounds: [number, number, number, number]): void {
    const [minX, minY, maxX, maxY] = bounds;
    const centerLongitude = (minX + maxX) / 2;
    const centerLatitude = (minY + maxY) / 2;

    // Simple zoom calculation (can be improved)
    const latDiff = maxY - minY;
    const lonDiff = maxX - minX;
    const maxDiff = Math.max(latDiff, lonDiff);
    const zoom = Math.log2(360 / maxDiff) - 1;

    this.setViewState({
      longitude: centerLongitude,
      latitude: centerLatitude,
      zoom: Math.max(0, zoom),
    });
  }

  /**
   * Get all layer IDs
   */
  getLayerIds(): string[] {
    return Array.from(this.layers.keys());
  }

  /**
   * Clear all layers
   */
  clearLayers(): void {
    this.layers.clear();
    this._updateLayers();
  }

  /**
   * Destroy the viewer and clean up resources
   */
  destroy(): void {
    this.deck.finalize();
    this.layers.clear();
  }

  /**
   * Update deck.gl with current layers
   */
  private _updateLayers(): void {
    const layersArray = Array.from(this.layers.values());
    this.deck.setProps({ layers: layersArray });
  }
}
