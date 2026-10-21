// Ogun's "Generate random preset" (FL: Ogun_x64.dylib 0x72b00, TTestPlug "WilldoEnGin"). The preset number is the seed of FL's Mersenne twister (Tmt19937 with the quirk of its second twist loop, which reads the index field
// below the state array as mt[-1]); every decision is one draw trunc(float32(float32(r) * 2^-32) * n) of that stream, taken in the
// order of FL's code: a template state (Default.dat or, for the resynthesis type, Default_C.dat), then the editor's controls set by
// SetPosition in turn, the random envelopes, the random pad harmonics maps and the madlib info text.
//
// The templates, the eight random envelope shapes, the chorus / reverb tables and the word lists are parameter-level data
// (randomdata.ts). The resynthesis template (type 2) holds a dense harmonic map in FL that is not part of that data; a generated
// preset never keeps it (the pad harmonics tool rebuilds the impulse EQ map in every preset), so no FL content is needed.

import type { FxParams } from '../../../fx/types';
import { exp as libmExp } from '../../../../engine/gen/plugins/harmor/fx-libm';
import { OG_RND } from './randomdata';
import { entryToState } from './state';
import { ART_TARGETS, OGUN_KEYS } from './params';
import {
  defaultWindow, newPadSettings, padHarmonics, padMapLoaded, padMapRaw, padSpectrum, padUnit, prepareWindow, randomizeBins, randomWidthValue,
} from './padharm';
import { fixLength, pointKind } from './flstate';
import type { OgArt, OgEntry, OgEnv } from './types';

const f32 = Math.fround;
const R32 = 2 ** -32;
const LN3 = 1.0986122886681098;

// ------------------------------------------------------------------------------------------------------------ the random numbers

