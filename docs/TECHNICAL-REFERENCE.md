# DRISHTI — Technical Reference

**D**rug Sample **I**maging, **S**tandardization & **T**esting **I**nformation
**S**ystem.

Colour-calibrated capture and tamper-evident recording of presumptive colorimetric
field-test results.

**Status:** working prototype. 366 tests across 16 files, clean typecheck,
production build 323 KB (106 KB gzipped) with offline service worker.

> The output is a **presumptive** field-test result and a supporting digital record.
> It does not replace laboratory confirmatory testing. This is printed on the card,
> shown on every result screen, and stored as a non-optional field in every signed
> record — there is no code path that can set it false.

---

## 1. The problem, restated precisely

Existing colorimetric field kits work. The failure is not chemical, it is
**metrological and evidentiary**:

| Problem | Consequence |
|---|---|
| A human eye judges the colour | Two officers, two verdicts |
| Ambient light changes the apparent colour | Same sample reads differently at noon and at night |
| Nothing records that a test happened | Outcome cannot serve as documentary evidence |
| No record of *how good* the reading was | A guess and a solid measurement look identical |

So there are two independent engineering problems, and they need different solutions:

1. **Make the colour measurement objective and reproducible** → reference-card
   colorimetry
2. **Make the record defensible** → cryptographic signing and hash chaining

---

## 2. The core insight

A camera does not measure colour. It measures *colour × illuminant × sensor
response × image processing*. Photographing a reagent result tells you almost
nothing absolute.

But if a **card with known colours** is in the same frame, under the same light,
through the same lens, then you have a system of equations. Solve for the transform
that maps the card's *measured* colours onto its *known* colours, and apply that
same transform to the sample. The illuminant and camera response cancel.

**The card is not a visual comparison chart. It is a calibration target that makes
the camera into an instrument.**

Second insight, equally important: a wrong-but-confident reading signed into an
evidentiary record is worse than no reading. So the system is built to **refuse**.
Ten quality gates must pass before any verdict is produced, and refusals are
themselves signed and logged.

---

## 3. Architecture

```
src/
  core/                    no DOM, no framework, no runtime dependencies
    math/linalg.ts         Gaussian elimination, least squares
    color/space.ts         sRGB <-> linear <-> XYZ <-> Lab (D65)
    color/deltaE.ts        CIEDE2000
    color/correction.ts    two-stage illumination + affine colour fit
    card/spec.ts           SINGLE SOURCE OF TRUTH for card geometry
    card/printable.ts      print-ready SVG generated from that spec
    vision/homography.ts   DLT + Hartley normalisation
    vision/detectCard.ts   marker detection, orientation, validation
    vision/image.ts        sampling, rectification, focus, thresholding
    classify/panels.ts     reagent reference data with provenance
    classify/engine.ts     dE matching with refusal guards
    record/canonical.ts    deterministic serialisation
    record/crypto.ts       SHA-256, ECDSA P-256
    record/record.ts       schema, signing, verification, hash chain
    pipeline/quality.ts    capture gates
    pipeline/analyse.ts    the single entry point
  data/                    IndexedDB (Dexie) + searchable log
  app/captureService.ts    analysis -> signed record -> log
  ui/                      React screens
```

**Deliberate choice: no OpenCV.** The whole detector is a few hundred lines against
an ~8 MB WASM dependency that would have to be cached for offline use on a
mid-range phone. Everything in `core/` is dependency-free and runs in plain Node,
which is what makes it testable.

**Deliberate choice: the app generates its own card.** There is no separate artwork
file. Change a dimension in `spec.ts` and the printable SVG changes with it, so the
printed card and the software that reads it cannot drift apart.

---

## 4. The mathematics

### 4.1 Colour space conversions

Camera frames arrive gamma-encoded. **All averaging must happen in linear light** —
the mean of gamma-encoded values is not the encoding of the mean, and the error is
patch-dependent, so it would be baked into the calibration.

sRGB inverse transfer function (IEC 61966-2-1):

```
linear = v / 12.92                        if v <= 0.04045
linear = ((v + 0.055) / 1.055) ^ 2.4      if v >  0.04045
```

Linear sRGB → CIE XYZ under D65:

