#!/usr/bin/env python
"""Export the NISAR river-ice U-Net to ONNX for in-browser inference.

  python tools/export_unet_onnx.py --ckpt <model.pt> --out app/public/models/<name>.onnx

The exported graph takes 2-channel dB (HH, HV) and does its OWN
normalization: the mean/std standardization, the finite-mask channel and
the NaN fill from geophoto_sar_train.prep_x are ONNX nodes inside the
graph, not numbers in a sidecar.

That is deliberate. SARdine's manifest vocabulary declares a per-band
transform ('none' | 'dB' | 'power') and nothing finer, and the onnx
backend hands the session exactly what the registry transformed. A model
whose constants lived in JSON would depend on a field no backend reads,
and a silent normalization mismatch produces a confident wrong map with
no error — the failure mode the manifest schema calls out as #1. Baking
them in makes the artifact self-contained: feed it dB, get logits.

Channel 3 (the validity mask) is therefore NOT an input. The graph
derives it with IsFinite over the two dB bands, exactly as training did,
so a caller cannot forget it or supply it inverted.
"""
import argparse, json, math, sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

# From geophoto_sar_train.py:30 — Clay S1 dB norms the checkpoints were trained under.
MEAN = (-12.113, -18.673)
STD = (8.314, 8.017)


def block(i, o):
    return nn.Sequential(
        nn.Conv2d(i, o, 3, padding=1), nn.BatchNorm2d(o), nn.GELU(),
        nn.Conv2d(o, o, 3, padding=1), nn.BatchNorm2d(o), nn.GELU(),
    )


class UNet(nn.Module):
    """Verbatim from geophoto_sar_train.py:86 — must stay byte-compatible
    with the checkpoint's state_dict keys."""

    def __init__(s, cin=3, ncls=3, w=(32, 64, 128, 256)):
        super().__init__()
        s.enc = nn.ModuleList(); c = cin
        for o in w: s.enc.append(block(c, o)); c = o
        s.mid = block(w[-1], w[-1] * 2)
        s.up = nn.ModuleList(); s.dec = nn.ModuleList(); c = w[-1] * 2
        for o in reversed(w):
            s.up.append(nn.ConvTranspose2d(c, o, 2, 2)); s.dec.append(block(o * 2, o)); c = o
        s.head = nn.Conv2d(w[0], ncls, 1)

    def forward(s, x):
        sk = []
        for e in s.enc: x = e(x); sk.append(x); x = F.max_pool2d(x, 2)
        x = s.mid(x)
        for u, d, k in zip(s.up, s.dec, reversed(sk)): x = d(torch.cat([u(x), k], 1))
        return s.head(x)


class UNetDeployable(nn.Module):
    """prep_x + UNet as one graph. Input (N,2,H,W) dB, output (N,3,H,W) logits."""

    def __init__(s, net):
        super().__init__()
        s.net = net
        s.register_buffer('mean', torch.tensor(MEAN).view(1, 2, 1, 1))
        s.register_buffer('std', torch.tensor(STD).view(1, 2, 1, 1))

    def forward(s, db):
        # prep_x (geophoto_sar_train.py:74): mask is per-pixel AND over both
        # bands, standardize, then fill non-finite with 0.
        finite = torch.isfinite(db)
        m = (finite[:, 0:1] & finite[:, 1:2]).to(db.dtype)
        x = (db - s.mean) / s.std
        # nan_to_num with an explicit where(): ORT's NaN handling across EPs
        # is better exercised on Where than on the fused nan_to_num pattern,
        # and infinities must collapse to 0 here too (nan_to_num's default
        # sends them to ±finfo.max, which prep_x overrode to 0.0).
        x = torch.where(torch.isfinite(x), x, torch.zeros_like(x))
        return s.net(torch.cat([x, m], 1))


def load(ckpt):
    sd = torch.load(ckpt, map_location='cpu', weights_only=True)
    net = UNet()
    missing, unexpected = net.load_state_dict(sd, strict=True), None
    net.eval()
    return net


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ckpt', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--tile', type=int, default=128, help='tile size used for the trace')
    ap.add_argument('--opset', type=int, default=17)
    ap.add_argument('--tol', type=float, default=1e-4)
    args = ap.parse_args()

    net = load(args.ckpt)
    model = UNetDeployable(net).eval()

    out = Path(args.out); out.parent.mkdir(parents=True, exist_ok=True)

    # A tile with real NaNs so the mask/fill path is traced and verified,
    # not just the happy path.
    torch.manual_seed(0)
    x = torch.randn(1, 2, args.tile, args.tile) * 6.0 - 15.0
    x[0, :, :8, :8] = float('nan')

    with torch.no_grad():
        ref = model(x)

    # Dynamic H/W so one artifact serves any tile size the manifest picks.
    torch.onnx.export(
        model, (x,), str(out),
        input_names=['db'], output_names=['logits'],
        dynamic_axes={'db': {0: 'n', 2: 'h', 3: 'w'},
                      'logits': {0: 'n', 2: 'h', 3: 'w'}},
        opset_version=args.opset, do_constant_folding=True,
        # Weights MUST live inside the .onnx file. The browser backend
        # fetches one href and caches one blob in IndexedDB; a sidecar
        # .onnx.data would 404 at session-create time (torch>=2.9 splits
        # tensors out by default once they pass ~1 MB).
        external_data=False,
    )

    # Verify against onnxruntime — an unverified model is not shippable.
    import onnxruntime as ort
    sess = ort.InferenceSession(str(out), providers=['CPUExecutionProvider'])
    got = sess.run(['logits'], {'db': x.numpy()})[0]

    if not np.isfinite(got).all():
        print('FAIL: onnxruntime output has non-finite values', file=sys.stderr); return 1
    dev = float(np.abs(got - ref.numpy()).max())
    print(f'max |torch - ort| = {dev:.3e}  (tol {args.tol:g})')
    if dev > args.tol:
        print('FAIL: torch and onnxruntime disagree beyond tolerance', file=sys.stderr); return 1

    # Argmax agreement is what the backend actually consumes.
    agree = (got.argmax(1) == ref.numpy().argmax(1)).mean()
    print(f'argmax agreement = {agree:.6f}')
    if agree < 1.0:
        print(f'WARNING: {(1-agree)*100:.4f}% of pixels change class', file=sys.stderr)

    # A second size proves the dynamic axes are real.
    x2 = torch.randn(1, 2, 256, 256) * 6.0 - 15.0
    with torch.no_grad(): ref2 = model(x2)
    got2 = sess.run(['logits'], {'db': x2.numpy()})[0]
    dev2 = float(np.abs(got2 - ref2.numpy()).max())
    print(f'256x256 max |torch - ort| = {dev2:.3e}')
    if dev2 > args.tol:
        print('FAIL: dynamic-shape run disagrees', file=sys.stderr); return 1

    print(f'OK  {out}  {out.stat().st_size/1e6:.1f} MB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
