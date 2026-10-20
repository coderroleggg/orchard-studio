// BeepMap (FL: BeepMap, Plugin database > Generators > Synth special): "an image
// synth" by Didier Dambrin: a vertical line scans a bitmap from left to right,
// the red component of every pixel is the amplitude of a sine on the left
// channel, green on the right, the pixel's height gives the sine's frequency and
// (optionally) blue the frequency range per pixel. A port of FL's plugin
// (docs/research/gen/beepmap.md). FL's "hybrid" generator: its INS tab
// (envelopes, LFOs, filter) is the channel's INS settings here.
//
// From FL 2026's plugin (BeepMap_x64.dylib): the editor form (SynthPanel 380 x
// 170 above the INS panel: PreAmpWheel Tag 0 "Freq range" 24..9600 default
// 7200, LengthWheel Tag 1 "Pixel duration" 0..4096 default 2048, ScaleSelect
// Tag 2 Log / Linear / Harmonics, UseBlueBox 3, GrainyBox 4, LoopBox 5 (checked),
// WidenBox 6 (checked), HeightSelect (no Tag) "Max bitmap height" 3..999 default
// 23), the test host's parameter list and value texts (`flfxhost info / sweep
// BeepMap`: parameters 0..6; 7..105 are the INS block), the plugin info
// (generator, note input, DefPoly 4) and the state format (SaveRestoreState
// 0x5df70: version 0 = 15 integers [the 7 parameters, 7 reserved, Max bitmap
// height] and the bitmap; version 1 adds the INS block before the bitmap).
//
// Fresh instance: FL adds the plugin with Plugin database/Generators/Synth
// special/BeepMap.fst = the constructor state (7200, 2048, Log, blue off, grainy
// off, loop on, widen ON, height 23, Default.bmp). The factory presets' state
// files (version 0) hold Widen off.
//
// The bitmap (state key `bmp`, text; see beepmap/image.ts for why it is not a
// pool sample) is FL content in FL's own presets and is not shipped: it stays ''
// (= an original stand-in picture) until the user picks / pastes / drops an image
// or imports FL's own (the plugin window menu).

import type { GenPluginDef } from '../types';
import { MAXH_DEFAULT, MAXH_MAX, MAXH_MIN } from './beepmap/image';

/** FL's percent texts (swept over every value): round half up of v x 100 / max. */
export function pctText(v: number, max: number): string {
  return `${Math.floor((v * 100 + max / 2) / max)}%`;
}

export const SCALES = ['Log', 'Linear', 'Harmonics'];
const onOff = (v: number) => (v ? 'on' : 'off');

export const def: GenPluginDef = {
  id: 'beepmap',
  name: 'BeepMap',
  category: 'Synth special',
  notes: 'voices',
  ins: true,
  // FL's voice engine applies the voice's pan / volume levels itself (ramped, after the release fade)
  levels: 'plugin',
  defPoly: 4,
  width: 380,
  height: 170,
  description: 'Turns bitmaps into sound',
  params: [
    { key: 'freq', name: 'Freq range', index: 0, min: 24, max: 9600, def: 7200, format: (v) => pctText(v, 9600), parse: (t) => Math.round((t / 100) * 9600) },
    { key: 'length', name: 'Pixel duration', index: 1, min: 0, max: 4096, def: 2048, format: (v) => pctText(v, 4096), parse: (t) => Math.round((t / 100) * 4096) },
    { key: 'scale', name: 'Type of frequency scale', index: 2, min: 0, max: 2, def: 0, options: SCALES, format: (v) => SCALES[Math.round(v)] ?? '' },
    { key: 'blue', name: 'Enable blue color', index: 3, min: 0, max: 1, def: 0, format: onOff },
    { key: 'grainy', name: 'Switch smooth / grainy mode', index: 4, min: 0, max: 1, def: 0, format: onOff },
    { key: 'loop', name: 'Repeat sound', index: 5, min: 0, max: 1, def: 1, format: onOff },
    { key: 'widen', name: 'Widen (stereo)', index: 6, min: 0, max: 1, def: 1, format: onOff },
  ],
  // `maxH`: FL's "Max bitmap height" (the tallest bitmap a load keeps = the number of sines per voice);
  // `bmp`: the bitmap's text form (beepmap/image.ts; '' = the stand-in picture)
  state: () => ({ maxH: MAXH_DEFAULT, bmp: '' }),
  normalize: (p) => {
    const h = Number(p.maxH);
    return {
      ...p,
      maxH: Number.isFinite(h) ? Math.max(MAXH_MIN, Math.min(MAXH_MAX, Math.round(h))) : MAXH_DEFAULT,
      bmp: typeof p.bmp === 'string' ? p.bmp : '',
    };
  },
  // Plugin presets/Generators/BeepMap/*.fst (parameter values only: their bitmaps are FL content)
  presets: [
    { name: 'Ambiance', params: { freq: 2816, length: 3008, scale: 0, blue: 0, grainy: 1, loop: 1, widen: 0, maxH: 64 } },
    { name: 'Bleep', params: { freq: 8672, length: 1664, scale: 0, blue: 0, grainy: 0, loop: 1, widen: 0, maxH: 23 } },
    { name: 'Climbing', params: { freq: 7616, length: 3424, scale: 0, blue: 1, grainy: 0, loop: 1, widen: 0, maxH: 64 } },
    { name: 'Default', params: { freq: 7200, length: 2048, scale: 0, blue: 0, grainy: 0, loop: 1, widen: 0, maxH: 23 } },
    { name: 'Liquid', params: { freq: 8832, length: 3584, scale: 0, blue: 1, grainy: 0, loop: 0, widen: 0, maxH: 64 } },
    { name: 'Voice', params: { freq: 6656, length: 704, scale: 1, blue: 0, grainy: 0, loop: 1, widen: 0, maxH: 40 } },
    { name: 'Warp', params: { freq: 3296, length: 3808, scale: 0, blue: 1, grainy: 0, loop: 0, widen: 0, maxH: 64 } },
  ],
};
