# Physical Grounding for General-Purpose Agents Interpreting SAR

**A SARdine technical note**
Status: design + implementation complete; behavioural evaluation not yet run.

---

## Summary

A synthetic aperture radar image is not self-describing. Shown a rendered SAR
scene, a general-purpose language agent reads it with optical intuitions —
dark is water, bright is built-up — and is wrong in specific, predictable
ways. The failure is not that the agent lacks knowledge of radar; it is that
nothing in a PNG tells it which knowledge applies.

SARdine now attaches a **grounding payload** to every view an agent can see.
The payload states the physical frame of the measurement, and — the part that
does the work — enumerates what the current view *cannot* resolve.

The claim this note advances is narrow and, so far, unproven:

> Injecting physical context into an agent-facing view should reduce
> confident misinterpretation of SAR, primarily by making unanswerable
> questions *visibly* unanswerable rather than by supplying more facts.

The implementation is complete and tested. The behavioural claim is not yet
evaluated. §6 specifies the experiment that would settle it.

---

## 1. The problem

SAR measures backscattered microwave energy. Brightness is governed by surface
roughness relative to wavelength, dielectric properties (largely water
content), and imaging geometry. None of these is albedo, and none of them
maps onto the visual priors a general-purpose model brings to an image.

The canonical failure is the **dark target**. Low backscatter is consistent
with at least three physically distinct causes:

| Cause | Mechanism |
|:--|:--|
| Open water | Specular reflection away from the sensor |
| Radar shadow | Terrain occludes the illuminating beam |
| Smooth dry surface | Playa, road, bare smooth soil — also specular |

These are *visually identical* in a rendered image. An agent asked "is this
flooding?" will usually answer, and its answer will be fluent regardless of
whether the question is answerable from the view it was given.

This matters more than a generic hallucination concern, for two reasons.
First, the vocabulary of a wrong SAR interpretation is indistinguishable from
that of a right one, so a non-expert reader cannot audit it. Second, the
error is *systematic*, not random: it correlates with terrain, which means it
concentrates exactly where the operational stakes are highest.

## 2. Why more context is not automatically the answer

The obvious remedy — attach metadata — is insufficient, and in one respect
dangerous.

Insufficient, because context *attached* to an image can be ignored. An agent
handed a caption and a picture may still describe the picture.

Dangerous, because context carries its own error. Ancillary land cover is
another classifier's output, with its own failure modes, often years stale,
and sometimes trained on the very phenomenon being detected. Injecting it as
context risks laundering a stale label into a fresh answer, and the agent
cannot tell a wrong ancillary pixel from a right one.

The design rule adopted here follows from that:

> **Report, never invent.** Every field is derived from what the product
> actually carries. Unknown stays null. No absolute backscatter thresholds
> are asserted anywhere in the payload.

The threshold rule is deliberate. Class thresholds in dB are site- and
calibration-dependent; a plausible-but-wrong threshold is worse than none,
because it is actionable. Thresholds belong in an ATBD, with grounding
supplying only the physical frame against which an ATBD's numbers are applied.
A unit test greps the serialized payload to keep thresholds from creeping in.

## 3. Terrain is part of the measurement

Terrain is often treated as enrichment to be added if affordable. For radar
that is a category error.

SAR is side-looking and ranging. Layover, shadow and foreshortening are
terrain effects intrinsic to image formation, and σ⁰ is defined against the
**local** incidence angle, which is a function of slope. Backscatter read
without terrain is not a calibrated measurement; it is a picture.

Two consequences follow, and both are implemented:

- **Shadow cannot be excluded without terrain.** With no terrain information,
  the dark-target ambiguity retains all three causes.
- **Slope and surface change are confounded without local incidence angle.**
  A brightness difference between two areas may be geometry, not surface.
  This is declared as its own ambiguity (`slope-vs-surface`) whenever
  per-pixel incidence angle is unavailable.

For NISAR GCOV this costs nothing, because the product already carries the
geometry: a metadata cube (JPL D-102274 §5.8) with per-pixel incidence angle,
a shadow/layover mask layer, and the convention that a power value of exactly
0 denotes zero illuminated area. No external DEM fetch is required.

