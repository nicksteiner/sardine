# H-Alpha (Cloude-Pottier) Decomposition Implementation Plan

## Overview

H-Alpha decomposition is a model-free polarimetric decomposition that characterizes scattering through eigenanalysis of the coherency matrix. It provides three parameters:

- **H (Entropy)**: Randomness of scattering [0-1]
- **α (Alpha angle)**: Dominant scattering mechanism [0°-90°]
- **A (Anisotropy)**: Relative importance of secondary mechanisms [0-1]

## Current Status

✅ Stub functions created in `src/utils/matrix.js`
✅ Plan documented
⏳ Eigenvalue decomposition (TODO)
⏳ Coherency matrix transformation (TODO)
⏳ Integration with SAR composites (TODO)

## Implementation Steps

### 1. Matrix Utilities (`src/utils/matrix.js`)

#### 1.1 Eigenvalue Decomposition (Jacobi Algorithm)

**Function**: `eigenDecomposition3x3(H)`

**Algorithm**: Jacobi rotation method for 3×3 Hermitian matrices

```javascript
function eigenDecomposition3x3(H) {
  // 1. Initialize V = I (identity)
  // 2. While max off-diagonal |H_ij| > tolerance:
  //    a. Find largest off-diagonal element (i,j)
  //    b. Compute Givens rotation angle θ to zero H_ij
  //    c. Apply rotation: H ← G^T H G
  //    d. Accumulate eigenvectors: V ← V G
  // 3. Extract eigenvalues from diagonal of H
  // 4. Sort eigenvalues descending, reorder eigenvectors
  // 5. Return {values: [λ1, λ2, λ3], vectors: V}
}
```

**Complexity**: O(n³) with n=3, ~50-100 iterations
**Tolerance**: 1e-10 for convergence
**Reference**: Golub & Van Loan, "Matrix Computations", Algorithm 8.4.3

#### 1.2 Coherency Matrix Transformation

**Function**: `covarianceToCoherency(C3)`

**Transformation**: T3 = A · C3 · A†

Where A is the unitary basis change matrix (lexicographic → Pauli):

```
       [1   0   1]
A = 1/√2 [√2  0  -√2]
       [0   2   0]
```

**Input**: Covariance matrix C3 elements:
- Diagonal: c11 (HH), c22 (HV), c33 (VV)
- Off-diagonal complex: c12, c13, c23 (real + imaginary parts)

**Output**: 3×3 coherency matrix T3 (Hermitian, complex)

#### 1.3 Alpha Angle Calculation

**Function**: `computeAlphaAngle(eigenvector)`

```javascript
function computeAlphaAngle(eigenvector) {
  // Extract first component of eigenvector in Pauli basis
  const v1 = eigenvector[0];
  const magnitude = Math.sqrt(v1.re * v1.re + v1.im * v1.im);

  // α = arccos(|v1|)
  const alpha_rad = Math.acos(Math.max(0, Math.min(1, magnitude)));
  return alpha_rad * 180 / Math.PI;  // Convert to degrees
}
```

**Range**: [0°, 90°]
- 0° → surface scattering
- 45° → volume scattering
- 90° → double-bounce scattering

### 2. H-Alpha Decomposition (`src/utils/sar-composites.js`)

#### 2.1 Per-Pixel Decomposition Function

```javascript
function computeHAlpha(c11, c22, c33, c13re, c13im) {
  // Build coherency matrix T3 from covariance C3
  // Note: Need all 6 covariance terms for full decomposition
  // For NISAR GCOV, we have: HHHH, HVHV, VVVV, HHVV (complex)
  // Missing: HHVH, VVVH — approximate or set to 0 (monostatic assumption)

  const C3 = {
    c11, c22, c33,
    c12re: 0, c12im: 0,  // HH-HV correlation (not in GCOV)
    c13re, c13im,        // HH-VV correlation (HHVV in GCOV)
    c23re: 0, c23im: 0   // HV-VV correlation (not in GCOV)
  };

  const T3 = covarianceToCoherency(C3);
  const { values, vectors } = eigenDecomposition3x3(T3);

  // Entropy
  const H = computeEntropy(values);

  // Alpha angle (weighted average from all eigenvectors)
  const [lambda1, lambda2, lambda3] = values;
  const total = lambda1 + lambda2 + lambda3;
  const alpha1 = computeAlphaAngle(vectors[0]);
  const alpha2 = computeAlphaAngle(vectors[1]);
  const alpha3 = computeAlphaAngle(vectors[2]);
  const alpha = (lambda1*alpha1 + lambda2*alpha2 + lambda3*alpha3) / total;

  // Anisotropy
  const A = computeAnisotropy(values);

  return { H, alpha, A };
}
```

#### 2.2 Tile-Level RGB Function

