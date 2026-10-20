# BeepMap (FL: BeepMap)

"An image synth" by Didier Dambrin (Plugin database > Generators > Synth special): a vertical
line scans a bitmap from left to right, every pixel row is a sine, the pixel's red byte is the
amplitude of that sine on the left channel, green on the right (yellow = both), the row's height
sets its frequency and, optionally, blue sets the frequency range per pixel. FL's former
"hybrid" generator: its INS tab is the channel's INS settings here (`ins: true`, like 3x Osc).

Sources: FL Studio 2026's `Plugins/Fruity/Generators/BeepMap/BeepMap_x64.dylib` (FPC, arm64
slice, class `TTestPlug`, VMT 0x2058d8; read with the RE tools in `.flref/special/tools`: Dispatcher
0x5d9a0, SaveRestoreState 0x5df70, ProcessParam 0x5e3c0, TriggerVoice 0x5eae0, Voice_Release
0x5ec30, Voice_Kill 0x5ec50, the row speeds 0x5ed30, the column setup 0x5f150, Voice_Render
0x5f4b0, the bitmap load 0x5f780, Gen_Render 0x5fe30, the sine kernels 0x60080 / 0x60160 /
0x60230, FPC's Random 0x16e40 / 0x16d30, the channel-sampler voice engine linked into the plugin
0x1c1000 - 0x1cc000), the editor form (`SynthEditorForm`), the 7 factory presets
(`Plugin presets/Generators/BeepMap/*.fst`), the plugin database's `BeepMap.fst`, FL's editor
thumbnail, the online manual and renders of FL's real plugin through the test host
(`flfxhost render BeepMap`, `--no-newtick`, `--fixed-time 1700000000`: BeepMap draws its sines'
start phases from FPC's Random, reseeded from the clock). The port is FL's code in FL's
arithmetic and reproduces its output **bit for bit** (see Fidelity).

## Parameters (form SynthPanel 380 x 170)

| # | Name | Range | Default | FL value text |
|---|---|---|---|---|
| 0 | Freq range (FREQ wheel) | 24..9600 | 7200 | `round half up (v x 100 / 9600)%` (swept over all 9577 values) |
| 1 | Pixel duration (LENGTH wheel) | 0..4096 | 2048 | `round half up (v x 100 / 4096)%` (all 4097 values) |
| 2 | Type of frequency scale | 0..2 | 0 | `Log`, `Linear`, `Harmonics` |
| 3 | Enable blue color (Use Blue) | 0..1 | 0 | `off` / `on` |
| 4 | Switch smooth / grainy mode (Grainy) | 0..1 | 0 | `off` / `on` |
| 5 | Repeat sound (Loop) | 0..1 | 1 | `off` / `on` |
| 6 | Widen (stereo) | 0..1 | 1 | `off` / `on` |

Parameters 7..105 of FL's list (`flfxhost info BeepMap`) are the INS block (the channel's
envelopes / LFOs / filter: "Panning envelope - ...", "Filter type"...): the channel's INS tab
here. Not a parameter: the **Max bitmap height** wheel (`HeightSelect`, 3..999, default 23), kept
in the state (`maxH`): the number of sines per voice a loaded bitmap may have.

## State and presets

State format (SaveRestoreState 0x5df70): `int32 version` (0 or 1), then 15 integers: the 7
parameters in order, 7 reserved (read, never used), Max bitmap height; version 1 adds the
91-integer INS block (364 bytes); then `int32 n` and the bitmap, a BMP file of n bytes (FL writes
32 bits; the loader takes any BMP). Version > 1 is ignored.

- **Fresh instance** (what FL adds, `Plugin database/Generators/Synth special/BeepMap.fst`):
  7200, 2048, Log, blue off, grainy off, loop **on**, widen **on**, height 23, a 300 x 23 bitmap
  (the constructor loads `Images/Default.bmp`). The parameters' defaults are the form's.
- **Factory presets**: Ambiance, Bleep, Climbing, Default, Liquid, Voice, Warp (version 0 files:
  Widen **off** in every one: their widen integer is 0). Values are in `src/model/gen/plugins/
  beepmap.ts`; every preset's bitmap is FL content and is not shipped (bitmaps 127 x 54, 300 x 23,
  128 x 54, 300 x 23, 128 x 54, 741 x 40, 128 x 54; the Images folder also holds `Rippled.bmp`,
  300 x 144, used by no preset). 7 channel presets (Channel presets/BeepMap: Beepcoder, duda1..6)
  are out of scope.
