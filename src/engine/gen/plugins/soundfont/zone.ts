// SoundFont zones for the engine: a preset's playable layers, each one an instrument zone combined with the
// preset zone that selects it (SF2 spec 9.4 / 9.5): ranges are intersected, generators of the instrument zone
// (global zone first) are summed with the preset zone's (non-additive generators come from the instrument only; FL clamps
// the sum to the spec's range where a preset level generator is added, an instrument value alone stands as it is and the
// destination handlers of the voices clamp what they need), modulators of the
// instrument level replace the default ones with the same identity and the preset level's add to them. FL's
// Sobanth builds the same "preset layers" with key / velocity range selectors.

import { G, NUM_GENS, GEN_RANGES, INSTRUMENT_ONLY, defaultGens } from '../../../../model/gen/plugins/soundfont/gens';
import type { Sf2Hydra, Sf2Mod, Sf2Sample } from '../../../../model/gen/plugins/soundfont/sf2';
import { DEFAULT_MODS, modKey } from './mod';

export interface SfZone {
  /** Instrument + preset generators (defaults applied; sums with a preset level addend clamped to the spec's range). */
  gens: Float64Array;
  keyLo: number;
  keyHi: number;
  velLo: number;
  velHi: number;
  sample: Sf2Sample;
  sampleIndex: number;
  mods: Sf2Mod[];
  exclusive: number;
}

export interface SfPreset {
  name: string;
  bank: number;
  program: number;
  zones: SfZone[];
}

const MAX_ZONES = 1 << 16;

interface RawZone {
  gens: Map<number, number>;
  mods: Sf2Mod[];
}

function readZones(gen: Int32Array, mod: Sf2Mod[], bag: Uint16Array, first: number, last: number): RawZone[] {
  const zones: RawZone[] = [];
  const nb = bag.length / 2;
  for (let z = first; z < last && z + 1 < nb; z++) {
    const g0 = bag[z * 2], g1 = bag[(z + 1) * 2];
    const m0 = bag[z * 2 + 1], m1 = bag[(z + 1) * 2 + 1];
    const gens = new Map<number, number>();
    for (let g = g0; g < g1 && g * 2 + 1 < gen.length; g++) gens.set(gen[g * 2], gen[g * 2 + 1]);
    const mods: Sf2Mod[] = [];
    for (let m = m0; m < m1 && m < mod.length; m++) mods.push(mod[m]);
    zones.push({ gens, mods });
    if (zones.length >= MAX_ZONES) break;
  }
  return zones;
}

function range(v: number | undefined): [number, number] {
  if (v === undefined) return [0, 127];
  return [v & 0xff, (v >> 8) & 0xff];
}

/** Merge the generators of a (global) zone into a map: later values win. */
function overlay(into: Map<number, number>, from: Map<number, number>): void {
  for (const [k, v] of from) into.set(k, v);
}

/** FL clamps the sum of a generator that has a preset level addend to the spec's range (an instrument value alone stands as it is). */
function clampGen(g: number, v: number): number {
  const r = GEN_RANGES[g];
  return r ? Math.max(r[0], Math.min(r[1], v)) : v;
}

function mergeMods(list: Sf2Mod[], add: Sf2Mod[]): Sf2Mod[] {
  const out = list.slice();
  for (const m of add) {
    const k = modKey(m);
    const i = out.findIndex((x) => modKey(x) === k);
    if (i >= 0) out[i] = m; else out.push(m);
  }
  return out;
}

/** Build the playable layers of preset `index` of a hydra. */
export function buildPreset(h: Sf2Hydra, index: number): SfPreset | null {
  const p = h.presets[index], next = h.presets[index + 1];
  if (!p || !next) return null;
  const pz = readZones(h.pgen, h.pmod, h.pbag, p.bag, next.bag);
  const zones: SfZone[] = [];
  const defaults = DEFAULT_MODS;

  // global preset zone: the first zone without an instrument generator
  let pGlobal: RawZone | null = null;
  const locals: RawZone[] = [];
  pz.forEach((z, i) => {
    if (z.gens.has(G.instrument)) locals.push(z);
    else if (i === 0) pGlobal = z;
  });

  for (const z of locals) {
    const instIndex = z.gens.get(G.instrument)!;
    const inst = h.insts[instIndex], instNext = h.insts[instIndex + 1];
    if (!inst || !instNext) continue;
    const iz = readZones(h.igen, h.imod, h.ibag, inst.bag, instNext.bag);
    let iGlobal: RawZone | null = null;
    const iLocals: RawZone[] = [];
    iz.forEach((x, i) => {
      if (x.gens.has(G.sampleID)) iLocals.push(x);
      else if (i === 0) iGlobal = x;
    });

    // preset-level values: global overlaid by the local zone
    const pg = new Map<number, number>();
    if (pGlobal) overlay(pg, (pGlobal as RawZone).gens);
    overlay(pg, z.gens);
    const pMods = mergeMods((pGlobal as RawZone | null)?.mods ?? [], z.mods);
    const pKey = range(pg.get(G.keyRange)), pVel = range(pg.get(G.velRange));

    for (const x of iLocals) {
      const ig = new Map<number, number>();
      if (iGlobal) overlay(ig, (iGlobal as RawZone).gens);
      overlay(ig, x.gens);
      const sIndex = ig.get(G.sampleID)!;
      const sample = h.samples[sIndex];
      if (!sample) continue;
      const iKey = range(ig.get(G.keyRange)), iVel = range(ig.get(G.velRange));
      const keyLo = Math.max(pKey[0], iKey[0]), keyHi = Math.min(pKey[1], iKey[1]);
      const velLo = Math.max(pVel[0], iVel[0]), velHi = Math.min(pVel[1], iVel[1]);
      if (keyLo > keyHi || velLo > velHi) continue;

      const gens = defaultGens();
      for (const [g, v] of ig) if (g >= 0 && g < NUM_GENS) gens[g] = v;
      for (const [g, v] of pg) {
        if (g < 0 || g >= NUM_GENS || INSTRUMENT_ONLY.has(g)) continue;
        if (g === G.instrument || g === G.sampleID || g === G.keyRange || g === G.velRange) continue;
        gens[g] = clampGen(g, gens[g] + v);
      }
      const iMods = mergeMods((iGlobal as RawZone | null)?.mods ?? [], x.mods);
      // instrument modulators replace the defaults with the same identity, preset modulators add to them
      let mods = mergeMods(defaults, iMods);
      for (const m of pMods) {
        const k = modKey(m);
        const i = mods.findIndex((q) => modKey(q) === k);
        if (i >= 0) mods[i] = { ...mods[i], amount: mods[i].amount + m.amount }; else mods.push(m);
      }
      zones.push({
        gens, keyLo, keyHi, velLo, velHi, sample, sampleIndex: sIndex, mods, exclusive: Math.max(0, ig.get(G.exclusiveClass) ?? 0),
      });
      if (zones.length >= MAX_ZONES) break;
    }
    if (zones.length >= MAX_ZONES) break;
  }
  return { name: p.name, bank: p.bank, program: p.program, zones };
}
