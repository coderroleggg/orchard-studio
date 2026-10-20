// Wave Traveller's plugin state (FL's SaveRestoreState 0x645f0: header chunk 1000, one chunk 2000 per key,
// end chunk 3000) as JSON, the spline point model and the spline -> table builder shared by the engine and
// the editor. See docs/research/gen/wavetraveller.md.
//
// FL's model (FL 2026 binary, Wave Traveller_x64.dylib, arm64 slice, class CWWarper / TCSplinePt):
// - 120 patches (keys 0..119), each with the sample region START / END (fractions of the sample), SPEED
//   (phrase length in beats, or the absolute speed factor), ATT / REL (ms), the speed mode and three lists:
//   the WAVE spline (time -> sample position), the VOL spline (time -> volume) and the mutes;
// - every spline is flattened into a 1024-entry table (float32) by `buildTable` (CWWarper 0x6c740).

const f32 = Math.fround;

/** FL's number of patches (keys 0..119). */
export const WT_KEYS = 120;
/** Entries of a spline table (FL: 1024 floats). */
export const WT_TABLE = 1024;

/** Spline segment types (the SplineEditorMenu tags): the type of a point is the shape of the segment to its right. */
export const WT_LINEAR = 1;
export const WT_HALF_COSINE = 2;
export const WT_BEZIER = 3;
export const WT_QUARTER_SINE = 4;
export const WT_QUARTER_COSINE = 5;
export const WT_TENSION = 6;
export const WT_MUTE = 8;

/** The segment types FL's table builder knows. */
export const WT_TYPES = [WT_LINEAR, WT_HALF_COSINE, WT_BEZIER, WT_QUARTER_SINE, WT_QUARTER_COSINE, WT_TENSION, WT_MUTE] as const;

/** Menu names of the types (FL's SplineEditorMenu captions). */
export const WT_TYPE_NAMES: Record<number, string> = {
  1: 'Linear', 2: 'Half cosine', 3: 'Bezier', 4: 'Quarter sine', 5: 'Quarter cosine', 6: 'Tension', 8: 'Mute',
};

/** A spline point (FL's TCSplinePt record, 60 bytes). */
export interface WtPoint {
  /** Time 0..1 (the phrase). */
  x: number;
  /** Value 0..1 (position in the START..END region for the WAVE spline, volume for the VOL spline). */
  y: number;
  /** Shape of the segment to the right (WT_* types). */
  type: number;
  /** Tension segments: 0..1, 0.5 = straight. */
  tension: number;
  /** Bezier handles (offsets from the point, FL stores them / 3): h1 comes in from the left, h2 goes out to the right. */
  h1x: number; h1y: number; h2x: number; h2y: number;
  /** FL's point flag (record byte 0x38; set on every inserted point of FL's presets, clear on the end points). */
  locked: boolean;
}

/** A mute change: from `t` (0..1 of the phrase) the patch plays (on) or is muted (FL's TBlnPt). */
export type WtMute = [on: number, t: number];

/** One patch (FL's 0x2xxx-byte patch object of the key). */
export interface WtPatch {
  /** Patch name ('' = FL's "Patch <key>"). */
  name: string;
  /** START / END of the sample region, 0..1 (FL 0x2010 / 0x2014). */
  start: number;
  end: number;
  /** Tempo based speed: the phrase length in beats (FL 0x2018, the wheel maps 0..1 to 0.125..8; shown as steps = beats x 4). */
  steps: number;
  /** Absolute speed factor (FL 0x201c, the wheel maps 0..1 to 0.25..4; 1 = original speed). */
  speed: number;
  /** ATT / REL in ms (FL 0x2020 / 0x2024; the wheels map to 1..500 and 1..1000). */
  attack: number;
  release: number;
  /** Speed mode: 0 = tempo based spline, 1 = absolute speed based spline (FL 0x2030). */
  mode: number;
  /** WAVE spline (sample position over the phrase) and VOL spline (volume). */
  wave: WtPoint[];
  vol: WtPoint[];
  /** Mutes (FL's list 0x2050): [on, time], sorted by time. */
  mutes: WtMute[];
}

