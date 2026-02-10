# SARdine Testing Strategy

## Overview

This document outlines the testing approach for the GPU acceleration optimization (Phase 1).

## Testing Levels

### 1. Unit Tests (Quick validation)
**Location**: `test/unit/`
**Run via**: `npm test`
**Purpose**: Test individual components in isolation

#### Test Files:
- `texture-formats.test.js` - R32F texture creation with various data patterns
- `shader-compilation.test.js` - Vertex/fragment shader compilation
- `colormap-functions.test.js` - GPU colormap outputs match CPU colormaps
- `data-validation.test.js` - Data range detection, NaN/zero handling

### 2. Integration Tests (Layer functionality)
**Location**: `test/integration/`
**Run via**: Browser (automated with Playwright)
**Purpose**: Test complete layer rendering pipeline

#### Test Scenarios:
- SARGPULayer instantiation with various coordinate systems
- deck.gl integration (CARTESIAN vs LNGLAT)
- Prop updates trigger correct re-renders
- Layer cleanup (no memory leaks)

### 3. Visual Regression Tests
**Location**: `test/visual/`
**Run via**: `npm run test:visual`
**Purpose**: Ensure GPU rendering matches CPU pixel-perfect

#### Approach:
1. Render same SAR data with CPU (SARBitmapLayer) and GPU (SARGPULayer)
2. Capture screenshots
3. Pixel-by-pixel comparison (tolerance: <1% difference)
4. Test all colormaps, stretch modes, parameter ranges

### 4. Performance Benchmarks
**Location**: `test/benchmarks/`
**Run via**: `npm run benchmark`
**Purpose**: Measure and track performance improvements

#### Metrics:
- **Contrast slider responsiveness**: Target <16ms per frame (60 FPS)
- **Colormap changes**: Target <1ms (uniform update only)
- **Initial tile load**: Target <100ms (256x256 tile)
- **Memory usage**: Track texture cache size

## Test Data

### Synthetic Data Generators
```javascript
// test/fixtures/data-generators.js

// Standard test tile - 256x256 with known patterns
export function generateStandardTile() {
  const data = new Float32Array(256 * 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const idx = y * 256 + x;
      // Gradient pattern: amplitude increases left-to-right
      data[idx] = (x / 255) * 100;
    }
  }
  return { data, width: 256, height: 256 };
}

// Edge cases
export function generateEdgeCases() {
  return {
    allZeros: new Float32Array(256 * 256),
    allOnes: new Float32Array(256 * 256).fill(1),
    withNaNs: (() => {
      const data = new Float32Array(256 * 256).fill(1);
      data[1000] = NaN;
      data[2000] = NaN;
      return data;
    })(),
    verySmall: new Float32Array(256 * 256).fill(1e-10),
    veryLarge: new Float32Array(256 * 256).fill(1e10)
  };
}
```

## Continuous Testing During Development

### Quick Validation Loop (< 5 seconds)
```bash
# Run after every code change
npm run test:quick

# Runs:
# 1. Shader compilation test
# 2. R32F texture creation test
# 3. Basic layer instantiation
```

### Full Test Suite (~ 30 seconds)
```bash
npm test

# Runs:
# 1. All unit tests
# 2. Integration tests
# 3. Visual regression (CPU vs GPU comparison)
# 4. Performance benchmarks (with threshold checks)
```

### Manual Test Checklist

When testing in the browser (`npm run dev`):

- [ ] Load NISAR file - single band mode displays
- [ ] Drag contrast slider - smooth 60 FPS
- [ ] Change colormap dropdown - instant update (<1ms)
- [ ] Adjust gamma slider - smooth rendering
- [ ] Change stretch mode - correct visual output
- [ ] Switch to RGB mode - works (falls back to CPU)
- [ ] Pan/zoom - tiles load without errors
- [ ] Check console - no WebGL errors
- [ ] Memory profiler - stable memory usage

## Regression Test Database

**File**: `test/regression-baseline/`

