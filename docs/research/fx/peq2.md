# Parametric EQ 2 (FL: Fruity Parametric EQ 2)

Files: `src/model/peq2.ts` (parameters, defaults, the bank response the editor
draws), `src/model/peq2design.ts` (FL's band designs, shared by engine and
editor), `src/engine/effects/ParametricEQ2.ts` (DSP), `src/ui/plugins/ParametricEQ2.tsx`
with `PEQ2*.tsx` / `peq2*.ts` (editor; its curves come from `bankResponse` /
`bandResponse`, so they follow every law below), `tests/peq2.test.ts`.
Behaviour, layout and interaction spec: `docs/research/peq2.md` (its [C: HOST]
entries come from this work).

Sources: FL Studio 2026 (26.1.6) `Fruity Parametric EQ 2_x64.dylib` measured with
the command-line plugin host: value-text sweeps of every parameter, impulse
responses fitted with biquad cascades (equation-error and Levenberg-Marquardt
fits), noise and automation renders compared sample by sample with the clone,
and saved states (SaveRestoreState version 8) to reach the settings that are not
parameters (HQ, LIN, precision, options, band mask). Scripts are in the
scratchpad (`fx/peq2cal/`: `peq.py` host helpers, `cmp.py` + `runpeq2.mjs` FL
versus clone, `val*.py` validations).

## Parameters (36, FL order) and state

| # | FL name | raw range | default | FL value text |
|---|---|---|---|---|
| 0-6 | Band N level | -1800..1800 (0.01 dB) | 0 | `0.0dB`, `-17.9dB` |
| 7-13 | Band N freq | 0..65536 | 10923, 18204, 25486, 32768, 40050, 47332, 54613 | `632Hz` = round(20 * 1000^x) |
| 14-20 | Band N width | 0..65536 | 40124, 25412 x 5, 40124 | `39%` = 100 x, round half even |
| 21-27 | Band N type | 0..7 | 5, 6, 6, 6, 6, 6, 7 | Disabled, Low pass, Band pass, High pass, Notch, Low shelf, Peaking, High shelf |
| 28-34 | Band N order | -3..3 | 0 | Steep 8, Steep 6, Steep 4, 2, Gentle 4, Gentle 6, Gentle 8 |
| 35 | Main level | -1800..1800 | 0 | as the band levels |

Level / main texts are "%.1f" of the single-precision value v * 0.01 with halves
rounded away from zero (3577 of 3601 texts; FL rounds the 24 values x.45 / x.95
between 10.45 and 15.95 dB up as well), no "+", no "-0.0". The frequency, width,
type and order texts match for every raw value. The clone stores level / main in
dB, frequency and width as raw / 65536.

Everything else is state (not automatable): `HQ` int (bit 0 = on, bit 1 = HQ+;
stored 3 = HQ+, 1 = oversampled, 0 / 2 = off), a flags byte (bit 0 LIN, bit 1
Enhanced instead of Legacy when HQ+ is off, then display flags), LIN precision
0..5, LIN mod speed 0..3, band mask (bit k = band k+1 enabled; higher bits have no
effect, so solo is not saved), minimum phase mod speed 0..2 and display options.
The plugin constructor and the factory `Default.fst` give HQ+ on (the default in
the clone; it was Enhanced before). The "...Hz cut", Kick and Quick Low Roll-Off
presets store HQ off.

## Band laws (knob x = raw / 65536)

- Frequency f = 20 * 1000^x Hz at every sample rate.
- Peaking: RBJ bandwidth form, BW = 0.1 + 4.9 x octaves, pre-warped
  (alpha = sin w0 sinh(ln2/2 BW w0 / sin w0)); band pass (0 dB peak) the same
  form with BW * 10^-0.15, notch with BW * 10^0.15.
- Low / high pass: RBJ with Q = (0.1 + 9.9 (1 - x)^3) / sqrt 2 (7.07 at 0 %,
  1.677 at 39 %, 0.0707 at 100 %; no pre-warp).
- Shelves: RBJ slope form, S = (117 - 98 x) / 57 (2.05 at 0 %, 1.0 at the 61 %
  default, 1/3 at 100 %), A = 10^(level / 40).
