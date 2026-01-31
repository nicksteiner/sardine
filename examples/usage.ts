/**
 * Example: Basic SARdine Usage
 * 
 * This example demonstrates how to use SARdine to visualize SAR imagery
 */

import { SARdine } from '../src';
import type { SARdineOptions, SARImageLayerOptions } from '../src';

// Create a viewer instance
const viewerOptions: SARdineOptions = {
  container: 'map-container',
  initialViewState: {
    longitude: -122.4,
    latitude: 37.8,
    zoom: 10,
  },
  controller: true,
  style: {
    width: '100%',
    height: '600px',
  },
};

const viewer = new SARdine(viewerOptions);

// Load a SAR image from a URL
async function loadSARImage() {
  const layerOptions: SARImageLayerOptions = {
    id: 'sar-layer-1',
    data: 'https://example.com/sar-image.tif',
    opacity: 0.8,
    colormap: {
      type: 'linear',
      min: 0,
      max: 255,
    },
  };

  await viewer.addLayer(layerOptions);
  console.log('SAR image loaded successfully');
}

// Load a SAR image from ArrayBuffer
async function loadSARImageFromBuffer() {
  const response = await fetch('https://example.com/sar-image.tif');
  const arrayBuffer = await response.arrayBuffer();

  await viewer.addLayer({
    id: 'sar-layer-2',
    data: arrayBuffer,
    opacity: 1.0,
  });
}

// Update layer properties
function updateLayerOpacity(layerId: string, opacity: number) {
  viewer.updateLayer(layerId, { opacity });
}

// Fit view to image bounds
function fitToImageBounds() {
  // Example bounds: [minLon, minLat, maxLon, maxLat]
  const bounds: [number, number, number, number] = [-123, 37, -122, 38];
  viewer.fitBounds(bounds);
}

// Get current viewport information
function getViewportInfo() {
  const viewState = viewer.getViewState();
  console.log('Current viewport:', viewState);
  return viewState;
}

// List all layers
function listLayers() {
  const layerIds = viewer.getLayerIds();
  console.log('Active layers:', layerIds);
  return layerIds;
}

// Remove a layer
function removeLayer(layerId: string) {
  viewer.removeLayer(layerId);
  console.log(`Layer ${layerId} removed`);
}

// Clear all layers
function clearAllLayers() {
  viewer.clearLayers();
  console.log('All layers cleared');
}

// Clean up when done
function cleanup() {
  viewer.destroy();
  console.log('Viewer destroyed');
}

// Export functions for use
export {
  viewer,
  loadSARImage,
  loadSARImageFromBuffer,
  updateLayerOpacity,
  fitToImageBounds,
  getViewportInfo,
  listLayers,
  removeLayer,
  clearAllLayers,
  cleanup,
};