/** Compact patch data (the preset tables): points as [x, y, type, locked], missing fields at FL's defaults. */
export interface WtPatchSeed {
  name?: string; start?: number; end?: number; steps?: number; speed?: number; attack?: number; release?: number; mode?: number;
  wave: ([number, number, number, number] | [number, number, number, number, number, number, number, number, number])[];
  vol: ([number, number, number, number] | [number, number, number, number, number, number, number, number, number])[];
  mutes: [number, number][];
}

/** The plugin state. */
export interface WtState {
  /** Pool sample id of the loaded audio ('' = none). */
  sample: string;
  /** The file name FL shows (SamplePathLabel); a factory preset names the FL pack sample it was made for. */
  file: string;
  /** The selected patch key (FL's header key; the patch selector keyboard). */
  key: number;
  /** The patches that differ from the default (sparse; missing keys are default patches). */
  patches: Record<string, WtPatch>;
  /** OPTIONS > Continuous output (no audible effect found in FL's DSP). */
  continuous: boolean;
  /** Editor view: WAVE (0) / VOL (1) page, patch selector octave scroll (0..8), snap (0 off, 1..6: 1/16 ... 1/3). */
  part: number;
  octave: number;
  snap: number;
}

export const WT_DEFAULT_HANDLE = 0.042;

/** FL's new point (TCSplinePt.Create 0x6e420 with the engine's defaults). */
export function newPoint(x: number, y: number, type = WT_LINEAR, locked = false): WtPoint {
  return {
    x: f32(x), y: f32(y), type, tension: 0.5, h1x: f32(-WT_DEFAULT_HANDLE), h1y: 0, h2x: f32(WT_DEFAULT_HANDLE), h2y: 0, locked,
  };
}

/** FL's default patch (CWWarper 0x69670: START 0, END 1, 4 beats, a straight WAVE line, full VOL, no mutes). */
export function defaultPatch(): WtPatch {
  return {
    name: '', start: 0, end: 1, steps: 4, speed: 1, attack: 1, release: 1, mode: 0,
    wave: [newPoint(0, 0), newPoint(1, 1)],
    vol: [newPoint(0, 1), newPoint(1, 1)],
    mutes: [[1, 0]],
  };
}

export function clonePatch(p: WtPatch): WtPatch {
  return {
    ...p,
    wave: p.wave.map((q) => ({ ...q })),
    vol: p.vol.map((q) => ({ ...q })),
    mutes: p.mutes.map((m) => [m[0], m[1]] as WtMute),
  };
}

/** A patch from compact data (the preset tables). */
export function patchFromSeed(s: WtPatchSeed): WtPatch {
  const mk = (a: WtPatchSeed['wave']) => a.map((r) => {
    const q = newPoint(r[0], r[1], r[2], !!r[3]);
    if (r.length > 4) { q.tension = f32(r[4] as number); q.h1x = f32(r[5] as number); q.h1y = f32(r[6] as number); q.h2x = f32(r[7] as number); q.h2y = f32(r[8] as number); }
    return q;
  });
  return normalizePatch({
    name: s.name ?? '', start: s.start ?? 0, end: s.end ?? 1, steps: s.steps ?? 4, speed: s.speed ?? 1,
    attack: s.attack ?? 1, release: s.release ?? 1, mode: s.mode ?? 0,
    wave: mk(s.wave), vol: mk(s.vol), mutes: s.mutes.map((m) => [m[0], m[1]] as WtMute),
  });
}

export function defaultWtState(): WtState {
  return { sample: '', file: '', key: 60, patches: {}, continuous: false, part: 0, octave: 5, snap: 0 };
}

const num = (v: unknown, d: number, lo: number, hi: number): number => {
  const x = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
};
const int = (v: unknown, d: number, lo: number, hi: number): number => Math.round(num(v, d, lo, hi));

