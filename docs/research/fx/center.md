# Center (FL: Fruity Center, legacy)

Real-time DC offset removal (Didier Dambrin, after a code sample by David Billen).
Not in FL's plugin database (`def.hidden`). Editor 170 x 55. No latency.

## Sources
- Form `Fruity Center`: StatusBevel (5,5,160,45), header "STATUS" (59,5,106,16),
  StatusCheckBox = TSwitchSelector (11,14,41,28), Tag 0, 0..1, default 1, captions Off / On.
- flfxhost: one parameter "Status" 0..1 (no value text); `Default.fst` = constructor state.
- Disassembly (FPC, arm64): Eff_Render (VMT slot 7) calls the filter routine through a
  pointer resolved at load time; coefficient set-up on creation and FPD_SetSampleRate;
  FPD_Flush zeroes the state.

## DSP (exact; bit-identical to FL at 44.1 / 48 / 96 kHz)
Per channel, double precision, state starting at 0:

    acc = (x - pos) * k1;  vel += acc;  pos += vel;  vel *= k2;  out = float32(x - pos)

- k1 = float32(4.567e-6 * 44100 / sr), k2 = float32(0.96).
- After each block: any of pos / vel with |v| < float32(2^-24) is set to 0 (FL repeats some
  of these checks; the effect is the same).
- Status Off: the input is copied unchanged and the state is frozen.
- DC step 0.5 at 44.1 kHz: out 0.4999977 (n=0), 0.4956 (100), 0.4471 (1000), 0.1595 (10000),
  0.00322 (44099); at 48 kHz 0.17510 at n=10000.

## Clone notes
- The end-of-block flush also resets non-finite state (FL would stay NaN).
- `tail` = 2.5 s (after a DC input stops, the output is -pos decaying over ~2 s).
- Editor: TSwitchSelector drawn as FL's vertical pill (ball up = On), captions On / Off at
  the right; click the upper / lower half to choose; right-click lists the positions and
  FL's automation items.
