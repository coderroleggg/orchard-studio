// SimSynth: FL's `Preset` (SSPlug + 0x238): the 45 patch values (doubles 0..1) and
// 19 switches, how each one sets the shared synth data (Preset::Set, 0x685c / 0x7884)
// and how it reaches every voice (Voice::Set, 0x72fc / 0x7698), plus the voice-list
// operations (SetNumVoices, SetQuality, SetRender, Set(double*, int*), Bend).

import { Patch } from './patch';
import { makeSamp, Synth } from './synth';
import { cvtzs, f32, fma } from './fmath';

export class Preset {
  readonly sy = new Synth();
  /** 0x50: the patch values; 0x1b8: controller offsets (always 0 in FL's plugin). */
  readonly d = new Float64Array(45);
  readonly off = new Float64Array(45);
  /** 0x320: the switches. */
  readonly ints = new Int32Array(19);
  /** The voice list (Voice::SetPreset appends; FL's slot order). */
  readonly voices: Patch[] = [];
  /** 0x48: pitch offset (SSPlug sets 2400). */
  transpose = 0;
  /** 0x838 / 0x83c = SSPlug 0xa70 / 0xa74: chorus switch, VCA Velo (output gain). */
  chorus = 0;
  vca = f32(0.5);
  /** 0x848 / 0x850: bend scale. */
  bendScale = 0;
  numVoices = 0;

  /** Preset::Create's part of the creation (the synth is constructed with the preset). */
  addVoice(p: Patch): void {
    this.voices.push(p);
    p.generate(0);
  }

  /** Preset::SetNumVoices (0x6754): the per-voice detune spread (0, -8, 8, -6, 6, ...). */
  setNumVoices(n: number): void {
    this.numVoices = n;
    let h = n < 0 ? (n + 1) >> 1 : n >> 1;
    if (!(h > 1)) h = 1;
    if (n === 0 || this.voices.length === 0) return;
    const d0 = 8 / h;
    let d1 = -8, d2 = 8, d4 = 0;
    for (let i = 0; i < n && i < this.voices.length; i++) {
      this.voices[i].detune = cvtzs(d4);
      const lt = d4 < 0;
      const d5 = lt ? -0 : d0;
      const d6 = lt ? d0 : 0;
      d4 = lt ? d2 : d1;
      d1 = d5 + d1;
      d2 = d2 - d6;
    }
  }

  setBendScale(b: number): void { this.bendScale = b * 0.006103515625; }

  /** Preset::SetQuality (0x7bc4) / SetRender (0x7c30). */
  setQuality(q: number, regen: boolean): void {
    this.sy.quality = q & 0xff;
    if (regen) this.makeVoices();
  }
  setRender(r: number, ri: number, regen: boolean): void {
    this.sy.render = r & 0xff;
    this.sy.renderInt = ri;
    if (regen) this.makeVoices();
  }

  /** Preset::MakeVoices (0x71dc): synth::f_generate(voice, 0) for every voice. */
  makeVoices(): void {
    for (const p of this.voices) p.generate(0);
  }

  /** Preset::Bend (0x7ca4). */
  bend(b: number): void {
    const v = f32(this.bendScale * b);
    for (const p of this.voices) p.bend = v;
  }

  clearOffsets(): void { this.off.fill(0); }

  /** Preset::Flush (0x7778). */
  flush(): void { for (const p of this.voices) p.start(); }

  /** Preset::Set(double*, int*) (0x77d0): a whole state, then every voice rebuilt. */
  setAll(d: ArrayLike<number>, ints: ArrayLike<number>): void {
    for (let i = 0; i < 19; i++) this.setI(i, ints[i], false, null);
    for (let i = 0; i < 45; i++) this.setD(i, d[i], false, null);
    this.makeVoices();
  }