```
| X |   | 0.41239080  0.35758434  0.18048079 |   | R |
| Y | = | 0.21263901  0.71516868  0.07219232 | * | G |
| Z |   | 0.01933082  0.11919478  0.95053215 |   | B |
```

XYZ → CIE L\*a\*b\*, with the **exact rational** constants
`eps = 216/24389`, `kappa = 24389/27`:

```
f(t) = cbrt(t)                if t >  eps
f(t) = (kappa * t + 16) / 116 if t <= eps

L* = 116 * f(Y/Yn) - 16
a* = 500 * [ f(X/Xn) - f(Y/Yn) ]
b* = 200 * [ f(Y/Yn) - f(Z/Zn) ]
```

**Detail worth a slide:** the matrix rows sum *exactly* to our D65 white point, so
white maps to L\*=100, a\*=b\*=0 to within 1e-8. Published tables use D65 rounded to
0.95047, giving a luminance coefficient of 0.2126729 instead of our 0.21263901 —
a ~0.004 L\* difference. Internal consistency was worth more than matching a table.

### 4.2 CIEDE2000 — why not Euclidean distance

Plain Euclidean distance in Lab (CIE76) badly misjudges differences in the blue and
near-neutral regions — exactly where several reagent reactions land. Marquis goes
deep blue-purple on some substrates; an unreacted reagent sits near neutral. CIE76
would make "faint colour vs no colour" and "blue vs purple" unreliable.

CIEDE2000 (Sharma/Wu/Dalal formulation):

```
Cbar = (C1 + C2) / 2
G    = 0.5 * (1 - sqrt( Cbar^7 / (Cbar^7 + 25^7) ))

a_i' = (1 + G) * a_i
C_i' = sqrt(a_i'^2 + b_i^2)
h_i' = atan2(b_i, a_i')                       [degrees, mod 360]

dL'  = L2 - L1
dC'  = C2' - C1'
dH'  = 2 * sqrt(C1' * C2') * sin(dh' / 2)

T  = 1 - 0.17*cos(hbar' - 30)  + 0.24*cos(2*hbar')
       + 0.32*cos(3*hbar' + 6) - 0.20*cos(4*hbar' - 63)

SL = 1 + (0.015 * (Lbar' - 50)^2) / sqrt(20 + (Lbar' - 50)^2)
SC = 1 + 0.045 * Cbar'
SH = 1 + 0.015 * Cbar' * T

dTheta = 30 * exp( -((hbar' - 275) / 25)^2 )
RC     = 2 * sqrt( Cbar'^7 / (Cbar'^7 + 25^7) )
RT     = -sin(2 * dTheta) * RC

dE00 = sqrt(  (dL'/(kL*SL))^2
            + (dC'/(kC*SC))^2
            + (dH'/(kH*SH))^2
            + RT * (dC'/(kC*SC)) * (dH'/(kH*SH)) )
```

**Verified against all 34 pairs of the published Sharma reference dataset to 4
decimal places.** Those pairs specifically exercise the formula's discontinuities —
hue wrap-around at 0/360 degrees, neutral samples where hue is undefined, and the
blue-region rotation term. Passing all 34 makes an error elsewhere very unlikely.

Scale for intuition: **1 dE ~ threshold of visibility.**

### 4.3 Finding the card: homography

The card is a rigid plane. Given the four corner markers in the image, a homography
lets us address any point by its physical millimetre coordinates, regardless of
tilt or rotation. That is what makes "sample the patch 12 mm from the left edge" a
well-defined operation on a hand-held photo.

```
u = (h0*x + h1*y + h2) / (h6*x + h7*y + 1)
v = (h3*x + h4*y + h5) / (h6*x + h7*y + 1)
```

Fixing `h33 = 1` linearises this into two rows per correspondence:

```
[ x  y  1  0  0  0  -x*u  -y*u ] . h = u
[ 0  0  0  x  y  1  -x*v  -y*v ] . h = v
```

**Hartley normalisation** is applied first: translate each point set's centroid to
the origin and scale so mean distance from origin is sqrt(2), then
`H = inv(T_dst) * H_norm * T_src`. Without it, pixel coordinates near 3000
multiplied together reach 1e7 while homogeneous terms are order 1, and the solve
loses precision.

*Verified: exact recovery under strong tilt and at 4000x3000 sensor coordinates
(reprojection error < 1e-6); returns null on degenerate collinear input.*

