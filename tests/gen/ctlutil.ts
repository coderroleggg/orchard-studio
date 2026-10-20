// Helpers for controller instrument tests: drive a gen instance block by block
// with timed note events (the way GenChannel calls it: triggerVoice at the
// voice's first sample with params.frame = its offset in the block, release()
// at the release sample, render() once per block with the song position), and
// read its controller outputs per block or per tick.
import type { GenContext, GenInstance, GenVoice, GenVoiceParams } from '../../src/engine/gen/types';
import { newLevels, setInitLevels } from '../../src/engine/gen/levels';

export interface CtlNote {
  /** Start and length in samples. */
  at: number;
  len: number;
  key?: number;
  vel?: number;
  color?: number;
  pan?: number;
  /** The note's Mod X / Y (-1..1) and the channel's Mod X / Y offsets (FL: FinalLevels.FCut = note + channel). */
  modX?: number;
  modY?: number;
  chanModX?: number;
  chanModY?: number;
}

export function voiceParams(key = 60, vel = 100, color = 0, len = Infinity): GenVoiceParams {
  const init = newLevels(), levels = newLevels();
  setInitLevels(init, (key - 60) * 100, vel, 0, 0, 0);
  Object.assign(levels, init);
  return { key, velocity: vel, release: 64, color, length: len, frame: 0, init, levels };
}

export interface CtlRun {
  /** Output values after every block: samples (block end) and values. */
  frames: number[];
  values: Float64Array[];
  /** The instance. */
  inst: GenInstance;
}

/**
 * Run `inst` for `frames` samples in blocks of `block` with the notes' voices.
 * `tempo` / `ppq` / `playing` go into the context; the song position starts
 * at `pos0` ticks and follows the samples while playing.
 */
export function driveCtl(
  inst: GenInstance, notes: CtlNote[], frames: number,
  opt: { sr?: number; block?: number; tempo?: number; ppq?: number; playing?: boolean; pos0?: number; onBlock?: (t: number, inst: GenInstance) => void } = {},
): CtlRun {
  const sr = opt.sr ?? 44100, block = opt.block ?? 128, tempo = opt.tempo ?? 130, ppq = opt.ppq ?? 96;
  const playing = opt.playing ?? true;
  const spt = (sr * 60) / (tempo * ppq);
  const ctx: GenContext = { sampleRate: sr, blockSize: block, tempo, ppq, playing, pos: opt.pos0 ?? 0, songMode: false, track: 0 };
  type Live = { note: CtlNote; v: GenVoice | null; p: GenVoiceParams; done: boolean; started: boolean; released: boolean };
  const live: Live[] = notes.map((n) => ({ note: n, v: null, p: voiceParams(n.key ?? 60, n.vel ?? 100, n.color ?? 0, n.len), done: false, started: false, released: false }));
  const L = new Float32Array(block), R = new Float32Array(block);
  const out: CtlRun = { frames: [], values: [], inst };
  for (let t0 = 0; t0 < frames; t0 += block) {
    const n = Math.min(block, frames - t0);
    ctx.pos = (opt.pos0 ?? 0) + (playing ? t0 / spt : 0);
    // voice events in time order inside the block
    const evs: { f: number; on: boolean; l: Live }[] = [];
    for (const l of live) {
      if (l.done) continue;
      if (!l.started && l.note.at >= t0 && l.note.at < t0 + n) evs.push({ f: l.note.at - t0, on: true, l });
      const end = l.note.at + l.note.len;
      if (!l.released && end >= t0 && end < t0 + n && l.note.len !== Infinity) evs.push({ f: end - t0, on: false, l });
    }
    evs.sort((a, b) => a.f - b.f || (a.on === b.on ? 0 : a.on ? 1 : -1));
    for (const e of evs) {
      e.l.p.frame = e.f;
      if (e.on) {
        const nt = e.l.note;
        e.l.p.init.pan = nt.pan ?? 0; e.l.p.init.fcut = nt.modX ?? 0; e.l.p.init.fres = nt.modY ?? 0;
        e.l.v = inst.triggerVoice?.(e.l.p) ?? null;
        e.l.started = true;
        if (!e.l.v) e.l.done = true;
      } else if (e.l.v) {
        e.l.v.release();
        e.l.released = true;
      }
    }
    // voices render (a voice that returns false ends and is killed)
    for (const l of live) {
      if (!l.v || l.done) continue;
      L.fill(0, 0, n); R.fill(0, 0, n);
      const alive = l.v.render(L, R, n);
      if (!alive) { l.v.kill(); l.v = null; l.done = true; }
    }
    L.fill(0, 0, n); R.fill(0, 0, n);
    inst.render?.(L, R, n, ctx);
    opt.onBlock?.(t0 + n, inst);
    out.frames.push(t0 + n);
    out.values.push(Float64Array.from(inst.controls?.() ?? []));
  }
  return out;
}

