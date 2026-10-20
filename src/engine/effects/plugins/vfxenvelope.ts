// VFX Envelope: note processing only (audio passes through).
// A note is handled by the first articulator whose colour is the note's and
// whose key range holds it. For each active target the property follows
//   out = base + env_level * ((env - neutral) + lfo_level * amount * wave / 2)
// (neutral 0 for velocity, 0.5 for the bipolar targets; the LFO adds to the
// envelope and the ENV knob scales both, so FL's Vibrato preset gives a small
// vibrato with ENV at 2/256). The envelope plays from the note start: while
// the note is held it stops at the S marker (sustain) or loops between D and
// S (loop on); after the note-off it plays on from S. ATT / DEC / REL scale
// the parts before D, between D and S and after S; SUS offsets S's level.
// The result is written as curves in note.mod (ticks from the note start):
// vel (absolute velocity = note velocity * out), pitch (semitones, +-48),
// pan (0..128), modX / modY (0..255).

import type { EffectInstance, EffectModule } from '../types';
import {
  ENV_TARGETS, envKey, envTimeScale, lfoCyclesPerBeat, normalizeArticulators, type EnvField, type EnvTarget,
} from '../../../model/fx/plugins/vfxenvelope';
import { envAt, type EnvPoints } from '../../../model/fx/plugins/vfx/envelope';
import type { VfxContext, VfxNote, VfxProp } from '../../../model/fx/plugins/vfx/notes';

type P = Record<string, unknown>;
const num = (p: P, k: string, d: number) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : d);

/** Envelope points with the ATT / DEC / REL time scaling and the SUS level offset applied. */
export function scaledEnvelope(t: Pick<EnvTarget, 'env' | 'dec' | 'sus'>, att: number, dec: number, sus: number, rel: number): EnvPoints {
  const fa = envTimeScale(att), fd = envTimeScale(dec), fr = envTimeScale(rel);
  const out: EnvPoints = [];
  let pos = 0;
  t.env.forEach((p, k) => {
    if (k > 0) {
      const d = p.pos - t.env[k - 1].pos;
      const f = t.dec >= 0 && k <= t.dec ? fa : t.sus >= 0 && k <= t.sus ? fd : t.sus >= 0 ? fr : fa;
      pos += d * f;
    }
    out.push({ ...p, pos, value: k === t.sus ? Math.min(1, Math.max(0, p.value + sus / 128)) : p.value });
  });
  return out;
}

/** Envelope value at time t (envelope units) for a note held for `held` units. */
export function timelineValue(points: EnvPoints, loop: boolean, dec: number, sus: number, held: number, t: number): number {
  if (!points.length) return 0;
  if (sus < 0 || sus >= points.length) return envAt(points, t);
  const pS = points[sus].pos;
  if (t <= held) {
    if (t < pS) return envAt(points, t);
    if (loop && dec >= 0 && dec < sus && pS > points[dec].pos) {
      const pD = points[dec].pos;
      return envAt(points, pD + ((t - pD) % (pS - pD)));
    }
    return points[sus].value;
  }
  return envAt(points, pS + (t - held));
}

/** LFO wave -1..1 at phase (cycles), shaped by tension, skew and pulse width (-1..1). */
export function lfoWave(phase: number, tension: number, skew: number, pw: number): number {
  let ph = phase - Math.floor(phase);
  const m = 0.5 + 0.45 * skew;
  ph = ph < m ? (ph / m) * 0.5 : 0.5 + ((ph - m) / (1 - m)) * 0.5;
  let w = Math.sin(2 * Math.PI * ph);
  if (pw !== 0) {
    const k = 1 - 0.95 * Math.abs(pw);
    w = Math.sign(w) * Math.pow(Math.abs(w), k);
    if (pw < 0) w = Math.sin(2 * Math.PI * ph) * (1 - Math.abs(pw)) + w * Math.abs(pw) * 0.5;
  }
  if (tension !== 0) w = Math.sign(w) * Math.pow(Math.abs(w), Math.pow(2, -2 * tension));
  return Math.max(-1, Math.min(1, w));
}

type NumField = 'vel' | 'pan' | 'modX' | 'modY';
const NOTE_FIELD: Record<string, { prop: NumField; full: number } | null> = {
  vel: { prop: 'vel', full: 128 }, pitch: null, pan: { prop: 'pan', full: 128 }, modx: { prop: 'modX', full: 255 }, mody: { prop: 'modY', full: 255 },
};