  /** Preset::Set(int, double, int, Voice*) (0x685c). */
  setD(slot: number, value: number, prop: boolean, voice: Patch | null): void {
    const sy = this.sy;
    for (;;) {
      this.d[slot] = value;
      const x = value + this.off[slot];
      const v = x < 0 ? 0 : x <= 1 ? x : 1;
      let reset = false, next = -1;
      const k = slot < 21 ? (slot / 7) | 0 : -1;
      const r = k >= 0 ? sy.osc[k] : sy.osc[3];
      switch (slot) {
        case 0: case 7: case 14: r.pw = cvtzs(v * 96) + 2; makeSamp(sy, k); break;
        case 1: case 8: case 15: r.coarse = Math.imul(cvtzs(Math.floor(v * 48) + -24), 100); break;
        case 2: case 9: case 16: r.fine = cvtzs(fma(v, 200, -100)); break;
        case 3: case 10: case 17: r.level = cvtzs(v * 100); break;
        case 4: case 11: case 18: r.lfo = cvtzs(fma(v, 200, -100)); break;
        case 5: case 12: case 19: r.env = cvtzs(fma(v, 200, -100)); break;
        case 6: case 13: case 20: {
          let t = -1;
          if (v === 0) t = 2; else if (v === 0.1) t = 1; else if (v === 0.2) t = 0; else if (v === 0.3) t = 4; else if (v === 0.4) t = 3;
          if (t >= 0) { r.type = t; if (t !== 3) makeSamp(sy, k); }
          reset = true;
          next = slot - 5;
          break;
        }
        case 21: sy.osc[3].f10 = cvtzs(v * 100); break;
        case 22: sy.osc[3].coarse = cvtzs(v * 999); break;
        case 24: {
          if (v === 0) sy.osc[3].type = 2; else if (v === 0.1) sy.osc[3].type = 1;
          else if (v === 0.2) sy.osc[3].type = 0; else if (v === 0.4) sy.osc[3].type = 3;
          break;
        }
        case 26: sy.cut = cvtzs(v * 255); break;
        case 27: sy.emph = cvtzs(v * 255); break;
        case 28: sy.fEnv = cvtzs(fma(v, 255, -127.5)); break;
        case 29: sy.fLfo = cvtzs(fma(v, 255, -127.5)); break;
        case 30: sy.kb = f32(v); break;
        case 31: sy.f160 = f32(v); break;
        case 32: sy.high = cvtzs(v * 255); break;
        case 33: sy.band = cvtzs(v * 255); break;
        case 34: sy.low = cvtzs(v * 255); break;
        case 35: sy.env1Times[0] = cvtzs(v * v * 8000 * v); sy.env1Lv[0] = 255; break;
        case 36: sy.env1Times[1] = cvtzs(v * v * 8000); break;
        case 37: { const s = cvtzs(v * 255); sy.env1Lv[1] = s; sy.env1Lv[2] = s; sy.env1Times[2] = -1; break; }
        case 38: sy.env1Lv[3] = 0; sy.env1Times[3] = cvtzs(v * v * 8000); break;
        case 39: { const g = f32(v); sy.vca = g; this.vca = g; return; }
        case 40: sy.d40sq = f32(v * v); break;
        case 41: sy.env2Times[0] = cvtzs(v * v * 8000 * v); sy.env2Lv[0] = 255; break;
        case 42: sy.env2Times[1] = cvtzs(v * v * 8000); break;
        case 43: { const s = cvtzs(v * 255); sy.env2Lv[1] = s; sy.env2Lv[2] = s; sy.env2Times[2] = -1; break; }
        case 44: sy.env2Lv[3] = 0; sy.env2Times[3] = cvtzs(v * v * 8000); break;
        default: break; // 23, 25: unused
      }
      if (!prop) return;
      if (voice) voiceSetD(voice, slot, v);
      else for (const p of this.voices) voiceSetD(p, slot, v);
      if (!reset) return;
      value = this.d[next];
      slot = next;
      prop = true;
    }
  }