function normalizePoints(raw: unknown, dflt: () => WtPoint[]): WtPoint[] {
  if (!Array.isArray(raw)) return dflt();
  const pts: WtPoint[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const q = r as Record<string, unknown>;
    const type = int(q.type, WT_LINEAR, 0, 99);
    pts.push({
      x: f32(num(q.x, 0, 0, 1)), y: f32(num(q.y, 0, 0, 1)),
      type: (WT_TYPES as readonly number[]).includes(type) ? type : WT_LINEAR,
      tension: f32(num(q.tension, 0.5, 0.001, 0.999)),
      h1x: f32(num(q.h1x, -WT_DEFAULT_HANDLE, -1, 1)), h1y: f32(num(q.h1y, 0, -1, 1)),
      h2x: f32(num(q.h2x, WT_DEFAULT_HANDLE, -1, 1)), h2y: f32(num(q.h2y, 0, -1, 1)),
      locked: !!q.locked,
    });
  }
  if (pts.length < 2) return dflt();
  // FL keeps the list ordered by time (the editor inserts in order)
  pts.sort((a, b) => a.x - b.x);
  return pts;
}

/** Repair a stored patch (types, ranges, point order). */
export function normalizePatch(p: unknown): WtPatch {
  const s = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const d = defaultPatch();
  let mutes: WtMute[] = [];
  if (Array.isArray(s.mutes)) {
    for (const m of s.mutes) {
      if (Array.isArray(m) && m.length >= 2) mutes.push([m[0] ? 1 : 0, f32(num(m[1], 0, 0, 1))]);
    }
  }
  if (!mutes.length) mutes = [[1, 0]];
  const start = f32(num(s.start, 0, 0, 1));
  const end = f32(num(s.end, 1, 0, 1));
  return {
    name: typeof s.name === 'string' ? s.name.slice(0, 255) : '',
    start, end,
    steps: f32(num(s.steps, d.steps, 0.125, 8)),
    speed: f32(num(s.speed, d.speed, 0.25, 4)),
    attack: f32(num(s.attack, d.attack, 1, 500)),
    release: f32(num(s.release, d.release, 1, 1000)),
    mode: int(s.mode, 0, 0, 1),
    wave: normalizePoints(s.wave, () => d.wave),
    vol: normalizePoints(s.vol, () => d.vol),
    mutes,
  };
}

/** Repair a stored state (types, ranges, the sparse patch map). */
export function normalizeWtState(p: Record<string, unknown>): Record<string, unknown> {
  const d = defaultWtState();
  const patches: Record<string, WtPatch> = {};
  const raw = p.patches && typeof p.patches === 'object' ? (p.patches as Record<string, unknown>) : {};
  for (const k of Object.keys(raw)) {
    const key = Number(k);
    if (!Number.isInteger(key) || key < 0 || key >= WT_KEYS) continue;
    patches[String(key)] = normalizePatch(raw[k]);
  }
  return {
    ...p,
    sample: typeof p.sample === 'string' ? p.sample : '',
    file: typeof p.file === 'string' ? p.file.slice(0, 255) : '',
    key: int(p.key, d.key, 0, WT_KEYS - 1),
    patches,
    continuous: !!p.continuous,
    part: int(p.part, 0, 0, 1),
    octave: int(p.octave, d.octave, 0, 8),
    snap: int(p.snap, 0, 0, 6),
  };
}

/** Read a (normalised) state with defaults. */
export function wtState(p: unknown): WtState {
  return normalizeWtState((p && typeof p === 'object' ? p : {}) as Record<string, unknown>) as unknown as WtState;
}

/** The patch of a key (the default patch for keys without an own entry). */
export function patchOf(s: Pick<WtState, 'patches'>, key: number): WtPatch {
  return s.patches[String(key)] ?? defaultPatch();
}

// ------------------------------------------------------------------------------------------ spline tables

const f32buf = new Float32Array(1);
const u32buf = new Uint32Array(f32buf.buffer);

/** FL's clamp of a table entry (0x6c740): negative -> 0, above 1 (or NaN) -> 1, by the float's bits. */
function clampTab(y: number): number {
  f32buf[0] = y;
  const b = u32buf[0];
  if (b & 0x80000000) return 0;
  if (b > 0x3f800000) return 1;
  return f32buf[0];
}