export function processNotes(notes: VfxNote[], p: P, ctx?: VfxContext): VfxNote[] {
  if (num(p, 'enable', 1) < 0.5) return notes.map((n) => ({ ...n }));
  const arts = normalizeArticulators(p.arts);
  const ppq = ctx?.ppq ?? 96, tempo = ctx?.tempo ?? 120;
  const step = Math.max(1, Math.round(ppq / 24));
  return notes.map((n) => {
    const a = arts.findIndex((x) => x.color === n.color && n.key >= x.low && n.key <= x.high);
    if (a < 0) return { ...n };
    const out: VfxNote = { ...n, mod: { ...(n.mod ?? {}) } };
    ENV_TARGETS.forEach((tg, ti) => {
      const t = arts[a].targets[ti];
      if (!t.on) return;
      const k = (f: EnvField) => num(p, envKey(a, ti, f), NaN);
      const pts = scaledEnvelope(t, isNaN(k('Att')) ? 128 : k('Att'), isNaN(k('Dec')) ? 128 : k('Dec'), isNaN(k('Sus')) ? 0 : k('Sus'), isNaN(k('Rel')) ? 128 : k('Rel'));
      const base = (isNaN(k('Base')) ? (ti === 0 ? 0 : 128) : k('Base')) / 256;
      const envLvl = (isNaN(k('Env')) ? (ti === 1 ? 64 : 256) : k('Env')) / 256;
      const lfoLvl = (isNaN(k('Lfo')) ? 256 : k('Lfo')) / 256;
      const cpb = lfoCyclesPerBeat(isNaN(k('LfoSpd')) ? 40898 : k('LfoSpd'));
      const lt = (isNaN(k('LfoTns')) ? 0 : k('LfoTns')) / 128, ls = (isNaN(k('LfoSkw')) ? 0 : k('LfoSkw')) / 128, lp = (isNaN(k('LfoPw')) ? 0 : k('LfoPw')) / 112;
      // envelope units: beats (TEMPO) or seconds
      const unitTicks = t.tempo ? ppq : (ppq * tempo) / 60;
      const held = n.len / unitTicks;
      const relLen = t.sus >= 0 && t.sus < pts.length ? pts[pts.length - 1].pos - pts[t.sus].pos : 0;
      const total = Math.max(n.len, Math.round((held + relLen) * unitTicks));
      const lfoActive = lfoLvl !== 0 && t.lfo.some((q) => q.value > 0);
      const neutral = tg.bipolar ? 0.5 : 0;
      const curve: [number, number][] = [];
      let varied = false;
      for (let tick = 0; tick <= total; tick += step) {
        const u = tick / unitTicks;
        let e = timelineValue(pts, t.loop, t.dec, t.sus, held, u) - neutral;
        if (lfoActive) {
          const amt = timelineValue(t.lfo, t.lfoLoop, t.lfoDec, t.lfoSus, held, u);
          const beats = (t.lfoGlobal ? n.pos + tick : tick) / ppq;
          e += lfoLvl * amt * lfoWave(beats * cpb, lt, ls, lp) * 0.5;
        }
        const o = Math.min(1, Math.max(0, base + envLvl * e));
        let v: number;
        const nf = NOTE_FIELD[tg.id];
        if (tg.id === 'pitch') v = (o - 0.5) * 96;
        else if (tg.id === 'vel') v = n.vel * o;
        else v = Math.min(nf!.full, Math.max(0, n[nf!.prop] + (o - 0.5) * nf!.full));
        v = Math.round(v * 1000) / 1000;
        const prev = curve[curve.length - 1];
        const neutralV = tg.id === 'pitch' ? 0 : tg.id === 'vel' ? n.vel : n[nf!.prop];
        if (Math.abs(v - neutralV) > 1e-6) varied = true;
        if (prev && prev[1] === v && curve.length > 1 && curve[curve.length - 2][1] === v) prev[0] = tick;
        else curve.push([tick, v]);
      }
      if (!varied) return;
      out.mod![tg.id === 'modx' ? 'modX' : tg.id === 'mody' ? 'modY' : (tg.id as VfxProp)] = curve;
    });
    if (out.mod && Object.keys(out.mod).length === 0) delete out.mod;
    return out;
  });
}

class Envelope implements EffectInstance {
  private p: P = {};
  setParams(p: unknown): void { this.p = (p ?? {}) as P; }
  process(): void { /* audio passes through */ }
  reset(): void {}
  notes(n: VfxNote[], ctx?: VfxContext): VfxNote[] { return processNotes(n, this.p, ctx); }
}

export const effect: EffectModule = { id: 'vfxenvelope', create: () => new Envelope() };
