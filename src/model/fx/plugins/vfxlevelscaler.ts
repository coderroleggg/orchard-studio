// VFX Level Scaler (FL: VFX Level Scaler): a live version of the piano roll's
// Level Scale tool. For each note property (Velocity, Release, Fine Pitch,
// Pan, Mod X, Mod Y) the input value is mapped through a tension curve around
// a centre, multiplied (around the centre), offset and humanized.
// Form: SynthPanel 566 x 481. Parameters (FL's names, 6 per property, Tags
// 0..5 for the visible tab): Center 0..8192, Multiplier -16384..16384 (8192 =
// x1), Offset -8192..8192, Tension -8192..8192, Humanize amount 0..16384,
// Humanize mode 0..2 (Subtract / Spread / Add). The plugin reports no value
// texts; the clone shows percentages.

import type { FxParamDef, FxPluginDef } from '../types';

export const LS_TARGETS = [
  { id: 'vel', name: 'Velocity', tab: 'Velocity', center: 0 },
  { id: 'rel', name: 'Release', tab: 'Release', center: 0 },
  { id: 'pitch', name: 'Fine Pitch', tab: 'Pitch', center: 4096 },
  { id: 'pan', name: 'Pan', tab: 'Pan', center: 0 },
  { id: 'modx', name: 'Mod X', tab: 'Mod X', center: 4096 },
  { id: 'mody', name: 'Mod Y', tab: 'Mod Y', center: 4096 },
] as const;

export type LsField = 'Center' | 'Mul' | 'Ofs' | 'Tension' | 'Hum' | 'HumMode';
export const lsKey = (t: number, f: LsField): string => `${LS_TARGETS[t].id}${f}`;

export const HUMANIZE_MODES = ['Subtract', 'Spread', 'Add'];

const pct = (v: number, full: number) => `${Math.round((v / full) * 100)}%`;
const spct = (v: number, full: number) => { const p = Math.round((v / full) * 100); return `${p > 0 ? '+' : ''}${p}%`; };

function params(): FxParamDef[] {
  const out: FxParamDef[] = [];
  LS_TARGETS.forEach((t, i) => {
    const b = i * 6;
    out.push(
      { key: lsKey(i, 'Center'), name: `${t.name} - Center`, index: b, min: 0, max: 8192, def: t.center, format: (v) => pct(v, 8192) },
      { key: lsKey(i, 'Mul'), name: `${t.name} - Multiplier`, index: b + 1, min: -16384, max: 16384, def: 8192, bipolar: true, format: (v) => pct(v, 8192) },
      { key: lsKey(i, 'Ofs'), name: `${t.name} - Offset`, index: b + 2, min: -8192, max: 8192, def: 0, bipolar: true, format: (v) => spct(v, 8192) },
      { key: lsKey(i, 'Tension'), name: `${t.name} - Tension`, index: b + 3, min: -8192, max: 8192, def: 0, bipolar: true, format: (v) => spct(v, 8192) },
      { key: lsKey(i, 'Hum'), name: `${t.name} - Humanize amount`, index: b + 4, min: 0, max: 16384, def: 0, format: (v) => pct(v, 16384) },
      { key: lsKey(i, 'HumMode'), name: `${t.name} - Humanize mode`, index: b + 5, min: 0, max: 2, def: 1, options: HUMANIZE_MODES },
    );
  });
  return out;
}

export interface LsChannel {
  center: number; // 0..1
  mul: number; // -2..2
  ofs: number; // -1..1
  tension: number; // -1..1
  hum: number; // 0..1 (knob position)
  mode: number; // 0 subtract, 1 spread, 2 add
}

export function lsChannel(p: Record<string, unknown>, t: number): LsChannel {
  const n = (f: LsField, d: number) => { const v = p[lsKey(t, f)]; return typeof v === 'number' && Number.isFinite(v) ? v : d; };
  return {
    center: Math.min(1, Math.max(0, n('Center', LS_TARGETS[t].center) / 8192)),
    mul: n('Mul', 8192) / 8192,
    ofs: n('Ofs', 0) / 8192,
    tension: Math.min(1, Math.max(-1, n('Tension', 0) / 8192)),
    hum: Math.min(1, Math.max(0, n('Hum', 0) / 16384)),
    mode: Math.round(n('HumMode', 1)),
  };
}

/** The tension curve: an S around the centre (positive tension: steep at the centre, flat at the ends). */
export function tensionCurve(x: number, center: number, tension: number): number {
  const xc = Math.min(1, Math.max(0, x));
  if (Math.abs(tension) < 1e-6) return xc;
  const e = Math.pow(2, 3 * tension);
  const bend = (d: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, d)), e);
  if (xc >= center) {
    const span = 1 - center;
    return span <= 0 ? xc : center + span * bend((xc - center) / span);
  }
  return center <= 0 ? xc : center - center * bend((center - xc) / center);
}

/** Humanize half-width (the knob's position maps through a square root, matching FL's band width). */
export const humanizeWidth = (hum: number): number => Math.sqrt(Math.max(0, hum));

/** The mapped value before humanizing (0..1). */
export function lsCurve(x: number, c: LsChannel): number {
  const y = c.center + (tensionCurve(x, c.center, c.tension) - c.center) * c.mul + c.ofs;
  return Math.min(1, Math.max(0, y));
}

/** The humanize band around the curve at x: [low, high] (0..1). */
export function lsBand(x: number, c: LsChannel): [number, number] {
  const y = c.center + (tensionCurve(x, c.center, c.tension) - c.center) * c.mul + c.ofs;
  const a = humanizeWidth(c.hum);
  const lo = c.mode === 2 ? y : y - a, hi = c.mode === 0 ? y : y + a;
  return [Math.min(1, Math.max(0, lo)), Math.min(1, Math.max(0, hi))];
}

/** One mapped value; `r` is a random number 0..1 for the humanizer. */
export function lsMap(x: number, c: LsChannel, r: number): number {
  let y = c.center + (tensionCurve(x, c.center, c.tension) - c.center) * c.mul + c.ofs;
  if (c.hum > 0) {
    const a = humanizeWidth(c.hum);
    if (c.mode === 0) y -= r * a;
    else if (c.mode === 2) y += r * a;
    else y += (2 * r - 1) * a;
  }
  return Math.min(1, Math.max(0, y));
}

export const def: FxPluginDef = {
  id: 'vfxlevelscaler',
  name: 'VFX Level Scaler',
  category: 'Patcher',
  width: 566,
  height: 481,
  description: 'Scale note velocity, release, pitch, pan and mod X / Y live (Patcher)',
  params: params(),
  state: () => ({ fade: 12288 }),
};