- **Bitmap content** (policy): by default every instance plays an original **stand-in picture**
  drawn by code (`beepmap/image.ts`: a bright band that climbs and falls, a red glide rising, a
  green glide falling, a drone row, a little blue; 300 x 23). The plugin window menu has
  **Import FL content...** (files or a folder): the `.fst` named like the current preset (its exact
  bitmap and Max bitmap height; for a new instance `BeepMap.fst`, then `Default`), else the BMP
  named like it (resampled), else a single picked file; FL's bytes only ever go into the user's
  own project.
- **Where the bitmap lives**: in the instrument's state, key `bmp` = `"<w>x<h>:<base64>"` (3 bytes
  per pixel, top row first; '' = the stand-in), not as a pool sample: the pool decodes user
  samples with the session's audio context, which may resample (a 44.1 kHz float WAV decoded at
  48 kHz no longer holds exact pixel values), a picture is only tens of kilobytes (FL stores it in
  the project too) and it then travels with channel copies, undo and project files. The engine
  decodes it once per change of the text (a new bitmap kills the voices, as FL does).

## Bitmap loading in FL (0x5f780)

A picture is refused when it has fewer than 3 rows (FL keeps the old bitmap). It is converted to
32 bits; when taller than the Max bitmap height it is resampled to that height (width kept) by
`ippiResize_8u_C4R` with interpolation mode 4. In FL 2026 for macOS FL's IPP-compatible library
forwards that to **Apple's `vImageScale_ARGB8888`** (flags EdgeExtend | DoNotTile). Probed with the
test host (`--load-file`, crafted states with one bright row on a baseline: the operator matrix of
48 -> 23, 128 -> 40, 100 -> 23, 24 -> 23, 54 -> 30, 40 -> 23 rows, and 40 random pictures): a
**Lanczos-3 kernel stretched by the reduction factor s, centres aligned, taps beyond the edges
folded onto the edge pixels, weights normalised, result rounded to 8 bits**, with the output
position quantised to 1 / P of a source row (floor): P = 64 for s <= 2, 32 for s <= 4, 16 for
s <= 8, 8 above (an empirical model of Apple's closed code: it reproduces most sizes to the
rounding, mean difference 0.005 / 255; some ratios, e.g. exactly 5 or 4.5, keep ~0.4 / 255). Our
`resizeRows` (`beepmap/resize.ts`) is that model in double precision. Resampling FL's own
`Images/*.bmp` with it gives 98.1 % identical bytes against the host's loader (mean difference
<= 0.1 / 255, largest 4: Default 24 -> 23 98.5 %, Voice 128 -> 40 92.8 %, Rippled 144 -> 23 /
64 / 100 99.4 / 99.5 / 99.5 %, Warp 54 -> 30 98.8 %, Ambiance 99.9 %). FL's factory `.fst`
bitmaps differ from FL 2026's own load of the same `Images` files (mean 14 / 255 on Default): they
were saved earlier by another build; importing the `.fst` gives the preset's exact sound.
Rows = the bitmap's height after that; the amplitude scale is `f32(1 / (255 sqrt(rows)))`. FL has
no width limit that we found; Orchard accepts up to 8192 columns, 999 rows and 2 million pixels
(8 MB of text in the state; larger pictures are box-averaged / resampled).

## DSP (exact)

All in FL's arithmetic (FPC: single precision where the code converts, double sums in the
kernels, no fused multiply-add).

**Plugin fields** (ProcessParam 0x5e3c0): parameters 0..6 at +0x130; pixel duration: `p = 64 +
rint(f32(f32(exp(f32(v / 4096) x 3.4965075614664802) - 1) x 256))` samples at 44.1 kHz,
`length = max(1, trunc(rate x p / 44100))`, reciprocal `f32(1 / length)`; a FREQ change resets
every voice's pitch cache (the speeds are recomputed in the next block). `exp` is the C library's:
checked identical to V8's for all 4097 lengths, all pitches (-14400..12000 cents) and all
Harmonics limits.

**TriggerVoice** (0x5eae0): one record per bitmap row, phase `Random(2^24) << 8` (left channel)
and, with Widen, a second `Random(2^24) << 8` (the right channel's offset; 0 without), amplitudes
0, pixel counter -1, positions 0, pitch cache = INT_MAX, grain phase 0. FPC's Random (MT19937,
`Random(l) = (l x genrand) >> 32`) is one stream per process seeded with the clock at load: the
port keeps one stream per engine from a fixed seed (`seedBeepMapRandom(1700000000)` = the host's
`--fixed-time`).

**Voice_Render** (0x5f4b0), per call of `n` frames (zeroed buffer):
- pitch = rint(FinalLevels.Pitch) (cents re C5, half to even); if it differs from the cache, the
  rows' speeds are recomputed (0x5ed30);
