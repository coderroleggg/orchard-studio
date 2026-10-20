// FL's envelope editor data (TMEnvEditor) for the VFX plugins: points with an
// absolute position, a value 0..1, the tension and the curve mode of the
// segment that ends at the point - the same point model and evaluator as
// automation clips (src/model/automation.ts).

import { CURVE_TAG, evalEnvelope, type AutoPoint, type CurveMode } from '../../../automation';

export type EnvPoints = AutoPoint[];

const MODE_OF: CurveMode[] = (() => {
  const m: CurveMode[] = [];
  for (const [k, v] of Object.entries(CURVE_TAG)) m[v] = k as CurveMode;
  return m;
})();

/** FL's stored mode number -> curve mode. */
export function curveModeOf(tag: number): CurveMode {
  return MODE_OF[tag] ?? 'single';
}

/** Compact preset form [pos, value, tension?, modeTag?] -> points. */
export function envFrom(c: number[][]): EnvPoints {
  return c.map(([pos, value, tension = 0, mode = 0]) => ({ pos, value, tension, mode: curveModeOf(mode) }));
}

export function flatEnv(value: number, length = 1): EnvPoints {
  return [{ pos: 0, value, tension: 0, mode: 'single' }, { pos: length, value, tension: 0, mode: 'single' }];
}

/** Repair stored points: sorted, finite, values 0..1, at least two points spanning 0..length. */
export function normalizeEnv(raw: unknown, fallback: EnvPoints, length = 1): EnvPoints {
  if (!Array.isArray(raw) || raw.length < 2) return fallback.map((p) => ({ ...p }));
  const pts: EnvPoints = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const p = q as Partial<AutoPoint>;
    const pos = typeof p.pos === 'number' && Number.isFinite(p.pos) ? Math.min(length, Math.max(0, p.pos)) : null;
    const value = typeof p.value === 'number' && Number.isFinite(p.value) ? Math.min(1, Math.max(0, p.value)) : null;
    if (pos === null || value === null) continue;
    pts.push({ pos, value, tension: typeof p.tension === 'number' && Number.isFinite(p.tension) ? Math.max(-1, Math.min(1, p.tension)) : 0, mode: typeof p.mode === 'string' && p.mode in CURVE_TAG ? p.mode : 'single' });
  }
  if (pts.length < 2) return fallback.map((p) => ({ ...p }));
  pts.sort((a, b) => a.pos - b.pos);
  pts[0].pos = 0;
  pts[pts.length - 1].pos = length;
  return pts;
}

export function envAt(points: EnvPoints, pos: number): number {
  return evalEnvelope(points, pos);
}
