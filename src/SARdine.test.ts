import { SARdine } from './SARdine';
import type { SARdineOptions } from './types';

describe('SARdine', () => {
  let container: HTMLElement;

  beforeEach(() => {
    // Create a container element for testing
    container = document.createElement('div');
    container.id = 'test-container';
    document.body.appendChild(container);
  });

  afterEach(() => {
    // Clean up
    document.body.removeChild(container);
  });

  describe('constructor', () => {
    it('should create a SARdine instance with string container', () => {
      const viewer = new SARdine({
        container: 'test-container',
      });

      expect(viewer).toBeInstanceOf(SARdine);
      viewer.destroy();
    });

    it('should create a SARdine instance with HTMLElement container', () => {
      const viewer = new SARdine({
        container: container,
      });

      expect(viewer).toBeInstanceOf(SARdine);
      viewer.destroy();
    });

    it('should throw error if container ID not found', () => {
      expect(() => {
        new SARdine({
          container: 'non-existent-container',
        });
      }).toThrow('Container element with id "non-existent-container" not found');
    });

    it('should apply custom styles', () => {
      const viewer = new SARdine({
        container: container,
        style: {
          width: '800px',
          height: '600px',
        },
      });

      expect(container.style.width).toBe('800px');
      expect(container.style.height).toBe('600px');
      viewer.destroy();
    });

    it('should set default styles if not specified', () => {
      const viewer = new SARdine({
        container: container,
      });

      expect(container.style.width).toBe('100%');
      expect(container.style.height).toBe('600px');
      expect(container.style.position).toBe('relative');
      viewer.destroy();
    });
  });

  describe('viewport methods', () => {
    let viewer: SARdine;

    beforeEach(() => {
      viewer = new SARdine({
        container: container,
        initialViewState: {
          longitude: -122.4,
          latitude: 37.8,
          zoom: 10,
        },
      });
    });

    afterEach(() => {
      viewer.destroy();
    });

    it('should get current view state', () => {
      const viewState = viewer.getViewState();
      expect(viewState).toHaveProperty('longitude');
      expect(viewState).toHaveProperty('latitude');
      expect(viewState).toHaveProperty('zoom');
    });

    it('should set view state', () => {
      viewer.setViewState({
        longitude: 0,
        latitude: 0,
        zoom: 5,
      });

      const viewState = viewer.getViewState();
      expect(viewState.longitude).toBe(0);
      expect(viewState.latitude).toBe(0);
      expect(viewState.zoom).toBe(5);
    });
  });

  describe('layer management', () => {
    let viewer: SARdine;

    beforeEach(() => {
      viewer = new SARdine({
        container: container,
      });
    });

    afterEach(() => {
      viewer.destroy();
    });

    it('should get empty layer IDs initially', () => {
      const layerIds = viewer.getLayerIds();
      expect(layerIds).toEqual([]);
    });

    it('should remove layer by ID', () => {
      viewer.removeLayer('non-existent');
      const layerIds = viewer.getLayerIds();
      expect(layerIds).toEqual([]);
    });

    it('should clear all layers', () => {
      viewer.clearLayers();
      const layerIds = viewer.getLayerIds();
      expect(layerIds).toEqual([]);
    });
  });

  describe('fitBounds', () => {
    let viewer: SARdine;

    beforeEach(() => {
      viewer = new SARdine({
        container: container,
      });
    });

    afterEach(() => {
      viewer.destroy();
    });

    it('should fit bounds and update view state', () => {
      const bounds: [number, number, number, number] = [-123, 37, -122, 38];
      viewer.fitBounds(bounds);

      const viewState = viewer.getViewState();
      expect(viewState.longitude).toBeCloseTo(-122.5, 1);
      expect(viewState.latitude).toBeCloseTo(37.5, 1);
      expect(viewState.zoom).toBeGreaterThan(0);
    });
  });
});