/** FL's Tmt19937 (Ogun_x64 0x26db20 init_genrand, 0x26dcf0 genrand_int32): MT19937 whose second twist loop starts at k = 226. */
export class FlMt {
  private idx = 625;
  private readonly mt = new Uint32Array(624);
  constructor(seed: number) {
    this.init(seed);
  }
  private init(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) {
      const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(p, 1812433253) + i) >>> 0;
    }
    this.idx = 624;
  }
  next(): number {
    const mt = this.mt;
    if (this.idx >= 624) {
      if (this.idx === 625) this.init(5489);
      const mag = (y: number) => (y & 1 ? 0x9908b0df : 0);
      let k = 0;
      for (; k <= 226; k++) {
        const y = (mt[k] & 0x80000000) | (mt[k + 1] & 0x7fffffff);
        mt[k] = mt[k + 397] ^ (y >>> 1) ^ mag(y);
      }
      // the quirk: the loop restarts at 226 and reads mt[-1], the index field of the FL object (still 624)
      for (k = 226; k < 623; k++) {
        const y = (mt[k] & 0x80000000) | (mt[k + 1] & 0x7fffffff);
        const m = k - 227 < 0 ? this.idx : mt[k - 227];
        mt[k] = m ^ (y >>> 1) ^ mag(y);
      }
      const y = (mt[623] & 0x80000000) | (mt[0] & 0x7fffffff);
      mt[623] = mt[396] ^ (y >>> 1) ^ mag(y);
      this.idx = 0;
    }
    let y = mt[this.idx++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
}

/** The draw FL uses everywhere: trunc((single(r) * 2^-32) * single(n)), 0 .. n - 1. */
function draw(mt: FlMt, n: number): number {
  return Math.trunc(f32(f32(f32(mt.next()) * R32) * f32(n)));
}
/** The double flavour of a draw: (double) r * (1 / 4294967295) (the constant at Ogun_x64 0x2a6f10; the single flavour uses 2^-32). */
function unit(mt: FlMt): number {
  return mt.next() * 2.3283064370807974e-10;
}

// -------------------------------------------------------------------------------------------------------------------- the state

/** Controls of the editor form the generator sets (name: parameter / setting, range) and how a position lands in the state ints. */
interface Ctl {
  min: number;
  max: number;
  /** Index of the state int the control writes. */
  at: number;
  /** Value stored for a position (identity unless noted). */
  to?: (v: number) => number;
}
const CT: Record<string, Ctl> = {
  MainCPitchSlider: { min: -24, max: 24, at: 1 },
  ModYWheel: { min: 0, max: 512, at: 4 },
  DecayWheel: { min: 0, max: 10000, at: 6 },
  ReleaseWheel: { min: 0, max: 10000, at: 7 },
  FullnessWheel: { min: -1000, max: 1000, at: 8 },
  TimbreSeedWheel: { min: 0, max: 9999, at: 10 },
  TimbreSeed2Wheel: { min: 0, max: 9999, at: 11 },
  FatOrderSelect: { min: 1, max: 9, at: 12 },
  FatPanWheel: { min: 0, max: 128, at: 13 },
  FatPitchWheel: { min: 0, max: 256, at: 15 },
  FatPhaseWheel: { min: 0, max: 128, at: 16 },
  FCutWheel: { min: 0, max: 256, at: 17 },
  FResWheel: { min: 0, max: 256, at: 18 },
  ChOrderSelect: { min: 0, max: 9, at: 19 },
  ChCrossWheel: { min: -128, max: 128, at: 24 },
  ChWetWheel: { min: -128, max: 128, at: 25 },
  DelVolWheel: { min: -128, max: 128, at: 29 },
  DelModeSelect: { min: 0, max: 2, at: 30 },
  RevVolWheel: { min: -128, max: 128, at: 39 },
  FOrderSelect: { min: 0, max: 3, at: 50 },
  /** The richness slider shows 1 .. 11, the state keeps the synthesizer's order 6 .. 16. */
  RichnessWheel: { min: 1, max: 11, at: 52, to: (v) => v + 5 },
};

interface Gen {
  mt: FlMt;
  /** 0 pad, 1 pad with plateau spectra, 2 resynthesis template. */
  type: number;
  ints: number[];
  b3: number[];
  eq: number[];
  arts: OgArt[];
  maps: OgEnv[];
  missing: string[];
  info: string;
}

function setCtl(g: Gen, name: string, v: number): void {
  const c = CT[name];
  const x = Math.min(c.max, Math.max(c.min, v));
  g.ints[c.at] = c.to ? c.to(x) : x;
}
/** The control's range (SetPosition clamps to it; the generator's formulas use min / max). */
const lo = (name: string): number => CT[name].min;
const hi = (name: string): number => CT[name].max;

/** A byte of the settings block: plug+0x200 + off (ints 49 ..). */
function getByte(g: Gen, off: number): number {
  return (g.ints[49 + ((off - 0x200) >> 2)] >>> (8 * (off & 3))) & 255;
}
function setByte(g: Gen, off: number, v: number): void {
  const k = 49 + ((off - 0x200) >> 2), sh = 8 * (off & 3);
  g.ints[k] = ((g.ints[k] & ~(255 << sh)) | ((v & 255) << sh)) | 0;
}
const ALT = 0x234;

// --------------------------------------------------------------------------------------------------------------------- curves

const pts = (e: OgEnv): number[][] => e.p;

/** 0x74d30: randomize the envelope of articulator `idx` (0 volume, 1 filter frequency). */
function randomEnvelope(g: Gen, idx: number): void {
  const mt = g.mt;
  const art = g.arts[idx];
  const env = art.e;
  const c = draw(mt, 4);
  const alt = getByte(g, ALT) !== 0;
  // marker 1 (+0x48): set when the shape is "free"; the filter envelope only keeps it for the plain pad type
  const free = (c === 0 || (idx === 1 && alt)) && (idx !== 1 || g.type === 0);
  env.m[1] = free ? -1 : 0;
  if (free && draw(mt, 3) === 0) {
    // a random file of Random pad/Envelopes (1.fnv .. 8.fnv): u = single(r) * 2^-32 as a double, index trunc(u * 8)
    const u = f32(f32(mt.next()) * R32);
    let k = Math.trunc(u * 8);
    if (k > 7) k = 7;
    const e = entryCurve(OG_RND.env[k] as unknown as unknown[], 1);
    env.p = e.p;
    env.m = e.m;
    env.a = e.a;
  }
  if (idx === 1) {
    const last = env.m[4];
    if (last >= 0 && pts(env).length - 1 >= last + 1) pts(env).length = last + 1;
    const d8 = unit(mt) * 0.5;
    for (const q of pts(env)) q[1] = f32(0.75 + f32(q[1] - 0.5) * d8);
    env.a![0] = draw(mt, 0xa1) + 0x60;
  } else {
    env.a![0] = draw(mt, 0xe1) + 0x20;
  }
  // the keyboard mapping's last point is lowered by a random 50 .. 100 percent
  const k0 = pts(art.k[0]);
  const q = k0[k0.length - 1];
  q[1] = f32((0.5 + unit(mt) * 0.5) * q[1]);
}

/** 0x74bc0: scatter the levels of the shaping map with object number `obj` (15 decay EQ, 16 release EQ). */
function randomMapLevels(g: Gen, obj: number): void {
  const mt = g.mt;
  const m = pts(g.maps[obj - 13]);
  for (let i = 0; i < m.length; i++) {
    const q = m[i];
    if (i < 4) {
      const y = q[1];
      q[1] = f32(y - (unit(mt) / 3) * y);
    } else {
      const u = f32(unit(mt));
      const e = f32(libmExp(u * LN3) - 1);
      q[1] = f32(f32(f32(2 - e) * 0.5) * q[1]);
    }
  }
}

/**
 * 0x74ad0 + 0xf2c90: the pad harmonics tool on shaping map `obj` (14 impulse EQ, 15 decay EQ) with the harmonics divided by `div`:
 * all settings reset, then the width and both bin arrays randomized and the map built. The state keeps the curve as FL loads it
 * (the first point at 0 and the distances scaled to sum to 1: flstate.ts fixLength).
 */
function randomPad(g: Gen, obj: number, div: number): void {
  const order = g.ints[52];
  const n = Math.trunc(padHarmonics(order) / div);
  const rng = () => g.mt.next();
  const s = newPadSettings();
  s.width = randomWidthValue(rng);
  randomizeBins(s.bins, 3, rng, { steep: obj !== 14, walk: g.type === 1 });
  const spec = padSpectrum(s.bins, prepareWindow(defaultWindow()), { width: s.width, normalize: s.normalize, n });
  const base = g.maps[obj - 13];
  // the editor stores the tool's curve with a copy of its first point (FL's state holds that); a load adds the point at 0 and scales
  // the distances to sum to 1 (the form of a project's state, as normalizeOgun keeps it)
  const p = padMapLoaded(padMapRaw(spec, padUnit(false), 1, base.m.slice(2, 5)), 1);
  fixLength(p);
  for (let i = 1; i < p.length; i++) p[i][6] = pointKind(p[i][2], p[i][3]);
  g.maps[obj - 13] = { ...base, t: 3, m: base.m.slice(), p };
  // the map is the tool's now, whatever the template left out
  g.missing = g.missing.filter((k) => k !== `m${obj - 13}`);
}

/** A compact curve of randomdata (flat points x, y, tension, packed bytes; markers; knob values) -> a model curve. */
function entryCurve(c: unknown[], t: number): OgEnv {
  const flat = c[0] as number[];
  const p: number[][] = [];
  for (let i = 0; i + 3 < flat.length; i += 4) {
    const b = flat[i + 3];
    p.push([flat[i], flat[i + 1], flat[i + 2], b & 255, (b >>> 8) & 255, (b >>> 16) & 255, (b >>> 24) & 255]);
  }
  const e: OgEnv = { t, p, m: (c[1] as number[]).slice() };
  if (t === 1) e.a = (c[2] as number[]).slice();
  return e;
}

// ---------------------------------------------------------------------------------------------------------------------- the text

const W = OG_RND.words as unknown as string[][];

/** 0x749e0: a random line of word list `list`. */
function pick(mt: FlMt, list: number): string {
  const w = W[list];
  return w[Math.min(w.length - 1, Math.trunc(f32(f32(f32(mt.next()) * R32) * f32(w.length))))];
}
/** FPC Format with %s only. */
function fmt(f: string, args: string[]): string {
  let i = 0;
  return f.replace(/%s/g, () => args[i++] ?? '');
}
function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
/** 0x74860: a thing to sound like, now and then with an adjective in front. */
function thing(mt: FlMt): string {
  const a = pick(mt, 6);
  const b = draw(mt, 2) === 0 ? pick(mt, 4) + ' ' : '';
  return fmt(a, [b]);
}

/**
 * The generator's info text: a title and one to three lines of description, put together from the word lists. Autogun's
 * generator (same function, FL's Autogun_x64.dylib 0x70170) makes no "Computer says no" draw, adds the last clause to a second line
 * after a first one too, and shows the name it draws:
 * title and author lines carry the memo's style codes (U+E427 / U+E4FF around the title, U+E5A0 / U+E5FF around the name).
 */
function infoText(g: Gen, autogun: boolean): string {
  const mt = g.mt;
  let t10 = '';
  const x21 = draw(mt, 4) > 0;
  if (x21) {
    const noun = pick(mt, 2);
    t10 = fmt(pick(mt, 1), [noun]);
    if (draw(mt, 12) === 0) t10 = pick(mt, 4) + '.';
    else if (draw(mt, 5) === 0) t10 += '.';
    else {
      if (draw(mt, 10) === 0) t10 += ' - ';
      else t10 += draw(mt, 3) === 0 ? ' ' : ', ';
      const a1 = pick(mt, 4), a2 = pick(mt, 4), a3 = pick(mt, 4);
      t10 += fmt(pick(mt, 3), [a1, a2, a3]) + '.';
    }
    t10 = cap(t10);
  }
  if (!x21 || draw(mt, 2) === 0) {
    if (t10) t10 += '\r';
    const a = thing(mt);
    const b = thing(mt);
    t10 += fmt(pick(mt, 5), [a, b]);
    const t18 = pick(mt, 7);
    const c3 = draw(mt, 3);
    if ((autogun || !x21) && c3 > 0 && t10.length <= 90) t10 = t10 + ' ' + t18;
    t10 += draw(mt, 5) > 0 ? '.' : '!';
  }
  let t20 = t10;
  const name = pick(mt, 0); // a name (Ogun's text does not show it)
  if (!autogun && draw(mt, 30) === 0) t20 = 'Computer says no\r' + t20;
  let title = draw(mt, 4) === 0 ? pick(mt, 4) : pick(mt, 8);
  if (draw(mt, 3) === 0) title = pick(mt, 9);
  else if (draw(mt, 4) === 0) title += cap(pick(mt, 9));
  else title = title + ' ' + pick(mt, 9);
  if (draw(mt, 4) === 0) title = title + ' ' + String(draw(mt, 6) + 2);
  if (autogun) return '\ue427' + cap(title) + '\ue4ff\r\ue5a0' + name + '\ue5ff\r' + t20;
  return cap(title) + '\r' + t20;
}

// ------------------------------------------------------------------------------------------------------------------ the generator

/** The template type a draw selects: 21 of 30 plain pads (0), 7 pads with plateau spectra (1), 2 of the resynthesis template (2). */
function typeOf(r: number): number {
  const t = Math.trunc(f32(f32(f32(r) * R32) * f32(30)));
  return t >= 28 ? 2 : t >= 21 ? 1 : 0;
}

/** The template type of preset number `seed` (the generator's first draw): 0 pad, 1 pad with plateau spectra, 2 resynthesis template. */
export function presetType(seed: number): number {
  return typeOf(new FlMt(seed).next());
}

/**
 * The patch FL's generator makes of preset number `seed` (the counter after the increment: "Generate random preset" asks for the
 * previous number + 1, "Enter random preset number" for number - 1). Returns the plugin state (types.ts). `autogun`: Autogun's variant of
 * the same function (the info text only; it keeps the plugin's master level and magic dust, which the caller sets).
 */
export function generateOgun(seed: number, autogun = false): FxParams {
  const mt = new FlMt(seed);
  const type = typeOf(mt.next());
  const tpl = (type === 2 ? OG_RND.tplC : OG_RND.tplA) as unknown as OgEntry;
  const st = entryToState(tpl) as Record<string, unknown>;
  const g: Gen = {
    mt, type,
    ints: [...OGUN_KEYS.slice(0, 49).map((k) => st[k] as number), ...(st.xi as number[])],
    b3: (st.b3 as number[]).slice(), eq: (st.i2 as number[]).slice(),
    arts: st.arts as OgArt[], maps: st.maps as OgEnv[], missing: (st.missing as string[]).slice(), info: '',
  };
  if (type !== 2) {
    // the plain pad types
    setByte(g, ALT, draw(mt, 4) === 0 ? 1 : 0);
    randomEnvelope(g, 0);
    randomEnvelope(g, 1);
    const filterFree = g.arts[1].e.m[1] !== 0;
    if (filterFree) setCtl(g, 'FOrderSelect', draw(mt, hi('FOrderSelect')) + 1);
    else setCtl(g, 'FOrderSelect', 0);
    const cut = Math.trunc(hi('FCutWheel') / 3);
    setCtl(g, 'FCutWheel', draw(mt, cut) + cut);
    setCtl(g, 'FResWheel', draw(mt, Math.trunc((hi('FResWheel') * 4) / 9)));
    g.ints[51] = draw(mt, 3) === 0 ? -1 : 0; // FFlatBtn
    setByte(g, 0x220, draw(mt, 4) === 0 ? 1 : 0);
    setCtl(g, 'MainCPitchSlider', draw(mt, 4) * 12 - 24);
    setCtl(g, 'FatOrderSelect', draw(mt, 5) + 1);
    setCtl(g, 'FatPitchWheel', draw(mt, hi('FatPitchWheel') + 1));
    setCtl(g, 'FatPhaseWheel', draw(mt, hi('FatPhaseWheel') + 1));
    setCtl(g, 'FatPanWheel', hi('FatPanWheel') - draw(mt, Math.trunc(hi('FatPanWheel') / 2)));
    setCtl(g, 'TimbreSeed2Wheel', draw(mt, hi('TimbreSeed2Wheel') + 1));
    if (draw(mt, 3) > 0) {
      const a = draw(mt, 5) + 2;
      const b = draw(mt, 5);
      setCtl(g, 'ChOrderSelect', b > 0 ? a : 0);
      setCtl(g, 'ChWetWheel', hi('ChWetWheel') - draw(mt, Math.trunc((hi('ChWetWheel') * 2) / 3)));
    } else {
      const row = OG_RND.chorus[draw(mt, 8)] as unknown as number[];
      for (let i = 0; i < 6; i++) g.ints[19 + i] = row[i];
    }
    setCtl(g, 'ChCrossWheel', draw(mt, hi('ChCrossWheel') - lo('ChCrossWheel') + 1) + lo('ChCrossWheel'));
    reverbPreset(g, draw(mt, 7));
    setCtl(g, 'RevVolWheel', Math.trunc((hi('RevVolWheel') * 2) / 3) - draw(mt, Math.trunc(hi('RevVolWheel') / 2)));
    g.b3[1] = draw(mt, 2) === 0 ? 1 : 0; // DelEnableBtn
    setCtl(g, 'DelVolWheel', draw(mt, Math.trunc(hi('DelVolWheel') / 3)) + Math.trunc(hi('DelVolWheel') / 5));
    const dec = hi('DecayWheel');
    if (g.arts[0].e.m[1] !== 0 || g.arts[1].e.m[1] !== 0) setCtl(g, 'DecayWheel', dec - 1 - draw(mt, Math.trunc(dec / 4)));
    else setCtl(g, 'DecayWheel', dec - 1 - draw(mt, Math.trunc((dec * 2) / 3)));
    setCtl(g, 'DelModeSelect', draw(mt, 3));
    const none = draw(mt, 3) === 0 ? 1 : 0;
    setCtl(g, 'RichnessWheel', hi('RichnessWheel') - (draw(mt, 3) + 1) * none);
  } else {
    // the resynthesis template keeps its sound and gets new seeds
    setByte(g, 0x21c, draw(mt, 5) === 0 ? 1 : 0);
    setCtl(g, 'TimbreSeedWheel', draw(mt, hi('TimbreSeedWheel') - 1) + 1);
    setCtl(g, 'TimbreSeed2Wheel', 0);
    setCtl(g, 'ModYWheel', hi('ModYWheel') * (draw(mt, 4) === 0 ? 1 : 0));
    setCtl(g, 'FullnessWheel', draw(mt, hi('FullnessWheel') - lo('FullnessWheel')) + lo('FullnessWheel'));
    setCtl(g, 'DecayWheel', hi('DecayWheel') - 1 - draw(mt, Math.trunc((hi('DecayWheel') * 2) / 3)));
    reverbPreset(g, draw(mt, 7));
    setCtl(g, 'RevVolWheel', Math.trunc(hi('RevVolWheel') / 2) - draw(mt, Math.trunc(hi('RevVolWheel') / 3)));
  }
  const rel = hi('ReleaseWheel');
  if (getByte(g, ALT) === 0) {
    randomMapLevels(g, 15);
    setCtl(g, 'ReleaseWheel', draw(mt, Math.trunc(rel / 4)) + Math.trunc(rel / 8));
  } else {
    setCtl(g, 'ReleaseWheel', draw(mt, Math.trunc(rel / 3)) + Math.trunc(rel / 4));
  }
  g.ints[0] = 128; // ProcessParam(0, 128): the master level
  if (draw(mt, 4) === 0 && getByte(g, ALT) === 0) g.ints[60] = draw(mt, 8);
  randomMapLevels(g, 16);
  let div2 = 1;
  if (getByte(g, ALT) !== 0) {
    const d1 = draw(mt, 2) + 1;
    randomPad(g, 15, d1);
    div2 = draw(mt, 2) === 0 && d1 === 1 ? 2 : 1;
  }
  randomPad(g, 14, div2);
  g.info = infoText(g, autogun);
  return finish(g, st);
}

/** 0x65aa0: reverb preset `i` (parameters 31 .. 39); the last one switches the reverb off. */
function reverbPreset(g: Gen, i: number): void {
  const row = OG_RND.reverb[i] as unknown as number[];
  for (let k = 0; k < 9; k++) g.ints[31 + k] = row[k];
  setByte(g, 0x211, 0); // RevTempoBtn off
  setByte(g, 0x210, i !== 6 ? 1 : 0); // RevEnableBtn
}

/** The generated state in the plugin state's layout (state.ts entryToState). */
function finish(g: Gen, st: Record<string, unknown>): FxParams {
  const out: FxParams = { ...st } as FxParams;
  for (let i = 0; i < 49; i++) out[OGUN_KEYS[i]] = g.ints[i];
  out.xi = g.ints.slice(49);
  out.b3 = g.b3;
  out.i2 = g.eq;
  out.info = g.info;
  out.arts = g.arts;
  out.maps = g.maps;
  out.missing = g.missing;
  for (let t = 0; t < ART_TARGETS.length; t++) {
    const kp = ART_TARGETS[t][0], a = g.arts[t].e.a ?? [128, 128, 0, 128], l = g.arts[t].l.l ?? [40000, 0, 0, 0];
    ['Att', 'Dec', 'Sus', 'Rel'].forEach((s, j) => { out[kp + s] = a[j]; });
    ['LfoSpd', 'LfoTns', 'LfoSkw', 'LfoPw'].forEach((s, j) => { out[kp + s] = l[j]; });
  }
  return out;
}