### 4.4 Identifying the markers: rotation-invariant shape descriptors

**This is where naive approaches fail, and it's good slide material.**

The obvious test for "is this blob a square" is bounding-box fill ratio. It is
**not rotation invariant**: a square rotated toward 45 degrees has its fill ratio
fall from 1.0 to 0.5. The first implementation rejected a perfectly good card held
at -25 degrees.

The fix is second-moment (inertia) descriptors. Central moments with the standard
discrete-pixel correction:

```
mu20 = sum(x^2)/A - cx^2 + 1/12
mu02 = sum(y^2)/A - cy^2 + 1/12
mu11 = sum(x*y)/A - cx*cy

lambda1,2 = (mu20 + mu02)/2  +/-  sqrt( ((mu20 - mu02)/2)^2 + mu11^2 )
```

For a **filled rectangle** with half-extents `a, b`: `lambda1 = a^2/3`,
`lambda2 = b^2/3`, `A = 4ab`. Therefore:

```
momentAspect   = sqrt(lambda1/lambda2) = a/b
               -> 1.0 for a square, AT ANY ROTATION

momentSolidity = A / (12 * sqrt(lambda1*lambda2))
               = 4ab / (12 * ab/3)
               -> 1.0 for any filled rectangle
```

Accepted range: aspect <= 1.5, solidity 0.68–1.35. A solid marker scores 1.0; the
hollowed top-left marker scores ~0.8.

### 4.5 Thresholding: Otsu, with a correction

Otsu maximises between-class variance `w0*w1*(mu0 - mu1)^2`. Chosen over a fixed
threshold because field lighting varies by orders of magnitude.

**But** for a cleanly bimodal histogram, *every* threshold between the two
populations scores identically, so the raw argmax returns whichever the loop visits
first — sitting directly on top of the darker population. With any sensor noise,
half of it is then misclassified.

We return the **midpoint of the two class means** instead, which sits in the middle
of the empty valley where a threshold belongs.

### 4.6 The orientation problem

Four identical markers leave a **four-fold rotational ambiguity**. Aspect ratio
resolves 90/270 degrees (the card is landscape), but **180 remains**. A card held
upside down still yields four corners in a valid arrangement — every patch is then
sampled from the wrong place and the result is confidently wrong.

Solution: the top-left marker carries a **white square** at 1/3 its width. Detection
compares the mean luma of that inner region against the surrounding ink; the marker
with the highest contrast is the top-left. The two neighbours in cyclic order are
then top-right and bottom-left, and since the card is landscape, the **further**
neighbour is top-right — resolving handedness without assuming anything about
rotation.

*Verified: a card rendered at 180 degrees is correctly recovered and all patches
read correctly. A set of four plain dark squares with no key is rejected, so a
hand-drawn imitation cannot be passed off as a calibrated card.*

### 4.7 Sampling

- Sampled on a grid in **card space**, not image space, so a close-up and a distant
  capture are weighted identically
- Only the **central 50%** of each patch is read, discarding print registration
  error and ink bleed at the edges
- **Trimmed mean** (10% each tail) rejects dust, print defects and small glare spots
- All accumulation in **linear light**
- Reports per-channel standard deviation, clipped fraction and out-of-frame fraction
  so downstream gates can judge reliability

### 4.8 Colour correction — two stages

**Stage 1: illumination field.** A light source off to one side, or a shadow across
part of the card, makes one edge dimmer. A single global matrix cannot represent
that; the best it can do is split the difference, leaving the extremes worst.

Model, fitted from the neutral patches:

```
Y_measured_i = Y_reference_i * ( c0 + cu*u_i + cv*v_i )
```

Solved in **absolute luminance**, not on ratios. This matters: measurement error is
roughly constant in absolute luminance, so the *relative* error of a ratio scales as
`1 / Y_reference`. The darkest neutral has `Y ~ 0.03`, so on a ratio basis a small
absolute error there becomes enormous and one noisy dark patch dominates. The
absolute formulation is exactly weighted least squares with weight proportional to
`Y_reference^2` — the inverse of that variance.

```
centre   = c0 + 0.5*cu + 0.5*cv
strength = (|cu| + |cv|) / centre
gain_rel(u,v) = (c0 + cu*u + cv*v) / centre      [clamped to 0.33 .. 3]
```

