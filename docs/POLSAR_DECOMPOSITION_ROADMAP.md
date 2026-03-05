# Polarimetric Decomposition Roadmap — Quad-Pol Focus

Roadmap for full-covariance polarimetric decompositions in SARdine, targeting
NISAR GCOV quad-pol products with `isFullCovariance = true`.

## Current State

**Implemented:**
- Freeman-Durden 3-component (`sar-composites.js`) — fully working, degrades when HHVV absent
- Pauli power approximation — uses |HH−VV|, HV, HH+VV (no phase)
- Dual-pol composites — HH/HV and VV/VH ratio-based RGB
- HH/HV/VV direct mapping

**Stubbed (not yet functional):**
- `matrix.js` — eigenDecomposition3x3, covarianceToCoherency, computeAlphaAngle (all throw)
- computeEntropy, computeAnisotropy — implemented and ready

**Key data fact:** NISAR GCOV quad-pol provides HHHH, HVHV, VVVV (diagonal, real)
plus HHVV, HHHV, HHVH, HVVH, HVVV, VHVV (off-diagonal, complex). The loader
de-interleaves complex terms into `_re`/`_im` pairs. Missing terms (HHHV, VHVV)
can be approximated via the monostatic reciprocity assumption (VH ≈ HV).

---

## Phase 1 — H/A/α (Cloude-Pottier) Decomposition

**Priority: HIGH — foundation for all eigenvalue-based methods**

The core building block. Once the 3×3 Hermitian eigendecomposition works,
every other coherency-matrix method falls out naturally.

### 1.1 Implement eigenDecomposition3x3 in matrix.js

Jacobi rotation method for 3×3 Hermitian matrices:
- Iterative Givens rotations to diagonalize
- ~50–100 iterations, O(n³) with n=3
- Sort eigenvalues descending, reorder eigenvectors
- Tolerance: 1e-10
- Reference: Golub & Van Loan Algorithm 8.4.3

### 1.2 Implement covarianceToCoherency

Build T3 = A · C3 · A† where A is the Pauli basis change matrix.
Input: 6 unique covariance terms (3 real diagonal + 3 complex off-diagonal).
For missing terms (HHHV, VHVV): default to 0 or use reciprocity approximation.

### 1.3 Implement computeAlphaAngle

α = arccos(|v₁|) where v₁ is first component of eigenvector in Pauli basis.
Range: 0° (surface) → 45° (volume) → 90° (double-bounce).

### 1.4 Wire up H-Alpha composite preset

Add `'h-alpha'` to SAR_COMPOSITES in sar-composites.js:
- R = H (entropy, [0, 1])
- G = α (alpha angle, normalized [0°, 90°] → [0, 1])
- B = A (anisotropy, [0, 1])
- Required: HHHH, HVHV, VVVV + HHVV complex
- `computeAll: true` with per-pixel decomposition loop

### 1.5 H-Alpha classification plane

Add the Cloude-Pottier H/α classification zones (9-zone partition):
- Z1–Z9 mapping scattering mechanisms in H vs α space
- Output as categorical index per pixel (colormap for zones)
- Useful for land cover / scattering type classification

### Validation
- Compare output against PolSARPro / ESA SNAP on same quad-pol scene
- Verify H ∈ [0,1], α ∈ [0°,90°], A ∈ [0,1]
- Check numerical stability on noisy pixels (near-zero power)

---

## Phase 2 — Yamaguchi 4-Component Decomposition

**Priority: HIGH — extends Freeman-Durden with helix scattering**

### 2.1 Helix scattering model

Fourth component for oriented urban structures (tilted dihedrals):
- Ph = 2 * |Im(C13)| (simplified) or full T33 residual analysis
- Subtract helix contribution before Freeman-Durden surface/double-bounce split

### 2.2 Implementation

```
Input: full covariance (C11, C22, C33, C12, C13, C23 complex)
1. Compute helix power: Ph from Im(C23) [original Yamaguchi]
   or from Im(HVVV) for the NISAR covariance layout
2. Remove helix: adjust C3 matrix
3. Apply Freeman-Durden on residual → Ps, Pd, Pv
4. Output: R=Pd, G=Pv, B=Ps, with Ph as optional 4th channel
```

### 2.3 Extended Yamaguchi (rotation)

Apply HH-VV phase rotation (orientation angle compensation) before decomposition.
Reduces cross-pol overestimation in oriented urban areas.

### Preset
```
'yamaguchi': {
  name: 'Yamaguchi 4-component',
  required: ['HHHH', 'HVHV', 'VVVV'],
  requiredComplex: ['HHVV', 'HHHV', 'VHVV'],
  channels: R=Pd, G=Pv, B=Ps (Ph encoded in brightness or separate layer)
}
```

---

## Phase 3 — Van Zyl Decomposition

**Priority: MEDIUM — non-negative power constraint**

### 3.1 Core algorithm

Similar structure to Freeman-Durden but enforces Ps ≥ 0, Pd ≥ 0, Pv ≥ 0
via constrained optimization rather than the sign-of-Re(HHVV) heuristic.

### 3.2 Implementation
- Start from covariance matrix C3
- Iterative fitting: minimize ||C3 - Cs - Cd - Cv|| subject to non-negative powers
- Falls back gracefully when solution is degenerate
- Uses HHVV complex term (same data requirements as Freeman-Durden)

### Preset
```
'van-zyl': {
  name: 'Van Zyl (non-negative)',
  required: ['HHHH', 'HVHV', 'VVVV'],
  requiredComplex: ['HHVV'],
  channels: R=Pd, G=Pv, B=Ps
}
```

