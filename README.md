# DRISHTI

**D**rug Sample **I**maging, **S**tandardization & **T**esting **I**nformation
**S**ystem.

Colour-calibrated capture and tamper-evident recording of presumptive colorimetric
field-test results.

Works alongside existing colorimetric field-test kits. No new hardware: the only
physical addition is a printed reference card, which the app generates itself.

> **The output of this application is a presumptive field-test result and a
> supporting digital record. It does not replace laboratory confirmatory testing.**
> That statement is printed on the card, shown on every result screen, and stored as
> a non-optional field in every signed record.

---

## What it does

1. **Captures** the test result with the device camera, with a reference colour card
   in frame.
2. **Calibrates** out the lighting using the card, so the same sample reads the same
   under tungsten, shade, sodium light or midday sun.
3. **Classifies** the corrected colour against a reagent panel, and refuses to
   answer when the evidence does not support one.
4. **Signs** a record containing the timestamp, GPS fix, operator identifier and a
   SHA-256 hash of the image, hash-chained to the previous record.
5. **Logs** everything in a searchable, offline-first log that can be exported.

## Quick start

```bash
npm install
npm run dev             # http://localhost:5173
npm run dev:https       # for testing on a phone over your LAN (see below)
npm test                # 370+ unit and integration tests
npm run build           # typecheck + production build
npm run preview:https   # serve the real build over HTTPS (needed for offline testing)
npm run verify:offline  # static offline-readiness check against ./dist
npm run card            # writes the printable card to ./out
```

### Testing on a phone

`getUserMedia`, WebCrypto and service workers all need a secure origin. `localhost`
counts; a LAN IP does not. Run `npm run dev:https`, open the printed network URL on
the phone, and accept the self-signed certificate warning.

---

## Offline operation

The app is offline-first, and the claim is checked rather than asserted.

Nothing is fetched at runtime: no CDN, no web fonts, no analytics, no API. The
measurement pipeline is hand-rolled rather than built on OpenCV.js, so there is no
multi-megabyte WASM blob to cache either. Records live in IndexedDB, exports are
generated as local blobs, and signing uses WebCrypto on-device. The whole build is
**about 371 KiB across 9 files, 7 of which are precached**.

```bash
npm run build && npm run verify:offline
```

`verify:offline` inspects the built output for the failure modes that are invisible
in a green build:

- A precached URL that is not actually in `dist/`. One of those makes
  `precacheAndRoute` reject, and then the service worker **never activates at all** —
  no offline support whatsoever, while the build log looks perfectly normal.
- An asset that is shipped and used by `index.html` but never precached. Loads fine
  online, breaks only once the network is gone.
- A construct that would genuinely request something off-origin: `fetch`,
  `importScripts`, `new Worker`, a CSS `@import` or `url()`, an absolute `src`.

That last check deliberately looks for *requesting constructs* rather than for any
`http://` string. A first version flagged four "failures" that were React's
error-decoder link, two Dexie error messages and a Workbox `console.warn` — all
message text, never fetched. A check that cries wolf trains people to ignore it, so
those hosts are now reported as string literals and pass.

### Two constraints worth knowing

**One online load is required** to install the service worker. Everything after that
works with the network off.

**A secure context is mandatory.** Opening `dist/index.html` from the filesystem does
not work: `file://` gives you no service worker, no camera and no WebCrypto.

### Confirming it on a device

The static check cannot prove the browser installs and serves from the worker, so
that part is a manual test:

1. `npm run preview:https`
2. Open the printed HTTPS network URL on the phone, accept the certificate warning.
3. Add to home screen, then load it once so the worker installs.
4. Enable aeroplane mode and launch from the home screen.

One honest caveat: GPS itself works without a network, but with no network assistance
the first fix is slower and often fails indoors. That degrades visibly rather than
silently — the reason is written into the signed record, so the log distinguishes "no
fix available here" from a blank field.

### Printing the card

Either run `npm run card -- --serial=DR-0001` and print `out/reference-card-print.html`,
or open the app and go to **Card → Print**. Both come from the same source, so they
cannot disagree with what the detector expects.