**Stage 2: affine colour matrix.** On field-normalised values, per output channel:

```
| R' |                | R |
| G' | = M_3x4    *   | G |
| B' |                | B |
                      | 1 |
```

Solved by normal equations `At*A*x = At*b` with Gaussian elimination and partial
pivoting. 12 patches, 4 unknowns per channel — comfortably overdetermined.

**Why affine (3x4) and not a bare 3x3:** the additive column absorbs veiling glare
and sensor black-level offset, which are always present on a phone camera and which
a purely multiplicative model must misattribute to the colour terms. *Measured: on a
simulated flare of 0.04, the affine model fits to < 0.05 dE while the 3x3 is more
than 5x worse.*

Singular systems return `null` rather than a fallback. A silently poor correction
would surface as a confidently wrong classification.

### 4.9 Classification — built to refuse

CIEDE2000 from the corrected sample to each reference colour on the selected
reagent panel, then **two independent guards**:

1. **Absolute:** nearest reference must be within `maxMatchDeltaE` (12). Otherwise
   the colour is not on the panel at all and forcing it into the nearest bucket
   would invent a result.
2. **Relative:** nearest must beat the runner-up by `minSeparationDeltaE` (8). A
   sample between two references is genuinely ambiguous; reporting whichever was
   marginally closer would reintroduce the arbitrary judgement this app exists to
   remove.

Failing either yields `inconclusive` with a machine-readable reason — **never a
low-confidence positive**. The asymmetry is deliberate: a false positive carries
real consequences for a person.

**Coherence invariant, enforced by a test:** `maxMatchDeltaE` must be smaller than
the smallest pairwise distance between a panel's own references. Otherwise the
accept radii overlap and plainly different colours get absorbed.

Confidence is reported as a **band** (high / moderate / low), not a percentage — a
percentage would imply a calibrated probability this method does not provide, and
that a reviewer could mistake for a statistical error rate.

---

## 5. Card design — every dimension has a reason

**88.9 x 54 mm**, 2.5 mm margin, four 8 mm corner markers, 12 patches in two rows.

| Design decision | Reason |
|---|---|
| White key square in top-left marker | Removes the 180-degree ambiguity (4.6) |
| Patches 12.73 x 7.5 mm -> **aspect 1.70** | Detector accepts blobs up to aspect 1.5 as markers. An earlier inset row was 9.6 x 7.5 (aspect **1.28**) and got selected as a corner. Enforced by test. |
| **Two** rows, above and below the sample window | A plane cannot be fitted from samples on one line. One row made the illumination fit rank-deficient. |
| Sample window **between** the rows | Its local illumination is *interpolated* between real measurements, not extrapolated past the edge of the data |
| Neutral lightness **de-correlated** from position | See section 7, bug 9 — the most subtle bug found |
| Lightest neutral **216, not 255 and not 240** | Pure white prints as bare stock: invisible, unverifiable, and targets L\*=100, a reflectance no card achieves. But 240 (a 6% tint) did not print **at all** on PVC — dye-sublimation heads have a transfer threshold in the highlights. 216 is a 15% tint at L\*86. See section 7, bug 13. |
| Neutral steps evenly spaced in **L\***, not code value | The fit weights every neutral equally, so the steps should be equally informative. Even 8-bit spacing gave a 5.6 L\* step at the light end and 17.6 L\* at the dark end. |
| Every patch carries a **keyline** | A dropped tint then reads as an empty box instead of as bare stock. Stroke is 0.25 mm on the boundary, against a 3.18 mm sampling inset, so it cannot reach a reading. Grey not black, so it stays clear of the ink population Otsu separates out. |
| Keyline colour chosen **per patch** from its own L\* | No single grey works: #707070 is bit-for-bit the level-112 fill, so that patch had no visible outline while the instructions claimed all twelve did. Light patches get the dark keyline — which is the case that matters, since those are the ones that drop out and a dark line is what stays visible on bare stock. |
| Nothing printed inside the read area | Enforced by tests checking rects, paths *and* text anchors |
| Patch index labels in the corner, **opaque** | Outside the sampled central 50%, so the ink cannot contaminate a reading. Opaque rather than alpha, because alpha flattening differs between the browser print pipeline and the printer's RIP. |
| Corner brackets point **outward** with a 0.35 mm gap | An earlier version pointed them inward, putting stroke ink inside the measured region |