/** round to nearest even (FRINTX under the default rounding mode), as an integer. */
function roundEven(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const r = Math.round(x);
  return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
}

/** FL's pi constants (the plugin uses 3.1415926 / 1.5707963, not the exact values). */
const PI_FL = 3.1415926;
const HALF_PI_FL = 1.5707963;

const bufX = new Float32Array(256);
const bufY = new Float32Array(256);

/** FL's Bezier flattening (0x6d830): 256 points of the cubic with control points p0 + 3 h2 and p3 + 3 h1. */
function flattenBezier(n: number, x0: number, y0: number, x3: number, y3: number, cx0: number, cy0: number, cx1: number, cy1: number): void {
  const dt = 1 / (n - 1);
  let t = 0;
  for (let k = 0; k < n; k++) {
    const u = 1 - t;
    const b0 = u * u * u;
    const b3 = t * t * t;
    const b1 = 3 * t * u * u;
    const b2 = 3 * t * t * u;
    bufX[k] = f32(b0 * x0 + b1 * cx0 + b2 * cx1 + b3 * x3);
    bufY[k] = f32(b0 * y0 + b1 * cy0 + b2 * cy1 + b3 * y3);
    t = (k + 1) * dt;
  }
}

export interface WtTableInfo {
  /** Index of the last valid entry (FL's patch field 0x1008 / 0x200c: entries 0..last). */
  last: number;
  /** Minimum / maximum of the curve before clamping (FL 0x2028 / 0x202c; start at 1 / 0). */
  min: number;
  max: number;
}

/**
 * FL's spline flattening (CWWarper 0x6c740): every segment between neighbouring points gets
 * round(dx x 1023) entries of the curve of its left point's type; the segment's last entry is
 * overwritten by the next segment's first. Entries are clamped to 0..1. float32 maths throughout.
 */
export function buildTable(pts: readonly WtPoint[], tab: Float32Array): WtTableInfo {
  let min = 1;
  let max = 0;
  let w = 1;
  const put = (y: number): void => {
    if (w >= 0 && w < WT_TABLE) tab[w] = clampTab(y);
    w++;
    if (y < min) min = y;
    if (y > max) max = y;
  };
  for (let i = 0; i + 1 < pts.length; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const dx = f32(p1.x - p0.x);
    const n = roundEven(f32(dx * 1023));
    w -= 1;
    const dy = f32(p1.y - p0.y);
    switch (p0.type) {
      case WT_LINEAR: {
        const step = f32(dy / f32(n - 1));
        let y = p0.y;
        for (let k = 0; k < n; k++) { put(y); y = f32(y + step); }
        break;
      }
      case WT_HALF_COSINE: {
        const dt = f32(PI_FL / (n - 1));
        const amp = f32(dy * 0.5);
        let t = 0;
        let y = p0.y;
        for (let k = 0; k < n; k++) {
          put(y);
          t = f32(t + dt);
          y = f32(p0.y + amp * (Math.cos(t + PI_FL) + 1));
        }
        break;
      }
      case WT_QUARTER_COSINE: {
        const dt = f32(HALF_PI_FL / (n - 1));
        let t = 0;
        let y = p0.y;
        for (let k = 0; k < n; k++) {
          put(y);
          t = f32(t + dt);
          y = f32(p0.y + dy * (Math.cos(t + PI_FL) + 1));
        }
        break;
      }
      case WT_QUARTER_SINE: {
        const dt = f32(HALF_PI_FL / (n - 1));
        let t = 0;
        let y = p0.y;
        for (let k = 0; k < n; k++) {
          put(y);
          t = f32(t + dt);
          y = f32(p0.y + dy * Math.sin(t));
        }
        break;
      }
      case WT_TENSION: {
        const tn = p0.tension;
        if (tn === 0.5) {
          const step = f32(dy / f32(n - 2));
          let y = p0.y;
          for (let k = 0; k < n; k++) { put(y); y = f32(y + step); }
        } else {
          const dt = f32(1 / (n - 1));
          const a = f32(f32(1 - f32(2 * tn)) / f32(tn * tn));
          const k1 = f32(dy / a);
          const L = f32(Math.log(f32(a + 1)));
          let t = 0;
          let y = p0.y;
          for (let k = 0; k < n; k++) {
            t = f32(t + dt);
            put(y);
            y = f32(p0.y + k1 * (Math.exp(f32(t * L)) - 1));
          }
        }
        break;
      }
      case WT_BEZIER: {
        const c1y = f32(f32(p1.h1y * 3) + p1.y);
        const c1x = f32(f32(p1.h1x * 3) + p1.x);
        const c0y = f32(f32(p0.h2y * 3) + p0.y);
        const c0x = f32(f32(p0.h2x * 3) + p0.x);
        flattenBezier(256, p0.x, p0.y, p1.x, p1.y, c0x, c0y, c1x, c1y);
        let y = p0.y;
        let j = 0;
        for (let k = 0; k < n; k++) {
          put(y);
          const xk = f32(p0.x + f32(f32((k + 1) * dx) / f32(n - 1)));
          if (xk > p1.x) break;
          if (bufX[j] === xk) { y = bufY[j]; continue; }
          while (j < 255 && bufX[j] < xk) j++;
          if (bufX[j] === xk) { y = bufY[j]; continue; }
          if (j === 0) { y = bufY[0]; continue; }
          const sy = bufY[j] - bufY[j - 1];
          const sx = bufX[j] - bufX[j - 1];
          const slope = f32(f32(sy) / f32(sx));
          y = f32(bufY[j - 1] + slope * (xk - bufX[j - 1]));
        }
        break;
      }
      case WT_MUTE: {
        for (let k = 0; k < n; k++) { if (w >= 0 && w < WT_TABLE) tab[w] = 0; w++; }
        if (0 < min) min = 0;
        break;
      }
      default:
        break;
    }
  }
  return { last: w - 1, min, max };
}