```javascript
function computeHAlphaRGB(bands) {
  const hh = bands['HHHH'];
  const hv = bands['HVHV'];
  const vv = bands['VVVV'];
  const re = bands['HHVV_re'];
  const im = bands['HHVV_im'];
  const n = hh.length;

  const R = new Float32Array(n);  // Entropy
  const G = new Float32Array(n);  // Alpha
  const B = new Float32Array(n);  // Anisotropy

  for (let i = 0; i < n; i++) {
    const c11 = hh[i];
    const c22 = hv[i];
    const c33 = vv[i];
    const c13re = re ? re[i] : 0;
    const c13im = im ? im[i] : 0;

    if (c11 <= 0 && c22 <= 0 && c33 <= 0) continue;

    const { H, alpha, A } = computeHAlpha(c11, c22, c33, c13re, c13im);

    R[i] = H;         // Entropy [0, 1] → no scaling needed
    G[i] = alpha / 90;  // Alpha [0°, 90°] → normalize to [0, 1]
    B[i] = A;         // Anisotropy [0, 1] → no scaling needed
  }

  return { R, G, B };
}
```

#### 2.3 Add Preset to SAR_COMPOSITES

```javascript
'h-alpha': {
  name: 'H-α-A (Cloude-Pottier)',
  description: 'Entropy / Alpha angle / Anisotropy decomposition',
  required: ['HHHH', 'HVHV', 'VVVV'],
  requiredComplex: ['HHVV'],
  computeAll: true,
  formula: computeHAlphaRGB,
  channelLabels: {
    R: 'H (entropy)',
    G: 'α (alpha)',
    B: 'A (anisotropy)'
  },
}
```

### 3. Testing & Validation

#### 3.1 Unit Tests for Matrix Functions

```javascript
// Test eigenvalue decomposition with known matrix
const H_test = [
  [{re: 5, im: 0}, {re: 1, im: 1}, {re: 0, im: 0}],
  [{re: 1, im: -1}, {re: 3, im: 0}, {re: 1, im: 0}],
  [{re: 0, im: 0}, {re: 1, im: 0}, {re: 2, im: 0}]
];

const { values } = eigenDecomposition3x3(H_test);
// Expected: [6.0, 3.0, 1.0] (approximate)
```

#### 3.2 Validation with Reference Data

- Compare against PolSARPro or ESA SNAP implementation
- Test with NISAR GCOV quad-pol data
- Verify output ranges:
  - H ∈ [0, 1]
  - α ∈ [0°, 90°]
  - A ∈ [0, 1]

#### 3.3 Visual Checks

- Load NISAR quad-pol GCOV product
- Select "H-α-A (Cloude-Pottier)" composite
- Expected visualization:
  - **High entropy (red)**: Heterogeneous areas (urban, forest)
  - **High alpha (green)**: Volume scattering (vegetation)
  - **High anisotropy (blue)**: Oriented targets (buildings, rows)

## Challenges & Considerations

### Missing Covariance Terms

NISAR GCOV provides only diagonal terms (HHHH, HVHV, VVVV) and HHVV (complex).

**Missing**:
- HHVH (HH-HV correlation)
- VVVH (VV-HV correlation)

**Impact**:
- Full coherency matrix cannot be built exactly
- **Solution**: Monostatic radar assumption → VH ≈ HV, so HHVH ≈ HHVV*, VVVH ≈ 0
- Or: Set missing terms to 0 (approximation for distributed targets)

### Numerical Stability

- Eigenvalue decomposition can be unstable for ill-conditioned matrices
- Use tolerance checks: `if (lambda < 1e-10) lambda = 0`
- Normalize eigenvectors after each rotation
- Clamp output values to valid ranges

### Performance

- Eigenvalue decomposition is ~50-100 iterations per pixel
- For 256×256 tile = 65,536 pixels → ~3-6 million operations
- Expected: 10-20ms per tile (comparable to Freeman-Durden)
- Consider caching if used for large exports

## File Structure

```
src/
├── utils/
│   ├── matrix.js              ← NEW: Eigenvalue decomposition
│   └── sar-composites.js      ← MODIFY: Add H-Alpha functions
└── loaders/
    └── nisar-loader.js        ← No changes needed

docs/
└── H_ALPHA_IMPLEMENTATION.md  ← This file
```

## References

1. Cloude, S. R., & Pottier, E. (1996). "A review of target decomposition theorems in radar polarimetry." *IEEE TGRS*, 34(2), 498-518.

2. Lee, J. S., & Pottier, E. (2009). *Polarimetric Radar Imaging: From Basics to Applications*. CRC Press. (Chapter 5)

3. Golub, G. H., & Van Loan, C. F. (2013). *Matrix Computations* (4th ed.). Johns Hopkins University Press. (Algorithm 8.4.3: Jacobi eigenvalue algorithm)

4. ESA SNAP Toolbox: [S1TBX Polarimetry Tutorial](https://step.esa.int/docs/tutorials/S1TBX%20Polarimetry%20Tutorial.pdf)

## Estimated Effort

- **Matrix utilities**: 2-3 hours
- **H-Alpha integration**: 1 hour
- **Testing & validation**: 1-2 hours
- **Total**: 4-6 hours for complete implementation

---

**Status**: Ready to implement — stub functions in place, build-safe
**Next step**: Implement `eigenDecomposition3x3()` in `src/utils/matrix.js`
