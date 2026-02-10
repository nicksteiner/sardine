/**
 * MetadataCube — NISAR GCOV metadata cube reader and interpolator.
 *
 * Per JPL D-102274 Rev E §5.8 / §6, metadata cubes are coarse 3D grids
 * stored at /science/{band}/GCOV/metadata/radarGrid/ with axes:
 *   - height (Nz): heightAboveEllipsoid, ~1.5 km spacing
 *   - northing (Ny): yCoordinates, ~3 km spacing (decreasing, north-up)
 *   - easting (Nx): xCoordinates, ~1 km spacing (increasing)
 *
 * Shape in HDF5: (Nz, Ny, Nx)  — height-first for GIS compatibility.
 *
 * The cube is small (~few hundred KB per field) and loaded entirely into
 * memory. Interpolation follows the spec's recommended approach:
 *   1. 2D bilinear interpolation at each height layer
 *   2. 1D linear interpolation along the height axis
 *
 * For users without a DEM, a single-height fallback uses the lowest layer.
 */

/**
 * @typedef {Object} MetadataCubeData
 * @property {Float64Array} xCoordinates - Easting axis (Nx), meters, increasing
 * @property {Float64Array} yCoordinates - Northing axis (Ny), meters, decreasing
 * @property {Float64Array} heights      - Height axis (Nz), meters, increasing
 * @property {number} nx - Number of easting samples
 * @property {number} ny - Number of northing samples
 * @property {number} nz - Number of height layers
 * @property {Object<string, Float32Array>} fields - Named 3D fields flattened as [nz * ny * nx]
 */

export class MetadataCube {
  /**
   * @param {MetadataCubeData} data
   */
  constructor(data) {
    this.x = data.xCoordinates;   // Nx, increasing easting
    this.y = data.yCoordinates;   // Ny, decreasing northing
    this.z = data.heights;        // Nz, increasing height
    this.nx = data.nx;
    this.ny = data.ny;
    this.nz = data.nz;
    this.fields = data.fields;    // { incidenceAngle: Float32Array, ... }

    // Precompute axis spacings for fast index lookup
    this.dx = this.nx > 1 ? (this.x[this.nx - 1] - this.x[0]) / (this.nx - 1) : 1;
    this.dy = this.ny > 1 ? (this.y[this.ny - 1] - this.y[0]) / (this.ny - 1) : 1; // negative for north-up
    this.dz = this.nz > 1 ? (this.z[this.nz - 1] - this.z[0]) / (this.nz - 1) : 1;

    console.log(`[MetadataCube] Created: ${this.nx}×${this.ny}×${this.nz}, ` +
      `fields: [${Object.keys(this.fields).join(', ')}], ` +
      `easting: ${this.x[0].toFixed(0)}–${this.x[this.nx - 1].toFixed(0)}m, ` +
      `northing: ${this.y[0].toFixed(0)}–${this.y[this.ny - 1].toFixed(0)}m, ` +
      `height: ${this.z[0].toFixed(0)}–${this.z[this.nz - 1].toFixed(0)}m`);
  }

  /**
   * Interpolate a field at a given (easting, northing, height) point.
   *
   * Uses bilinear interpolation in XY per height layer, then linear
   * interpolation in Z. Falls back to nearest-layer 2D interpolation
   * if height is not provided.
   *
   * @param {string} fieldName - e.g. 'incidenceAngle', 'elevationAngle'
   * @param {number} easting   - UTM easting in meters
   * @param {number} northing  - UTM northing in meters
   * @param {number|null} height - Height above ellipsoid in meters (null = ground layer)
   * @returns {number|null} Interpolated value, or null if out of bounds
   */
  interpolate(fieldName, easting, northing, height = null) {
    const field = this.fields[fieldName];
    if (!field) return null;

    // Compute fractional indices along each axis
    const fi = (easting - this.x[0]) / this.dx;
    const fj = (northing - this.y[0]) / this.dy;

    // Bounds check (allow slight extrapolation for edge pixels)
    if (fi < -0.5 || fi > this.nx - 0.5 || fj < -0.5 || fj > this.ny - 0.5) {
      return null;
    }

    if (height === null || this.nz <= 1) {
      // No height or single layer: 2D bilinear at layer 0
      return this._bilinear(field, 0, fi, fj);
    }

    // 3D interpolation: bilinear per layer, then linear in height
    const fk = (height - this.z[0]) / this.dz;
    const fkClamped = Math.max(0, Math.min(this.nz - 1, fk));

    const k0 = Math.floor(fkClamped);
    const k1 = Math.min(k0 + 1, this.nz - 1);
    const wz = fkClamped - k0;

    const v0 = this._bilinear(field, k0, fi, fj);
    if (k0 === k1 || wz === 0) return v0;

    const v1 = this._bilinear(field, k1, fi, fj);
    if (v0 === null || v1 === null) return v0 ?? v1;

    return v0 * (1 - wz) + v1 * wz;
  }