**Calibration provenance** is tracked honestly as `nominal` or `measured`, and
propagates into every signed record. Patch values are specified as sRGB; a printer
converting to CMYK will not reproduce them exactly. Until the printed card is
measured, the app reports `nominal` and says so on screen.

### Card v3 layout (drishti-card-3)

```
Row A (y = 11.5 mm):  N112   RED    N216   GREEN  N81    BLUE
Row B (y = 34.0 mm):  ORANGE N145   CYAN   N50    PURPLE N180

Sample window: x 14, y 21, 60.9 x 11 mm   (read region inset 20%)
Markers:       8 mm squares at the four corners, 2.5 mm inset
               centres (6.5, 6.5) (82.4, 6.5) (82.4, 47.5) (6.5, 47.5)
               marker-centre rectangle 75.9 x 41 mm, aspect 1.8512
Keyline:       0.25 mm #707070 on every patch boundary
```

Neutral 8-bit levels and their nominal L\*:

| Level | 216 | 180 | 145 | 112 | 81 | 50 |
|---|---|---|---|---|---|---|
| L\* | 86.3 | 73.3 | 60.2 | 47.2 | 34.4 | 20.8 |
| step | — | 13.0 | 13.1 | 13.0 | 12.8 | 13.6 |

Chromatic hexes: `#b5473c` `#cf8b3f` `#4f8f52` `#3f8f9e` `#3f5f9e` `#7b4f8f`
(deliberately mid-saturation to stay inside CMYK gamut).

Level/position covariance is 1.5% of the monotonic worst case; row mean levels are
136 (A) and 125 (B). Both properties are enforced by tests in `spec.test.ts`.

---

## 6. Tamper-evidence

### 6.1 What the record proves

| Property | Mechanism |
|---|---|
| **Integrity** | ECDSA P-256 signature over a canonical serialisation of every field |
| **Image binding** | SHA-256 of the retained image bytes inside the signed payload |
| **Ordering** | Hash chain: each record commits to `SHA-256(canonical(previous record))` |
| **Device attribution** | Non-extractable key — copying the database yields no usable key |

### 6.2 Canonical serialisation

A signature is only meaningful if the signed bytes can be reproduced.
`JSON.stringify` follows insertion order, so two structurally identical records
serialise differently and one fails verification for no substantive reason.

Canonical form: keys sorted by code unit, `undefined` omitted, no insignificant
whitespace, and **non-finite numbers throw** rather than serialise.
`JSON.stringify` silently converts `NaN` to `null` — which would let a record be
signed with a measurement quietly replaced by null, invisible until someone relied
on it.

### 6.3 Why ECDSA P-256 and not Ed25519

Ed25519 is better on the merits — smaller, faster, no nonce-reuse hazard. It is not
used because WebCrypto support is still uneven across mobile browsers, and a signing
scheme that fails to initialise on an officer's phone is worse than a slightly older
one that works everywhere. The private key is generated non-extractable, so nonce
handling stays inside the platform implementation.

### 6.4 Why a hash chain and not a blockchain

*(Prepare this answer — it will be asked.)*

The property required is "an entry cannot be altered or removed without detection".
A signed hash chain provides that **directly**. Distributed consensus solves a
different problem — mutual distrust among many writers — which does not apply to a
single department's evidence log, and adds operational cost with no gain in
evidential strength. A deliberate engineering choice, not a shortcut.

Note a per-record signature alone would **not** catch deletion. Remove a record from
the middle of a log and every remaining record still verifies individually. The
chain is what makes the gap detectable.

### 6.5 What it does NOT prove — state this out loud

- **Not that the content is true.** A device key attests that *this device produced
  this record*, not that the GPS fix was genuine. A rooted device with a mock
  location provider can produce a validly signed record with false coordinates.
- **Not countersigned.** Production hardening: server-side countersigning on sync,
  hardware-backed key attestation, server-side anomaly detection on implausible GPS
  movement.
- **The PIN is not strong authentication.** It binds an operator identifier to each
  record. Stored salted and hashed, but a PIN has little entropy and the signing key
  is not derived from it.

---

## 7. Quality gates, and the bugs found by testing

Ten gates run before any classification. Each returns an **actionable** message —
"move out of direct light", not "error 7".