- loop over the call: at a pixel boundary (position == next boundary; the first at position 0)
  `next += length`, `column += 1` and the column setup runs; then one chunk to the earlier of the
  call's end and the boundary: row 0 is **written** by the sine kernel, rows 1.. **added** when
  their active flag is set (a silent row only advances its phase by `n x speed`), then Grainy
  multiplies the chunk by a sine of one cycle per pixel (a 32-bit phase advancing
  `floor(2^32 / length)` per sample, started at 0 per voice);
- returns `width < column`: the voice is finished.

**Column setup** (0x5f150): past the last column (`width <= column`) Loop resets the column to 0,
otherwise no row has a pixel (the targets are 0: the sound fades out over one more pixel, and
the voice finishes at the end of the call in which the column passes `width`). For every row:
the amplitude is flushed to 0 when below 2^-24; target L = `f32(red) x scale`, target R =
`f32(green) x scale`; with Use Blue the row's blue scale is `256 - blue byte` (256 otherwise);
then the speeds (0x5ed30) are recomputed (they depend on the blue scale); then for Harmonics a row
whose frequency exceeds the limit `rint(f32(exp(f32(FREQ / 9600) x 2.3978952727983707) - 1) x
1102.5)` Hz is faded (targets x `max(0, 1 - (hz - limit) / 480)`); the slopes are
`(target - amplitude) x f32(1 / length)` per sample (single precision), the row's active flag =
any of amplitude / target non-zero. The amplitudes thus glide linearly over each pixel from the
previous pixel's values.

**Row speeds** (0x5ed30), n rows, `n1 = n - 1`, `w = n1 x 512`, `k = ln 2 / 12 / 100`, e8 =
`f32(2^32 x 523.2511306 / rate)`:
- **Log**: pitch_i = clamp(pitch - trunc(blue_i x FREQ x (2 i - n1) / w), -4800, 4800) cents,
  speed = `round(e8 x exp(pitch_i x k))` (low 32 bits, half to even): the picture spans FREQ
  cents (default 7200 = +-3 octaves) around the note, the top row highest;
- **Linear**: f0 = min(rint(523.2511306 e^(pitch k)), rate / 4); the limit L = rate / 4 rounded
  down to a multiple of f0; hz_i = f0 - trunc(blue_i x trunc(1.5 FREQ) x (2 i - n1) / w), clamped
  to 40 Hz .. L, speed = `floor(hz x 2^32 / rate)`;
- **Harmonics**: f0 as above for the pitch two octaves down (pitch - 2400); hz_i = (9 - trunc(blue_i
  / 32)) x f0 x (n - i) (row n - 1 is the fundamental, the top row the highest harmonic), same
  clamp and speed; FREQ only sets the fade-out limit.

**Sine kernels** (0x60160 write, 0x60080 add): per sample the left value is `tab[phase >> 18]`
x amplitude, the right `tab[(phase + offset) >> 18]` x amplitude (the sum is **not wrapped**: a
random offset puts about half of the right channel's reads past the 16384-point table into
the one that follows it in FL's memory, the triangle: FL's host wavetables are 0x10000 bytes
apart; the test host's own allocation happens to be contiguous too, so the port reproduces it:
`TAB` = sine ++ triangle), accumulated in double (`out + tab x amp`), stored in single; the
amplitudes advance by the slopes in double and are stored back in single at the end of each call.

**Voice engine** (the channel-sampler code linked into the plugin, as 3x Osc's:
docs/research/gen/3xosc.md): the buffer is scaled by FL's pan law of FinalLevels.Pan / Vol, ramped
from block to block (at most 0.001 per sample, even / odd accumulators), no ramp at the voice's
start; a note off starts the 441-sample cosine fade (10 ms built at 44.1 kHz) and ends the voice
with it. `levels: 'plugin'`.

## Our implementation

