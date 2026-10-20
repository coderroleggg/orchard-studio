# Wave Traveller (FL: Wave Traveller)

FL's Wave Traveller scratches a sample under spline control: every key has a patch whose WAVE spline moves
the play position over the loaded sample (time on the x axis, position inside the START..END region on the
y axis), a VOL spline and a list of mutes shape the volume, SPEED sets the phrase length (tempo based, in
beats) or an absolute speed factor, ATT / REL fade the voice in and out. Category Sampler, `notes: 'voices'`,
`levels: 'plugin'` (the plugin pans and scales with the voice's FinalLevels itself), DefPoly 0, no INS tab,
editor 715 x 224, 0 parameters (everything is the saved state).

Sources: FL 2026's binary (`Plugins/Fruity/Generators/Wave Traveller/Wave Traveller_x64.dylib`, arm64
slice, FPC, class `TTestPlug`, VMT 0x1f9df0, no symbols), its editor form, the plugin database state
(`Data/Patches/Plugin database/Generators/Sampler/Wave Traveller.fst`), the 6 factory presets, the 19 spline
presets (`Presets/*.spln`), the editor thumbnail (colours) and renders of FL's real plugin through the test
host (`flfxhost`, with a private build that dumps the plugin's patch objects: tables, fields).

| What | Address (arm64) |
|---|---|
| Dispatcher (slot 1): ProcessMode 1, SetSampleRate 4, CollectFile 15, LoadFile 18 | 0x630f0 |
| GetName (section 2 = key name: the patch name) | 0x63640 |
| SaveRestoreState (3) / header chunk / patch chunk / end chunk | 0x645f0 / 0x63900 / 0x63d20 / 0x64570 |
| TriggerVoice / Voice_Release / Voice_Kill / Gen_Render (9 / 10 / 11 / 8) | 0x64790 / 0x64870 / 0x648a0 / 0x64950 |
| ProcessEvent (FPE_Tempo -> engine +0x448) | 0x64a50 |
| engine (CWWarper, 0x4a8 bytes): constructor, voice creation | 0x69670, 0x6c180 |
| spline -> table flattening (`CWWarper.Rebuild(kind)`), Bezier flattening | 0x6c740, 0x6d830 |
| render loops: normal (6-point cubic) / HQ export (windowed sinc), DC blocker | 0x6a540 / 0x6b560, 0x6c0e0 / 0x6c130 |
| LoadSample (engine) | 0x6dd40 |
| point record <-> object (TCSplinePt), mute record | 0x6e5d0 / 0x6e8f0, 0x6e2e0 / 0x6e320 |
| editor: wheel change 0x5efe0, value setter 0x618b0, Normalize 100 / 50 % 0x5fa40 / 0x627f0, spline control 0x6ede0.. | |

## State (SaveRestoreState, "version" 1000005)

A stream of chunks `[tag:int32][size:int32][payload]` (sizes are unreliable: FL writes a wrong size for the
patch chunks; readers go by structure):

```
1000  header: size = 12 + len(path); version 1000005, selected key (the patch selector), len(path), path bytes
2000  one per patch (FL always writes 120 chunks, keys 0..119; presets from FL 4 hold 108):
        key:int32, 6 x float32 [steps(0x2018) speed(0x201c) attack(0x2020) release(0x2024) start(0x2010) end(0x2014)],
        mode:int32 (0x2030: 0 tempo based, 1 absolute), len(name):int32 + name,
        n:int32 + n x 8-byte mutes   { on:u8 (+3 padding), time:float32 }     (list at 0x2050)
        n:int32 + n x 60-byte points                                           (WAVE list, 0x2040)
        n:int32 + n x 60-byte points                                           (VOL list, 0x2048)
3000  end (size 0)
```

A point record (60 bytes = 15 words; FL dumps the object, the other words are garbage / pointers): word 2 x, 3 y
(0..1), 5 / 6 handle 1 (incoming) x / y, 8 / 9 handle 2 (outgoing) x / y, 10 tension, 12 type, 14 low byte
"locked". Defaults of a new point: tension 0.5, handles (-0.042, 0) / (+0.042, 0), the editor sets locked = 1 on
every inserted point (end points 0). Types (SplineEditorMenu tags): 1 Linear, 2 Half cosine, 3 Bezier, 4 Quarter
sine, 5 Quarter cosine, 6 Tension, 8 Mute (the segment to the point's right plays silence); 10 = Locked toggle,
11 = Delete (not on the end points). A new instance gets 120 default patches, key 60, no sample:
WAVE (0,0) -> (1,1) linear, VOL (0,1) -> (1,1), mutes [(on, 0)], START 0, END 1, 4 beats, ATT / REL 1 ms
(a 36,508 byte state: the clone's `defaultWtState()` serialises to the same size). The state holds only the
sample's file name (FHD_PackDataFile): FL loads it again from its Data folders.

The controls map the wheel positions v (0..1) to the stored values: steps = 0.125 + 7.875 v beats (hint
"%.3f (Steps)" = beats x 4), absolute speed = 0.25 + 3.75 v, ATT = 1 + 499 v ms, REL = 1 + 999 v ms (form
wheels: SPEED 0..1024, ATT 0..100, REL 0..5000, START / END 0..10000). The `.spln` spline files hold the
normalised v values: `4000, 1000005, mode, speed v (tempo), speed v (absolute), ATT v, REL v, start, end`, then
the WAVE points, the VOL points and the mutes in the patch chunk's layout (all 19 decode; 2526 points in the
presets use only types 1, 2, 4, 5 and default tension / handles; their mutes alternate [on, time]).

## DSP

A note triggers `TriggerVoice` (0x6c180): no sample -> no voice (-1); key = round(InitLevels.Pitch / 100),
outside 0..119 = a silent dummy voice. The voice copies the patch's two 1024-entry float tables and mutes:

- table A = WAVE spline, table B = VOL spline: `CWWarper.Rebuild` (0x6c740) walks the points; every segment
  gets `round(dx x 1023)` entries (the last entry of a segment is overwritten by the next segment's first),
  `last` = index of the last entry (1022 for the default patch: x = i / 1022); entries are clamped to 0..1
  by their float bits; min / max of the unclamped curve are kept (Normalize). Segment curves (float32 steps,
  pi = 3.1415926 and pi/2 = 1.5707963 literals of the plugin): Linear `y0 + k step`, step = dy / (n - 1);
  Half cosine `y0 + dy/2 (1 - cos t)`, t = 0..pi; Quarter sine `y0 + dy sin t`, Quarter cosine `y0 + dy (1 - cos t)`,
  t = 0..pi/2; Tension with a = (1 - 2T) / T^2: `y0 + dy ((1 + a)^t - 1) / a` (exp(t log(a + 1))), T = 0.5 is a straight
  line with step dy / (n - 2); Bezier: the cubic through p0, p0 + 3 h2, p1 + 3 h1, p1 sampled at 256 points and
  read back by x with linear interpolation (overshooting parts are skipped: time only moves forward); Mute: zeros.
- speed per output sample (table entries): tempo mode `tempo (last - 1) / (steps x rate x 60)`, absolute mode
  `rateRatio x speed x (last - 1) / ((frames - 1) x (end - start))`, then x `1 + c / 1200` where c = FinalLevels.Pitch
  - 100 (key - 60) (divided by `1 - c / 1200` for a negative final pitch): the key itself never changes the speed,
  the channel's pitch knob / fine pitch / bends at note start do (later changes are ignored). One tempo step is a
  beat: 4 beats at 130 BPM = 1.846 s (+ 256 samples tail). The tempo is read when the voice starts (FPE_Tempo).
- per sample: the position `pos` (double) steps by the speed; mutes: the next [on, t] applies when pos / last
  >= t; the VOL value follows `pos` one table entry per sample (`vol = B[ceil(pos)]`, no interpolation); ATT:
  `level += 1000 / (ATT x rate)` up to 1 (sustain); REL (note off, any state but the tail): `level -= 1000 / (REL x rate)`,
  the voice ends when it goes negative (that sample is dropped). Sample position P = START + (A lerp pos) x (END - START)
  in frames (START / END = int(v x (frames - 1))). The sample is read through a 6-point cubic Hermite with
  4th-order tangents (x0 + c f + a f^2 + b f^3, float32 coefficients 1.25, 7/3, 5/3, 1/12, 1/6, 7/12, 4/3, 2/3;
  neighbours outside the sample are 0), then a DC blocker per channel `y = x - x' + (1 - 126 / rate) y'`, then the
  gains `g = 0.99 g + 0.01 pan law(FinalLevels.Pan, FinalLevels.Vol) x VOL` (a muted region decays `g = 0.99 g`),
  then `x level`. The pan law is FL's circular law (0.7071 each side at the centre), evaluated per sample on the
  live FinalLevels (pan and volume changes follow the knobs).
- end of the phrase (`pos > last - 1`): the voice plays its last 256 outputs backwards with a linear fade
  (256 - n) / 256 and ends. Voice_Release only starts REL (not in the tail); a new sample ends all voices.
- the sample as the plugin holds it: stereo 16-bit (LoadSample asks for it) x 1/32768, i.e. round(x 32767) / 32768 of the
  host's float data; the rate ratio file rate / project rate (SmpRateConv) is used only in absolute mode.
- FPD_ProcessMode (0x634e0): when exporting (PM_IsRendering) with the project's resampling points (bits 8..23) 3 /
  4 / 5 the plugin switches to a windowed-sinc kernel with 64 / 128 / 256 taps per side (mode 2): kernel
  `sin(c pi x) / (pi x) cos^2(pi x / (2 T))` with the cutoff c = min(1, 1 / |position change per sample|) (position
  as float32), pan = Final.Pan + Init.Pan, and the VOL table value is left out of the gains. With FL's points
  table (1, 3, 12, 32, ...) only 3 (6-point Hermite) selects it; the live mode and the other settings use the cubic.
- Continuous output (OPTIONS menu): no engine field changes with it that the renders could show; stored
  only (`continuous`).

`dis_table*.dat` (Data folder, 4 x 257 floats): not referenced by the plugin binary (no string, no load): nothing to
port or import. The spline presets are shipped as numbers in `presets.ts`; the 6 factory presets name FL pack
samples (HIP_Kick_3.wav, VOC_Go.wav, VOC_ICantFeelNoBetter.wav, VOC_ScratchinSurf.wav, HIP_Snare_8.wav): sample
content comes only from the user (drop, file picker, Browser) or the optional "Import FL content...".

## Editor (FL's form: SynthPanel 715 x 224)

Left column 252 px: sample file button + name, waveform scope 252 x 73 (START / END markers, the patch's path
drawn on it), patch name label (click: list of the 120 patches in columns of 12, right click: rename), the
START / END wheels (0..10000, kept at least 1 pixel = 1/251 apart), the SPEED wheel (0..1024) with its menu (tempo
mode: 1 / 2 / 4 / 8 / 16 / 32 steps; absolute: 25 / 50 / 100 / 200 / 300 / 400 %), the T-A switch (tempo / absolute
speed), the ATT (0..100) and REL (0..5000) wheels, the snap button and menu (Off, 1/16, 1/12, 1/8, 1/6, 1/4, 1/3)
and the octave scroll buttons, the patch selector keyboard (2 octaves, 120 keys, selecting a key selects its patch
and previews it; right click: Copy / Paste / Normalize 100 % / Normalize 50 % / Presets / Save presets...). The
spline editor 400 x 210: left click on an empty spot adds a point of the page's last chosen type (new WAVE points
Half cosine, VOL points Linear), a point is hit within 4 px, dragging moves it (end points only vertically; interior
points keep 1 pixel from their neighbours; Shift = vertical lock, Ctrl = horizontal lock, Alt inverts snap), Bezier
handles and the Tension handle (at the segment's middle, y0 + T dy) are dragged the same way, right click: the
point menu (Mute / Delete / Half cosine / Linear / Bezier / Tension / Quarter sine / Quarter cosine / Locked). The
snap grid has beats x div cells over the phrase (div 16 / 12 / 8 / 6 / 4 / 3; absolute mode: 1 beat) and 4 x div rows.
The mutes strip 400 x 13 (left drag mutes, right drag unmutes), the vertical wave scope 61 x 210 next to the spline's y
axis and the WAVE / VOL page switch. Normalize 100 % scales the WAVE points' y so the curve spans 0..1 and moves START /
END to the span the curve really covers; Normalize 50 % scales it to 0.25..0.75 (START / END unchanged).

### Sample loading (drop, picker, Browser, "Import FL content...")

A sample is a pool sample of the project (state `sample` = pool id, `file` = the name FL shows and saves). A WAV is parsed
directly, other formats go through the browser's decoder. FL's own pack samples (`Data/Patches/Packs/...`) are not PCM:
the file is a RIFF / WAVE container whose `fmt ` tag is 0x674F (Ogg Vorbis; 0x6750 / 0x6751 / 0x676F..0x6771 are the
sibling Vorbis modes) and whose `data` chunk is a plain Ogg stream ("OggS"). The editor takes that stream out of the
chunk and hands it to the browser's decoder (`oggInWav` in `ops.ts`); the extracted stream, not FL's file, is what the project
keeps. The 6 factory presets name their samples (HIP_Kick_3.wav, ...): when the project's pool holds a sample with that
file name (imported through the plugin menu's "Import FL content..." from the user's own FL install, a folder or files), the
editor selects it for the patch; without it the plugin is silent and shows the name, like FL when the file is missing.

## Fidelity

Compared with FL 2026's real plugin through the test host (`flfxhost`, 44.1 kHz stereo float renders, the input samples
synthesised the same way on both sides: 16-bit pseudo-noise, 22.05 kHz mono, 48 kHz stereo and a 37-frame sample):
59 renders, every output sample of both channels. 58 are **bit-exact** (residual 0, max difference 0), 1 (`poly`, three
notes overlapping on different keys) differs by 1.2e-7 = one float32 ulp in the mix of the overlapping voices (-149 dB).
Scenarios: the default patch (1 s, long), keys 48 / 50 / 67 / 72 / 119 and 125 (out of range = silent dummy voice),
velocity 64 / 100 / 128, every spline type (Linear, Half cosine, Bezier, Quarter sine, Quarter cosine, Tension at 0.5 / 0.8 /
0.1), mutes, a VOL spline, ATT / REL (release inside the attack, inside the tail, a 0.01-beat note), a reversed WAVE
spline, START / END, tempo mode and absolute mode (speed 2, with pitch), mono 22.05 kHz and stereo 48 kHz samples in 44.1 and
48 kHz projects, the 37-frame sample, the same key played twice, polyphony, the channel's pitch (+100 / +200 / +300 / -250 /
-300 cents, root note 64) and pan (note pan, channel pan), and the export path (`FPD_ProcessMode` with resampling
points 3: the 64-tap windowed sinc, also with VOL, with pan and with a fast phrase; points 12 and 1 keep the cubic). The 6 FL
factory presets (20 renders: each preset on its keys) are bit-exact as well, played over deterministic test audio because
the host cannot load FL's Ogg-in-WAV pack files (the preset is loaded with its sample path blanked and the sample given by
`--load-file`).

