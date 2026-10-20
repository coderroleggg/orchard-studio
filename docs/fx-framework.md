# Effect plugin framework

How mixer effects are built in Orchard Studio. Every FL Studio stock effect
is a plugin made of up to four files that are discovered automatically
(`import.meta.glob`), so adding a plugin never edits a shared registry.

| Part | File | Exports |
|---|---|---|
| Definition (shared by engine and UI) | `src/model/fx/plugins/<id>.ts` | `def: FxPluginDef` |
| DSP (runs in the AudioWorklet and in Node tests) | `src/engine/effects/plugins/<id>.ts` | `effect: EffectModule` |
| Editor | `src/ui/plugins/fx/<id>.tsx` or `src/ui/plugins/fx/<id>/index.tsx` | `editor: FxEditorModule` |
| Tests | `tests/fx/<id>.test.ts` | vitest |
| Research notes | `docs/research/fx/<id>.md` | the plugin's spec |

The reference implementation is **Balance** (`balance.ts` in each place).
Instrument (generator) plugins follow the same pattern and use the same editor
kit: see docs/gen-framework.md.
Parametric EQ 2 predates the framework and keeps its own files (`src/model/peq2.ts`,
`src/engine/effects/ParametricEQ2.ts`, `src/ui/plugins/ParametricEQ2.tsx`).

## Definition (`FxPluginDef`, src/model/fx/types.ts)

- `id`: short lowercase id stored in projects (`limiter`, `delay3`, `reeverb2`).
  Never change it once used.
- `name`: FL's plugin name without the "Fruity " prefix (`Limiter`, `Delay 3`,
  `Love Philter`, `Maximus`).
- `category` (+ `alsoIn`): FL's plugin database folders: Controller,
  Delay reverb, Distortion, Dynamics, Filter, Flanger, Gain, Misc, Patcher,
  Visual. Legacy plugins that are not in FL's database get `hidden: true`.
- `width`, `height`: FL's editor panel size (the `SynthPanel` in FL's form).
- `params`: the automatable parameters, in FL's order:
  - values are stored in **FL's control units**: the control's `Min`/`Max` in
    FL's form, e.g. 0..2000 for a gain wheel. The default is the form's
    `DefaultValue`, and `index` is the control's `Tag` (FL's parameter index).
    The DSP maps control units to physical units;
  - `name`: FL's parameter name, taken from the control's hint
    (`'|^b^aLimiter ceiling'` -> `Limiter ceiling`; strip the `|^x` prefixes);
  - `format`: FL's value text for a control value (`-0.2 dB`, `10 ms`,
    `3.2 : 1`). Match FL's display exactly where it is known;
  - `options` for discrete choices, `bipolar` for centre-zero wheels, `step` (default 1).
- `outputs`: controller plugins only; see `controls()` below.
- `presets`: FL's factory presets (`{ name, params }`), shown in the plugin window's
  preset menu and arrows (also for modules in Patcher). Generate the values with
  the FL test host (`flfxhost info "<FL plugin>" --preset <name> --tsv`). Loading
  one goes through `presetState()` (registry.ts): defaults plus the preset,
  clamped to the controls' ranges as FL's controls do, normalised, view state
  kept. tests/fx/roundtrip.test.ts checks every preset (JSON round trip, ranges,
  finite audio).
- `viewState`: state keys that are only view settings (selected band, display
  speed); preset loads keep them.
- `state()`: non-parameter state (A/B spare state, envelopes, text, file references).
  The whole slot state is `FxSlot.params` (`Record<string, unknown>`), and it
  must be JSON-serialisable.
- `normalize()`: optional repair of stored states.

## DSP (`EffectInstance`, src/engine/effects/types.ts)

Plugin definitions and DSP modules are loaded in the AudioWorklet
(`AudioWorkletGlobalScope`): no DOM, `window`, timers (`setTimeout`),
`fetch`, `performance` or `localStorage` there, at module load or at run time.
`structuredClone` is polyfilled (src/engine/polyfills.ts).

- `create(sampleRate, blockSize, env)` returns an instance; `env.sample(id)`
  looks up audio in the sample pool (impulses for Convolver).
- `setParams(p)` receives the whole state on every edit or automation step.
  Precompute coefficients there, not per sample. Never allocate in `process()`.