| Gate | Action | Threshold |
|---|---|---|
| Focus (Laplacian variance on rectified card) | reject | < 8 |
| Card coverage | reject | < 6% of frame |
| Overexposure / clipping | reject | mean > 0.12 |
| Underexposure | reject | brightest neutral Y < 0.06 |
| Within-patch uniformity | reject | > 0.45 |
| Viewing angle | reject | outside 1.15–2.9 |
| **Grey-ramp monotonicity** | reject | any inversion |
| Correction residual | reject | nominal 8/16, measured 4/9 dE |
| Sample-area uniformity | reject | > 0.45 |
| Colour cast / uneven light / nominal calibration | warn | — |

**The grey-ramp gate deserves a slide.** It is an *independent* check on the
geometry. If the homography were wrong, the grey patches would be read from the
wrong places and stop descending in lightness. It catches whole classes of
geometric error the detector itself cannot see.

Refusals are **signed and logged**. The log must distinguish "no test was attempted"
from "a test was attempted and could not be read".

### Thirteen real defects found — this is your engineering-maturity slide

| # | Defect | Fix |
|---|---|---|
| 1 | Otsu argmax landed on the dark population | Return midpoint of class means |
| 2 | Bounding-box fill ratio not rotation invariant; rejected card at -25 deg | Second-moment descriptors |
| 3 | Size check inflated by (cos+sin)^2 under rotation | Compare **areas**, not lengths |
| 4 | Picked best-scoring quad *then* validated | Validated **search** over candidate quads |
| 5 | All neutrals in one row -> rank-deficient plane fit | Two rows |
| 6 | Inset bottom row aspect 1.28 -> mistaken for a marker | Full-width rows, aspect 1.70 |
| 7 | `maxMatchDeltaE`=25 exceeded panel separation ~17; **a blue sample was reported as opiate-consistent purple** | 12, plus a coherence invariant test |
| 8 | Uniformity threshold calibrated on synthetic data that cannot exhibit print texture | Recalibrated against a real print |
| 9 | **Neutral lightness correlated with position** -> printer tone curve aliased with a spatial gradient -> spurious 126% gradient -> bare paper read 25 L\* too dark | De-correlated layout, covariance cut ~35x |
| 10 | Pure-white patch invisible and targeting an unachievable L\*=100 | Level 240 |
| 11 | Illumination field fitted on ratios | Weighted least squares in absolute luminance |
| 12 | Plausibility cap of 0.6 rejected a *real* 55% gradient | Raised to 1.0; magnitude alone cannot separate steep-but-real from spurious |
| 13 | **Level 240 did not print at all on a PVC card** — dye-sublimation heads have a transfer threshold in the highlights, so a 6% tint registers as nothing, and with no outline the missing patch looked identical to bare stock | Level 216 (15% tint), whole ramp re-spaced evenly in L\*, and a 0.25 mm grey keyline on every patch so a dropped tint presents as an empty box |

Bug 9 is the best story. It was invisible in synthetic testing and only surfaced
because a real print's tone curve differs from sRGB. Two patches of *identical bare
paper* corrected to L\*100 and L\*75 — that inconsistency is what exposed it.

Bug 13 is the most useful one to be honest about, because the fix for bug 10 caused
it. Moving the lightest neutral from 255 to 240 was correct in principle and still
wrong in practice: it reasoned about colour space and not about the machine. A 6%
tint is a real colour and an unprintable one. Nothing in synthetic testing, in the
type system, or in 366 unit tests could have caught it — only printing the card
could, which is the argument for printing the card early.

---

## 8. Measured results

### Verified against synthetic ground truth

Because the synthetic renderer applies a *known* distortion to *known* colours, the
pipeline can be asserted to recover the truth — impossible to do rigorously with
photographs of a real card, where ground truth is only approximately known.

| Condition | Uncorrected | Corrected |
|---|---|---|
| Neutral daylight | small | < 1 dE |
| Warm tungsten | large | < 4 dE |
| Cool shade | large | < 4 dE |
| **Sodium-like (strong cast)** | **> 15 dE** | **< 4 dE** |
| Side lighting, 55% falloff | large | < 4 dE |

The same physical sample reads **within 4 dE of itself across all six conditions**.