- Orders, n = 1 + |order| second-order sections at the band frequency:
  - LP / HP: section Qs c_i Q^(1/n). Steep: c = (0.630012, 1.667835),
    (0.551023, 0.858402, 2.097782), (0.505166, 0.805575, 0.880403, 2.757819) for
    Steep 4 / 6 / 8 (measured; not Butterworth). Gentle: n sections of
    2^(-(n-1)/2n) Q^(1/n) (n Butterworth sections at the neutral Q 0.7071).
  - Shelves: gain level / n per section; Gentle keeps S, Steep uses S d_i with
    d = (0.615645, 2.630447), (0.509868, 1.109270, 5.161229),
    (0.552999, 0.694030, 1.514437, 10.319122).
  - Peaking: Gentle = n sections of level / n with the same BW. Steep =
    staggered sections: Steep 4 at f 2^(+-BW/8), BW/2, gain (0.6625 - 0.01 BW)
    level; Steep 6 at f 2^(+-19 BW/120) (BW/3) and f (pi BW/6), gain 0.4884
    level; Steep 8 at f 2^(+-3 BW/40) (pi BW/8) and f 2^(+-31 BW/160) (BW/4),
    gain 0.42889 level.
  - Band pass / notch: Steep = Gentle = n identical sections, BW * sqrt n
    (band pass) or BW / sqrt n (notch).

## Modes

