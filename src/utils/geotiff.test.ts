import { normalizeData, applyColorMap } from './geotiff';

describe('geotiff utilities', () => {
  describe('normalizeData', () => {
    it('should normalize Float32Array data to 0-255 range', () => {
      const data = new Float32Array([0, 50, 100]);
      const normalized = normalizeData(data, 0, 100);

      expect(normalized).toBeInstanceOf(Uint8Array);
      expect(normalized.length).toBe(3);
      expect(normalized[0]).toBe(0);
      expect(normalized[1]).toBeGreaterThanOrEqual(127);
      expect(normalized[1]).toBeLessThanOrEqual(128);
      expect(normalized[2]).toBe(255);
    });

    it('should handle automatic min/max calculation', () => {
      const data = new Float32Array([10, 20, 30]);
      const normalized = normalizeData(data);

      expect(normalized).toBeInstanceOf(Uint8Array);
      expect(normalized[0]).toBe(0);
      expect(normalized[2]).toBe(255);
    });

    it('should handle infinite values', () => {
      const data = new Float32Array([0, Infinity, -Infinity, 100]);
      const normalized = normalizeData(data, 0, 100);

      expect(normalized[1]).toBe(0); // Infinity mapped to 0
      expect(normalized[2]).toBe(0); // -Infinity mapped to 0
    });

    it('should work with Uint16Array', () => {
      const data = new Uint16Array([0, 32768, 65535]);
      const normalized = normalizeData(data, 0, 65535);

      expect(normalized).toBeInstanceOf(Uint8Array);
      expect(normalized[0]).toBe(0);
      expect(normalized[2]).toBe(255);
    });
  });

  describe('applyColorMap', () => {
    it('should apply grayscale colormap by default', () => {
      const data = new Uint8Array([0, 128, 255]);
      const rgbaData = applyColorMap(data);

      expect(rgbaData).toBeInstanceOf(Uint8ClampedArray);
      expect(rgbaData.length).toBe(data.length * 4);

      // Check first pixel (black)
      expect(rgbaData[0]).toBe(0);   // R
      expect(rgbaData[1]).toBe(0);   // G
      expect(rgbaData[2]).toBe(0);   // B
      expect(rgbaData[3]).toBe(255); // A

      // Check middle pixel (gray)
      expect(rgbaData[4]).toBe(128);  // R
      expect(rgbaData[5]).toBe(128);  // G
      expect(rgbaData[6]).toBe(128);  // B
      expect(rgbaData[7]).toBe(255);  // A

      // Check last pixel (white)
      expect(rgbaData[8]).toBe(255);   // R
      expect(rgbaData[9]).toBe(255);   // G
      expect(rgbaData[10]).toBe(255);  // B
      expect(rgbaData[11]).toBe(255);  // A
    });

    it('should handle empty data', () => {
      const data = new Uint8Array([]);
      const rgbaData = applyColorMap(data);

      expect(rgbaData.length).toBe(0);
    });

    it('should handle single value', () => {
      const data = new Uint8Array([100]);
      const rgbaData = applyColorMap(data);

      expect(rgbaData.length).toBe(4);
      expect(rgbaData[0]).toBe(100);
      expect(rgbaData[1]).toBe(100);
      expect(rgbaData[2]).toBe(100);
      expect(rgbaData[3]).toBe(255);
    });
  });
});