  /**
   * Bilinear interpolation within a single height layer.
   *
   * @param {Float32Array} field - Flattened 3D array [nz * ny * nx]
   * @param {number} k          - Height layer index
   * @param {number} fi         - Fractional easting index
   * @param {number} fj         - Fractional northing index
   * @returns {number|null}
   */
  _bilinear(field, k, fi, fj) {
    const i0 = Math.max(0, Math.min(this.nx - 1, Math.floor(fi)));
    const j0 = Math.max(0, Math.min(this.ny - 1, Math.floor(fj)));
    const i1 = Math.min(i0 + 1, this.nx - 1);
    const j1 = Math.min(j0 + 1, this.ny - 1);

    const wx = Math.max(0, Math.min(1, fi - i0));
    const wy = Math.max(0, Math.min(1, fj - j0));

    const layerOffset = k * this.ny * this.nx;

    const v00 = field[layerOffset + j0 * this.nx + i0];
    const v10 = field[layerOffset + j0 * this.nx + i1];
    const v01 = field[layerOffset + j1 * this.nx + i0];
    const v11 = field[layerOffset + j1 * this.nx + i1];

    // Skip NaN fill values
    if (isNaN(v00) && isNaN(v10) && isNaN(v01) && isNaN(v11)) return null;

    // Simple bilinear (NaN-aware: treat NaN as 0 weight)
    let sum = 0, wsum = 0;
    const weights = [
      [(1 - wx) * (1 - wy), v00],
      [wx * (1 - wy), v10],
      [(1 - wx) * wy, v01],
      [wx * wy, v11],
    ];
    for (const [w, v] of weights) {
      if (!isNaN(v)) { sum += w * v; wsum += w; }
    }

    return wsum > 0 ? sum / wsum : null;
  }

  /**
   * Evaluate a field on the full-resolution pixel grid.
   *
   * Converts pixel coordinates to UTM using the product's coordinate
   * arrays, then interpolates the metadata cube at each pixel.
   *
   * @param {string} fieldName
   * @param {Float64Array} pixelXCoords - Full-res easting per column (width)
   * @param {Float64Array} pixelYCoords - Full-res northing per row (height)
   * @param {number} width
   * @param {number} height
   * @param {number|null} elevationM - Fixed height for all pixels (null = layer 0)
   * @param {number} subsample - Subsample factor (e.g. 4 = every 4th pixel, then fill)
   * @returns {Float32Array} Interpolated field, shape [height × width]
   */
  evaluateOnGrid(fieldName, pixelXCoords, pixelYCoords, width, height, elevationM = null, subsample = 1) {
    const out = new Float32Array(width * height);

    if (subsample <= 1) {
      // Full resolution evaluation
      for (let row = 0; row < height; row++) {
        const northing = pixelYCoords[row];
        for (let col = 0; col < width; col++) {
          const easting = pixelXCoords[col];
          const val = this.interpolate(fieldName, easting, northing, elevationM);
          out[row * width + col] = val ?? NaN;
        }
      }
    } else {
      // Subsampled evaluation + bilinear fill
      // Evaluate on coarse grid, then interpolate to full res
      const cw = Math.ceil(width / subsample) + 1;
      const ch = Math.ceil(height / subsample) + 1;
      const coarse = new Float32Array(cw * ch);

      for (let cj = 0; cj < ch; cj++) {
        const row = Math.min(cj * subsample, height - 1);
        const northing = pixelYCoords[row];
        for (let ci = 0; ci < cw; ci++) {
          const col = Math.min(ci * subsample, width - 1);
          const easting = pixelXCoords[col];
          const val = this.interpolate(fieldName, easting, northing, elevationM);
          coarse[cj * cw + ci] = val ?? NaN;
        }
      }

      // Bilinear upscale from coarse to full
      for (let row = 0; row < height; row++) {
        const cfj = row / subsample;
        const cj0 = Math.floor(cfj);
        const cj1 = Math.min(cj0 + 1, ch - 1);
        const wy = cfj - cj0;

        for (let col = 0; col < width; col++) {
          const cfi = col / subsample;
          const ci0 = Math.floor(cfi);
          const ci1 = Math.min(ci0 + 1, cw - 1);
          const wx = cfi - ci0;

          const v00 = coarse[cj0 * cw + ci0];
          const v10 = coarse[cj0 * cw + ci1];
          const v01 = coarse[cj1 * cw + ci0];
          const v11 = coarse[cj1 * cw + ci1];

          out[row * width + col] =
            v00 * (1 - wx) * (1 - wy) +
            v10 * wx * (1 - wy) +
            v01 * (1 - wx) * wy +
            v11 * wx * wy;
        }
      }
    }

    return out;
  }