- **HQ off** ("draft"): RBJ cookbook biquads at the host rate in direct form I
  (double precision). Peaking frequencies are held at 0.35 fs (0.4 fs for
  staggered Steep sections), LP / HP / shelves at 0.4995 fs; band pass is
  bypassed at or above Nyquist (FL's notch returns NaN there; the clone bypasses it).
- **HQ+** ("decramped"): one biquad per section whose magnitude matches the
  analog prototype at characteristic frequencies. In the basis p0 = cos^2(w/2),
  p1 = sin^2(w/2), p2 = 4 p0 p1, |H|^2 = (B0 p0 + B1 p1 + B2 p2) / (p0 + A1 p1 +
  A2 p2), solved linearly for each type:
  - peaking: DC, Nyquist, centre value and zero slope, lower half-gain edge
    f 2^(-BW/2) (centre above Nyquist: matched just below Nyquist, prototype unchanged);
  - LP, Q > 1/sqrt 2: value and curvature at DC, Nyquist, resonance peak value
    and position; Q <= 1/sqrt 2: value and curvature at DC, Nyquist, value at
    min(f0, fs/4), first-order numerator;
  - HP: numerator g (1 - z^-1)^2 fixed by the (f / f0)^4 asymptote; peak below
    Nyquist: peak value and position, otherwise Nyquist and min(f0, fs/4);
  - band pass: impulse-invariant poles, zero at DC, unity peak exactly at f0;
    notch: impulse-invariant poles, zeros at f0, unity DC gain;
  - shelves: impulse-invariant poles with the numerator matched at DC,
    min(f0, fs/10) and Nyquist; when Q^2 > 0.6 (overshoot, measured threshold
    0.774597 = sqrt 0.6) and both extrema are below Nyquist: DC and both extrema
    (value and position).
- **HQ Legacy**: 2x with HIIR polyphase half-bands (6 coefficients, transition
  0.1, the set Love Philter and Maximus use) around draft designs at 2 fs.
  Latency 0; a flat instance still filters (the HIIR up/down response).
- **HQ Enhanced**: zero-stuffing, draft designs at 2 fs, then a 176-tap
  decimator h[i] = sinc((i - 88)/2) sin(pi (i + 1)/176) (the window sits one tap
  off the sinc centre) and every other sample. Latency 44 samples at any rate,
  flat gain 0.99984.
- **LIN**: one overlap-save FFT convolution with a K = 256 * 2^precision tap
  kernel, latency 1.5 K = 384 ... 12288 samples at any rate. The kernel is the
  magnitude of the minimum-phase design of the current HQ setting (draft, HQ+,
  or draft at 2 fs for Legacy / Enhanced, without oversampling) converted as
  2^(dB/6) (= |H|^1.003433), sampled on 2K bins, inverse FFT, cut to K taps
  around the centre under a sine window sin(pi j / (K - 1)) (flat gain
  sin(pi K/2 / (K-1)), 0.999981 at precision 0). Parameter changes crossfade the
  outputs of the old and new kernels linearly over 0.1 / 0.25 / 0.01 / 0.02 s for
  stored LIN mod speed 0 / 1 / 2 / 3.

## Processing details

- Parameter changes apply at once (sample-exact; FL's host splits blocks at
  automation points). Direct form I history is kept on level / frequency /
  width changes and cleared on type, order or enable changes.
- A peaking / shelf band at 0 dB passes the signal but keeps its history for
  0.2 s, so returning to a level within that time is seamless; after 0.2 s at
  0 dB the history is dropped (FL resumes from silence). The timer restarts
  when the input resumes after a silence stop.
- Minimum phase mod speed: Off (default) = at once; Smooth = one-pole glide per
  sample of level (dB), frequency and width (knob units) with
  k = 44100 / (192 fs); Medium = 1 - (1 - k)^2; coefficients recomputed every
  sample (per 2x sample in the oversampled modes). Not used in LIN.
- Main level 10^(dB/20) is applied to the input, ramped linearly across each
  processing block by at most 44.1 / s in linear gain (22.05 / s while HQ
  Legacy / Enhanced is selected, LIN included).
- After 0.2 s of digital silence at the input (whole blocks) processing stops
  with all states frozen (the last output of a 512-sample-block render of a
  ringing band is sample 9727); not in LIN mode.
- L and R run the same coefficients with separate states.

## Fidelity (FL render vs clone)

Static settings, noise input, 1-4 random bands per render (all types, orders,
widths, levels -18..18 dB, main level), 12 renders per mode and rate, max |error|
relative to the input peak:

| mode | 44.1 kHz median / worst | 48 kHz | 96 kHz |
|---|---|---|---|
| HQ off | -143 / -123 dB | -137 / -120 | -131 / -111 |
| HQ+ | -137 / -114 | -140 / -113 | -143 / -116 |
| HQ Legacy | -128 / -110 | -131 / -107 | -143 / -129 |
| HQ Enhanced | -134 / -113 | -131 / -122 | -137 / -105 |

Single bands fit FL's biquads to 1e-7 (draft) and match at -115..-170 dB in
every mode, type and order (the worst cases are very low, narrow sections where
FL's float32 output and double-precision rounding differ). Gains of 17 reference
settings (`tests/peq2.test.ts`) agree within 0.002 dB (0.01 dB below -40 dB).

Automation (noise, change at 0.2 s, error re input peak after the change):
level / frequency / type / order changes -138..-145 dB (draft and HQ+), Legacy
and Enhanced changes -133..-139 dB, 0 dB -> 12 dB -145 dB, main level ramps
-92..-97 dB (FL accumulates its ramp in float32), Minimum phase mod speed
Medium / Smooth -94..-99 dB (draft, HQ+) and -75 dB (Legacy).

LIN: -78..-101 dB re output peak for typical settings at precision 0-3 (the
2^(dB/6) magnitude leaves a +-0.001 dB ripple against FL), crossfades on
automation at the static floor.

Value texts: frequency (65537), width (65537), type and order exact; level and
main level 3577 of 3601.

## Approximations and open points

- HQ+ high pass whose resonance lies above Nyquist (resonant BW with f0 above
  about 12-20 kHz): FL's third matching condition is not identified (no
  interior match, Nyquist value equals the analog one); the clone uses its
  no-resonance design: -13..-21 dB re output for those settings.
- HQ+ shelves with Q^2 > 0.6 whose upper overshoot extremum lies above Nyquist
  (high f0 with BW below about 55 %): not identified either; the clone falls back
  to the impulse-invariant design (about -34 dB).
- LIN: narrow bands at low precision and bands below about 50 Hz at precision
  4-5 deviate (-15..-60 dB re output); FL's magnitude evaluation there is not
  identified (probably single precision near DC). FL outputs exact zeros when the
  total LIN response is nearly zero (about 1e-6 in the clone). Changes that
  arrive during a LIN crossfade were not measured (the clone continues from the
  current mix, which is linear in the kernel).
- HQ+ band pass at extreme settings (20-50 Hz, BW near 0 %): FL's own
  coefficients are numerically noisy; the clone uses the exact (well-conditioned)
  solution: -45..-75 dB.
- Sample rates below 40 kHz: HQ off is measured (limits above); HQ+ is not (the
  clone holds f0 below Nyquist).
- Smoothing in the oversampled modes runs per 2x sample (-75 dB vs FL).
- Not measurable with the host: solo's audio effect (UI state), display options
  and the editor's drawing rules.