Detection verified under: rotation (-25 to +20 degrees, and 180), perspective tilt,
tungsten cast, deep shade, 45% lighting gradient, sensor noise, dark and light
backgrounds, and background clutter. Rejects a hand-drawn imitation card.

Concurrency: eight simultaneous appends produce chain indices 0–7 with an intact
chain.

### Verified on a real printed card

Detection **succeeded** on a phone photo of a real inkjet card at ~90 degrees
rotation against a cluttered notebook background — the geometry pipeline works on
real imagery.

Colorimetry on two real printed cards:

| Metric | `card-1` (pre-layout-fix) | `card-2` (de-correlated layout) |
|---|---|---|
| Mean fit error | 5.46 dE | 9.91 dE |
| Worst patch | 15.01 dE (red, hue-shifted toward magenta) | 28.25 dE |
| Reported illumination gradient | 1.260 (spurious — bug 9) | 0.769 |
| Focus score | — | 181 |
| Card coverage | — | 27.1% |
| Clipping | 0% on all 12 patches | 0% |
| Within-patch variation | 0.015 – 0.296 | 0.015 – 0.296 |

Note that `card-2` reports a *worse* mean fit error than `card-1` while being the
better card. That is the honest reading: the de-correlated layout stopped the fit
from absorbing print error into a fake illumination gradient, so the residual now
shows up where it actually belongs — in the print. The spurious gradient fell from
1.260 to 0.769 at the same time.

Those worst-patch figures are a **measurement of print quality**, not a software
problem — and they are exactly what the `nominal` vs `measured` provenance flag
exists to communicate. With a consumer printer and no spectrophotometer, nominal
calibration has a floor that no amount of software can lower.

### Offline operation — statically verified

`npm run verify:offline` inspects the built output and confirms: the service worker is
registered, every precached URL exists in `dist/`, every asset `index.html` uses is
precached, navigations fall back to the cached `index.html`, the workbox runtime chunk
ships, the manifest icons are cached, and no shipped bundle contains a construct that
would request something off-origin. Build is 371 KiB across 9 files, 7 precached.

The check is negative-tested: deleting a precached asset makes it report the specific
failure and exit non-zero.

Worth knowing about the off-origin check — it matches *requesting constructs*
(`fetch`, `importScripts`, `new Worker`, CSS `@import`/`url()`, absolute `src`) rather
than any `http://` string. The first version flagged four false positives that were
React's error-decoder link, two Dexie error messages and a Workbox `console.warn`. A
check that cries wolf trains people to ignore it.

### Not yet verified — say so

- No `card-3` capture yet (the 216 level and the patch keylines are newer than the
  last real test)
- Offline operation is verified **statically**, not in a browser. Nothing drives a
  real device with the network off, so service worker installation and cache-serving
  remain a manual test
- The UI has never been exercised by an automated test; screens compile and run but
  have no test coverage
- IndexedDB adapter untested (the chain logic behind it is thoroughly tested against
  an in-memory store)
- Camera and geolocation paths untested by automation
- **Reagent reference colours are placeholders**

---

## 9. Honest limitations — lead with these, don't bury them

**Reagent reference colours are approximations of published colour *descriptions*,
not measurements.** The qualitative associations are well established (Marquis ->
purple for opiates, cobalt thiocyanate -> blue for cocaine). The numeric Lab values
are not. Every one carries a `provenance` field that propagates into the signed
record and onto the result screen.

**Reaction intensity varies** with concentration, substrate and elapsed time. A
faint and a deep version of the same reaction share a hue but differ in lightness
and chroma, so a single reference point with a tight accept radius will report some
genuine reactions as inconclusive. That is the *safe* failure direction. The real fix
is reference data with several measured points along each reaction's intensity
range — lab work, not a threshold change.

**Print error is not corrected in nominal mode.** It applies identically to every
capture, so **reproducibility is unaffected** — only absolute accuracy is. Since the
problem statement asks for objectivity and standardisation rather than absolute
colorimetry, this does not undermine the deliverable, but it must be stated.

**The uniformity metric partly measures patch lightness.** Normalised by the patch
mean, a fixed amount of noise yields a larger relative figure on a dark patch. Real
data shows the neutral ramp's variation rising monotonically from 0.015 at the
lightest step to 0.248 at the darkest with **no shadow present**. The proper fix —
fitting a plane within each patch to separate low-frequency shading from
high-frequency texture — is documented as follow-up, not done.