---

## Phase 4 — True Pauli Decomposition (Complex)

**Priority: MEDIUM — proper phase-aware Pauli**

### 4.1 Complex Pauli basis

Replace the existing power-only approximation with true complex Pauli:
- k₁ = (SHH + SVV) / √2  → surface
- k₂ = (SHH − SVV) / √2  → double-bounce
- k₃ = √2 · SHV           → volume

For GCOV covariance data (not SLC), the Pauli powers are:
- |k₁|² = (HHHH + VVVV + 2·Re(HHVV)) / 2
- |k₂|² = (HHHH + VVVV − 2·Re(HHVV)) / 2
- |k₃|² = 2 · HVHV

The sign of Re(HHVV) now correctly separates surface from double-bounce,
which the power-only approximation cannot do.

### 4.2 Replace pauli-power preset

Update or add alongside existing `pauli-power`:
```
'pauli': {
  name: 'Pauli (coherent)',
  required: ['HHHH', 'HVHV', 'VVVV'],
  requiredComplex: ['HHVV'],
  channels:
    R = (HHHH + VVVV - 2*Re(HHVV)) / 2   (double-bounce)
    G = 2 * HVHV                            (volume)
    B = (HHHH + VVVV + 2*Re(HHVV)) / 2    (surface)
}
```

Keep `pauli-power` as fallback when HHVV is absent.

---

## Phase 5 — GPU Compute for Decompositions

**Priority: MEDIUM — performance for large scenes**

### 5.1 Port Freeman-Durden to WGSL compute shader

- 6 input textures (C11, C22, C33, C13_re, C13_im) → 3 output textures (Ps, Pd, Pv)
- Per-pixel, embarrassingly parallel
- Expected: 256×256 tile in <1ms on discrete GPU

### 5.2 Port H/A/α to WGSL

- Jacobi eigendecomposition per pixel in compute shader
- 3×3 matrix → small enough for register-only computation
- Main challenge: loop convergence control in WGSL (no dynamic break in all impls)
- Alternative: closed-form eigenvalues for 3×3 via Cardano's formula (no iteration)

### 5.3 Port Yamaguchi to WGSL

- Sequential: helix removal → Freeman-Durden residual
- Two-pass or single-pass with branching

### 5.4 Shared infrastructure

- Multi-texture input binding (up to 6 R32F textures for full C3)
- Multi-output storage textures (3–4 bands)
- Reuse WebGPU device from existing histogram compute path

---

## Phase 6 — Dual-Pol Vegetation Indices

**Priority: LOW (deferred) — simple band math, implement when needed**

These work with all NISAR data (dual-pol HH/HV), not just quad-pol:

| Index | Formula | Notes |
|-------|---------|-------|
| RVI4S1 | `4·σ_HV / (σ_HH + σ_HV)` | Radar vegetation index |
| DpRVI | `q(q+3)/(q+1)²`, q = HV/HH | Mandal et al. 2020 |
| Cross-pol ratio | HV/HH (linear) | Volume scattering proxy |
| Depolarization | HV/(HH+HV) | Normalized volume fraction |

These are trivial to add as composite presets — single-formula operations.
Park here until there's a concrete use case driving them.

---

## Phase 7 — GLCM Texture Features

**Priority: SHELVED — revisit when use case is clear**

Gray-Level Co-occurrence Matrix texture (contrast, homogeneity, entropy, etc.)
computed on any single band. Potentially valuable for land cover classification
but needs more thought on UI integration and whether GPU compute is worthwhile
for the window sizes involved.

---

## Dependencies & Ordering

```
Phase 1: H/A/α ─────────────────────────────┐
  └─ matrix.js eigendecomp is the key blocker │
                                               ├── Phase 5: GPU compute
Phase 2: Yamaguchi ──── needs Phase 1 T3 code │     (port all to WGSL)
                                               │
Phase 3: Van Zyl ────── independent of Phase 1│
                                               │
Phase 4: True Pauli ─── independent, simple   ─┘

Phase 6: Dual-pol indices ─── independent, trivial (deferred)
Phase 7: GLCM ─────────────── independent (shelved)
```

**Critical path:** Phase 1 (eigendecomp) → Phase 2 (Yamaguchi) → Phase 5 (GPU)

Phase 3 (Van Zyl) and Phase 4 (True Pauli) can proceed in parallel with Phase 2.

## Files to Modify

| File | Changes |
|------|---------|
| `src/utils/matrix.js` | Implement eigenDecomposition3x3, covarianceToCoherency, computeAlphaAngle |
| `src/utils/sar-composites.js` | Add h-alpha, yamaguchi, van-zyl, pauli (coherent) presets |
| `src/layers/shaders.js` | GLSL support for decomposition outputs (if needed beyond RGB) |
| `src/gpu/polsar-compute.js` | NEW — WGSL compute shaders for Phase 5 |
| `app/main.jsx` | UI: decomposition selector, H-α plane visualization |

## References

- Cloude & Pottier (1996), IEEE TGRS 34(2) — H/α decomposition
- Freeman & Durden (1998), IEEE TGRS 36(3) — 3-component model
- Yamaguchi et al. (2005), IEEE TGRS 43(7) — 4-component with helix
- Van Zyl et al. (2011), IEEE TGRS 49(8) — non-negative eigenvalue
- Lee & Pottier (2009), *Polarimetric Radar Imaging* — comprehensive reference
- Golub & Van Loan (2013), *Matrix Computations* — Jacobi eigenvalue algorithm
