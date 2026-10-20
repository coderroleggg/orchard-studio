// FPC (FL: FPC, Plugin database > Generators > Drum): Image-Line's
// multi-layer, velocity-sensitive pad sampler modelled on the Akai MPC. 2 banks
// x 16 pads; each pad holds layers (samples on velocity ranges, chosen together,
// randomly or in turn), a volume and a pan envelope, its note, mixer track
// offset, cut / cut-by groups, colour and icon (docs/research/gen/fpc.md).
//
// From FL 2026's FPC_x64.dylib: the 768 parameter slots (the 416 named ones are
// listed here with FL's indices, names, ranges and value texts; FL's test host
// sweeps confirm every text), the editor form (TSynthEditorForm 790 x 367) and
// the state format. A fresh instance holds FL's plugin database kit (Plugin
// database/Generators/Drum/FPC.fst); the 40 factory presets are FL's kits.
// Their layers keep FL's sample file references: no FL audio is shipped, the
// samples stay missing until the user loads their own or imports FL's library.

import type { GenPluginDef } from '../types';
import {
  FPC_ENV_KEYS, FPC_PADS_N, FPC_PRESET_NAMES, fpcEmptyPad, fpcKey, fpcKitState, fpcNormPad, fpcPadIndex, type FpcPad,
} from './fpc/state';

export * from './fpc/state';

type P = GenPluginDef['params'][number];

/** FL rounds its percentage texts half away from zero. */
const rha = (x: number) => (x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5));
/** FL's texts: volume v / 127 %, pan and envelope knobs v / 128 %, tune 9.375 cents per step (truncated). */
export const fpcVolText = (v: number) => `${rha((v / 127) * 100)}%`;
export const fpcPctText = (v: number) => `${rha((v / 128) * 100)}%`;
export const fpcTuneText = (v: number) => `${Math.trunc(v * 9.375)} cents`;
const onOff = (v: number) => (v >= 0.5 ? 'on' : 'off');

const ENV_NAMES = ['volume attack', 'volume decay', 'volume sustain', 'volume release', 'pan attack', 'pan decay', 'pan sustain', 'pan release'];

function params(): P[] {
  const out: P[] = [];
  for (let k = 0; k < FPC_PADS_N; k++) {
    const n = `Pad ${k + 1}`;
    // FL's control is 0..127, but FL's own kits store 128 and play it (2.1 dB louder than 100 %); 128 is kept here so they play at FL's level
    out.push({ key: fpcKey('vol', k), name: `${n} volume`, index: fpcPadIndex(k, 'vol'), min: 0, max: 128, def: 127, format: fpcVolText, parse: (t) => (t / 100) * 127 });
    out.push({ key: fpcKey('pan', k), name: `${n} pan`, index: fpcPadIndex(k, 'pan'), min: -128, max: 128, def: 0, bipolar: true, format: fpcPctText, parse: (t) => (t / 100) * 128 });
    out.push({ key: fpcKey('mute', k), name: `${n} mute`, index: fpcPadIndex(k, 'mute'), min: 0, max: 1, def: 0, format: onOff });
    out.push({ key: fpcKey('solo', k), name: `${n} solo`, index: fpcPadIndex(k, 'solo'), min: 0, max: 1, def: 0, format: onOff });
    out.push({ key: fpcKey('tune', k), name: `${n} tune`, index: fpcPadIndex(k, 'tune'), min: -128, max: 128, def: 0, bipolar: true, format: fpcTuneText, parse: (t) => t / 9.375 });
    FPC_ENV_KEYS.forEach((e, j) => {
      const sus = j === 2 || j === 6;
      out.push({
        key: fpcKey(e, k), name: `${n} ${ENV_NAMES[j]}`, index: 512 + 8 * k + j, min: sus ? -128 : 0, max: sus ? 128 : 256,
        def: sus ? 0 : 128, bipolar: sus, format: fpcPctText, parse: (t) => (t / 100) * 128,
      });
    });
  }
  return out.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

const num = (x: unknown, d: number, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : d);

/** Names FL gives the Piano roll keys: the first pad (in pad order) mapped to a key, by its name. */
export function fpcKeyNames(p: Record<string, unknown>): Record<number, string> {
  const pads = Array.isArray(p.pads) ? (p.pads as FpcPad[]) : [];
  const out: Record<number, string> = {};
  const seen = new Set<number>();
  for (const pad of pads) {
    if (!pad || typeof pad.key !== 'number' || seen.has(pad.key) || pad.key >= 128) continue;
    seen.add(pad.key);
    if (pad.name) out[pad.key] = pad.name;
  }
  return out;
}

export const def: GenPluginDef = {
  id: 'fpc',
  name: 'FPC',
  category: 'Drum',
  notes: 'events',
  width: 790,
  height: 367,
  description: 'Multi-layer velocity-sensitive drum pad sampler (32 pads in two banks)',
  params: params(),
  // FL's plugin database kit; view: selected pad, its layer and envelope, the bank shown, FL's view mode
  state: () => ({ ...(fpcKitState(0) ?? {}), sel: 0, layer: 0, envSel: 0, bank: 0, view: 1 }),
  normalize: (p) => {
    const q: Record<string, unknown> = { ...p };
    if (typeof q.__fpc === 'number') {
      const k = fpcKitState(q.__fpc);
      delete q.__fpc;
      if (k) Object.assign(q, k);
    }
    const pads = Array.isArray(q.pads) ? q.pads : [];
    q.pads = Array.from({ length: FPC_PADS_N }, (_, k) => (pads[k] ? fpcNormPad(pads[k], k) : fpcEmptyPad(60 + (k & 15))));
    q.loop = typeof q.loop === 'string' ? q.loop : '';
    q.sel = num(q.sel, 0, 0, FPC_PADS_N - 1);
    q.layer = num(q.layer, 0, 0, 63);
    q.envSel = num(q.envSel, 0, 0, 1);
    q.bank = num(q.bank, 0, 0, 1);
    q.view = num(q.view, 1, 0, 2);
    q.spreadLog = q.spreadLog === true;
    return q;
  },
  // view settings (FL keeps SPREAD EVEN's linear / logarithmic choice as a global option)
  viewState: ['sel', 'layer', 'envSel', 'bank', 'view', 'spreadLog'],
  keyNames: fpcKeyNames,
  presets: FPC_PRESET_NAMES.map((name, i) => ({ name, params: { __fpc: i + 1 } })),
};