**No backend.** Records carry sync state and a queue exists, but there is no server
and no countersigning.

### Getting reference values without a spectrophotometer

If reagent references are captured **through the same card and app**, the print
distortion applies to both reference and sample and largely cancels. Cancellation is
approximate — dE is non-linear in Lab — but it removes the need for an instrument.
The constraint becomes access to known reference reactions, not hardware.

---

## 10. Suggested slide structure

| # | Slide | Key content |
|---|---|---|
| 1 | Title | Name, team, one-line description |
| 2 | The problem | The four-row table from section 1 |
| 3 | Not one problem but two | Metrology + evidence, different solutions |
| 4 | Core insight | "The card makes the camera an instrument" |
| 5 | What the user does | Three steps: place card, capture, done |
| 6 | Architecture | The tree from section 3, highlight "no OpenCV, no dependencies" |
| 7 | Finding the card | Homography + the 180-degree ambiguity and key square |
| 8 | Rotation invariance | Fill-ratio failure -> second moments. Shows depth. |
| 9 | The correction | Two stages, with the affine-vs-3x3 justification |
| 10 | **Money slide** | Sodium light: > 15 dE -> < 4 dE. Same sample, six illuminants. |
| 11 | Built to refuse | Gate table; the negative->positive transition must pass through inconclusive |
| 12 | Grey-ramp gate | Independent geometry check — subtle and impressive |
| 13 | Tamper-evidence | Four properties + what a chain catches that signatures don't |
| 14 | Why not blockchain | Prepared answer |
| 15 | Card design | "Every dimension has a reason" table |
| 16 | Engineering rigour | 366 tests; the twelve-defect table |
| 17 | Bug 9 deep-dive | The confound. Optional, but it's your strongest technical story. |
| 18 | Limitations | Provenance, intensity variation, not a lab replacement |
| 19 | Roadmap | Lab-verified references, server countersigning, key attestation |
| 20 | Live demo | Script in section 11 |

---

## 11. Demo script

1. **Show the problem.** Photograph the same result under two very different
   lights. Raw colours are obviously different.
2. **Capture** under warm indoor light. Show the result, then the **calibrated vs
   raw swatches** — the gap between them is the error the card removed.
3. **Capture again** under completely different light. Same verdict; the calibrated
   swatch lands in nearly the same place.
4. **Show a refusal.** Deliberately blur or blow out a capture. The app declines
   with a specific instruction — and the refused attempt still appears in the log.
5. **Show the per-patch diagnostics.** Print vs read swatch, dE, variation, clipping
   for all 12 patches. This is what "we measured it" looks like.
6. **Open the record.** Signature verified, image hash, GPS, operator, chain
   position, canonical payload.
7. **Break it.** Edit one character of a result and show verification failing with a
   *specific* reason.
8. **Airplane mode.** Capture offline; the record is signed and queued locally.

**Have a recorded backup video.** Live camera and network during judging are risks
you don't need to take.

---

## 12. Likely judge questions

**"How do you know your reference colours are accurate?"**
The card's are nominal and the app says so — provenance is in every record. The
reagent values are placeholders derived from published colour descriptions, clearly
marked. Absolute accuracy needs a measured card and lab-verified reaction colours;
reproducibility, which is what the problem statement asks for, does not.

**"What happens in bad lighting, or with no card in frame?"**
Ten gates. Show the refusal with its measured value and threshold. Demonstrate it
live — it's more convincing than a slide.

**"Why not blockchain?"** -> section 6.4.

**"What if the officer fakes the GPS or the photo?"**
Device-level signing binds the record to a specific device and key at capture time;
the image hash binds the photograph. Neither proves the *content* is true. Name the
production hardening path: server countersigning, hardware key attestation,
server-side GPS anomaly detection.

**"Does this replace lab testing?"**
No. Say it plainly — it's on the card, on every result screen, and it's a
non-optional field in every record.

**"Why a web app rather than native?"**
Offline-first PWA, installable, no app-store gatekeeping for a department rollout,
one codebase. Trade-off stated honestly: `getUserMedia` gives the *processed* camera
stream with no access to raw, and exposure/white-balance locking is best-effort
because browser support is uneven — which is exactly why the correction is designed
not to depend on it.
