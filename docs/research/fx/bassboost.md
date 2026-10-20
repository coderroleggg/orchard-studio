# Bass Boost (FL: Fruity Bass Boost, legacy)

"Just a fancy bass knob" (Didier Dambrin). Not in FL's plugin database (`def.hidden`).
Editor 335 x 55. No latency; tail 0.25 s in the clone.

## Sources
- Form: FrequencyBevel (5,5) / AmountBevel (170,5); FrequencyWheel (7,8) Tag 0 and
  AmountWheel (172,8) Tag 1, 0..1024, defaults 512 / 768; headers "FREQ" / "AMOUNT";
  FreqValueLabel (60,31,102,14); AmountSlider TVectorSlider (221,34,108,14), Tag -1, no
  OnChange (a read-only bar set from the amount).
- flfxhost: no value texts; `Default.fst` = constructor state (512 / 768).
- Disassembly: ProcessParam -> coefficient routine; Eff_Render -> a hand-written kernel
  (arm64 at 0x214c of the thin slice). libm stubs resolved with `otool -Iv` (cos, exp).

## Parameters (exact)
- x = float32(v / 1024).
- Frequency f = Round(float32(float32(x*80) + 20)) Hz, banker's rounding (20..100; 512 = 60,
  32 = 22, 96 = 28). Label `"%d Hz"`.
- Amount gain amt = float32(exp(x * ln 11) - 1) * 0.5 (0..5; 768 -> 2.52005).
- Amount hint text: Round(float32(x*19)) "|" characters (FL's own bar string); the editor
  shows the slider instead.

## DSP (exact; bit-identical to FL, impulse and noise renders at 44.1 / 48 kHz)
Coefficients (sr = the host's integer sample rate):

    c = float32(cos(2*pi*f / sr))
    A = float32(2 - float32(2c))
    t = float32(c - 1);  h = float32(0.5 t)
    B = float32((sqrt2 * sqrt(-(t*(t*t))) + h) / h)        (= 1 - 2 sqrt2 sqrt(1 - c))

Per channel, double precision, state from 0:

    vel += (x - pos) * A;  pos += vel;  vel *= B;  out = float32(pos * amt + x)

(FL uses a fused multiply-add for the output; the clone's two roundings agree in practice.)
A resonant low-pass with unity DC gain added to the input: a low shelf of 1 + amt with a
shallow dip an octave above f. Default response (44.1 kHz): +9.90 dB at 20 Hz, +7.33 at 40,
+4.18 at 60, +1.29 at 80, -1.76 at 120, -1.09 at 250, -0.08 at 1 kHz.

FL recomputes the frequency coefficients only when the Frequency parameter is set (not on
FPD_SetSampleRate); the clone computes them for its sample rate. No smoothing anywhere.

## Clone notes
- End-of-block guard resets denormal / non-finite state (FL has none).
- Editor: legacy look (shared `mute2/legacy.tsx`), pink scheme; the amount bar is display
  only, as in FL (frame #353b40, track #41484c, fill #ffd4d8, 1 device px frame at 1.5x).
