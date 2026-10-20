// Toxic Biohazard plugin layer: FL's CFLWrapper around the ToxicSynth engine
// (the wrapper code is identical to PoiZone's, see ../poizone/plugin.ts):
// - every FL voice becomes a MIDI note: key = trunc(InitLevels.Pitch / 100),
//   velocity = trunc(41.71426 ln(10 InitVol + 1)); a new voice on a key that
//   still has one first sends that key's note off;
// - per render call every key's FinalLevels (FL's pan law, pitch offset, Mod
//   X / Y) are copied into the engine (keys without a voice take the nearest
//   lower voice's values; with no voice at all, 0);
// - the engine renders blocks of at most 64 samples;
// - FL parameters 0..293 are the engine's first 294 values (raw / 256);
//   294..421 send MIDI CC 0..127 (raw / 256 x 127; CC 7, 10 and 32 not
//   passed), 422 channel aftertouch;
// - the hidden values 294..339, custom harmonics and the CC link map come
//   from the state (FL's chunk);
// - state `sample`: the pool sample holding FL's built-in harmonic tables
//   imported from the user's own FL install (else synthesized substitutes).

import type { GenContext, GenEnv, GenInstance, GenNote } from '../../types';
import { flFinalPitch } from '../../levels';
import { TxSynth } from './synth';
import { txUnpackTables } from './wave';
import { f32, fmaD } from '../poizone/dsp';
import { logf, cosf, sinf } from '../poizone/applemath';
import { TX_INSERT_PRESET, TX_PARAM_COUNT, TX_PARAM_KEYS, txPresetState, txStateValues, type TxStateLike } from '../../../../model/gen/plugins/toxicbiohazard/data';

interface Ev { at: number; on: boolean; note: GenNote }

export class TxPlugin implements GenInstance {
  readonly synth = new TxSynth();
  private readonly sr: number;
  private readonly slot: (GenNote | null)[] = new Array(128).fill(null);
  private readonly evs: Ev[] = [];
  private readonly applied = new Float64Array(340 + 129).fill(NaN);
  private first = true;
  private wavesKey = '';
  private ccKey = '';
  private tailLeft = 0;
  private readonly env: GenEnv | null;
  private sampleId = '';
  private tablesOk = true;
  private retry = 0;
  tail = 0.05;

  constructor(sampleRate: number, _blockSize: number, env?: GenEnv) {
    this.sr = sampleRate;
    this.env = env ?? null;
    // FL's order: the constructor loads the first factory preset, then FPD_SetSampleRate
    // (smoothers snap, effects reset), then the host's state
    const ins = txStateValues(txPresetState(TX_INSERT_PRESET));
    this.synth.loadValues(ins.values, ins.waves, ins.ccMap);
    this.synth.setSampleRate(sampleRate);
    this.synth.setMaxPoly(0);
  }

  /** FL's tables from the pool sample `sample` (null until the pool delivers a valid pack). */
  private loadTables(): boolean {
    const t = this.sampleId && this.env ? txUnpackTables(this.env.sample(this.sampleId)?.channels[0]) : null;
    this.synth.tables = t;
    return !this.sampleId || t !== null;
  }