The distinction the implementation is careful about:

> Terrain data **existing** is not the same as terrain being **accounted
> for**.

A product may ship a shadow mask that the user has not enabled. In that state
the payload still lists shadow as a candidate cause, says the mask exists but
is not applied, and names enabling it as the resolving action. Only an
*applied* mask retires shadow. A test pins this, because silently dropping a
cause because the data merely exists would reintroduce the original error in
a more credible disguise.

## 4. What the payload contains

Three sections accompany every agent-facing view.

**Acquisition** — radar band mapped to wavelength and its canopy-penetration
consequence; polarization mapped to what it is physically sensitive to; look
direction; orbit pass. Derived from product identification metadata.

**Measurement** — what the pixels *are* (σ⁰ in dB, or linear power), pixel
spacing, CRS, and an explicit statement that the display range is a rendering
choice and **not** an absolute measurement. This last item matters: apparent
brightness is a function of the contrast stretch, and an agent reasoning from
brightness without knowing the stretch is reasoning about a display artifact.

**Ambiguities** — the load-bearing section. Each entry names a question the
view cannot settle, why it is unresolved *here*, the candidate causes, and the
measurement that would resolve it. The set is dynamic: causes are removed only
when something in the view actually removes them.

Alongside these is an **interpretation contract**: this is radar, not an
optical image; any reading is a hypothesis to be verified against numbers
(ROI statistics, histogram, transect) before being stated as a finding; do not
assert absolute dB thresholds; if a listed ambiguity bears on the question,
say so and name the resolving measurement. **Deferring is the correct answer,
not a failure.**

## 5. Architecture

Grounding is delivered over a read-only bridge between an agent and a live
browser viewer. A browser tab cannot be dialed into, so both sides connect to
a small local broker: the agent over stdio, the page over Server-Sent Events,
with replies by POST. Two commands are exposed — current view state (with
grounding attached) and a downscaled screenshot of the actual rendered canvas.

The transport is deliberately dependency-free (Node's `http` plus the
browser's `EventSource`), and binds to localhost only. State travels over this
channel; credentials never do.

Nothing in the read path writes viewer state. That is a scoping decision, not
a limitation of the transport: the value being tested is whether an agent can
*see and correctly hedge*, which does not require it to drive anything.

## 6. What remains to be shown

Everything above is machinery. The scientific question is unaddressed:

> Does grounding measurably change the behaviour of an unmodified
> general-purpose agent?

The evaluation is a 2×2: {grounded, ungrounded} × {scenes where dark is
water, scenes where dark is shadow}. **The ungrounded arm must receive the
identical image**, or the experiment measures rendering rather than grounding.

The primary metric is not accuracy. It is **appropriate deference**: on a
scene where the view genuinely cannot resolve the question, does the agent
decline and name the resolving measurement? Under this metric a grounded
agent that answers "shadow is not excluded here; enable the layover/shadow
mask" scores as a success despite giving no classification. This inverts the
usual benchmark assumption that answering is winning, and it is the part of
this proposal most likely to be contested.

A secondary axis is the **context ladder** — pixels only; instrument frame;
+ ambiguities; + terrain; + site prior; + expert annotation. The question with
a publishable answer is where the curve flattens. If automated grounding
approaches expert annotation, grounding substitutes for expert attention at
scale. If it does not, that bound is worth reporting too.

Two honest constraints. Scenes where the answer is independently known are
the scarce resource, and producing them is expert labour. And the evaluation
prompt must be authored independently of the grounding payload, or the result
is circular.

## 7. Status

Implemented and tested: the grounding payload, terrain-aware ambiguity
derivation, the read-only agent bridge, and 21 unit tests pinning the
behaviour described in §3 and §4 — including that candidate causes shrink only
as terrain knowledge actually improves, and that no dB thresholds appear in
the payload.

Not yet done: the §6 evaluation. Until it is run, this note describes a
specification and an implementation, not a demonstrated benefit.

---

*SARdine is an open-source browser-native SAR analysis tool. Source:
`src/utils/sar-grounding.js`, `server/agent-bridge.cjs`,
`test/unit/sar-grounding.test.mjs`.*
