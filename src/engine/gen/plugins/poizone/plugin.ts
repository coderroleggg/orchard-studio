// PoiZone plugin layer: FL's CFLWrapper around the PoiZoneSynth engine,
// decoded from FL 2026's PoiZone engine library:
// - every FL voice becomes a MIDI note: key = trunc(InitLevels.Pitch / 100),
//   velocity = trunc(41.71426 ln(10 InitVol + 1)) (127 ln(10 v + 1) / ln 21);
//   a new voice on a key that still has one first sends that key's note off;
//   PoiZone asks FL not to apply velocity to FinalLevels (link velocity off);
// - per render call the wrapper copies every key's FinalLevels into the
//   engine: L / R gains (FL's pan law on Pan / Vol), pitch offset in
//   semitones beyond the key, Mod X (cutoff), Mod Y (resonance); keys without
//   a voice take the values of the nearest lower key that has one (the
//   lowest key's below it; with no voice at all, 0: FL reads its cleared stack);
// - the engine renders in blocks of at most 64 samples; the song position
//   (beats, when playing) and the transport state reach it per block;
// - FL's parameters 74..201 send MIDI CC 0..127 (raw / 256 x 127; CC 7, 10
//   and 32 are not passed), 202 channel aftertouch (no effect);
// - FL sends FPE_MaxPoly when it creates the channel (0 = the engine's cap,
//   64): without it PoiZone would play every note on one generator.

import type { GenContext, GenInstance, GenNote } from '../../types';
import { flFinalPitch } from '../../levels';
import { PzSynth } from './core';
import { f32, fmaD } from './dsp';
import { logf, cosf, sinf } from './applemath';
import { PZ_PARAM_COUNT, PZ_PARAM_KEYS, pzRawToEngine, type PzStateLike } from '../../../../model/gen/plugins/poizone/data';

interface Ev { at: number; on: boolean; note: GenNote }

export class PzPlugin implements GenInstance {
  readonly synth = new PzSynth();
  private readonly sr: number;
  /** FL voice per key (the wrapper's slots). */
  private readonly slot: (GenNote | null)[] = new Array(128).fill(null);
  private readonly evs: Ev[] = [];
  private readonly applied = new Float64Array(PZ_PARAM_COUNT + 129).fill(NaN);
  private readonly hiddenApplied = new Float64Array(82).fill(NaN);
  private playing = false;
  private tailLeft = 0;
  private first = true;
  tail = 0.05;

  constructor(sampleRate: number, _blockSize: number) {
    this.sr = sampleRate;
    // FL's order: FPD_SetSampleRate (effects created, smoothers snap), then the wrapper switches the
    // engine to float parameters, which resets it to its defaults (now with its effects in place)
    this.synth.setSampleRate(sampleRate);
    this.synth.resetToDefaults();
    this.synth.setMaxPoly(0);
  }

  setParams(p: unknown): void {
    const st = p as PzStateLike;
    const S = this.synth;
    const hid = Array.isArray(st.hidden) ? st.hidden : [];
    const map = Array.isArray(st.ccMap) ? st.ccMap : [];
    if (this.first) {
      // FL's state load: defaults, then the internal ids 0..155 in order
      const v = new Float64Array(156);
      for (let i = 0; i < 156; i++) v[i] = PzSynth.defaultParam(i);
      for (let i = 0; i < PZ_PARAM_COUNT; i++) {
        const raw = Number(st[PZ_PARAM_KEYS[i]]);
        if (Number.isFinite(raw)) { v[i] = pzRawToEngine(i, raw); this.applied[i] = raw; }
      }
      for (let i = 74; i <= 80; i++) {
        const x = Number(hid[i - 74]);
        if (Number.isFinite(x)) v[i] = x;
        this.hiddenApplied[i] = v[i];
      }
      for (let i = 0; i < 74; i++) {
        const x = Number(map[i]);
        if (Number.isFinite(x)) v[81 + i] = x;
      }
      S.loadState(v);
    } else {
      for (let i = 0; i < PZ_PARAM_COUNT; i++) {
        const raw = Number(st[PZ_PARAM_KEYS[i]]);
        if (!Number.isFinite(raw) || raw === this.applied[i]) continue;
        this.applied[i] = raw;
        S.setParameter(i, pzRawToEngine(i, raw));
      }
      for (let i = 74; i <= 80; i++) {
        const x = Number(hid[i - 74]);
        if (!Number.isFinite(x) || x === this.hiddenApplied[i]) continue;
        this.hiddenApplied[i] = x;
        S.setParameter(i, x);
      }
      for (let i = 0; i < 74; i++) {
        const x = Number(map[i] ?? -1);
        if (Number.isFinite(x) && S.ccMap[i] !== x) S.setParameter(81 + i, x);
      }
    }
    // FL parameters 74..202: MIDI CC 0..127 and channel aftertouch (sent when they change)
    for (let c = 0; c < 129; c++) {
      const k = PZ_PARAM_COUNT + c;
      const raw = Number(st[PZ_PARAM_KEYS[k]] ?? 0);
      if (raw === this.applied[k]) continue;
      const firstSet = Number.isNaN(this.applied[k]);
      this.applied[k] = raw;
      if (firstSet && raw === 0) continue;
      if (c >= 128 || c === 7 || c === 10 || c === 32) continue;
      const v = Math.max(Math.min(raw * 0.00390625, 1), 0);
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