Print at **100% scale** on **matte** white stock — PVC card blanks or heavy matte
paper. Glossy stock produces specular glare, which the app rejects. Verify with a
ruler: 88.9 mm × 54 mm at the trim marks.

**Then check all twelve patches.** Every patch is printed with a grey outline, so
each box must contain a visible tint. An outlined box that looks empty means the
printer did not lay down that tint — reject the card and reprint. This is not
hypothetical: card revision 2 specified the lightest neutral as a 6% tint, which a
dye-sublimation card printer dropped entirely, and with no outline the missing patch
was indistinguishable from bare stock. Revision 3 raised it to a 15% tint and added
the outlines.

---

## How the colour correction works

This is the part that turns a subjective visual judgement into a measurement.

**Detection.** The card carries four black squares at its corners. The app
thresholds the frame (Otsu), labels connected dark components, and filters them by
rotation-invariant second-moment shape descriptors. Four candidates that form a
plausible quadrilateral give a homography mapping card millimetres to image pixels,
so any point on the card can be addressed by its physical position regardless of
how the phone was held.

The top-left marker contains a small white square. Without it, a card held upside
down would still yield four corners in a valid arrangement, every patch would be
sampled from the wrong place, and the result would be confidently wrong. The
asymmetric marker removes that failure mode rather than relying on the operator.

**Sampling.** Each patch is sampled on a grid in *card* space, so a close-up and a
distant capture are weighted identically. Only the central 50% of each patch is
read, which discards print registration error and ink bleed at the edges. All
averaging happens in **linear light** — averaging gamma-encoded values biases every
reading dark by a patch-dependent amount, and that bias would be baked into the
calibration.

**Correction.** Two stages:

1. A planar illumination field `gain(u,v)` is fitted from the neutral patches,
   capturing brightness falloff across the card from side lighting or a shadow. This
   is why the neutral patches are scattered across both rows rather than grouped:
   a plane cannot be fitted from samples that all lie on one line.
2. A 3×4 affine matrix maps field-normalised measurements onto the reference
   values. The additive column absorbs veiling glare and sensor black level, which
   a bare 3×3 matrix has to misattribute to the colour terms.

**Classification.** CIEDE2000 against the panel's reference colours, with two
independent guards. The nearest reference must be close in absolute terms, *and*
must beat the runner-up by a clear margin. Failing either yields `inconclusive`
with a machine-readable reason — never a low-confidence positive.

### Measured performance

Against synthetic captures with exactly known ground truth
(`src/core/color/correction.test.ts`, `src/core/pipeline/analyse.test.ts`):

| Condition | Uncorrected error | Corrected error |
| --- | --- | --- |
| Neutral daylight | small | < 1 ΔE |
| Warm tungsten | large | < 4 ΔE |
| Cool shade | large | < 4 ΔE |
| Sodium-like (strong cast) | **> 15 ΔE** | **< 4 ΔE** |
| Side lighting, 55% falloff | large | < 4 ΔE |

The same physical sample reads within 4 ΔE of itself across all of those
conditions. For reference, 1 ΔE is roughly the threshold of visibility.

---

## Quality gates

A wrong-but-confident reading, signed into an evidentiary record, is worse than no
reading. Every capture must clear these before it is classified. Thresholds were
set from measurements, not guesses.

| Gate | Behaviour |
| --- | --- |
| Focus (Laplacian variance on the rectified card) | Reject below 8 |
| Card coverage | Reject below 6% of frame |
| Overexposure / clipping | Reject |
| Underexposure | Reject |
| Within-patch uniformity (shadow, glare) | Reject |
| Viewing angle | Reject when too oblique |
| **Grey-ramp monotonicity** | Reject on any inversion |
| Correction fit residual | Reject above 9 ΔE worst patch |
| Sample-area uniformity | Reject |
| Colour cast, uneven lighting, nominal calibration | Warn only |

