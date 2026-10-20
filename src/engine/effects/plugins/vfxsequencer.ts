// VFX Sequencer (BlueARP engine): note processing only (audio passes through).
// processNotes turns held notes into the programmed pattern on the step grid:
// - input: range filter (Truncate drops, Pass thru lets the notes through
//   unarpeggiated), range wrap (octave folding), input quantize, smart bend;
// - per step (Sync length, swing delays the even steps): the held chord is
//   ordered (Order algorithm), the step's KeySelect picks N1..N5 / Root (of the
//   detected chord) / Fix (Fixed key), StepType plays one note (Nrm), a tie
//   (Tie: legato slide), the previous notes longer (Rst), all held notes (Chr),
//   a random held note (Rnd) or nothing (Off); missing notes are replaced as
//   set (Don't play, Cyclic, First, Last, Fixed note; +-1 octave);
// - Octave (+ bit masks with Polyphonic octave), ScaleStep (semitones, or scale
//   steps with Force to scale), master transpose, force to scale (All notes /
//   Semi-transposed), output range wrap;
// - velocity from the lane, the input note or both, Gate (x the lane's 1/8 ..
//   32x), randomized velocity / gate / start;
// - the pattern restarts on Beat 0 / Key / 1st key / Play; Latch keeps the
//   last chord playing (until the next input, or one pattern length after the
//   last note in this offline model); Arp modes On, Off, Thru, 2 / 3 note
//   on/off and on/thru.

import type { EffectInstance, EffectModule } from '../types';
import { IN_QUANT_FRAC, LANES, SCALE_STEPS, SYNC_FRAC, laneKey, type LaneId } from '../../../model/fx/plugins/vfxsequencer';
import { clampKey, type VfxContext, type VfxNote } from '../../../model/fx/plugins/vfx/notes';

type P = Record<string, unknown>;

const GATE_MUL: Record<number, number> = { [-3]: 1 / 8, [-2]: 1 / 4, [-1]: 1 / 2, 0: 1, 1: 2, 2: 4, 3: 8, 4: 16, 5: 32 };

const CHORDS: { iv: number[]; minor: boolean }[] = [
  { iv: [0, 4, 7], minor: false }, { iv: [0, 3, 7], minor: true }, { iv: [0, 4, 7, 10], minor: false }, { iv: [0, 4, 7, 11], minor: false },
  { iv: [0, 3, 7, 10], minor: true }, { iv: [0, 3, 6], minor: true }, { iv: [0, 4, 8], minor: false }, { iv: [0, 2, 7], minor: false }, { iv: [0, 5, 7], minor: false },
];

/** Root pitch class and chord tones of a held chord (null: nothing to detect). */
export function detectChord(keys: number[]): { root: number; iv: number[]; minor: boolean } | null {
  if (!keys.length) return null;
  const pcs = [...new Set(keys.map((k) => ((k % 12) + 12) % 12))];
  let best: { root: number; iv: number[]; minor: boolean; score: number } | null = null;
  const lowest = ((Math.min(...keys) % 12) + 12) % 12;
  for (const r of pcs) {
    for (const c of CHORDS) {
      const rel = pcs.map((p) => (p - r + 12) % 12);
      const hit = rel.filter((x) => c.iv.includes(x)).length;
      const extra = rel.length - hit;
      const score = hit * 10 - extra * 12 - (c.iv.length - hit) * 2 + (r === lowest ? 1 : 0);
      if (!best || score > best.score) best = { root: r, iv: c.iv, minor: c.minor, score };
    }
  }
  return best && best.score > 0 ? best : { root: lowest, iv: [0], minor: false };
}

/** Snap a key onto a scale (root pitch class + intervals): the nearest scale note, ties down. */
export function snapToScale(k: number, root: number, steps: number[]): number {
  for (let d = 0; d < 12; d++) {
    for (const s of [-d, d]) {
      const pc = (((k + s - root) % 12) + 12) % 12;
      if (steps.includes(pc)) return k + s;
    }
  }
  return k;
}