  /**
   * Evaluate ALL loaded fields on a (possibly multilooked) export grid.
   *
   * Returns a dict of {fieldName: Float32Array} suitable for appending
   * as extra bands in a multi-band GeoTIFF export.
   *
   * @param {Float64Array} pixelXCoords - Full-res easting per column
   * @param {Float64Array} pixelYCoords - Full-res northing per row
   * @param {number} width  - Export width (after multilook)
   * @param {number} height - Export height (after multilook)
   * @param {number} ml     - Multilook factor (subsample source coords)
   * @param {number|null} elevationM - Fixed height (null = ground layer)
   * @returns {Object} { fieldName: Float32Array, ... }
   */
  evaluateAllFields(pixelXCoords, pixelYCoords, width, height, ml = 1, elevationM = null) {
    const result = {};

    // Build subsampled coordinate arrays matching the export grid.
    // Multilook pixel (i,j) maps to source pixel center (i*ml + ml/2 - 0.5).
    const exportX = new Float64Array(width);
    const exportY = new Float64Array(height);
    for (let c = 0; c < width; c++) {
      const srcCol = Math.min(Math.round(c * ml + (ml - 1) / 2), pixelXCoords.length - 1);
      exportX[c] = pixelXCoords[srcCol];
    }
    for (let r = 0; r < height; r++) {
      const srcRow = Math.min(Math.round(r * ml + (ml - 1) / 2), pixelYCoords.length - 1);
      exportY[r] = pixelYCoords[srcRow];
    }

    // The cube is coarse (~1 km), so subsample the full-res evaluation.
    // A factor of 8–16 pixels between exact evaluations is fine given
    // the cube's native ~1 km spacing vs the product's ~30 m posting.
    const subsample = Math.max(1, Math.floor(1000 / (Math.abs(this.dx) || 30)));

    for (const fieldName of Object.keys(this.fields)) {
      result[fieldName] = this.evaluateOnGrid(
        fieldName, exportX, exportY, width, height, elevationM, subsample
      );
    }

    return result;
  }

  /**
   * Get incidence angle at a pixel location (convenience method).
   *
   * @param {number} easting  - UTM easting in meters
   * @param {number} northing - UTM northing in meters
   * @param {number|null} height - Height above ellipsoid (null = ground)
   * @returns {number|null} Incidence angle in degrees
   */
  getIncidenceAngle(easting, northing, height = null) {
    return this.interpolate('incidenceAngle', easting, northing, height);
  }

  /**
   * Get elevation angle at a pixel location (convenience method).
   *
   * @param {number} easting
   * @param {number} northing
   * @param {number|null} height
   * @returns {number|null} Elevation angle in degrees
   */
  getElevationAngle(easting, northing, height = null) {
    return this.interpolate('elevationAngle', easting, northing, height);
  }

