// Slicex state helpers shared by the engine and the editor: normalisation of stored states,
// FL's key mapping (base note 0x1fe810, effective trigger note 0x1fe880, the per-deck key lists
// built by 0x7d3f0), region ends (0x1fe350) and the plugin state keys.

import type { FxParams } from '../../../fx/types';
import { defaultArt, defaultRegion, defaultSettings, emptyDeck, settingsFromRaw } from './defaults';
import type { SxArt, SxCurve, SxDeck, SxRegion, SxSettings, SxTarget } from './types';

/** State keys of the two decks' samples (pool ids; "sample" keys reach the engine automatically). */
export const SX_SAMPLE_KEYS = ['sampleA', 'sampleB'] as const;
export const SX_DECK_KEYS = ['deckA', 'deckB'] as const;

/** View state keys (kept on preset loads, no undo). */
export const SX_VIEW_KEYS = ['vArt', 'vTarget', 'vPart', 'vDeck', 'vRegion', 'vKbBase', 'vSel', 'vZoom', 'vSnap', 'vSpec'];

const num = (x: unknown, d: number, lo = -Infinity, hi = Infinity): number =>
  typeof x === 'number' && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d;
const int = (x: unknown, d: number, lo = -2147483648, hi = 2147483647): number => Math.round(num(x, d, lo, hi));
const str = (x: unknown): string => (typeof x === 'string' ? x : '');

function normCurve(c: unknown, d: SxCurve): SxCurve {
  if (!c || typeof c !== 'object') return structuredClone(d);
  const o = c as Partial<SxCurve>;
  const p = Array.isArray(o.p) && o.p.length > 0
    ? o.p.map((q) => {
      const a = Array.isArray(q) ? q : [];
      return [num(a[0], 0, 0), num(a[1], 0, 0, 1), num(a[2], 0, -1, 1), int(a[3], 0, 0, 255), int(a[4], 0, 0, 255), int(a[5], 0, 0, 255), int(a[6], 0, 0, 255)];
    })
    : structuredClone(d.p);
  const m = Array.from({ length: 5 }, (_, i) => int(Array.isArray(o.m) ? o.m[i] : undefined, d.m[i]));
  const out: SxCurve = { t: d.t, p, m };
  if (d.a) out.a = Array.from({ length: 4 }, (_, i) => int(Array.isArray(o.a) ? o.a[i] : undefined, d.a![i]));
  if (d.l) out.l = Array.from({ length: 4 }, (_, i) => int(Array.isArray(o.l) ? o.l[i] : undefined, d.l![i]));
  if (d.ph !== undefined) out.ph = int(o.ph, d.ph, 0, 4294967295);
  return out;
}

function normTarget(t: unknown, d: SxTarget): SxTarget {
  const o = (t && typeof t === 'object' ? t : {}) as Partial<SxTarget>;
  const maps = Array.isArray(o.maps) ? o.maps : [];
  return {
    b: num(o.b, d.b), ea: num(o.ea, d.ea), la: num(o.la, d.la),
    env: normCurve(o.env, d.env), lfo: normCurve(o.lfo, d.lfo), maps: d.maps.map((m, i) => normCurve(maps[i], m)),
  };
}

export function normArt(a: unknown): SxArt {
  const d = defaultArt();
  const o = (a && typeof a === 'object' ? a : {}) as Partial<SxArt>;
  const t = Array.isArray(o.t) ? o.t : [];
  const fb = Array.isArray(o.fb) ? o.fb : [];
  return {
    ft: int(o.ft, 0, 0, 255), fb: [0, 1, 2].map((i) => int(fb[i], 0, 0, 255)), fo: int(o.fo, 0, -2147483648, 2147483647),
    t: d.t.map((dt, i) => normTarget(t[i], dt)),
  };
}