- `process(L, R, n, ctx)` processes `n` stereo frames in place (n <= blockSize, usually 128).
  `ctx` has tempo, ppq, playing, pos (ticks at block start), songMode, track,
  `sidechain` and `sendTo()` for routing plugins, and `rendering` (true while
  the project is exported to WAV, false/absent in the live AudioWorklet: FL's
  `FPD_ProcessMode` with `PM_IsRendering | PM_HQ_NonRealtime`, "HQ for all
  plugins"; use it only where FL's plugin processes differently on export,
  measured with the test host's `--mode live|export`). As in FL, every track routed
  into this one is a sidechain input, in source track order, carrying the
  source's full output whatever the send level ("Sidechain to this track" makes
  a level-0 route). FL's sidechain input k is `ctx.sidechain[k-1]`.
- Reproduce FL's parameter-change behaviour, not a nicer one: where FL smooths,
  use its smoother (measure it with the test host's `--at` automation); where
  FL steps a value once per block, step it once per block (our blocks are 128
  frames); where FL clicks or kicks, do the same. Do not add oversampling,
  anti-aliasing, de-zippering or crossfades that FL does not have. The only
  allowed departures keep the output finite (NaN / Inf input -> 0, denormal
  flushing, a clamp that stops an unbounded feedback path); document each one.
- Generic building blocks are in src/engine/dsp (biquad, svf, fft, interp,
  sinc, math). Filters, oversamplers and detectors that reproduce one FL
  plugin's own implementation stay with that plugin: they are calibrated
  against FL's output and differ between FL plugins.
- Flush denormals / keep feedback paths finite. Output must stay finite for any setting.
- `latency` (samples, for lookahead / linear phase): the mixer compensates it (PDC).
- `tail` (seconds): how long the effect rings after the input stops (reverb,
  delay feedback). Without it the mixer stops an idle track after about 0.5 s.
  `Infinity` means the effect always runs (effects that generate sound).
  A newly created effect also runs for 1 s on its own (Mixer.ts SETTLE_SECONDS),
  and a project export first runs 1 s of silence: FL processes plugins all the
  time, so start-up glides from constructor values end before audio arrives.
- `monitor()`: display data for the editor (meters, gain reduction, envelopes,
  spectra), polled about 30 times a second while the editor is open. Return
  small objects; reset peak accumulators when read. The mixer adds `__active`
  (false once the track has gone idle and is no longer processed): let meters
  fall then.
- `reset()`: clear delay lines, filters and envelopes.
- `monitorHosted(moduleId)` (host plugins: Patcher): the display data of a hosted
  module, for editors watching `"<slot>#<module>"`.
- `controls()` (controller plugins): the current values (0..1) of the plugin's
  internal controller outputs, read after every block. Name the outputs in
  `def.outputs` (a list, or a function of the slot state for dynamic outputs
  such as Control Surface). The Link to controller system (Remote control
  settings dialog, `Project.links`, src/model/formula.ts) maps them onto any
  automatable control; see docs/research/fx/links.md.
- MIDI input (effects that take notes; docs/research/midiout.md): MIDI Out
  channels send their notes on a port, and the mixer calls
  `noteOn(key, velocity, frameOffset, port, channel)` / `noteOff(key,
  frameOffset, port, channel)` on every slot listening on that port (the
  slot's `FxSlot.midiPort` plus the plugin's own `midiPorts()`), right before
  `process()` of that block: apply each event at its `frameOffset` sample in
  the following `process()` call (queue them in fixed arrays; no allocation).
  `velocity` is FL's 0..128. A bypassed slot gets no calls; the mixer catches it
  up when it runs again. `allNotesOff()` = panic. `setMidiPort(port)` tells the
  plugin its slot port (Patcher's "Notes" output). State the plugin changes by
  itself from notes (a selected slot, latched keys) is reported by
  `takeStateChanges()` as [path in params, value] pairs; the engine mirrors it
  into the project. Add the plugin id to `NOTE_INPUT_FX` (src/model/midiout.ts)
  for the plugin window's MIDI input port, and to Patcher's note inputs
  (`NOTE_INPUT` in src/model/fx/plugins/patcher/graph.ts).

## Editor (`FxEditorModule`, src/ui/plugins/registry.ts)

- `Editor` renders an `FxPanel` of exactly `def.width` x `def.height`, with every
  control placed at **FL's form coordinates** (Left/Top/Width/Height). The
  window scales the panel to fit.
- Controls come from the kit (`src/ui/plugins/kit`):
  - `Wheel` (knob; looks `flat`, `metal`, `classic`) and `DigiWheel` (spinner);
  - `Slider`, `ParamTabs`, `TabSelector`, `PillSwitch` and `Check` (LED switch);
  - `IconButton`, `TextButton`, `Bevel` (inset panel / section title) and `Label`;
  - `Display` and `AnimatedDisplay` (canvas), `drawMeter`;
  - `useParam(key)` (binding: value, undo gesture, automation menu, value text),
    `useFxState(key)` for non-parameter state, `useFxMonitor(slotId, fn)` for engine data,
    and `useFxEditor()` for slotId / params;
  - `useFxEdit()` (undoable state edits, optional merge key) and `useFxView()`
    (view state without an undo entry);
  - routing (`routes.ts`): `useRoutes(slotId, 'out' | 'in')` for the tracks the
    slot's track sends to / the tracks routed into it (FL's sidechain inputs
    1, 2... in source order), `openRouteMenu` (FL's output menu) and
    `useSidechainInput()` (FL's "Sidechain input number" spinner and menu).
  Every bound control already has FL's mouse behaviour: drag, Ctrl = fine, Alt or
  middle-click = reset, wheel, and right-click menu with Create automation clip
  and Init song with this position.
- State edits other than parameters go through `useFxEdit()` /
  `A.editFx(slotId, label, recipe)` (undoable) or `useFxView()` /
  `A.setFxStateNoHistory` (view state). Parameters go through the kit (`A.setFxParam`).
- Editors also run hosted in Patcher. There the editor's `slotId` is
  `"<slot id>#<module id>"`, and every slot action (`findFx`, `setFxParam`,
  `editFx`, `setFxStateNoHistory`, `useFxMonitor`) resolves it to the module
  inside Patcher's state (src/model/fx/hosted.ts). So:
  - always edit through those actions with the context's `slotId`; never write
    `d.mixer.tracks[..].slots[..].params` yourself (inside a store recipe use
    `A.fxParamsDraft(d, slotId)`);
  - build automation / link targets with `fxTargetOf(slotId, key)` (it points
    hosted modules at their path inside the Patcher slot), not `params.<key>`;
  - main-thread code that walks the project's effects (sample delivery,
    renders, persistent windows) uses `allFx(project, pluginId)`, which
    includes hosted modules with their ids.
- Colours and styling follow FL's screenshots. Sample exact colours with
  `scratchpad/fx/tools/pngpix.py <png> at X Y` / `region X0 Y0 X1 Y1 N`
  (screenshots are usually 1.5x the form size).
- Plugin-specific widgets live in the plugin's own folder (`src/ui/plugins/fx/<id>/`).
- `menu(slotId)` adds items to the plugin window menu (FL's plugin options menu).
- `size(params)`: for editors whose panel grows or shrinks with their state
  (Vintage Phaser's gear hides its advanced strip): the panel size for the
  state; the plugin window (and Patcher's module window) follows it. Keep the
  state that drives it in the slot state (a `viewState` key), not React state.
- `Persistent({ slotId })`: an optional component rendered for every instance of
  the plugin while it exists, editor open or not (detached displays such as
  Wave Candy's and ZGameEditor Visualizer's windows; the kit's `useAuxWindow`
  keeps such a window in step with the plugin state).

## Tests

`tests/fx/util.ts` has `makeCtx`, `render` (block-wise processing), `sine`,
`rms` and `peak`. Each plugin tests its registration (ranges and defaults),
its signature behaviour (e.g. a limiter holds its ceiling; a delay repeats at
the set time; a filter attenuates above cutoff), parameter smoothing,
silence in -> silence out (or the expected tail), and finiteness at extreme
settings.

Commands (call the node binaries directly; an RTK hook mangles npx output):

```
node node_modules/typescript/bin/tsc --noEmit -p .
node node_modules/vitest/vitest.mjs run tests/fx
```
