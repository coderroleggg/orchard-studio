# Pitcher (FL: Pitcher)

Real-time pitch correction and harmonization (Maxx Claster). Category Misc. FL's
Pitcher is a C++ plugin with a bitmap editor; there is no extracted form. Editor
415 x 280 (measured on the manual screenshot, which is at 1x).

## Sources
- FL's binary in the FL test host (C++ ABI): parameter names and value texts (set +
  readback sweeps), renders of tones and noise, and the binary's strings (option lists,
  bitmap names).
- Manual page and screenshots (Automatic and Harmonizing views).

## Parameters (index, raw range, default, text)
0 Correction Speed 0..256 = 256 (`floor(v*100/256)` + a space: `100 `); 1 Stereo = 256;
2 Gender 0..256 = 128 (`floor((v-128)*100/128) `, -100..100); 3 Fine Tune = 128 (cents);
4 Bypass All = 0; 5..16 Key C..B Bypass (0 `Enabled `, > 0 `Bypassed `);
17..20 Voice 1..4 Pan = 128. (FL also exposes 128 MIDI CC + aftertouch host parameters,
not modelled.) Non-parameter state: Min `25/55/80/110/170/220 Hz` (default 110), scale
`Minor/Major/Pentatonic` (binary order; default Minor), key C, A3 440.0 Hz, the 12 note
switches (default all on), reference `Left/Both/Right` (default Left), FORMANT (off),
MIDI / OCTAVES / HARMONIZE, REPLACE/MIX, VEL, MIDI port.

## Measured behaviour (implemented)
- **Whole-sample period detection.** FL's detected pitch is `sr / round(sr / f)`; the
  correction ratio is `target / detected`, so outputs keep FL's residual detuning: at
  44.1 kHz, inputs A+10/20/30/40/50/60/70/80/90 cents come out at +6.1, -1.3, +8.7,
  +1.1, +93.5, +103.2, +95.5, +105.3, +97.3 cents. The clone matches all of them within
  0.2 cents (and the 48 kHz cases). Detection range: periods >= 45 samples (980 Hz
  corrected, 1000 Hz not, at 44.1 kHz) down to Min (105 Hz passes at Min 110). The dip must
  be a real local minimum of the YIN function (else unvoiced).
- **Correction speed**: exponential glide in cents, `tau = 348 (1 - v/256)^3` ms (FL: 43 ms
  at 50%, 144 ms at 25%, 348 ms at 0, a few ms at 100%); the clone's glide matches FL's
  measured curves within ~1.5 cents.
- **Formant off** (default): resampling shift, the formants follow the pitch (FL's -30 cent
  correction moved the spectral centroid 768.9 -> 755.3 Hz; the clone gives 755.3). The
  shifter is a pitch-synchronous delay line spliced by whole periods; output starts with a
  few samples of delay (FL: 9) and no latency is reported (FL reports none).
- Key bypass: input whose nearest note is bypassed passes uncorrected; fine tune adds
  exactly +-cents to the target; reference Left (default) makes the right channel follow
  the left channel's correction (FL: R at A-30 -> -51.3 cents), Both corrects each channel.
- Output level unchanged (FL: 1.000).

## Not measurable in the host / approximated
- FL ignores state edits other than the parameters in the host, so scale/key/notes,
  Min, reference, FORMANT and the MIDI switches were implemented from the manual. FORMANT
  on uses TD-PSOLA; GENDER (active with FORMANT on, as in FL) shifts formants by up to +-7
  semitones (FL's range unknown).
- **MIDI / OCTAVES / HARMONIZE** follow MIDI notes, as in FL: a MIDI Out channel on
  Pitcher's own *MIDI Input Port Number* (`port`, "..." = none; `midiPorts()`), or on the
  slot's MIDI input port (docs/research/midiout.md). Notes apply at their sample (the
  correction targets are recomputed there and glide at the correction speed). MIDI = the
  last note pressed, in the octave nearest the input; OCTAVES = the note and octave
  played; HARMONIZE = up to 4 voices (the 4 last pressed; highest note = voice 1) panned
  by the voice pans x STEREO, REPLACE or MIX; VEL (with OCTAVES off) scales each voice by
  its velocity (MIDI velocity / 127). With no note held the automatic correction applies
  (FL's behaviour between notes not measured; the "last note" choice in MIDI mode is an
  interpretation). The note switches keep their FL function (scale notes); in MIDI mode
  they light up with the held notes (`monitor().held`). The earlier mouse latching of
  notes (`held`) is gone: FL has no such control.
- The retro skin is drawn in vector form (no Image-Line bitmaps); the PITCHER lettering
  uses a system serif font.
