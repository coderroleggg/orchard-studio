// Sawer plugin layer: FL's CFLWrapper around the SawerSynth engine (FL 2026's Sawer
// engine library; the wrapper code is the one PoiZone uses, see ../poizone/plugin.ts):
// - every FL voice becomes a MIDI note (key = trunc(InitLevels.Pitch / 100), velocity =
//   trunc(41.71426 ln(10 InitVol + 1))); a new voice on a sounding key first sends its note off;
// - per render call the wrapper copies every key's FinalLevels into the engine (pan law gains,
//   pitch offset, Mod X / Y); the engine renders blocks of at most 64 samples;
// - FL's parameters 0..72 reach the engine as raw / 256, the state holds the hidden values
//   73..95 and the MIDI-learn CC of every engine value; FL's parameters 73..200 send MIDI CC
//   0..127 (raw / 256 x 127; CC 7, 10 and 32 are not passed), 201 channel aftertouch (a
//   modulation source in Sawer);
// - state `sample`: the pool sample holding FL's data.saw (imported by the user from their
//   own FL install); without it the engine uses its synthesized stand-in table.
// Sawer renders silence in FL's test host (licence check), so none of this could be
// compared with FL's output: static analysis only.

import type { GenContext, GenEnv, GenInstance, GenNote } from '../../types';
import { flFinalPitch } from '../../levels';
import { SwSynth } from './core';
import { swUnpackTable } from './tables';
import { f32, fmaD } from '../poizone/dsp';
import { logf, cosf, sinf } from '../poizone/applemath';
import {
  SW_ENGINE_COUNT, SW_PARAM_COUNT, SW_PARAM_KEYS, swStateValues, type SwStateLike,
} from '../../../../model/gen/plugins/sawer/data';

interface Ev { at: number; on: boolean; note: GenNote }

export class SwPlugin implements GenInstance {
  readonly synth = new SwSynth();
  private readonly sr: number;
  private readonly env: GenEnv | null;
  /** FL voice per key (the wrapper's slots). */
  private readonly slot: (GenNote | null)[] = new Array(128).fill(null);
  private readonly evs: Ev[] = [];
  private readonly applied = new Float64Array(SW_PARAM_COUNT + 129).fill(NaN);
  private readonly hiddenApplied = new Float64Array(SW_ENGINE_COUNT).fill(NaN);
  private playing = false;
  private tailLeft = 0;
  private first = true;
  private sampleId = '';
  private tableOk = true;
  private retry = 0;
  tail = 0.05;

  constructor(sampleRate: number, _blockSize: number, env?: GenEnv) {
    this.sr = sampleRate;
    this.env = env ?? null;
    // FL's order: FPD_SetSampleRate, then the wrapper resets the engine to its defaults
    this.synth.setSampleRate(sampleRate);
    this.synth.resetToDefaults();
    this.synth.setMaxPoly(0);
  }

  /** FL's data.saw from the pool sample `sample` (false while the pool has not delivered a valid pack). */
  private loadTable(): boolean {
    const t = this.sampleId && this.env ? swUnpackTable(this.env.sample(this.sampleId)?.channels[0]) : null;
    this.synth.setTable(t);
    return !this.sampleId || t !== null;
  }

  setParams(p: unknown): void {
    const st = p as SwStateLike;
    const S = this.synth;
    const sid = typeof st.sample === 'string' ? st.sample : '';
    if (sid !== this.sampleId) {
      this.sampleId = sid;
      this.tableOk = this.loadTable();
      this.retry = 0;
    }
    const { values, ccMap } = swStateValues(st);
    if (this.first) {
      // FL's state load: the 96 engine values in order, then the MIDI-learn map
      S.loadState(values);
      for (let i = 0; i < SW_ENGINE_COUNT; i++) {
        if (i < SW_PARAM_COUNT) this.applied[i] = Number(st[SW_PARAM_KEYS[i]]);
        else this.hiddenApplied[i] = values[i];
      }
      S.ccMap.set(ccMap);
    } else {
      for (let i = 0; i < SW_PARAM_COUNT; i++) {
        const raw = Number(st[SW_PARAM_KEYS[i]]);
        if (!Number.isFinite(raw) || raw === this.applied[i]) continue;
        this.applied[i] = raw;
        S.setParameter(i, values[i]);
      }
      for (let i = SW_PARAM_COUNT; i < SW_ENGINE_COUNT; i++) {
        if (values[i] === this.hiddenApplied[i]) continue;
        this.hiddenApplied[i] = values[i];
        S.setParameter(i, values[i]);
      }
      S.ccMap.set(ccMap);
    }
    // FL parameters 73..201: MIDI CC 0..127 and channel aftertouch (sent when they change)
    for (let c = 0; c < 129; c++) {
      const k = SW_PARAM_COUNT + c;
      const raw = Number(st[SW_PARAM_KEYS[k]] ?? 0);
      if (raw === this.applied[k]) continue;
      const firstSet = Number.isNaN(this.applied[k]);
      this.applied[k] = raw;
      if (firstSet && raw === 0) continue;
      const v = Math.max(Math.min(raw * 0.00390625, 1), 0);
      const x = Math.max(Math.min(Math.trunc(v * 127), 127), 0);
      if (c === 128) S.aftertouch(x);
      else if (c !== 7 && c !== 10 && c !== 32) S.controlChange(c, x);
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

  isActive(): boolean { return this.synth.count > 0 || this.tailLeft > 0 || this.evs.length > 0; }

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
        // FL writes its uninitialised L / R locals here (0 in FL: the stack area its render cleared)
        S.noteL[k] = 0; S.noteR[k] = 0; S.notePitch[k] = 0; S.noteCut[k] = 0; S.noteRes[k] = 0;
        continue;
      }
      S.noteL[k] = l; S.noteR[k] = r; S.notePitch[k] = pit; S.noteCut[k] = cut; S.noteRes[k] = res;
    }
  }

  private run(L: Float32Array, R: Float32Array, from: number, n: number, ctx: GenContext): void {
    const S = this.synth;
    this.updateLevels();
    const tempo = f32(ctx.tempo);
    S.tempo = tempo;
    S.tempoF = tempo;
    let beats = 0;
    if (ctx.playing) beats = ctx.pos / ctx.ppq + (from * tempo) / (60 * this.sr);
    let at = from;
    let left = n;
    while (left > 0) {
      const m = Math.min(left, 64);
      S.songPos = beats;
      if (this.playing !== ctx.playing) { this.playing = ctx.playing; S.playing = ctx.playing; }
      const bl = L.subarray(at, at + m), br = R.subarray(at, at + m);
      bl.fill(0); br.fill(0);
      S.process(bl, br, m);
      beats += (m * (1 / 60) * tempo) / this.sr;
      at += m;
      left -= m;
    }
    // FL kills voices whose key no longer sounds (released and no generator left)
    for (let k = 0; k < 128; k++) if (this.slot[k] && S.use[k] === 0 && S.vel01[k] === 0) this.slot[k] = null;
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    if (!this.tableOk && ++this.retry >= 64) {
      this.retry = 0;
      this.tableOk = this.loadTable();
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
    if (pk > 1e-6 || this.synth.count > 0) this.tailLeft = this.sr;
    else this.tailLeft = Math.max(0, this.tailLeft - n);
  }
}
