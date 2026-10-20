// Drumaxx's parameter keys and pattern helpers (shared by the definition, the
// engine and the editor; the kit bank is in ./state.ts). FL's 719 parameters: per pad (16 x 44: Volume,
// Panning, Mute, Solo, Key, the 38 Drumpad parameters, one reserved), then
// reserved 704, Master Level, Swing, EQ Enable, EQ Band 1..8, Limiter Enable,
// Gain, Release. A kit (FL's .fst state "3SMD" / "4SMD", 21636 bytes): name /
// comment (256 bytes), 720 floats (the parameters' engine values), 16 patterns
// (length - 1, trigger key, 16 tracks x 64 step bytes: bit 7 on, bits 0..6
// velocity), 16 pad names (128 bytes each), 16 cut groups, 16 mixer track
// offsets (7-bit varints).

import { DP_KEYS } from '../drumpad/keys';
import { base64ToBytes } from './inflate';

export const DX_PADS = 16;
/** Per-pad parameter names after the 5 pad controls (FL: the Drumpad parameters). */
export const DX_PAD_LOCAL = ['vol', 'pan', 'mute', 'solo', 'key', ...DP_KEYS];
export const DX_GLOBAL = ['master', 'swing', 'eqOn', 'eq1', 'eq2', 'eq3', 'eq4', 'eq5', 'eq6', 'eq7', 'eq8', 'limOn', 'limGain', 'limRelease'];
/** FL index of the first global (Master Level). */
export const DX_GLOBAL_BASE = 705;

/** Parameter key of pad k (0..15), local j (0..42). */
export const dxKey = (k: number, j: number): string => `p${k + 1}_${DX_PAD_LOCAL[j]}`;

/** FL parameter index -> key ('' for reserved indices). */
export function dxKeyOf(index: number): string {
  if (index < 704) {
    const k = Math.floor(index / 44), j = index % 44;
    return j < 43 ? dxKey(k, j) : '';
  }
  const g = index - DX_GLOBAL_BASE;
  return g >= 0 && g < DX_GLOBAL.length ? DX_GLOBAL[g] : '';
}

/** Parameters FL's wrapper hands the engine as they are (key, velocity targets); the rest control / 256. */
export const dxRaw = (local: number): boolean => local === 4 || (local >= 35 && local <= 38);

/** A pattern as stored in the state (steps: base64 of 16 tracks x 64 step bytes). */
export interface DxPattern { len: number; key: number; steps: string }

const EMPTY_STEPS = (() => {
  const b = new Uint8Array(1024).fill(0x7f);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
})();

export const dxEmptyPattern = (): DxPattern => ({ len: 15, key: 127, steps: EMPTY_STEPS });

/** Decode a pattern's step bytes (cached by string). */
const stepCache = new Map<string, Uint8Array>();
export function dxSteps(s: string): Uint8Array {
  let b = stepCache.get(s);
  if (!b) {
    b = new Uint8Array(1024).fill(0x7f);
    try { const d = base64ToBytes(s); b.set(d.subarray(0, 1024)); } catch { /* keep empty */ }
    if (stepCache.size > 512) stepCache.clear();
    stepCache.set(s, b);
  }
  return b;
}

export function dxEncodeSteps(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < 1024; i++) s += String.fromCharCode(b[i] ?? 0x7f);
  return btoa(s);
}