/** Move a key by n steps along a scale. */
export function scaleShift(k: number, n: number, root: number, steps: number[]): number {
  let x = snapToScale(k, root, steps);
  const dir = n > 0 ? 1 : -1;
  for (let i = 0; i < Math.abs(n); i++) {
    do { x += dir; } while (!steps.includes((((x - root) % 12) + 12) % 12));
  }
  return x;
}

function wrapRange(k: number, lo: number, hi: number): number {
  if (hi - lo < 11) return Math.max(lo, Math.min(hi, k));
  while (k < lo) k += 12;
  while (k > hi) k -= 12;
  return k;
}

interface Held { n: VfxNote; key: number; order: number }

export function processNotes(notes: VfxNote[], p: P, ctx?: VfxContext): VfxNote[] {
  const v = (k: string, d: number) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : d);
  const lane = (l: LaneId, i: number) => v(laneKey(l, i), LANES.find((x) => x.id === l)!.def);
  const ppq = ctx?.ppq ?? 96;
  const rnd = ctx?.random ?? Math.random;
  const mode = Math.round(v('arpMode', 1));
  if (mode === 0) return [];

  // --- master output processing (also used by Thru)
  const scale = Math.round(v('scale', 0)), scaleKeyMode = Math.round(v('scaleKey', 0)), semiOnly = v('scaleMode', 0) >= 1;
  const transpose = Math.round(v('transOct', 0)) * 12 + Math.round(v('transSemi', 0));
  const outLow = v('outLow', 0), outHigh = v('outHigh', 127);
  const scaleOf = (held: number[]): { root: number; steps: number[] } | null => {
    if (scale === 0) return null;
    const det = detectChord(held);
    const root = scaleKeyMode === 0 ? (((Math.min(...(held.length ? held : [0]))) % 12) + 12) % 12 : scaleKeyMode === 1 ? det?.root ?? 0 : scaleKeyMode - 2;
    const steps = scale === 1 ? SCALE_STEPS[det?.minor ? 1 : 0] : SCALE_STEPS[scale - 2] ?? SCALE_STEPS[0];
    return { root, steps };
  };
  const finish = (k: number, sc: { root: number; steps: number[] } | null, shifted: boolean) => {
    let x = k + transpose;
    if (sc && (!semiOnly || shifted)) x = snapToScale(x, sc.root, sc.steps);
    return clampKey(wrapRange(x, outLow, outHigh));
  };

  // --- input conditioning
  const inLow = v('inLow', 0), inHigh = v('inHigh', 127), passThru = v('inRangeMode', 0) >= 1;
  const wLow = v('wrapLow', 0), wHigh = v('wrapHigh', 127);
  const q = IN_QUANT_FRAC[Math.round(v('inQuant', 1))] * 4 * ppq;
  const bend = Math.round(v('smartBend', 0));
  const thru: VfxNote[] = [];
  const input: Held[] = [];
  notes.forEach((n, i) => {
    if (n.key < inLow || n.key > inHigh) { if (passThru) thru.push({ ...n }); return; }
    let key = wrapRange(n.key, wLow, wHigh);
    if (bend) {
      const sc = scaleOf([key]);
      key = sc ? scaleShift(key, bend, sc.root, sc.steps) : key + bend;
    }
    let pos = n.pos, len = n.len;
    if (q > 0) { const s = Math.round(pos / q) * q; len = Math.max(1, len - (s - pos)); pos = s; }
    input.push({ n: { ...n, pos, len }, key, order: i });
  });
  if (mode === 2) {
    return [...thru, ...input.map((h) => ({ ...h.n, key: finish(h.key, scaleOf([h.key]), false) }))].sort((a, b) => a.pos - b.pos);
  }

  // --- arpeggiator
  const stepT = SYNC_FRAC[Math.round(v('sync', 4))] * 4 * ppq;
  const nSteps = Math.max(0, Math.round(v('steps', 16)));
  if (nSteps === 0 || !input.length) return thru;
  const gateFrac = v('gate', 90) * 0.008;
  const swing = (v('swing', 0) * 2) / 100;
  const order = Math.round(v('order', 0));
  const miss = Math.round(v('missKey', 0)), missOct = [0, -12, 12][Math.round(v('missOct', 0))] ?? 0;
  const fixed = v('fixedKey', 57);
  const restart = Math.round(v('restart', 0));
  const latch = v('latch', 0) >= 1;
  const polyOct = v('polyOct', 0) >= 1, polyKey = v('polyKey', 0) >= 1;
  const outVel = Math.round(v('outVelMode', 0));
  const randVel = v('randVel', 0) / 100, randGate = v('randGate', 0) / 100, randStart = v('randStart', 0) / 100;
  const minHeld = mode >= 5 ? 3 : mode >= 3 ? 2 : 1;
  const thruSingles = mode === 4 || mode === 6;

  const start = Math.floor(Math.min(...input.map((h) => h.n.pos)) / stepT) * stepT;
  const lastEnd = Math.max(...input.map((h) => h.n.pos + h.n.len));
  const end = latch ? lastEnd + nSteps * stepT : lastEnd;
  const out: VfxNote[] = [...thru];
  let latched: Held[] = [];
  let idx = -1;
  let prevHeldCount = 0;
  let lastEmitted: VfxNote[] = [];
  const singlesDone = new Set<number>();

  const sortHeld = (hs: Held[]): Held[] => {
    const a = [...hs];
    switch (order) {
      case 1: return a.sort((x, y) => y.key - x.key);
      case 2: return a.sort((x, y) => x.n.pos - y.n.pos || x.key - y.key);
      case 3: return a.sort((x, y) => y.n.pos - x.n.pos || x.key - y.key);
      case 4: return a.sort((x, y) => y.n.vel - x.n.vel || x.key - y.key);
      case 5: return a.sort((x, y) => x.n.vel - y.n.vel || x.key - y.key);
      case 6: case 7: {
        // chord orders: the detected chord, completed; normalized starts on the root, as played on the lowest key
        const det = detectChord(a.map((h) => h.key));
        a.sort((x, y) => x.key - y.key);
        if (!det || !a.length) return a;
        const lowest = a[0];
        const rootInst = a.find((h) => ((h.key % 12) + 12) % 12 === det.root) ?? lowest;
        const from = order === 6 ? rootInst.key - ((((rootInst.key - det.root) % 12) + 12) % 12) : lowest.key;
        const pcs = det.iv.map((iv) => (det.root + iv) % 12);
        const res: Held[] = [];
        for (let k = from; res.length < pcs.length && k < from + 24; k++) if (pcs.includes(((k % 12) + 12) % 12)) res.push({ n: rootInst.n, key: k, order: 0 });
        return res;
      }
      default: return a.sort((x, y) => x.key - y.key);
    }
  };

  for (let t = start; t < end; t += stepT) {
    const heldNow = input.filter((h) => h.n.pos <= t + 1e-6 && t < h.n.pos + h.n.len - 1e-6);
    const newKey = input.some((h) => h.n.pos > t - stepT + 1e-6 && h.n.pos <= t + 1e-6);
    let held = heldNow;
    if (heldNow.length) latched = heldNow;
    else if (latch) held = latched;
    // pattern position
    if (restart === 1 && newKey) idx = 0;
    else if (restart === 2 && heldNow.length && prevHeldCount === 0) idx = 0;
    else if (restart === 0 || restart === 3) idx = Math.round(t / stepT) % nSteps;
    else idx = (idx + 1) % nSteps;
    if (idx < 0) idx = 0;
    prevHeldCount = heldNow.length;
    if (held.length < minHeld) {
      if (thruSingles) for (const h of heldNow) if (!singlesDone.has(h.order)) { singlesDone.add(h.order); out.push({ ...h.n, key: finish(h.key, scaleOf([h.key]), false) }); }
      lastEmitted = [];
      continue;
    }
    const ordered = sortHeld(held);
    const type = Math.round(lane('type', idx));
    if (type === 0) { lastEmitted = []; continue; }
    if (type === 2) { for (const e of lastEmitted) e.len += stepT; continue; }
    const keySel = Math.round(lane('key', idx));
    const oct = Math.round(lane('oct', idx));
    const ss = Math.round(lane('scale', idx));
    const gl = Math.round(lane('gate', idx));
    const laneVel = lane('vel', idx);
    const sc = scaleOf(held.map((h) => h.key));
    // the notes this step plays: [key, source note, replaced]
    const picks: [number, VfxNote, boolean][] = [];
    const pickN = (k: number) => {
      if (k <= ordered.length) { const h = ordered[k - 1]; picks.push([h.key, h.n, false]); return; }
      const c = ordered.length;
      switch (miss) {
        case 1: { const h = ordered[(k - 1) % c]; picks.push([h.key + missOct, h.n, true]); break; }
        case 2: picks.push([ordered[0].key + missOct, ordered[0].n, true]); break;
        case 3: picks.push([ordered[c - 1].key + missOct, ordered[c - 1].n, true]); break;
        case 4: picks.push([fixed + missOct, ordered[0].n, true]); break;
        default: break;
      }
    };
    if (type === 4) for (const h of ordered) picks.push([h.key, h.n, false]);
    else if (type === 5) { const h = ordered[Math.min(ordered.length - 1, Math.floor(rnd() * ordered.length))]; picks.push([h.key, h.n, false]); }
    else if (polyKey && keySel > 0) {
      for (let b = 0; b < 6; b++) if (keySel & (1 << b)) { if (b === 0) { const det = detectChord(held.map((h) => h.key)); const lo = ordered[0]; picks.push([lo.key - ((((lo.key - (det?.root ?? lo.key)) % 12) + 12) % 12), lo.n, false]); } else pickN(b); }
    } else if (keySel === -1) picks.push([fixed, ordered[0].n, false]);
    else if (keySel === 0) {
      const det = detectChord(held.map((h) => h.key));
      const lo = ordered.reduce((a, b) => (b.key < a.key ? b : a));
      picks.push([lo.key - ((((lo.key - (det?.root ?? lo.key)) % 12) + 12) % 12), lo.n, false]);
    } else pickN(keySel);
    if (!picks.length) { lastEmitted = []; continue; }
    const octs = polyOct || oct > 3 ? [0, 1, 2, 3, 4, 5, 6].filter((b) => oct & (1 << b)).map((b) => b - 3) : [oct];
    const swingDelay = idx % 2 === 1 ? swing * stepT : 0;
    const emitted: VfxNote[] = [];
    for (const [k0, src] of picks) {
      for (const o of octs.length ? octs : [0]) {
        let k = k0 + o * 12;
        if (ss) k = sc ? scaleShift(k, ss, sc.root, sc.steps) : k + ss;
        const key = finish(k, sc, ss !== 0);
        const inVel = src.vel;
        const lv = (laneVel * 128) / 127;
        let vel = outVel === 1 ? inVel : outVel === 2 ? (lv * inVel) / 128 : lv;
        if (randVel > 0) vel += (2 * rnd() - 1) * randVel * 64;
        let len = stepT * gateFrac * (GATE_MUL[gl] ?? 1);
        if (randGate > 0) len *= 1 + (2 * rnd() - 1) * randGate * 0.5;
        const pos = t + swingDelay + (randStart > 0 ? rnd() * randStart * stepT * 0.5 : 0);
        const nn: VfxNote = { ...src, key, pos: Math.round(pos), len: Math.max(1, Math.round(len)), vel: Math.round(Math.min(128, Math.max(1, vel))) };
        delete nn.mod;
        if (type === 3) {
          nn.slide = true;
          for (const e of lastEmitted) e.len = Math.max(e.len, nn.pos - e.pos + 1);
        }
        emitted.push(nn);
        out.push(nn);
      }
    }
    lastEmitted = emitted;
  }
  return out.sort((a, b) => a.pos - b.pos || a.key - b.key);
}

class Sequencer implements EffectInstance {
  private p: P = {};
  setParams(p: unknown): void { this.p = (p ?? {}) as P; }
  process(): void { /* audio passes through */ }
  reset(): void {}
  notes(n: VfxNote[], ctx?: VfxContext): VfxNote[] { return processNotes(n, this.p, ctx); }
}

export const effect: EffectModule = { id: 'vfxsequencer', create: () => new Sequencer() };
