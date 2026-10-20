# VFX Envelope (FL: VFX Envelope)

Files: `src/model/fx/plugins/vfxenvelope.ts` (def, state, presets),
`src/engine/effects/plugins/vfxenvelope.ts`, `src/ui/plugins/fx/vfxenvelope.tsx`
(+ the shared envelope editor `src/ui/plugins/fx/vfx/EnvEdit.tsx`),
`tests/fx/vfxenvelope.test.ts`.

Sources: FL 2026 form (SynthPanel 768 x 400: articulator buttons 8 + 24i, TargetSelect
483,11 277x30, ctrlPanel 8,41 with Color / Low / High / MODE / BASE / ENV / LFO,
MEnvEditor 0,44 752x253 with the Env and LFO knob panels), the manual page, the
screenshot `VFX_envelope.png` (1.53x), `flfxhost info` (880 parameters, constructor
and preset values), and FL's four factory presets decoded from their `.fst` files.

## Parameters (FL's 880, FL order)

Index `(a-1)*55 + t*11 + f` for articulator a = 1..16, target t (Velocity, Pitch,
Pan, Mod X, Mod Y) and field f: Attack, Decay (0..256, 128), Sustain (-128..128, 0),
Release (0..256, 128), LFO Speed (512..65536, 40898), LFO Tension, LFO Skew
(-128..128, 0), LFO Pulse Width (-112..112, 0), Base Level (0..256), Envelope Level
(-256..256), LFO Level (-256..256). Names as FL's: `Articulator 1 Velocity - Attack`.
Keys `a<a><vel|pitch|pan|modx|mody><Att|Dec|Sus|Rel|LfoSpd|LfoTns|LfoSkw|LfoPw|Base|Env|Lfo>`.

Defaults follow FL's Default preset, which FL applies on insertion (it differs
from the constructor in 160 values): Velocity Base 0, Envelope 256, LFO 256;
Pitch Base 128, Envelope 64, LFO 256; Pan / Mod X / Mod Y Base 128, Envelope 256,
LFO 256. The plugin reports no value texts; the clone shows time factors,
percentages and LFO cycles per beat.

## State and preset format (decoded)

Event 213 is a chunk list (`u32 id, u32 size, u32 0, data`, as in Patcher's own
state): 1003 global (enable, view state), 1008 the 880 parameters (i32), 1007,
then per articulator 1004 `(index, colour, low key, high key)` and per target 1005
`(articulator, target, 0)` + 1006: `version 3, f32 base, f32 env, f32 lfo (copies of
the levels), u32 active`, the envelope (FL's envelope format: u32 3, count, 24-byte
points), its markers `(flags/loop, ?, D index, ?, S index)`, the four ADSR knob
values, then the LFO part's envelope with its markers and the LFO knob values.

State: `arts[16] = { color, low, high, targets[5] }`, each target `{ on, env, loop,
dec, sus, lfo, lfoLoop, lfoDec, lfoSus, tempo, global, lfoGlobal }` (envelope
positions in beats), plus `enable` and the editor's `art`, `target`, `mode`.

Factory presets (all four): Default (all articulators colour 1: the first one
wins), Default (all channels) (articulator n answers colour n), Pumping
(articulator 1's velocity: 0 -> 100% in half a beat, hold, looped every beat),
Vibrato (velocity flat, pitch LFO at speed 54917 with ENV 2/256).

## Processing (interpretation; the plugin cannot render in the test host)

- A note uses the first articulator whose colour is the note's and whose key
  range holds the key.
- Envelope timeline: plays from the note start; while held it stops at S (or
  loops D..S with loop on); after note-off it continues from S. ATT / DEC / REL
  scale the parts before D, D..S and after S (`2^((v-128)/64)`); SUS offsets S's
  level by `v/128`. This reading of the markers reproduces the presets: Default's
  velocity is an ADSR (attack 0.75 beat, decay to 50%, release), Pumping loops.
- Output (0..1): `base + envLevel * ((env - neutral) + lfoLevel * amount * wave / 2)`
  with neutral 0 for velocity and 0.5 for the others. The LFO adds to the envelope
  and ENV scales both, which makes the Vibrato preset a gentle (fraction of a
  semitone) vibrato with ENV at 2/256.
- LFO: sine shaped by skew (peak position), pulse width (squarer) and tension;
  speed `2^((v-40898)/8192)` cycles per beat (Vibrato: 3.3 per beat, 6.6 Hz at
  120 BPM); GLOBAL ties its phase to the song position instead of the note.
- The LFO part's envelope is the LFO amount over time. FL's stored default LFO
  part (0.5 -> 0.5 -> 1.0 -> 0.5 with a sustain marker) cannot be read as an
  amount without making every preset wobble, so the clone's default LFO part is
  flat at 0 and the Vibrato preset's pitch LFO part is flat at 1 (as stored).
- Results go to `note.mod` curves (ticks from the note start, 1/24-beat steps):
  `vel` (note velocity x out), `pitch` (semitones, +-48), `pan` (0..128),
  `modX` / `modY` (0..255); unchanged properties get no curve.

Audio passes through. Inside Patcher the notes of its event links are played live through it (Patcher's LiveVfx, per note; docs/research/fx/patcher.md): the notes pass with their velocity at the
start; the `mod` curves have no receiver among effects.

## Editor

Articulator buttons (selected orange), target tabs, colour button (menu of the
16 note colours), Low / High note boxes (drag / wheel), MODE (Envelope / LFO part),
BASE / ENV / LFO knobs, FL's envelope editor (drag points, segment tension
handles, right-click to add / point menu with Delete, curve modes, D / S markers
and the loop; time grid in 1/4 beats; zoomable time scrollbar; Freeze, Points,
Snap, Slide), the knob strip (activate switch, ATT / DEC / SUS / REL + TEMPO /
GLOBAL, or SPD / TNS / SKW / PW + GLOBAL in the LFO part) and Enable.