`src/engine/gen/plugins/beepmap.ts` (+ `beepmap/rng.ts`; the wavetables and the fade come from
`3xosc/tables.ts`), `src/model/gen/plugins/beepmap.ts` (+ `beepmap/image.ts` bitmap value type,
text form and stand-in, `bmp.ts` the defensive BMP reader, `flstate.ts` the FL state / .fst
reader, `resize.ts`), `src/ui/plugins/gen/beepmap/` (editor, loading). Like the 3x Osc port an FL
render block is the channel's audio block (a voice's first block ends with the current block),
rendered when it starts and served to the channel's 16-frame steps; a sequenced note's release
ends a block (`GenVoiceParams.length`: FL splits blocks at note offs); parameter, pitch and level
changes take effect per block as in FL. `setBlockLength(n)` and `setBitmap(b)` are test hooks
(the host's block structure; a bitmap without the state). Up to 128 voices; a voice's rows are
allocated when first needed. Cost: 0.01 ms per 128-frame block and voice at 23 rows, 0.26 ms at
999 rows.

## Fidelity (FL 2026 vs ours, test host renders, 44.1 kHz unless noted)

Bit-exact (every sample, both channels; `tests/gen/beepmap.test.ts` pins 12 cases of the stand-in
picture from FL's output): all 7 factory presets with their FL bitmaps; the constructor state
(Widen on: the table overrun); keys 0 / 24 / 36 / 84 / 96 / 100 / 131, velocity 64 / 80 / 128,
note pan, fine pitch; blocks of 1 / 16 / 64 / 77 / 128 / 212 / 512 / 1000; 8 / 11.025 / 22.05 / 48 /
96 / 192 kHz; pixel duration 0 and 4096, FREQ 24 and 9600; Log / Linear / Harmonics, each with
Use Blue; Grainy on and off, also toggled mid-note; Loop off (the voice ends by itself) and
toggled mid-note; parameter automation (FREQ, LENGTH, scale, blue, grainy, loop at odd samples);
pitch glides (up to +-1200 cents), channel pitch steps and ramps, channel pan steps; chords and
8 overlapping notes with voices ending, note offs at odd samples, notes of 1 / 16 / 17 / 129
samples; bitmaps from 3 x 3 to 300 rows tall and 2000 columns wide (random noise, white, red,
blue-only); 40 s notes. Through the real `GenChannel` (128-frame blocks): bit-exact (the first
tests/gen case and Default / Ambiance presets), 1.8e-7 for a velocity-64 note (FL computes
InitLevels.Vol in single precision, src/engine/gen/levels.ts in double: shared). Channel volume
steps / ramps through the driver: -147 / -121 dB (the same level maths).

Import end to end (the editor's own code on FL's real files, then our engine): importing the 7
factory `.fst` files and playing them reproduces the host's `--preset` renders **bit for bit**
(bitmap, Max bitmap height and parameters). Loading the same presets' bitmaps from the `Images`
BMPs instead (resampled by our model, only Default 24 -> 23 and Voice 128 -> 40 rows need it):
-57 dB (Default) and -56 dB (Voice) rms against FL's own load. A picture that uses Use Blue is far
more sensitive to resampling noise (blue = frequency range: a 1 / 255 change near 255 doubles a
row's range), which is why the `.fst` is preferred.

Differences:
- FL's own output depends on its block structure at the single-precision level (blocks of 128
  against 512 against FL's tick-split blocks: -132 dB re peak): the amplitude state is rounded to
  single precision at the end of every Voice_Render call. Ours is exact for the host's block
  structure and ~-132 dB from FL's real-time structure.
- A tall picture's resampling (an empirical model of Apple's vImageScale in double precision): see above.
- Polyphony limit: the channel's 10 ms declick; FL's plugin (FPE_MaxPoly, stored at +0xe4,
  TriggerVoice 0x5ffd0) releases the oldest voice that is not yet released instead (441-sample
  fade). DefPoly is 4.
- Not host-testable: the INS tab (envelopes, LFOs, filter: FHD_90 is not emulated; the channel's
  code, as for every hybrid), `Voice_Render` used by FL's former sampler path (FL 2026 plays
  BeepMap through Gen_Render).

## Editor

FL's form at its coordinates (SynthPanel 380 x 170): FREQ (7,15) and LENGTH (59,15) wheels (40 x 40,
dark discs in a thin ring with a blue value arc), the scale combo (117,22; 98 x 28), the Use Blue /
Grainy / Loop / Widen lamps (228,23 / 301,23 / 228,41 / 301,41), the FREQ / LENGTH / SCALE captions,
the OPEN / preset list / COPY / PASTE strip (6,85), the BEEP · MAP title, the Max bitmap height
wheel (336,89; dark red) and the bitmap panel (6,124; 368 x 40). Panel gradient, wheel and lamp
colours sampled from FL's database thumbnail; original drawing. OPEN loads a picture (file
picker; BMP by our reader, PNG / JPEG / GIF / WebP by the browser), COPY puts the bitmap on the
clipboard as a PNG, PASTE takes a picture from it, a picture (or `.fst`) dropped on the panel is
loaded, the list button and the window menu hold Open / Copy / Paste / Stand-in bitmap /
Import FL content. Every load is one undo step and follows FL's rules (at least 3 rows, at most
Max bitmap height rows).
