# Delay Bank (FL: Fruity Delay Bank)

Sources: FL's form (580 x 280), manual and factory presets, and FL Studio 2026's own
`Fruity Delay Bank_x64.dylib` measured with `flfxhost` (info / sweeps, `--state` blobs,
renders with `--at`, 44.1 / 48 kHz, oversampling). Files: `src/model/fx/plugins/delaybank.ts`,
`src/engine/effects/plugins/delaybank.ts`, `src/ui/plugins/fx/delaybank/`, `tests/fx/delaybank.test.ts`.

## Parameters and state

131 automatable parameters: 0 Dry, 1 Wet, 2 Input, 3 Feedback (0..128), then per unit
u = 0..7 at index 4 + 16u: input pan (-128..128), input volume (-160..160), input filter
cutoff / resonance (0..65536) / gain (0..256), feedback pan, feedback volume (-128..128),
separation (-128..128), time (0..7680), offset (-512..512), feedback filter cutoff / res /
gain, output pan, output volume, to next (not for unit 8). Keys: `dry wet input feedback`,
`u1InPan ... u8OutVol`.

The rest is plugin state (SaveRestoreState, version 16; version < 16 stores time / 10):
133 ints (the parameters, then the solo unit, -1 = none, and oversampling) and per unit
filter type / slope (input, feedback), post, feedback mode (0 off, 1 normal, 2 inverted,
3 ping-pong), grain division (0..16) and shape (-128..128), enable, leave first echo,
tempo-based time. Stored here as `units[8]`, `solo`, `oversample` (+ `tab`, editor only).
Defaults = FL's Default preset (unit 1 enabled, filters off, gain wheels 0, normal mode,
tempo on). The 21 factory presets were decoded from the states FL produces for them.

Texts (0 mismatches against full sweeps): percents round half away from zero, pans round
half to even ("62% left", "Centered"); gain = A x 100%; time = trunc(raw / 10) ticks of
1/48 step as `S:TT`; offset `15.3ms left`.

## Mappings (measured)

- Volumes (unit in / out / to next, global dry / wet / input): sign(v)(11^(|v|/128) - 1)/10.
  Feedback volume and the global feedback are linear (raw / 128).
- Time: raw / 1920 beats at the song tempo (fixed 120 BPM with tempo off),
  D = max(1, round-half-even(T sr)).
- Offset: (1001^(|v|/512) - 1)/2 ms, a pre-delay of the left (negative) or right input.
- Pan law (input, feedback, output): theta = |p| pi/4, the far side x (cos - sin), the near
  side gets 1/2(cos + sin - cos 2theta) of the far input plus 1/2(cos + sin + cos 2theta).
- Separation: s < 0: a = 1 - s^2/4, b = s/2 + s^2/4; s > 0: b = (5^s - 1)/8, a = 1 - b;
  L' = aL + bR, R' = bL + aR.
- Feedback pan after separation (FL quirk, exact): far side k0 x separated; near side
  K x separated + q (far - near of the unseparated signal), q = min(k1 (a + b), K (a - b)/2),
  k0 = cos - sin, k1 = 1/2(cos + sin - cos 2theta), K = cos + sin.
- Filters: RBJ biquads, direct form I (coefficients switch at once). Types OFF, LP, BP,
  NOT, HP, LS, PK, HS. LP fc = 132.3 + 43967.7 (1501^x - 1)/1500, others
  4.4079 + 26455.59 (1501^x - 1)/1500 (x = wheel / 65536), clamped to 20 kHz, absolute Hz.
  LP / HP Q = 0.1 + 49.9 (2001^x - 1)/2000; BP / notch bandwidth 0.02892 + 34.5951
  (101^x - 1)/100 octaves; PK Q = 0.1 + 99.9 (2001^(1-x) - 1)/2000; shelf S = 0.1 + 0.45
  (3^(1-x) - 1). Gain (shelves and peak only): A = 0.1 + 8.1((10/9)^(v/128) - 1) up to 128,
  1 + 9((10/9)^((v-128)/128) - 1) above; RBJ A = A (shelf / peak gain A^2).
  Dual / triple slopes = 2 / 3 identical stages with Q^(1/n) (LP / HP), bandwidth x n (BP),
  bandwidth / n (notch), A^(1/n) (shelves / peak).
- Grain: one grain = the exact (unrounded) echo time / division; grain k starts at sample
  round(k G) counted from the plugin start, a Hann window over about G - 1.5 samples, bent by
  the shape: (N^h - 1)/(N - 1), N = 10000^(-shape/128).

## Structure

```
x * In -> unit 1 .. 8 in order:
  input pan/vol (+ previous unit's "to next", which skips this unit's input pan/vol)
  -> input filter (pre) -> offset pre-delay -> lines (per input side, D samples)
     feedback: line out -> fb filter -> sep + pan -> x fb vol x FB -> (ping-pong: swap) -> lines
  -> output = processed echo (or the raw line output: "leave first echo"; inverted swaps sides)
  -> x grain envelope -> input filter (post) -> to next (x volume curve, before the output
     pan / vol) -> output pan / vol -> sum
out = dry x + wet x sum
```

- Feedback mode off: the unit passes its input (filter, grain and output still apply; no
  offset, no feedback section).
- Disabled units do nothing (and pass nothing on). Solo (right-click on an enable LED) mutes
  the other units' outputs; they still run and feed the next unit.
- Smoothing: input / feedback / output matrices, global In and Wet head for their targets
  linearly across each processing block, at most 0.001 x 44100 / rate per sample. Dry and
  "to next" switch at once. Filters switch at once.
- A change of a delay length (time, tempo) or offset re-creates the lines: the next echoes
  start from silence (O(1) here).
- OVERSAMPLE: the whole plugin, dry included, runs at 2x between HIIR-style polyphase IIR
  half-band up / down samplers with 6 allpass coefficients (transition 0.1):
  0.0391516, 0.1473771, 0.3026468, 0.4824685, 0.6746159, 0.8830050. The dry path becomes an
  allpass; delays are rounded at the 2x rate.

## Fidelity (vs FL renders, error / reference)

Static settings, chains, modes, offsets, filters (all types and slopes), 48 kHz, OS:
-105 to -148 dB, several bit-exact. Factory presets: Crowded -105, Something -119, Funky
tin roof -117, 6 voice choir -127, Clearer echoes (OS) -135, Big res -75, Ringy modder -44
(grain). Ramps -113 to -147 dB; filter / to-next changes -134 to -144 dB.

Deviations: FL's grain envelope steps through a table with irregular stalls (sample-level
differences, -44 to -77 dB on grain cases). FL processes the delay in segments that end where
its circular buffers wrap and restarts its parameter ramps there; we ramp per host block,
so a ramp that crosses a wrap differs briefly (-40 dB during that ramp). Runaway feedback
(loop gain above 1 through resonant / boosting feedback filters) grows without bound in FL;
here the lines are limited to +-8. Lines are allocated for tempos down to 30 BPM (or the
song tempo when slower); longer times are clamped until the next parameter change.
The editor follows the form's geometry with the look of FL's manual screenshot.