Store known-good outputs:
- `cpu-grayscale-25-0.png` - CPU rendered with contrast [-25, 0]
- `gpu-grayscale-25-0.png` - GPU rendered with same params
- `cpu-viridis-30-5.png` - CPU with viridis colormap
- etc.

Compare new GPU renders against these baselines.

## Performance Tracking

**File**: `test/benchmarks/results.json`

```json
{
  "2025-02-08": {
    "contrastSlider": {
      "avgFrameMs": 0.8,
      "fps": 1250,
      "maxFrameMs": 1.2
    },
    "colormapChange": {
      "avgMs": 0.3
    },
    "tileLoad": {
      "256x256": 45,
      "512x512": 120
    }
  }
}
```

Track over time to catch performance regressions.

## Known Issues / Expected Failures

### Browser Compatibility
- **Safari < 14**: No EXT_color_buffer_float → CPU fallback expected
- **Firefox < 51**: R32F textures may fail → CPU fallback expected

### Data Edge Cases
- **All zeros**: Will render as transparent (correct)
- **All NaN**: Will render as transparent (correct)
- **Negative amplitudes**: Invalid SAR data, but should not crash

## Test Automation Setup

### Install Dependencies
```bash
npm install --save-dev \
  vitest \
  @vitest/ui \
  playwright \
  pixelmatch \
  pngjs
```

### Configuration Files

**`vitest.config.js`**:
```javascript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.js'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.js']
    }
  }
});
```

**`test/setup.js`**:
```javascript
import { vi } from 'vitest';
import { JSDOM } from 'jsdom';

// Mock WebGL2 context for tests
global.document = new JSDOM('<!DOCTYPE html>').window.document;
global.HTMLCanvasElement.prototype.getContext = vi.fn((type) => {
  if (type === 'webgl2') {
    return {
      R32F: 0x822E,
      RED: 0x1903,
      FLOAT: 0x1406,
      // ... mock WebGL2 API
    };
  }
});
```

## Success Criteria

### Phase 1 Complete When:

1. ✅ All unit tests pass
2. ✅ Visual regression tests show <1% pixel difference
3. ✅ Performance benchmarks meet targets:
   - Contrast slider: 60 FPS (avg <16ms)
   - Colormap change: <1ms
4. ✅ Integration with NISAR loader works (single-band mode)
5. ✅ No console errors during typical usage
6. ✅ Memory usage stable (<500 MB for 100 tiles)
7. ✅ CPU fallback works on unsupported browsers

## Running Tests

```bash
# Quick validation
npm run test:quick

# Full test suite
npm test

# Visual tests only
npm run test:visual

# Performance benchmarks
npm run benchmark

# Watch mode (during development)
npm run test:watch

# Generate coverage report
npm run test:coverage
```

## Adding New Tests

1. Create test file in appropriate directory:
   - `test/unit/` for isolated component tests
   - `test/integration/` for full layer tests
   - `test/visual/` for rendering comparisons

2. Follow naming convention: `*.test.js`

3. Use descriptive test names:
   ```javascript
   describe('SARGPULayer', () => {
     it('should create R32F texture from Float32Array data', () => {
       // test
     });
   });
   ```

4. Update this document with new test coverage

## Debugging Failed Tests

### GPU Texture Creation Fails
- Check WebGL2 support: `chrome://gpu`
- Check extensions: `gl.getSupportedExtensions()`
- Try smaller texture size (128x128)

### Visual Regression Mismatch
- Check if CPU code changed recently
- Verify same input data used for both
- Check if shader precision differs
- Review shader code for floating-point issues

### Performance Regression
- Profile with Chrome DevTools
- Check if accidentally using CPU path
- Verify uniform updates (not texture recreation)
- Check for memory leaks (growing cache)

## Next Steps

After Phase 1 tests are solid:

1. **Phase 2**: Add RGB composite GPU tests
2. **Phase 3**: Add texture caching tests
3. **CI Integration**: Run tests on every commit
4. **Public Test Suite**: Share test results for transparency
