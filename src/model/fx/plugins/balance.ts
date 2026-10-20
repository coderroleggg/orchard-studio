// Balance (FL: Fruity Balance): a true balance control that pours one channel
// into the other, plus volume. Form: 227 x 148; PanWheel (Tag 0) -128..128,
// VolWheel (Tag 1) 0..320 with 256 = unity. Calibrated against FL's binary
// with flfxhost (all value texts; DSP in the engine).

import type { FxPluginDef } from '../types';

function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Balance text: "Centered", "35% left", "100% right" (FL rounds |v|·100/128 half to even: 80 reads 62%). */
export function balanceText(v: number): string {
  const p = roundHalfEven((Math.abs(v) * 100) / 128);
  if (p === 0) return 'Centered';
  return `${p}% ${v < 0 ? 'left' : 'right'}`;
}

/** FL's volume law: (11^(v/256) - 1) / 10 (320 = +5.6 dB). */
export function balanceGain(v: number): number {
  const s = v / 256;
  if (s === 1) return 1;
  return Math.max(0, (Math.pow(11, s) - 1) * 0.1);
}

/** Volume text as FL writes it: "0.0dB  1.00" (dB and linear gain, two spaces), "-InfdB  0.00". */
export function volumeText(v: number): string {
  const g = balanceGain(v);
  if (!(g > 0)) return '-InfdB  0.00';
  const db = (20 * Math.log10(g)).toFixed(1);
  return `${db === '-0.0' ? '0.0' : db}dB  ${g.toFixed(2)}`;
}

export const def: FxPluginDef = {
  id: 'balance',
  name: 'Balance',
  category: 'Gain',
  width: 227,
  height: 148,
  description: 'Stereo balance and volume',
  params: [
    {
      key: 'pan', name: 'Balance', index: 0, min: -128, max: 128, def: 0, bipolar: true, format: balanceText,
      parse: (pct) => Math.round((Math.max(-100, Math.min(100, pct)) * 128) / 100),
    },
    {
      key: 'vol', name: 'Volume', index: 1, min: 0, max: 320, def: 256, format: volumeText,
      parse: (db) => Math.round((256 * Math.log(10 * Math.pow(10, db / 20) + 1)) / Math.log(11)),
    },
  ],
};