// ------------------------------------------------------------------------------------------ control mapping

/** FL's wheel <-> value mappings (CWWarper 0x6d9a0..0x6dd00); `v` is the wheel position 0..1. */
export const speedFromWheel = (mode: number, v: number): number => (mode === 0 ? f32(0.125 + f32(v * 7.875)) : f32(0.25 + f32(v * 3.75)));
export const speedToWheel = (mode: number, x: number): number => (mode === 0 ? f32(f32(x - 0.125) / 7.875) : f32(f32(x - 0.25) / 3.75));
export const attackFromWheel = (v: number): number => f32(1 + f32(v * 499));
export const attackToWheel = (x: number): number => f32(f32(x - 1) / 499);
export const releaseFromWheel = (v: number): number => f32(1 + f32(v * 999));
export const releaseToWheel = (x: number): number => f32(f32(x - 1) / 999);

/** Wheel ranges of FL's form (SpeedWheel 0..1024, AttackWheel 0..100, ReleaseWheel 0..5000, START / END 0..10000). */
export const WT_WHEELS = {
  speed: { min: 0, max: 1024 },
  attack: { min: 0, max: 100 },
  release: { min: 0, max: 5000 },
  start: { min: 0, max: 10000 },
  end: { min: 0, max: 10000 },
} as const;

/** Width of FL's waveform display in pixels: START and END keep at least one pixel (1/251) apart. */
export const WT_SCOPE_W = 252;

/** Hint texts of the wheels (FL: "%.3f (Steps)", "%.3f (ms)", "%d %%"). */
export function speedText(p: Pick<WtPatch, 'mode' | 'steps' | 'speed'>): string {
  return p.mode === 0 ? `${(p.steps * 4).toFixed(3)} (Steps)` : `${Math.round(p.speed * 100)} %`;
}
export const attackText = (ms: number): string => `${ms.toFixed(3)} (ms)`;
export const releaseText = (ms: number): string => `${ms.toFixed(3)} (ms)`;
export const regionText = (v: number): string => `${Math.round(v * 100)} %`;