  /**
   * List available fields in this cube.
   * @returns {string[]}
   */
  getFieldNames() {
    return Object.keys(this.fields);
  }

  /**
   * Get axis bounds for display/debug.
   * @returns {Object}
   */
  getBounds() {
    return {
      easting: [this.x[0], this.x[this.nx - 1]],
      northing: [this.y[0], this.y[this.ny - 1]],
      height: [this.z[0], this.z[this.nz - 1]],
      shape: [this.nx, this.ny, this.nz],
    };
  }
}

/**
 * Load metadata cube datasets from an HDF5 file reader.
 *
 * Reads the axis arrays and all available scalar fields from
 * /science/{band}/GCOV/metadata/radarGrid/
 *
 * @param {Object} reader - h5chunk StreamingHDF5Reader or h5wasm File
 * @param {string} band   - 'LSAR' or 'SSAR'
 * @param {Object} options
 * @param {string[]} options.fields - Fields to load (default: all available)
 * @returns {Promise<MetadataCube|null>} MetadataCube instance, or null if not found
 */
export async function loadMetadataCube(reader, band, options = {}) {
  const basePath = `/science/${band}/GCOV/metadata/radarGrid`;

  const defaultFields = [
    'incidenceAngle',
    'elevationAngle',
    'slantRange',
    'losUnitVectorX',
    'losUnitVectorY',
    'alongTrackUnitVectorX',
    'alongTrackUnitVectorY',
  ];

  const requestedFields = options.fields || defaultFields;

  try {
    // Read axis arrays
    const xCoordinates = await readDataset(reader, `${basePath}/xCoordinates`);
    const yCoordinates = await readDataset(reader, `${basePath}/yCoordinates`);
    const heights = await readDataset(reader, `${basePath}/heightAboveEllipsoid`);

    if (!xCoordinates || !yCoordinates || !heights) {
      console.warn('[MetadataCube] Missing axis datasets, skipping cube load');
      return null;
    }

    const nx = xCoordinates.length;
    const ny = yCoordinates.length;
    const nz = heights.length;

    console.log(`[MetadataCube] Axes: nx=${nx}, ny=${ny}, nz=${nz}`);

    // Read fields
    const fields = {};
    for (const fieldName of requestedFields) {
      const data = await readDataset(reader, `${basePath}/${fieldName}`);
      if (data) {
        // Verify expected size
        const expected = nz * ny * nx;
        if (data.length === expected) {
          fields[fieldName] = data instanceof Float32Array ? data : new Float32Array(data);
          console.log(`[MetadataCube] Loaded ${fieldName}: ${data.length} values`);
        } else {
          // Some fields are 2D (e.g. groundTrackVelocity: ny × nx)
          console.log(`[MetadataCube] ${fieldName}: ${data.length} values (expected ${expected}), skipping 3D interp`);
        }
      }
    }

    if (Object.keys(fields).length === 0) {
      console.warn('[MetadataCube] No fields loaded');
      return null;
    }

    return new MetadataCube({
      xCoordinates: xCoordinates instanceof Float64Array ? xCoordinates : new Float64Array(xCoordinates),
      yCoordinates: yCoordinates instanceof Float64Array ? yCoordinates : new Float64Array(yCoordinates),
      heights: heights instanceof Float64Array ? heights : new Float64Array(heights),
      nx, ny, nz,
      fields,
    });
  } catch (e) {
    console.warn('[MetadataCube] Failed to load:', e.message);
    return null;
  }
}

/**
 * Read a dataset from h5wasm File or h5chunk reader.
 * Handles both APIs transparently.
 *
 * @param {Object} reader
 * @param {string} path
 * @returns {Promise<TypedArray|null>}
 */
async function readDataset(reader, path) {
  try {
    // h5wasm API
    if (reader.get) {
      const ds = reader.get(path);
      if (!ds || !ds.value) return null;
      return ds.value;
    }

    // h5chunk StreamingHDF5Reader API
    if (reader.getDataset) {
      const ds = await reader.getDataset(path);
      if (!ds) return null;
      return ds.data || ds;
    }

    // Direct read method
    if (reader.read) {
      return await reader.read(path);
    }

    return null;
  } catch {
    return null;
  }
}
