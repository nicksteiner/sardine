/**
 * WebGPU device manager — singleton adapter/device with graceful fallback.
 *
 * Usage:
 *   import { getDevice, hasWebGPU } from './webgpu-device.js';
 *   if (hasWebGPU()) {
 *     const device = await getDevice();
 *     // use device for compute pipelines
 *   }
 */

let _adapter = null;
let _device = null;
let _probed = false;
let _available = false;

/**
 * Probe whether WebGPU is available (synchronous after first call).
 * Does NOT request a device — just checks navigator.gpu existence.
 */
export function hasWebGPU() {
  if (_probed) return _available;
  _probed = true;
  _available = typeof navigator !== 'undefined' && !!navigator.gpu;
  return _available;
}

/**
 * Get (or create) the shared GPUDevice.
 * Reuses a single device for the lifetime of the page.
 * @returns {Promise<GPUDevice>}
 * @throws if WebGPU is not available
 */
export async function getDevice() {
  if (_device) return _device;

  if (!hasWebGPU()) {
    throw new Error('WebGPU is not supported in this browser');
  }

  _adapter = await navigator.gpu.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!_adapter) {
    _available = false;
    throw new Error('WebGPU adapter not available');
  }

  // Request device with defaults — no optional features needed for histogram
  _device = await _adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: _adapter.limits.maxStorageBufferBindingSize,
      maxComputeWorkgroupSizeX: 256,
      maxComputeWorkgroupSizeY: 1,
      maxComputeWorkgroupSizeZ: 1,
    },
  });

  // Handle device loss — clear cache so next getDevice() re-creates
  _device.lost.then((info) => {
    console.warn('[webgpu] Device lost:', info.message);
    _device = null;
    _adapter = null;
  });

  return _device;
}

/**
 * Return adapter limits (call after getDevice()).
 */
export function getDeviceLimits() {
  return _device ? _device.limits : null;
}

/**
 * Destroy the cached device (for cleanup / tests).
 */
export function destroyDevice() {
  if (_device) {
    _device.destroy();
    _device = null;
    _adapter = null;
  }
}
