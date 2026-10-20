// Send (FL: Fruity Send): a pre-fader send from any point of the FX chain to
// another mixer track, with send pan / volume and a dry (pass-through) level.
// Form: 258 x 84; PanWheel (Tag 0) -128..128, VolWheel (Tag 1) 0..320 with
// 256 = 0 dB, DryVolWheel (Tag 2) 0..256; the target selector (a DigiWheel
// plus the "Send to" menu button, Tag -1) is not a parameter.
//
// FL keeps the target as an index into the host's list of the track's
// outputs (the tracks it is routed to); the clone stores the target mixer
// track itself (`target`, -1 = none) and shows FL's index in the editor.

import type { FxPluginDef } from '../types';

/** FL's gain law for the send volume and the dry level: (11^(v/256) - 1) / 10. */
export function sendGain(v: number): number {
  const s = v / 256;
  if (s === 1) return 1;
  return Math.max(0, (Math.pow(11, s) - 1) * 0.1);
}

export function sendPosFromGain(g: number): number {
  return (256 * Math.log(Math.max(0, g) * 10 + 1)) / Math.log(11);
}

function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Send pan text: FL truncates to its -64..64 pan scale ("Centered", "98% left"). */
export function sendPanText(v: number): string {
  const p64 = Math.trunc(v / 2);
  if (p64 === 0) return 'Centered';
  return `${roundHalfEven((Math.abs(p64) * 100) / 64)}% ${p64 < 0 ? 'left' : 'right'}`;
}

export function sendVolText(v: number): string {
  const g = sendGain(v);
  if (!(g > 0)) return '-InfdB';
  const s = (20 * Math.log10(g)).toFixed(1);
  return (s === '-0.0' ? '0.0' : s) + 'dB';
}

/** Dry level text: a plain percentage of the wheel (the gain follows the 11^x law). */
export function sendDryText(v: number): string {
  return `${Math.floor((v / 256) * 100 + 0.5)}%`;
}

export const def: FxPluginDef = {
  id: 'send',
  name: 'Send',
  category: 'Gain',
  width: 258,
  height: 84,
  description: 'Sends audio from this point of the effect chain to another mixer track',
  params: [
    {
      key: 'pan', name: 'Send panning', index: 0, min: -128, max: 128, def: 0, bipolar: true, format: sendPanText,
      parse: (pct) => Math.round((Math.max(-100, Math.min(100, pct)) * 128) / 100),
    },
    {
      key: 'vol', name: 'Send volume', index: 1, min: 0, max: 320, def: 256, format: sendVolText,
      parse: (db) => Math.round(sendPosFromGain(Math.pow(10, db / 20))),
    },
    { key: 'dry', name: 'Dry level', index: 2, min: 0, max: 256, def: 256, format: sendDryText, parse: (pct) => Math.round(pct * 2.56) },
  ],
  state: () => ({ target: -1 }),
  normalize: (p) => {
    const t = Number(p.target);
    return { ...p, target: Number.isInteger(t) && t >= 0 ? t : -1 };
  },
};