  /** Preset::Set(int, int, int, Voice*) (0x7884). */
  setI(idx: number, val: number, prop: boolean, voice: Patch | null): void {
    const sy = this.sy;
    this.ints[idx] = val;
    switch (idx) {
      case 0: case 4: case 8: sy.osc[idx >> 2].off = val === 0 ? 1 : 0; break;
      case 1: case 5: case 9: sy.osc[(idx / 4) | 0].oct1 = val; makeSamp(sy, (idx / 4) | 0); break;
      case 2: case 6: case 10: sy.osc[(idx / 4) | 0].oct2 = val; makeSamp(sy, (idx / 4) | 0); break;
      case 3: case 7: case 11: sy.osc[(idx / 4) | 0].warm = val; break;
      case 12: sy.osc[3].off = val === 0 ? 1 : 0; break;
      case 13: sy.osc[3].warm = val; break;
      case 14: sy.svfOff = val === 0 ? 0x2253 : 0; break;
      case 15: sy.b15c = val === 1 ? 1 : 0; break;
      case 16: sy.trackAmpOff = val === 0 ? 1 : 0; break;
      case 17: sy.osc[0].ring = val; break;
      case 18: this.chorus = val === 1 ? 1 : 0; return;
      default: return;
    }
    if (!prop) return;
    if (voice) voiceSetI(voice, idx); else for (const p of this.voices) voiceSetI(p, idx);
    if (idx === 8) { this.setD(15, this.d[15], true, voice); this.setD(17, this.d[17], true, voice); this.setD(14, this.d[14], true, voice); }
    else if (idx === 4) { this.setD(8, this.d[8], true, voice); this.setD(10, this.d[10], true, voice); this.setD(7, this.d[7], true, voice); }
    else if (idx === 0) { this.setD(1, this.d[1], true, voice); this.setD(3, this.d[3], true, voice); this.setD(0, this.d[0], true, voice); }
  }
}

const s16 = (v: number) => (v << 16) >> 16;

/** Voice::Set(int, double) (0x72fc). */
function voiceSetD(p: Patch, slot: number, v: number): void {
  const sy = p.sy;
  switch (slot) {
    case 1: case 8: case 15: { const k = (slot / 7) | 0; p.setOscKnob(f32(v), k); p.setOscFrq(k, s16(sy.osc[k].coarse), s16(sy.osc[k].fine)); break; }
    case 2: case 9: case 16: { const k = (slot / 7) | 0; p.setOscFrq(k, s16(sy.osc[k].coarse), s16(sy.osc[k].fine)); break; }
    case 3: case 10: case 17: p.recalcAmps(); break;
    case 4: case 11: case 18: p.changeOscLfo((slot / 7) | 0); break;
    case 5: case 12: case 19: p.changeOscEnv((slot / 7) | 0); break;
    case 6: case 13: case 20: p.rethinkOscs(); break;
    case 21: p.setLfoDelay(); break;
    case 22: p.setLfoFrq(); break;
    case 24: p.rethinkLfo(); break;
    case 26: p.setFilterFrq(sy.cut); break;
    case 27: p.setFilterQ(sy.emph); break;
    case 28: if (p.fEnvOn) p.setFilterEnvAmt(sy.fEnv); else p.rethinkFilter(); break;
    case 29: if (p.fLfoOn) p.setFilterLfoAmt(sy.fLfo); else p.rethinkFilter(); break;
    case 30: case 31: case 32: case 33: case 34: p.rethinkFilter(); break;
    case 35: p.env1.setAttack(sy.env1Times[0]); break;
    case 36: p.env1.setDecay(sy.env1Times[1]); break;
    case 37: p.env1.modSustain(sy.env1Lv[2]); break;
    case 38: p.env1.setRelease(sy.env1Times[3], 2); break;
    case 39: p.vca = sy.vca; break;
    case 40: p.x14 = sy.d40sq; break;
    case 41: p.env2.setAttack(sy.env2Times[0]); break;
    case 42: p.env2.setDecay(sy.env2Times[1]); break;
    case 43: p.env2.modSustain(sy.env2Lv[2]); break;
    case 44: p.env2.setRelease(sy.env2Times[3], 1); break;
    default: break;
  }
}

/** Voice::Set(int, int) (0x7698). */
function voiceSetI(p: Patch, idx: number): void {
  switch (idx) {
    case 0: case 4: case 8: p.rethinkOscs(); break;
    case 1: case 2: case 3: p.reInitOsc(0); break;
    case 5: case 6: case 7: p.reInitOsc(1); break;
    case 9: case 10: case 11: p.reInitOsc(2); break;
    case 12: case 13: p.rethinkLfo(); break;
    case 14: p.rethinkFilter(); break;
    case 16: p.trackAmpOff = p.sy.trackAmpOff; break;
    case 17: p.ring = p.sy.osc[0].ring !== 0 ? 1 : 0; break;
    default: break;
  }
}
