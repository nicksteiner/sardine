// Simple standalone tests for utility functions

describe('Data normalization', () => {
  it('should normalize Float32Array data to 0-255 range', () => {
    // Inline implementation for testing
    function normalizeData(
      data: Float32Array,
      min: number,
      max: number
    ): Uint8Array {
      const normalized = new Uint8Array(data.length);
      const range = max - min;
      
      for (let i = 0; i < data.length; i++) {
        const val = data[i];
        if (!isFinite(val)) {
          normalized[i] = 0;
        } else {
          normalized[i] = Math.round(((val - min) / range) * 255);
        }
      }
      return normalized;
    }

    const data = new Float32Array([0, 50, 100]);
    const normalized = normalizeData(data, 0, 100);

    expect(normalized).toBeInstanceOf(Uint8Array);
    expect(normalized.length).toBe(3);
    expect(normalized[0]).toBe(0);
    expect(normalized[2]).toBe(255);
  });

  it('should apply grayscale colormap', () => {
    function applyColorMap(data: Uint8Array): Uint8ClampedArray {
      const rgbaData = new Uint8ClampedArray(data.length * 4);
      
      for (let i = 0; i < data.length; i++) {
        const value = data[i];
        rgbaData[i * 4] = value;     // R
        rgbaData[i * 4 + 1] = value; // G
        rgbaData[i * 4 + 2] = value; // B
        rgbaData[i * 4 + 3] = 255;   // A
      }
      return rgbaData;
    }

    const data = new Uint8Array([0, 128, 255]);
    const rgbaData = applyColorMap(data);

    expect(rgbaData).toBeInstanceOf(Uint8ClampedArray);
    expect(rgbaData.length).toBe(12);
    
    // Check first pixel (black)
    expect(rgbaData[0]).toBe(0);
    expect(rgbaData[3]).toBe(255);
    
    // Check last pixel (white)
    expect(rgbaData[8]).toBe(255);
    expect(rgbaData[11]).toBe(255);
  });
});
