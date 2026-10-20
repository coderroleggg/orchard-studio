// Operator waveform for the scopes (THQWAVScope): the engine's own table
// (SyShape: harmonics drawn with SH / TN / SK / SN, half / even / absolute,
// FL's pre-filter), cached per waveform settings.

import type { SyOp } from '../../../../model/gen/plugins/sytrus/types';
import { SyShape, shapeKey } from '../../../../engine/gen/plugins/sytrus/shape';
import { C } from './theme';

const cache = new Map<string, Float32Array>();

export function opTable(op: SyOp, gibbs: boolean): Float32Array {
  const key = shapeKey(op, gibbs);
  let t = cache.get(key);
  if (!t) {
    t = new SyShape(op, gibbs).table;
    if (cache.size > 24) cache.clear();
    cache.set(key, t);
  }
  return t;
}

/** One cycle of `table` (min / max per pixel column) with the centre line. */
export function drawScope(g: CanvasRenderingContext2D, w: number, h: number, table: Float32Array, bg: string): void {
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  const mid = h / 2, amp = h / 2 - 3;
  g.fillStyle = C.scopeCenter;
  g.fillRect(0, Math.round(mid), w, 1);
  const n = table.length - 1;
  g.strokeStyle = C.scopeLine;
  g.lineWidth = 1.2;
  g.lineJoin = 'round';
  g.beginPath();
  const cols = Math.max(2, Math.round(w * 2));
  for (let c = 0; c <= cols; c++) {
    const a = Math.floor((c / cols) * n), b = Math.max(a + 1, Math.floor(((c + 1) / cols) * n));
    let lo = Infinity, hi = -Infinity;
    for (let j = a; j < Math.min(b, n + 1); j++) { const v = table[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!Number.isFinite(lo)) { lo = hi = table[Math.min(n, a)]; }
    const x = (c / cols) * w;
    const y0 = mid - Math.max(-1, Math.min(1, hi)) * amp, y1 = mid - Math.max(-1, Math.min(1, lo)) * amp;
    if (c === 0) g.moveTo(x, y0); else g.lineTo(x, y0);
    if (y1 - y0 > 1) g.lineTo(x, y1);
  }
  g.stroke();
}
