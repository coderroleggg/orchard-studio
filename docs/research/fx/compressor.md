# Compressor (FL: Fruity Compressor)

Files: `src/model/fx/plugins/compressor.ts`, `src/engine/effects/plugins/compressor.ts`,
`src/ui/plugins/fx/compressor.tsx` (widgets shared from `fx/limiter/widgets.tsx`),
`tests/fx/compressor.test.ts`.

Source of truth: FL Studio 2026's `Fruity Compressor_x64.dylib` (Ultrafunk
design). Parameter texts came from `flfxhost info/sweep`; the DSP was read from
the plugin's arm64 code (parameter-update routine at 0x5c090, process routine
right after it, constants at 0x192d40..0x192dc8, knee table [0, 6, 7, 15] in
__data) and then verified against host renders: max error 2e-6 .. 3e-5 (FL
computes in float32) for all eight types, the built-in limiter, expansion and
the sidechain path (sidechain checked with a private host build that serves an
input buffer).

## Parameters

| # | key | FL name | range / default | text |
|---|---|---|---|---|
| 0 | thr | Threshold | -600..0 / 0 | v/10 dB: `-8.4 dB` |
| 1 | ratio | Ratio | 4..300 / 10 | `3.2 : 1` (0.4:1 expands) |
| 2 | gain | Gain | -300..300 / 0 | `3.4 dB` |
| 3 | att | Attack | 0..4000 / 150 | `10.8 ms` (v/10) |
| 4 | rel | Release | 1..4000 / 200 | `117 ms` |
| 5 | type | Type | 0..7 / 0 | Hard, Medium, Vintage, Soft, Hard/R, Medium/R, Vintage/R, Soft/R |

State blob: version 3, the six values, "Report latency" (1) and the sidechain
input (0/-1 none). Our state: `sidechain`, `reportLatency`. 20 factory presets
(External/…, Internal/…) read with `info --preset`.

## DSP (per sample; coef(T ms) = 0.1^(1/(T·sr/1000)))

1. +1e-30 on each input; DC blocker: ap = a(x - ap₋₁) + x₋₁, x' = (x - ap)/2,
   a = (tan(3π/sr) - 1)/(tan(3π/sr) + 1) (3 Hz). The sidechain is not DC-blocked.
2. Detector: max(|L|,|R|) of the blocked input (or |sidechain|) + 1e-30; peak
   follower attack coef(0.01), release coef(1); lv = ln(env).
3. Gain computer (nepers): lnT = ln(10^(thr/200)), knee K = 0/6/7/15 dB:
   lb = lnT - K·ln10/20, ub = lnT + K·ln10/20, slope = 1/R - 1.
   lv < lb: 1; lv ≥ ub: exp((lv - lnT)·slope); else exp(slope·(lv - lb)²/(2(ub - lb))).
   **Vintage**: u = lnT + 1.25·R^¼, g_end = exp((u - lnT)·slope); ub' = u + 7 dB;
   slope' = ln(g_end)/(ub' - lnT); x = (lv - lb)/(ub' - lb);
   y = x + (x²(3 - 2x) - x)·min(1, lnT - lb); gain = exp((ub' - lnT)·slope'·y),
   g_end above ub' (the ratio fades back to 1:1; max reduction (1-1/R)·1.25·R^¼ nepers).
4. Smoothing: target below g -> g += coef(att/10)·…; above -> release coef of the
   previous sample. TCR: follower f = g + (f - g)·coef(rel), f ≥ g; d = f - g
   (Vintage: d = (0.707 - g)·1.414); release coef = max(0, rN + (rF - rN)·d),
   rF = coef(rel/10) for /R types (= rN otherwise). The Vintage/R formula makes the
   coefficient reach 1 near -2.1 dB, so the gain stays there (FL does the same).
5. Makeup gain 10^(gain/200).
6. Look-ahead limiter (64 samples at any rate, reported as latency): when
   max(|L|,|R|) > 1, required gain 0.9885531/peak; a stricter target schedules a
   smoothstep ramp from the applied gain over 64 samples into a 128-entry gain
   ring (min-merged; the ring is flattened first unless a hold is running), sets a
   64-sample hold and resets the release speed; without hold the target moves
   toward 1 (or the required gain) by `speed`, speed += (0.09 - speed)·5e-5 per
   sample. Each sample reads the ring, writes the target back and outputs the
   64-sample-delayed signal times the read gain.

FL re-runs the update (coefficients, limiter target = 1, hold = 0, speed = 0.01,
TCR follower = 1) whenever a parameter changes; we do it when a value changes,
at the next block. The makeup gain steps there too (heard 64 samples later
through the look-ahead), as in FL. Departure (finite output): NaN / inf input -> 0.

Parameter changes vs FL (flfxhost `--at`, noise): makeup, threshold, ratio,
attack, release and type steps -104..-121 dB in the 512 samples after each
change (float32 vs double, the static floor); before this pass the 256-sample
makeup ramp gave -10 dB after a makeup change (-25..-46 dB overall).

## Editor

500 x 105: six bevels (#4b5356) with header strips (#545e64, #bdcdd4 caps) and
pink value texts (#ffd0ff), 40 px pink wheels (FL's knob with a lit facet),
sidechain spinner (right-click lists routed tracks, shows the source track),
▶ options button and window menu with "Report latency".

## Open questions

- Sample-rate quirks are kept as in FL: the limiter look-ahead (64) and its
  release speed constants are per sample, so they scale with the rate.
- FL's sidechain list: we expose every routed track, in source order.