  setParams(p: unknown): void {
    const st = p as TxStateLike;
    const S = this.synth;
    const sid = typeof st.sample === 'string' ? st.sample : '';
    if (sid !== this.sampleId) {
      this.sampleId = sid;
      this.tablesOk = this.loadTables();
      if (!this.first) S.rebuildWaves();
    }
    const sv = txStateValues(st);
    const wk = JSON.stringify(st.waves ?? null);
    const ck = JSON.stringify(st.ccMap ?? null);
    if (this.first || wk !== this.wavesKey || ck !== this.ccKey) {
      S.loadValues(sv.values, sv.waves, sv.ccMap);
      for (let i = 0; i < 340; i++) this.applied[i] = sv.values[i];
      this.wavesKey = wk;
      this.ccKey = ck;
    } else {
      for (let i = 0; i < 340; i++) {
        const v = sv.values[i];
        if (v === this.applied[i]) continue;
        this.applied[i] = v;
        S.setParameter(i, v);
      }
    }
    // FL parameters 294..422: MIDI CC 0..127 and channel aftertouch
    for (let c = 0; c < 129; c++) {
      const k = 340 + c;
      const raw = Number(st[TX_PARAM_KEYS[TX_PARAM_COUNT + c]] ?? 0);
      if (raw === this.applied[k]) continue;
      const firstSet = Number.isNaN(this.applied[k]);
      this.applied[k] = raw;
      if (firstSet && raw === 0) continue;
      const v = Math.max(Math.min(raw * 0.00390625, 1), 0);
      if (c === 128) { S.aftertouch(f32(v)); continue; }
      if (c === 7 || c === 10 || c === 32) continue;
      S.controlChange(c, Math.max(Math.min(Math.trunc(v * 127), 127), 0));
    }
    this.first = false;
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

  isActive(): boolean {
    const S = this.synth;
    if (this.tailLeft > 0 || this.evs.length > 0) return true;
    for (const g of S.gens) if (g.note >= 0) return true;
    return false;
  }

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

  /** FL's Voice_Release: the key's note off, unless the voice was replaced (the wrapper had FL kill it). */
  private release(n: GenNote): void {
    const k = this.keyOf(n);
    if (this.slot[k] !== n) return;
    this.synth.noteOff(k);
  }

  /** CFLWrapper: copy every key's FinalLevels into the engine. */
  private updateLevels(): void {
    const S = this.synth;
    let have = false;
    let l = 0, r = 0, pit = 0, cut = 0, res = 0;
    for (let k = 0; k < 128; k++) {
      const v = this.slot[k];
      if (v) {
        const lv = v.levels;
        const pan = Math.max(Math.min(f32(lv.pan), 1), -1);
        const a = f32((f32(pan + 1)) * 0.7853981633974483);
        const vol = f32(lv.vol);
        l = f32(cosf(a) * vol);
        r = f32(sinf(a) * vol);
        pit = f32(fmaD(f32(flFinalPitch(lv)), 0.01, 60 - k));
        cut = f32(lv.fcut);
        res = f32(lv.fres);
        if (!have) {
          have = true;
          for (let j = 0; j <= k; j++) { S.noteL[j] = l; S.noteR[j] = r; S.notePitch[j] = pit; S.noteCut[j] = cut; S.noteRes[j] = res; }
          continue;
        }
      } else if (!have) {
        S.noteL[k] = 0; S.noteR[k] = 0; S.notePitch[k] = 0; S.noteCut[k] = 0; S.noteRes[k] = 0;
        continue;
      }
      S.noteL[k] = l; S.noteR[k] = r; S.notePitch[k] = pit; S.noteCut[k] = cut; S.noteRes[k] = res;
    }
  }

  private run(L: Float32Array, R: Float32Array, from: number, n: number, ctx: GenContext): void {
    const S = this.synth;
    this.updateLevels();
    S.tempo = f32(ctx.tempo);
    S.playing = ctx.playing;
    let at = from;
    let left = n;
    while (left > 0) {
      const m = Math.min(left, 64);
      const bl = L.subarray(at, at + m), br = R.subarray(at, at + m);
      bl.fill(0); br.fill(0);
      S.process(bl, br, m);
      at += m;
      left -= m;
    }
    for (let k = 0; k < 128; k++) if (this.slot[k] && S.use[k] === 0 && S.vel01[k] === 0) this.slot[k] = null;
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    if (!this.tablesOk && ++this.retry >= 64) {
      this.retry = 0;
      if ((this.tablesOk = this.loadTables())) this.synth.rebuildWaves();
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
    let any = false;
    for (const g of this.synth.gens) if (g.note >= 0) { any = true; break; }
    if (pk > 1e-6 || any) this.tailLeft = this.sr * 4;
    else this.tailLeft = Math.max(0, this.tailLeft - n);
  }
}