The grey-ramp gate is worth singling out: it is an *independent* check on the
geometry. If the homography were wrong, the grey patches would be read from the
wrong places and stop descending in lightness. It therefore catches classes of
geometric error the detector itself cannot see.

Rejections carry an actionable message ("move out of direct light", not "error 7"),
and a rejected capture is still signed and logged — the log must distinguish "no
test was attempted" from "a test was attempted and could not be read".

---

## Tamper-evidence

### What the record proves

- **Integrity** — every field is covered by an ECDSA P-256 signature over a
  canonical serialisation. Any edit invalidates it.
- **Image binding** — the SHA-256 of the retained image bytes is in the signed
  payload, so the photograph cannot be swapped afterwards.
- **Ordering** — records form a hash chain. Deleting or reordering an entry breaks
  it, which per-record signatures alone would not catch.
- **Device attribution** — the signing key is generated non-extractable, so copying
  the database off the device does not yield a usable key.

### What it does not prove

- **Not that the content is true.** A device-held key attests that this device
  produced this record, not that the GPS fix was genuine. An operator with a rooted
  device and a mock location provider can still produce a validly signed record with
  false coordinates.
- **Not countersigned.** Production hardening would add server-side countersigning
  on sync (so the department's key attests to time of receipt), hardware-backed key
  attestation, and server-side anomaly detection on implausible GPS movement.
- **The PIN is not strong authentication.** It binds an operator identifier to each
  record and gates the app. It is stored salted and hashed, but a PIN has little
  entropy and the signing key is not derived from it.

### Why a hash chain and not a blockchain

The property required is "an entry cannot be altered or removed without detection",
which a signed hash chain provides directly. Distributed consensus solves a
different problem — mutual distrust among many writers — which does not apply to a
single department's evidence log, and would add operational cost with no gain in
evidential strength. This is a deliberate engineering choice, not a shortcut.

### Canonical serialisation

`JSON.stringify` is order-dependent, so two structurally identical records can
serialise differently and one fails verification for no substantive reason. The
canonical form sorts keys, omits `undefined`, and **throws on non-finite numbers**
rather than silently writing `null` the way `JSON.stringify` does — that would let a
record be signed with a measurement quietly replaced by null.

---

## Honesty about the reference data

**The reagent reference colours shipped here are placeholders.** The qualitative
colour associations are well established (Marquis turning purple with opiates,
cobalt thiocyanate turning blue with cocaine, and so on). The *numeric* Lab values
are approximations of those colour names, chosen so the pipeline can be
demonstrated end to end.

Every reference colour carries a `provenance` field (`placeholder` / `literature` /
`lab-verified`), each panel reports the weakest provenance among its outcomes, and
that value propagates into the signed record and onto the result screen. A reviewer
can therefore see whether a result rested on measured data or on a placeholder,
instead of taking a number on trust.

The same applies to the card itself. Patch values are specified as sRGB, and a
printer converting to CMYK will not reproduce them exactly. The app reports its
calibration as `nominal` until the printed card is measured and those values loaded.
`npm run card` emits `calibration-worksheet.csv` for exactly that.

**Known limitation.** Reagent reactions vary in intensity with concentration,
substrate and elapsed time. A faint and a deep version of the same reaction share a
hue but differ in lightness and chroma, so a single reference point per outcome with
a tight accept radius will report some genuine reactions as inconclusive. That is
the safe direction to fail, but the real fix is reference data with several measured
points along each reaction's intensity range — lab work, not a threshold change.

---

## Architecture

```
src/
  core/                      no DOM, no framework, fully unit tested
    math/linalg.ts           solvers, least squares
    color/space.ts           sRGB ↔ linear ↔ XYZ ↔ Lab (D65)
    color/deltaE.ts          CIEDE2000, verified against the 34 Sharma pairs
    color/correction.ts      two-stage illumination + affine colour fit
    card/spec.ts             single source of truth for card geometry
    card/printable.ts        print-ready SVG generated from the spec
    vision/homography.ts     DLT with Hartley normalisation
    vision/detectCard.ts     marker detection, orientation, validation
    vision/image.ts          sampling, rectification, focus, thresholding
    classify/panels.ts       reagent reference data with provenance
    classify/engine.ts       CIEDE2000 matching with refusal guards
    record/canonical.ts      deterministic serialisation
    record/crypto.ts         SHA-256, ECDSA P-256, encoding
    record/record.ts         record schema, signing, verification, chain
    pipeline/analyse.ts      the single entry point
    pipeline/quality.ts      capture gates
  data/                      storage
    recordLog.ts             chain logic + search (storage-agnostic)
    db.ts                    Dexie/IndexedDB adapter
  app/captureService.ts      analysis → signed record → log
  ui/                        React screens
```

The `core` tree has no DOM or framework dependencies and no third-party runtime
libraries. Card detection and colour maths are implemented directly rather than via
OpenCV.js: the whole detector is a few hundred lines against an ~8 MB WASM
dependency that would have to be cached for offline use on a mid-range phone.

### The synthetic card renderer

`src/core/vision/__fixtures__/syntheticCard.ts` renders the card through an
arbitrary homography, under an arbitrary illuminant, with optional gradient,
defocus and sensor noise. Because both the true colour of every point and the exact
distortion applied are known, the pipeline can be asserted to recover the truth —
which is impossible to do rigorously with photographs of a real card, where the
ground truth is only ever approximately known.

This is what makes claims like "recovers the sample colour to within 4 ΔE under a
strong sodium-vapour cast" testable in CI rather than anecdotal.

---

## Demo script

1. **Show the problem.** Photograph the same test result under two very different
   lights. The raw colours are obviously different.
2. **Print the card** from Card → Print.
3. **Capture** under warm indoor light. Show the result, then the *calibrated vs raw*
   swatches on the result screen — the gap between them is the error the card removed.
4. **Capture again** under a completely different light. Same verdict, and the
   calibrated swatch lands in nearly the same place.
5. **Show a refusal.** Deliberately blur or blow out a capture. The app declines with
   a specific instruction, and the refused attempt still appears in the log.
6. **Show the record.** Open it from the log: signature verified, image hash, GPS,
   operator, chain position, canonical payload.
7. **Break it.** Export the JSON, edit one character of the result, re-import — or
   use the tamper tests in `src/core/record/record.test.ts` — and show verification
   failing with a specific reason.
8. **Airplane mode.** Capture offline; the record is signed and queued locally with
   `unsynced` on it.

---

## Test coverage

```
npm test
```

350+ tests. The load-bearing ones:

- **CIEDE2000** verified against all 34 pairs of the Sharma/Wu/Dalal reference
  dataset, which specifically exercise the formula's discontinuities.
- **Homography** exact recovery under strong tilt and at 4000×3000 sensor
  coordinates, with degenerate configurations correctly returning null.
- **Detection** under rotation, perspective, tungsten cast, deep shade, lighting
  gradient, sensor noise, dark and light backgrounds, and background clutter —
  including recovering from a 180° rotation and rejecting a hand-drawn imitation card.
- **Colour recovery** of a held-out sample colour across six illuminants.
- **Card layout invariants** — no patch overlaps a marker; every patch is oblong
  enough that it cannot be mistaken for one; nothing is printed inside the measured
  area; the neutral patches span both axes so the illumination plane is solvable.
- **Classification refusal** — a sweep from negative to positive must pass through
  an inconclusive band, never flip directly.
- **Tamper detection** — edited fields, moved coordinates, altered timestamps,
  substituted images, re-signed records, deleted and reordered chain entries.
- **Concurrency** — eight simultaneous appends produce indices 0–7 with an intact
  chain.

---

## Status and next steps

Working prototype. Complete: capture, calibration, classification, quality gates,
signing, hash chain, offline log, search, export, card generation.

Not built: server-side sync and countersigning (the record carries the sync state
and the queue exists, but there is no backend), hardware-backed key attestation, and
lab-verified reagent reference values — the last of which is the single change that
would most improve real-world accuracy.