export function normRegion(r: unknown): SxRegion {
  const d = defaultRegion();
  const o = (r && typeof r === 'object' ? r : {}) as Partial<SxRegion>;
  const i = (k: keyof SxRegion, lo?: number, hi?: number) => int(o[k], d[k] as number, lo, hi);
  return {
    s: Math.max(0, i('s')), e: Math.max(-1, i('e')), name: str(o.name), info: str(o.info), pur: i('pur', 0, 7), note: i('note', -1, 127),
    cut: i('cut', 0, 99), out: i('out', -99, 99), pan: i('pan', -6400, 6400), vol: i('vol', 0, 16000), aArt: i('aArt', -1, 7), aAmt: i('aAmt', 0, 12800),
    fc: i('fc', 0, 256), fr: i('fr', 0, 256), fArt: i('fArt', -1, 7), fAmt: i('fAmt', 0, 12800), pitch: i('pitch', -1200, 1200), sArt: i('sArt', -1, 7),
    sAmt: i('sAmt', 0, 12800), delay: i('delay', 0, 12800), ofs: i('ofs', 0, 12800), oArt: i('oArt', -1, 7), oAmt: i('oAmt', 0, 12800),
  };
}

export function normDeck(x: unknown): SxDeck {
  const d = emptyDeck();
  const o = (x && typeof x === 'object' ? x : {}) as Partial<SxDeck>;
  return {
    title: str(o.title), file: str(o.file), tempo: num(o.tempo, d.tempo, 0, 1000), beats: num(o.beats, d.beats, 0, 1e6),
    regions: Array.isArray(o.regions) ? o.regions.map(normRegion) : [],
  };
}

export function normSettings(x: unknown): SxSettings {
  const d = defaultSettings();
  const o = (x && typeof x === 'object' ? x : {}) as Partial<SxSettings>;
  const raw = Array.isArray(o.raw) && o.raw.length === 47 ? o.raw.map((v) => int(v, 0, 0, 255)) : d.raw;
  const s = settingsFromRaw(raw);
  const b = (k: keyof SxSettings) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : (s[k] as boolean));
  return {
    lmode: int(o.lmode, s.lmode, 0, 7), xfade: int(o.xfade, s.xfade, 0, 4), sameDeck: b('sameDeck'), smooth: b('smooth'),
    startWhole: b('startWhole'), velVol: b('velVol'), loopHalf: b('loopHalf'), hqEnv: b('hqEnv'), autoDump: b('autoDump'),
    lockAudio: b('lockAudio'), noEmbed: b('noEmbed'), loop: b('loop'), kbShown: b('kbShown'), noAutoScroll: b('noAutoScroll'),
    dual: b('dual'), dispMode: int(o.dispMode, s.dispMode, 0, 3), raw,
  };
}

/** The non-parameter part of a fresh state (FL's plugin database state without its audio). */
export function sxInitialState(): FxParams {
  return {
    sampleA: null, sampleB: null, deckA: emptyDeck(), deckB: emptyDeck(),
    arts: Array.from({ length: 8 }, defaultArt), opt: defaultSettings(),
    vArt: 0, vTarget: 1, vPart: 0, vDeck: 0, vRegion: 0, vKbBase: 3, vSel: null, vZoom: null, vSnap: 4, vSpec: 0,
  };
}

/** Normalise a stored state's Slicex fields (parameters are clamped by the framework). */
export function sxNormalize(p: FxParams): FxParams {
  const q: FxParams = { ...p };
  for (const k of SX_SAMPLE_KEYS) q[k] = typeof q[k] === 'string' && q[k] ? q[k] : null;
  for (const k of SX_DECK_KEYS) q[k] = normDeck(q[k]);
  const arts = Array.isArray(q.arts) ? q.arts : [];
  q.arts = Array.from({ length: 8 }, (_, i) => normArt(arts[i]));
  q.opt = normSettings(q.opt);
  q.vArt = int(q.vArt, 0, 0, 7); q.vTarget = int(q.vTarget, 1, 0, 5); q.vPart = int(q.vPart, 0, 0, 5); q.vDeck = int(q.vDeck, 0, 0, 1);
  q.vRegion = int(q.vRegion, 0, 0, 65535); q.vKbBase = int(q.vKbBase, 3, 0, 7);
  q.vSnap = int(q.vSnap, 4, 0, 5); q.vSpec = int(q.vSpec, 0, 0, 1);
  delete q.vDisp; delete q.vKb; delete q.vDual;
  if (!Array.isArray(q.vSel) || q.vSel.length !== 2) q.vSel = null;
  if (!Array.isArray(q.vZoom) || q.vZoom.length !== 2) q.vZoom = null;
  return q;
}