Pinned in `tests/gen/wavetraveller-golden.ts`: 33 of these renders (every 1722nd output sample of both channels, the RMS
and the last non-zero frame, compared to 6 decimals) and the spline tables the plugin's patch objects hold (1024 entries,
`last`, min / max) for the default, "types", high-tension, VOL and reversed patches (read from the live plugin with a
private host build that dumps the patch objects). The factory and spline presets are numbers extracted from FL's files
(names, point counts, mutes and fields are spot-checked in the tests) and the `.spln` reader / writer round-trips all 19.

Approximations and what is not matched:
- The 128 / 256-tap sinc variants (resampling points 4 / 5) come from the disassembly only: FL's resampling table cannot
  select them, so no render exists for them. Only the 64-tap kernel (points 3) is verified.
- The rate ratio of absolute mode is file rate / project rate as the plugin computes it from its own sample (bit-exact for
  22.05 / 44.1 / 48 kHz here); the plugin's SmpRateConv native-rate conversion is not otherwise modelled.
- The 16-bit quantisation of the loaded sample follows what the test host does with float data (`round(x 32767) / 32768`);
  real FL's loader could convert formats the host does not read (24-bit, float, compressed) differently - they are
  quantised by the same rule here.
- "Continuous output" (OPTIONS menu) is stored in the state; no engine field changes with it in the renders, so it has no
  effect.
- The editor follows FL's layout and interaction rules (coordinates, snap, hit sizes, drag locks, menu items, wheel ranges
  and hints), but the drawing is original: grid, beat bands, colours (taken from the thumbnail) and fonts are approximated,
  the patch list is a menu of octave submenus (FL shows the 120 patches in columns), and a `.spln` file cannot be dropped on
  the editor (the keyboard's Presets menu holds the 19 built-in presets, Save presets... downloads a `.spln`).
- The tempo is read when the voice starts, as in FL (FPE_Tempo); the clone passes the channel context to `triggerVoice`
  for that (`GenInstance.triggerVoice(params, ctx?)`, the one framework change).
- Live path: in the running app a generated 330 Hz WAV loaded through the editor's loader (pool sample -> engine worklet)
  plays on a key press with a steady level for as long as the note is held and stops after the note off (analyser
  peak 0.194 -> 0). Not listened to by ear; the DSP's numbers come from the offline renders above.
- FL's Ogg-in-WAV pack files are unpacked by `oggInWav` (checked on one real pack file's structure with ffprobe: a mono
  44.1 kHz Vorbis stream) and decoded by the browser; the decode itself was not run in the app for such a file.
