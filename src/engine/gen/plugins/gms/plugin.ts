// GMS plugin layer: FL's CFLWrapper (the older build GMS ships with; FL 2026 GMS_x64
// 0x3ded0 / 0x3d10c / 0x3ca8c) around the GMSynth engine:
// - every FL voice becomes a MIDI note (key = trunc(InitLevels.Pitch / 100), velocity =
//   trunc(41.71426 ln(10 InitVol + 1))); a new voice on a sounding key first sends its note
//   off; per render call every key's FinalLevels reach the engine (pan law gains, pitch
//   offset); blocks of at most 508 samples (the wrapper's 512-frame buffer minus 4);
// - FL's synth parameters write the internal value they view (raw / 256, clamped), "Envelope
//   Number" / "LFO Number" select; parameters 76..203 send MIDI CC 0..127 (raw / 256 x 127;
//   CC 7, 10, 32 not passed), 204 channel aftertouch; the state's `iv` / `sel` are applied when
//   they change (presets, editor);
// - the oscillator waves: FL's Synth Waves by name from the pool (`wavePool`, imported by the
//   user) or Orchard's stand-ins; FL sends FPE_MaxPoly 16 (GMS's DefPoly).
// GMS renders silence in FL's test host (licence check): static analysis only.

import type { GenContext, GenEnv, GenInstance, GenNote } from '../../types';
import { flFinalPitch } from '../../levels';
import { GmsSynth } from './core';
import { gmsSubstitute, gmsTable } from './waves';
import { f32, fmaD } from '../poizone/dsp';
import { logf, cosf, sinf } from '../poizone/applemath';
import {
  GMS_ENGINE_COUNT, GMS_PARAM_COUNT, GMS_PARAM_KEYS, gmsInternal, type GmsStateLike,
} from '../../../../model/gen/plugins/gms/data';

interface Ev { at: number; on: boolean; note: GenNote }

const PACK_MAGIC = 1196250455; // 'GMSW'

/** An imported wave as a pool-sample pack: magic, frames, checksum, 0, then the samples. */
export function gmsPackWave(x: Float32Array): Float32Array {
  const out = new Float32Array(4 + x.length);
  out[0] = PACK_MAGIC; out[1] = x.length;
  let s = 0;
  for (let i = 0; i < x.length; i++) { out[4 + i] = x[i]; s += x[i]; }
  out[2] = Math.fround(s);
  return out;
}

/** The wave back from gmsPackWave's data (null when it is not such a pack). */
export function gmsUnpackWave(d: Float32Array | undefined | null): Float32Array | null {
  if (!d || d.length < 8 || d[0] !== Math.fround(PACK_MAGIC)) return null;
  const n = d[1];
  if (!(n >= 4 && n <= 1 << 20) || d.length < 4 + n) return null;
  const x = d.slice(4, 4 + n);
  let s = 0;
  for (let i = 0; i < n; i++) { const v = x[i]; if (!(v >= -8 && v <= 8)) return null; s += v; }
  return Math.fround(s) === d[2] ? x : null;
}

export class GmsPlugin implements GenInstance {
  readonly synth = new GmsSynth();
  private readonly sr: number;
  private readonly env: GenEnv | null;
  private readonly slot: (GenNote | null)[] = new Array(128).fill(null);
  private readonly evs: Ev[] = [];
  private readonly applied = new Float64Array(GMS_PARAM_COUNT + 129).fill(NaN);
  private readonly ivApplied = new Float64Array(GMS_ENGINE_COUNT).fill(NaN);
  private waveKeys = ['', '', ''];
  private waveOk = [true, true, true];
  private retry = 0;
  private lastWaves: string[] = ['', '', ''];
  private lastPool: Record<string, string> = {};
  private tailLeft = 0;
  tail = 0.05;

  constructor(sampleRate: number, _blockSize: number, env?: GenEnv) {
    this.sr = sampleRate;
    this.env = env ?? null;
    this.synth.setSampleRate(sampleRate);
    this.synth.setMaxPoly(16);
  }