// ------------------------------------------------------------------ key mapping

/** FL's base note for automatically mapped regions (0x1fe810): C5, lowered by octaves so all regions fit below key 125. */
export function sxBaseNote(regionCount: number): number {
  const x = regionCount - 1 - 64;
  if (x <= 0) return 60;
  const b = 60 - Math.trunc((x + 11) / 12) * 12;
  return b < 0 ? 0 : b;
}

/** Effective trigger note of region r (0x1fe880): its note, else base note + r. */
export function sxRegionKey(deck: SxDeck, r: number): number {
  const n = deck.regions[r]?.note ?? -1;
  return n >= 0 ? n : sxBaseNote(deck.regions.length) + r;
}

/**
 * FL's key lists (0x7d3f0): per deck d and key, the regions to play as (deck << 16 | region).
 * Regions with a trigger note go to that key of every deck's list (only their own deck's with
 * "Layer regions of same deck only"); then each deck's regions without one fill the deck's
 * still-empty keys from the base note on.
 */
export function sxKeyLists(decks: readonly SxDeck[], sameDeck: boolean): number[][][] {
  const out: number[][][] = [];
  for (let d = 0; d < decks.length; d++) {
    const lists: number[][] = Array.from({ length: 128 }, () => []);
    for (let d2 = 0; d2 < decks.length; d2++) {
      if (sameDeck && d2 !== d) continue;
      decks[d2].regions.forEach((rg, r) => {
        if (rg.note >= 0 && rg.note <= 127) lists[rg.note].push(r | (d2 << 16));
      });
    }
    const base = sxBaseNote(decks[d].regions.length);
    decks[d].regions.forEach((rg, r) => {
      if (rg.note !== -1) return;
      const k = r + base;
      if (k >= 0 && k <= 127 && lists[k].length === 0) lists[k].push(r | (d << 16));
    });
    out.push(lists);
  }
  return out;
}

/** Last frame of region r (0x1fe350): its end, or for a marker the frame before the next later region's start / the sample's last frame. */
export function sxRegionEnd(deck: SxDeck, r: number, frames: number): number {
  const rg = deck.regions[r];
  if (!rg) return frames - 1;
  if (rg.e >= 0) return rg.e;
  for (let j = r + 1; j < deck.regions.length; j++) if (deck.regions[j].s > rg.s) return deck.regions[j].s - 1;
  return frames - 1;
}

/**
 * Names on keys (FL's GetName(FPN_Semitone)): the regions in deck A's list of each key, unnamed ones as
 * "Region #n" / "Marker #n", unique ignoring (ASCII) case, joined with " + ".
 */
export function sxKeyNames(p: FxParams): Record<number, string> {
  const a = p.deckA as SxDeck | undefined, b = p.deckB as SxDeck | undefined;
  if (!a || !b || (a.regions.length === 0 && b.regions.length === 0)) return {};
  const lists = sxKeyLists([a, b], !!(p.opt as SxSettings | undefined)?.sameDeck)[0];
  const out: Record<number, string> = {};
  const upper = (t: string) => t.replace(/[a-z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 32));
  lists.forEach((l, k) => {
    const names: string[] = [];
    for (const e of l) {
      const r = e & 0xffff, rg = (e >> 16 ? b : a).regions[r];
      if (!rg) continue;
      const n = rg.name || `${rg.e >= 0 ? 'Region' : 'Marker'} #${r + 1}`;
      if (!names.some((x) => upper(x) === upper(n))) names.push(n);
    }
    if (names.length) out[k] = names.join(' + ');
  });
  return out;
}