/** The value of output `i` after the block that ends at or after sample `s`. */
export function valueAt(r: CtlRun, i: number, s: number): number {
  for (let k = 0; k < r.frames.length; k++) if (r.frames[k] >= s) return r.values[k][i];
  return r.values[r.values.length - 1][i];
}

/** One scripted action of a controller run: `fn` runs between blocks, at the block that starts at sample `at`. */
export interface CtlAction {
  at: number;
  fn: () => void;
}

/**
 * Like driveCtl, but in blocks of at most 16 frames (the channel's control step, so a block holds at
 * most one tick), with scripted actions (parameter automation) applied exactly at their samples, and
 * returns every output's changes as [tick, value]: the tick is the song tick (tick k sits at sample
 * floor(k x samples per tick)) whose NewTick produced the new value.
 */
export function driveCtlChanges(
  inst: GenInstance, notes: CtlNote[], frames: number, actions: CtlAction[],
  opt: { sr?: number; tempo?: number; ppq?: number; playing?: boolean } = {},
): Array<Array<[number, number]>> {
  const sr = opt.sr ?? 44100, tempo = opt.tempo ?? 130, ppq = opt.ppq ?? 96, playing = opt.playing ?? true;
  const spt = (sr * 60) / (tempo * ppq);
  const ctx: GenContext = { sampleRate: sr, blockSize: 16, tempo, ppq, playing, pos: 0, songMode: false, track: 0 };
  type Live = { note: CtlNote; v: GenVoice | null; p: GenVoiceParams; done: boolean; started: boolean; released: boolean };
  const live: Live[] = notes.map((n) => ({ note: n, v: null, p: voiceParams(n.key ?? 60, n.vel ?? 100, n.color ?? 0, n.len), done: false, started: false, released: false }));
  const acts = actions.slice().sort((a, b) => a.at - b.at);
  const L = new Float32Array(16), R = new Float32Array(16);
  const out: Array<Array<[number, number]>> = [];
  let last: number[] = [];
  let t0 = 0;
  while (t0 < frames) {
    while (acts.length && acts[0].at <= t0) acts.shift()!.fn();
    let n = Math.min(16, frames - t0);
    if (acts.length) n = Math.min(n, acts[0].at - t0);
    if (n <= 0) n = 1;
    ctx.pos = playing ? t0 / spt : 0;
    const evs: { f: number; on: boolean; l: Live }[] = [];
    for (const l of live) {
      if (l.done) continue;
      if (!l.started && l.note.at >= t0 && l.note.at < t0 + n) evs.push({ f: l.note.at - t0, on: true, l });
      const end = l.note.at + l.note.len;
      if (!l.released && end >= t0 && end < t0 + n && l.note.len !== Infinity) evs.push({ f: end - t0, on: false, l });
    }
    evs.sort((a, b) => a.f - b.f || (a.on === b.on ? 0 : a.on ? 1 : -1));
    for (const e of evs) {
      e.l.p.frame = e.f;
      if (e.on) {
        const nt = e.l.note;
        e.l.p.init.pan = nt.pan ?? 0; e.l.p.init.fcut = nt.modX ?? 0; e.l.p.init.fres = nt.modY ?? 0;
        // the channel's levels follow the init levels (+ the channel's Mod X / Y offsets, set by the caller through levels)
        e.l.p.levels.fcut = (nt.modX ?? 0) + (nt.chanModX ?? 0); e.l.p.levels.fres = (nt.modY ?? 0) + (nt.chanModY ?? 0);
        e.l.v = inst.triggerVoice?.(e.l.p) ?? null;
        e.l.started = true;
        if (!e.l.v) e.l.done = true;
      } else if (e.l.v) {
        e.l.v.release();
        e.l.released = true;
      }
    }
    for (const l of live) {
      if (!l.v || l.done) continue;
      L.fill(0, 0, n); R.fill(0, 0, n);
      if (!l.v.render(L, R, n)) { l.v.kill(); l.v = null; l.done = true; }
    }
    L.fill(0, 0, n); R.fill(0, 0, n);
    inst.render?.(L, R, n, ctx);
    const c = inst.controls?.() ?? [];
    for (let a = 0; a < c.length; a++) {
      if (!out[a]) { out[a] = []; last[a] = NaN; }
      const v = c[a];
      if (v === v && v !== last[a]) {
        last[a] = v;
        // the latest tick that fired in this block: the one with the greatest floor(k x spt) <= the block's last sample
        out[a].push([Math.ceil((t0 + n - 1e-6) / spt) - 1, v]);
      }
    }
    t0 += n;
  }
  return out;
}