  private loadWaves(waves: string[], pool: Record<string, string>): void {
    for (let k = 0; k < 3; k++) {
      const name = waves[k] ?? '';
      const id = name ? pool[name] ?? '' : '';
      let key = '', wave: Float32Array | null = null, ok = true;
      if (id) {
        wave = this.env ? gmsUnpackWave(this.env.sample(id)?.channels[0]) : null;
        if (wave) key = `pool:${id}`;
        else ok = false;
      }
      if (!wave && name) { key = `sub:${name.toLowerCase()}`; }
      this.waveOk[k] = ok;
      if (key === this.waveKeys[k]) continue;
      this.waveKeys[k] = key;
      if (!key) { this.synth.setTable(k, null); continue; }
      const w = wave;
      this.synth.setTable(k, gmsTable(key, () => w ?? gmsSubstitute(name)));
    }
  }

  setParams(p: unknown): void {
    const st = p as GmsStateLike;
    const S = this.synth;
    // waves
    const waves = Array.isArray(st.waves) ? st.waves.map((w) => String(w ?? '')) : ['', '', ''];
    const pool = st.wavePool && typeof st.wavePool === 'object' ? st.wavePool : {};
    if (waves.join('\n') !== this.lastWaves.join('\n') || JSON.stringify(pool) !== JSON.stringify(this.lastPool)) {
      this.lastWaves = waves; this.lastPool = { ...pool };
      this.loadWaves(waves, pool);
    }
    S.fxPressed = st.fxHold === true;
    // the internal values, then the selections
    const iv = Array.isArray(st.iv) ? st.iv : [];
    for (let i = 0; i < GMS_ENGINE_COUNT; i++) {
      const x = Number(iv[i]);
      if (!Number.isFinite(x) && !Number.isNaN(x)) continue;
      if (Object.is(x, this.ivApplied[i])) continue;
      this.ivApplied[i] = x;
      S.iv[i] = Number.isNaN(x) ? NaN : x;
    }
    const sel = Array.isArray(st.sel) ? st.sel : [0, 0, 0];
    for (let k = 0; k < 3; k++) S.sel[k] = Math.min(Math.max(Math.trunc(Number(sel[k]) || 0), 0), k === 0 ? 9 : 1);
    // FL's synth parameters: the value they view (sent when they change)
    for (let i = 0; i < GMS_PARAM_COUNT; i++) {
      const raw = Number(st[GMS_PARAM_KEYS[i]]);
      if (!Number.isFinite(raw) || raw === this.applied[i]) continue;
      const first = Number.isNaN(this.applied[i]);
      this.applied[i] = raw;
      const v = f32(Math.min(Math.max(f32(raw * 0.00390625), 0), 1));
      if (i === 37 || i === 44) {
        if (!first) S.sel[i === 37 ? 1 : 2] = Math.trunc(v);
        continue;
      }
      const m = gmsInternal(i, S.sel);
      if (m < 0) continue;
      // on load the exact internal value stands unless the parameter was edited since (FL's raw readback differs)
      if (first && raw === Math.trunc(Math.min(Math.max(S.iv[m], 0), 1) * 256)) continue;
      S.iv[m] = v;
    }
    // MIDI CC 0..127 and channel aftertouch
    for (let c = 0; c < 129; c++) {
      const k = GMS_PARAM_COUNT + c;
      const raw = Number(st[GMS_PARAM_KEYS[k]] ?? 0);
      if (raw === this.applied[k]) continue;
      const firstSet = Number.isNaN(this.applied[k]);
      this.applied[k] = raw;
      if (firstSet && raw === 0) continue;
      const v = Math.max(Math.min(raw * 0.00390625, 1), 0);
      const x = Math.max(Math.min(Math.trunc(v * 127), 127), 0);
      if (c === 128) S.setAftertouch(x);
      else if (c !== 7 && c !== 10 && c !== 32) S.controlChange(c, x);
    }
  }

  reset(): void {
    this.evs.length = 0;
    this.slot.fill(null);
    this.synth.setSampleRate(0);
  }

  noteOn(note: GenNote, frameOffset: number): void { this.evs.push({ at: frameOffset, on: true, note }); }
  noteOff(note: GenNote, frameOffset: number): void { this.evs.push({ at: frameOffset, on: false, note }); }
  killNote(note: GenNote): void { this.evs.push({ at: 0, on: false, note }); }

  allNotesOff(): void {
    this.evs.length = 0;
    for (let k = 0; k < 128; k++) if (this.slot[k]) { this.slot[k] = null; this.synth.noteOff(k); }
  }

  isActive(): boolean { return this.synth.sounding || this.tailLeft > 0 || this.evs.length > 0; }

  private keyOf(n: GenNote): number {
    return Math.max(Math.min(Math.trunc(f32(n.init.pitch) * 0.01), 127), 0);
  }

  private trigger(n: GenNote): void {
    const k = this.keyOf(n);
    const old = this.slot[k];
    if (old && old !== n) this.synth.noteOff(k);
    this.slot[k] = n;
    const x = logf(f32(n.init.vol * 10 + 1));
    const v = Math.trunc(f32(x * f32(41.71426010131836)));
    this.synth.noteOn(k, Math.max(Math.min(v, 127), 0));
  }

  private release(n: GenNote): void {
    const k = this.keyOf(n);
    if (this.slot[k] !== n) return;
    this.synth.noteOff(k);
  }

  /** The wrapper's per-key levels (FL 0x3d10c, the host's pan law). */
  private updateLevels(): void {
    const S = this.synth;
    let have = false;
    let l = 0, r = 0, pit = 0;
    for (let k = 0; k < 128; k++) {
      const v = this.slot[k];
      if (v) {
        const lv = v.levels;
        const pan = Math.max(Math.min(f32(lv.pan), 1), -1);
        const a = f32(f32(pan + 1) * 0.7853981633974483);
        const vol = f32(lv.vol);
        l = f32(cosf(a) * vol);
        r = f32(sinf(a) * vol);
        pit = f32(fmaD(f32(flFinalPitch(lv)), 0.01, 60 - k));
        if (!have) {
          have = true;
          for (let j = 0; j <= k; j++) { S.noteL[j] = l; S.noteR[j] = r; S.notePitch[j] = pit; }
          continue;
        }
      } else if (!have) {
        S.noteL[k] = 0; S.noteR[k] = 0; S.notePitch[k] = 0;
        continue;
      }
      S.noteL[k] = l; S.noteR[k] = r; S.notePitch[k] = pit;
    }
  }

  private run(L: Float32Array, R: Float32Array, from: number, n: number, ctx: GenContext): void {
    const S = this.synth;
    this.updateLevels();
    const tempo = f32(ctx.tempo);
    S.tempo = tempo;
    S.playing = ctx.playing;
    let beats = ctx.playing ? ctx.pos / ctx.ppq + (from * tempo) / (60 * this.sr) : 0;
    let at = from, left = n;
    while (left > 0) {
      const m = Math.min(left, 508);
      S.songPos = beats;
      const bl = L.subarray(at, at + m), br = R.subarray(at, at + m);
      bl.fill(0); br.fill(0);
      S.process(bl, br, m);
      if (ctx.playing) beats += (m * (1 / 60) * tempo) / this.sr;
      at += m;
      left -= m;
    }
    // FL kills voices whose key no longer sounds (no engine voice, key not held)
    for (let k = 0; k < 128; k++) if (this.slot[k] && S.use[k] === 0 && S.vel01[k] === 0) this.slot[k] = null;
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    if (this.waveOk.some((o) => !o) && ++this.retry >= 64) {
      this.retry = 0;
      this.waveKeys = ['', '', ''];
      this.loadWaves(this.lastWaves, this.lastPool);
    }
    this.evs.sort((a, b) => a.at - b.at);
    let pos = 0, e = 0;
    while (pos < n) {
      while (e < this.evs.length && this.evs[e].at <= pos) {
        const ev = this.evs[e++];
        if (ev.on) this.trigger(ev.note); else this.release(ev.note);
      }
      const next = e < this.evs.length ? Math.min(Math.max(this.evs[e].at, pos + 1), n) : n;
      this.run(L, R, pos, next - pos, ctx);
      pos = next;
    }
    while (e < this.evs.length) {
      const ev = this.evs[e++];
      if (ev.on) this.trigger(ev.note); else this.release(ev.note);
    }
    this.evs.length = 0;
    let pk = 0;
    for (let i = 0; i < n; i++) { const a = Math.abs(L[i]) + Math.abs(R[i]); if (a > pk) pk = a; }
    if (pk > 1e-6 || this.synth.sounding) this.tailLeft = this.sr * 2;
    else this.tailLeft = Math.max(0, this.tailLeft - n);
  }
}
