// Slicex deck commands (FL's Edison sample editor inside Slicex: the deck toolbar, its menus, the sample
// window's mouse and the keyboard shortcuts all call these). They read the plugin state at call time
// (paramsNow) and change it through ./actions.ts: view state (selection, zoom, current region / deck)
// without undo, regions and audio as undo steps.

import { store } from '../../../../store';
import type { SxDeck, SxRegion } from '../../../../model/gen/plugins/slicex/types';
import {
  CLICK_FREE_S, deleteRange, fadeInRange, fadeOutRange, declickIn, declickOut, insertSilence, invertRange, normalizeRange, removeDC,
  reverseRange, silenceRange, swapChannels, toMono, toStereo, trimTo, type Chans,
} from '../../fx/edison/ops';
import { encodeEdisonWav } from '../../fx/edison/wav';
import {
  audioEdit, audioOf, autoDump, deckEdit, dumpScore, framesOf, paramsNow, playDeck, setViewOption, step, stopRaw, view, edit, isPlaying,
} from './actions';
import {
  deckKey, deckOf, optOf, regionSpan, sxAddMarker, sxAddRegion, sxAssignAll, sxAssignToKey, sxAutoSlice, sxCloneRegion, sxDeleteRegion, sxGridSlice,
  sxMacro, sxRegionOnKey, sxSetAllCutGroups, sxSetRegion, sxToMarker, sxToRegion, sxZeroCrossAll, viewOf, artsOf, type Range, type SxMacro,
} from './model';

/** The deck UI switches (FL keeps them in the editor, not in the plugin state). */
export interface DeckUi {
  regions: boolean;
  noise: boolean;
  freeze: boolean;
  step: boolean;
  snap: boolean;
  slide: boolean;
  clickFree: boolean;
  scrub: boolean;
  lockRegions: boolean;
  gradient: boolean;
}

export const DECK_UI: DeckUi = {
  regions: true, noise: true, freeze: false, step: false, snap: false, slide: false, clickFree: true, scrub: false,
  lockRegions: false, gradient: true,
};

export function cur(slotId: string) {
  const p = paramsNow(slotId);
  const v = viewOf(p);
  const d = v.deck;
  const audio = audioOf(p, d);
  return { p, v, d, deck: deckOf(p, d), audio, n: framesOf(audio) };
}

const norm = (r: Range): Range => [Math.min(r[0], r[1]), Math.max(r[0], r[1])];

/** The selection, else the whole sample (FL's tools work on the selection or everything). */
export function selOrAll(slotId: string): Range | null {
  const c = cur(slotId);
  if (!c.n) return null;
  return c.v.sel && c.v.sel[1] !== c.v.sel[0] ? norm(c.v.sel) : [0, c.n - 1];
}

// ------------------------------------------------------------------ view

/** Each deck's last selection (FL keeps one per deck; the state holds the current deck's). */
const deckSels = new Map<string, (Range | null)[]>();
function remember(slotId: string, d: number, sel: Range | null): void {
  const m = deckSels.get(slotId) ?? [null, null];
  m[d] = sel;
  deckSels.set(slotId, m);
}

/** The selections of both decks: the current deck's from the state, the other's remembered. */
export function deckSelections(slotId: string): (Range | null)[] {
  const c = cur(slotId);
  const m = deckSels.get(slotId) ?? [null, null];
  return [0, 1].map((d) => (d === c.d ? c.v.sel : m[d] ?? null));
}

export function setSel(slotId: string, sel: Range | null): void {
  const s: Range | null = sel ? [Math.round(sel[0]), Math.round(sel[1])] : null;
  remember(slotId, cur(slotId).d, s);
  view(slotId, 'Select', (q) => { q.vSel = s; });
}

export function setRegion(slotId: string, i: number, select = true): void {
  const c = cur(slotId);
  if (i < 0 || i >= c.deck.regions.length) return;
  const span = regionSpan(c.deck, i, c.n);
  if (select) remember(slotId, c.d, span);
  view(slotId, 'Current region', (q) => { q.vRegion = i; if (select) q.vSel = span; });
}

export function setDeck(slotId: string, d: number): void {
  const c = cur(slotId);
  if (c.d === d) return;
  remember(slotId, c.d, c.v.sel);
  const back = (deckSels.get(slotId) ?? [null, null])[d] ?? null;
  view(slotId, 'Current deck', (q) => { q.vDeck = d; q.vSel = back; q.vZoom = null; q.vRegion = 0; });
}

export function viewRange(slotId: string): Range {
  const c = cur(slotId);
  return c.v.zoom ? norm(c.v.zoom) : [0, Math.max(1, c.n)];
}

export function setZoom(slotId: string, a: number, b: number): void {
  const n = cur(slotId).n;
  if (!n) return;
  const span = Math.max(16, Math.min(n, b - a));
  const s = Math.max(0, Math.min(n - span, a));
  view(slotId, 'Zoom', (q) => { q.vZoom = s <= 0 && span >= n ? null : [s, s + span]; });
}

export function zoomBy(slotId: string, k: number, center?: number): void {
  const [a, b] = viewRange(slotId);
  const c = center ?? (a + b) / 2;
  const span = (b - a) * k;
  setZoom(slotId, c - ((c - a) / (b - a)) * span, c - ((c - a) / (b - a)) * span + span);
}

export const zoomFull = (slotId: string) => view(slotId, 'Zoom', (q) => { q.vZoom = null; });

export function zoomSel(slotId: string): void {
  const s = cur(slotId).v.sel;
  if (s) { const [a, b] = norm(s); setZoom(slotId, a, b + 1); }
}

export function zoomEdge(slotId: string, side: 'left' | 'right'): void {
  const c = cur(slotId);
  if (!c.v.sel) return;
  const [a, b] = norm(c.v.sel);
  const f = side === 'left' ? b : a;
  setZoom(slotId, f - 64, f + 64);
}

export function selectZoomed(slotId: string): void {
  const [a, b] = viewRange(slotId);
  setSel(slotId, [a, b - 1]);
}

export function selectBeside(slotId: string, side: -1 | 1): void {
  const c = cur(slotId);
  if (!c.v.sel || !c.n) return;
  const [a, b] = norm(c.v.sel);
  setSel(slotId, side < 0 ? [0, Math.max(0, a - 1)] : [Math.min(c.n - 1, b + 1), c.n - 1]);
}

export function selectRegionStep(slotId: string, dir: -1 | 1): void {
  const c = cur(slotId);
  const n = c.deck.regions.length;
  if (!n) return;
  const i = c.v.sel ? Math.max(0, Math.min(n - 1, c.v.region + dir)) : dir > 0 ? 0 : n - 1;
  setRegion(slotId, i);
}

// ------------------------------------------------------------------ regions

const guard = (ui: DeckUi) => !ui.lockRegions && !ui.freeze;

/** Add / remove a marker at the selection start (FL's AddMarkerBtn: removes one already there). */
export function addMarker(slotId: string, ui: DeckUi, toggle = false): void {
  const c = cur(slotId);
  if (!c.n || !guard(ui)) return;
  const at = c.v.sel ? Math.min(c.v.sel[0], c.v.sel[1]) : 0;
  const there = c.deck.regions.findIndex((r) => r.s === Math.round(at) && r.e < 0);
  if (toggle && there >= 0) { deckEdit(slotId, c.d, 'Remove marker', (dk) => sxDeleteRegion(dk, there)); return; }
  deckEdit(slotId, c.d, 'Add marker', (dk, _a, n) => sxAddMarker(dk, at, n));
}

export function addRegion(slotId: string, ui: DeckUi): void {
  const c = cur(slotId);
  if (!c.n || !c.v.sel || !guard(ui)) return;
  const [a, b] = norm(c.v.sel);
  if (b <= a) return;
  deckEdit(slotId, c.d, 'Add region', (dk, _a, n) => sxAddRegion(dk, a, b, n));
}

export function deleteRegion(slotId: string, i: number, ui: DeckUi): void {
  const c = cur(slotId);
  if (!c.deck.regions[i] || !guard(ui)) return;
  deckEdit(slotId, c.d, 'Delete region', (dk) => sxDeleteRegion(dk, i));
}

export function cloneRegion(slotId: string, i: number, ui: DeckUi): void {
  const c = cur(slotId);
  if (!c.deck.regions[i] || !guard(ui)) return;
  const [s, e] = regionSpan(c.deck, i, c.n);
  deckEdit(slotId, c.d, 'Clone as region', (dk, _a, n) => sxCloneRegion(dk, i, s, e, n));
}

export function toggleRegionKind(slotId: string, i: number, ui: DeckUi): void {
  const c = cur(slotId);
  const rg = c.deck.regions[i];
  if (!rg || !guard(ui)) return;
  deckEdit(slotId, c.d, rg.e < 0 ? 'Turn into region' : 'Turn into marker', (dk, _a, n) => (rg.e < 0 ? sxToRegion(dk, i, n) : sxToMarker(dk, i)));
}

/** A field of region i of the current deck (one undo step). */
export function setRegionField<K extends keyof SxRegion>(slotId: string, i: number, label: string, k: K, v: SxRegion[K]): void {
  const c = cur(slotId);
  if (!c.deck.regions[i]) return;
  deckEdit(slotId, c.d, label, (dk) => sxSetRegion(dk, i, { [k]: v } as Partial<SxRegion>));
}

export function renameRegion(slotId: string, i: number): void {
  const rg = cur(slotId).deck.regions[i];
  if (!rg) return;
  const s = prompt(`Region #${i + 1} name`, rg.name);
  if (s !== null) setRegionField(slotId, i, 'Rename region', 'name', s.slice(0, 255));
}

export function setRegionInfo(slotId: string, i: number): void {
  const rg = cur(slotId).deck.regions[i];
  if (!rg) return;
  const s = prompt(`Region #${i + 1} info`, rg.info);
  if (s !== null) setRegionField(slotId, i, 'Set info', 'info', s.slice(0, 1024));
}

export function renameAll(slotId: string): void {
  const c = cur(slotId);
  const names: string[] = [];
  for (let i = 0; i < c.deck.regions.length; i++) {
    const s = prompt(`Region #${i + 1} name`, c.deck.regions[i].name);
    if (s === null) break;
    names[i] = s.slice(0, 255);
  }
  if (!names.length) return;
  deckEdit(slotId, c.d, 'Rename all', (dk) => ({ ...dk, regions: dk.regions.map((r, j) => (j < names.length ? { ...r, name: names[j] } : r)) }));
}

export function autoSlice(slotId: string, kind: 0 | 1 | 2, ui: DeckUi): void {
  const c = cur(slotId);
  if (!c.audio || !guard(ui)) return;
  const sel = c.v.sel && c.v.sel[0] !== c.v.sel[1] ? norm(c.v.sel) : null;
  deckEdit(slotId, c.d, ['Dull auto-slicing', 'Medium auto-slicing', 'Sharp auto-slicing'][kind], (dk, a) => (a ? sxAutoSlice(dk, a, kind, sel) : null));
}

export function gridSlice(slotId: string, size: 0 | 1 | 2, ui: DeckUi): void {
  const c = cur(slotId);
  if (!c.audio || !guard(ui)) return;
  const sel = c.v.sel && c.v.sel[0] !== c.v.sel[1] ? norm(c.v.sel) : null;
  deckEdit(slotId, c.d, ['Small grid-slicing', 'Medium grid-slicing', 'Large grid-slicing'][size], (dk, a) => (a ? sxGridSlice(dk, a, size, sel, store.project.tempo) : null));
}

export function zeroCrossAll(slotId: string, ui: DeckUi): void {
  const c = cur(slotId);
  if (!c.audio || !guard(ui)) return;
  deckEdit(slotId, c.d, 'Zero-cross check all regions', (dk, a) => (a ? sxZeroCrossAll(dk, a) : null));
}

export function assignAll(slotId: string, mode: number): void {
  const c = cur(slotId);
  deckEdit(slotId, c.d, 'Assign all to', (dk) => sxAssignAll(dk, mode));
}

export function setAllCutGroups(slotId: string): void {
  const c = cur(slotId);
  const s = prompt('Cut group for all regions (0 = none)', '1');
  const v = s === null ? NaN : parseInt(s, 10);
  if (Number.isFinite(v)) deckEdit(slotId, c.d, 'Set all cut groups', (dk) => sxSetAllCutGroups(dk, v));
}

/** Options > Macros: both decks (and the articulators) through the model macro. */
export function macro(slotId: string, kind: SxMacro, label: string): void {
  const p = paramsNow(slotId);
  const r = sxMacro([deckOf(p, 0), deckOf(p, 1)], artsOf(p), kind, {
    sels: deckSelections(slotId), audio: [audioOf(p, 0), audioOf(p, 1)], sameDeck: optOf(p).sameDeck,
  });
  step(label, () => {
    edit(slotId, label, (q) => { q.deckA = r.decks[0]; q.deckB = r.decks[1]; q.arts = r.arts; });
    autoDump(slotId);
  });
}

/** Keyboard menu: "Assign current region to this key" / "Select region assigned to this key". */
export function assignKey(slotId: string, key: number): void {
  const c = cur(slotId);
  if (!c.deck.regions[c.v.region]) return;
  deckEdit(slotId, c.d, 'Assign current region to this key', (dk) => sxAssignToKey(dk, c.v.region, key));
}

export function selectKeyRegion(slotId: string, key: number, otherDeck = true): void {
  const c = cur(slotId);
  const hit = sxRegionOnKey([deckOf(c.p, 0), deckOf(c.p, 1)], c.d, key, optOf(c.p).sameDeck);
  if (!hit || (!otherDeck && hit.deck !== c.d)) return;
  if (hit.deck !== c.d) setDeck(slotId, hit.deck);
  setRegion(slotId, hit.region);
}

// ------------------------------------------------------------------ audio edits (destructive)

const cf = (ui: DeckUi, sr: number) => (ui.clickFree ? Math.round(CLICK_FREE_S * sr) : 0);

/** A range edit of the current deck (selection or whole sample); regions kept. */
function rangeEdit(slotId: string, label: string, f: (ch: Chans, a: number, b: number, sr: number) => Chans): void {
  const c = cur(slotId);
  const r = selOrAll(slotId);
  if (!r || !c.audio) return;
  void audioEdit(slotId, c.d, label, (ch, sr) => f(ch, r[0], r[1] + 1, sr));
}

export const normalize = (slotId: string) => rangeEdit(slotId, 'Normalize', (ch, a, b) => normalizeRange(ch, a, b));
export const fadeIn = (slotId: string) => rangeEdit(slotId, 'Fade in', (ch, a, b) => fadeInRange(ch, a, b));
export const fadeOut = (slotId: string) => rangeEdit(slotId, 'Fade out', (ch, a, b) => fadeOutRange(ch, a, b));
export const reverse = (slotId: string) => rangeEdit(slotId, 'Reverse', (ch, a, b) => reverseRange(ch, a, b));
export const invert = (slotId: string) => rangeEdit(slotId, 'Reverse polarity', (ch, a, b) => invertRange(ch, a, b));
export const center = (slotId: string) => rangeEdit(slotId, 'Center', (ch, a, b) => removeDC(ch, a, b));
export const swap = (slotId: string) => rangeEdit(slotId, 'Swap channels', (ch, a, b) => (ch.length > 1 ? swapChannels(ch, a, b) : ch));
export const declickInSel = (slotId: string) => rangeEdit(slotId, 'Declick in', (ch, a, _b, sr) => declickIn(ch, a, Math.round(0.002 * sr)));
export const declickOutSel = (slotId: string) => rangeEdit(slotId, 'Declick out', (ch, _a, b, sr) => declickOut(ch, b, Math.round(0.002 * sr)));
export const clearSel = (slotId: string, ui: DeckUi) => rangeEdit(slotId, 'Clear', (ch, a, b, sr) => silenceRange(ch, a, b, cf(ui, sr)));

export function toChannels(slotId: string, mode: 'mono' | 'stereo' | 'left' | 'right'): void {
  const c = cur(slotId);
  if (!c.audio) return;
  void audioEdit(slotId, c.d, mode === 'stereo' ? 'Convert to stereo' : 'Convert to mono', (ch) =>
    mode === 'stereo' ? toStereo(ch) : toMono(ch, mode === 'left' ? 1 : mode === 'right' ? 2 : 0));
}

/** Per-region processing of every region of the current deck (Tools > Regions). */
function regionsEdit(slotId: string, label: string, f: (ch: Chans, a: number, b: number, sr: number) => Chans): void {
  const c = cur(slotId);
  if (!c.audio || !c.deck.regions.length) return;
  const spans = c.deck.regions.map((_, i) => regionSpan(c.deck, i, c.n));
  void audioEdit(slotId, c.d, label, (ch, sr) => spans.reduce((acc, [a, b]) => f(acc, a, b + 1, sr), ch));
}

export const normalizeRegions = (slotId: string) => regionsEdit(slotId, 'Normalize all regions', (ch, a, b) => normalizeRange(ch, a, b));
export const declickInRegions = (slotId: string) => regionsEdit(slotId, 'Declick in all regions', (ch, a, _b, sr) => declickIn(ch, a, Math.round(0.002 * sr)));
export const declickOutRegions = (slotId: string) => regionsEdit(slotId, 'Declick out all regions', (ch, _a, b, sr) => declickOut(ch, b, Math.round(0.002 * sr)));
export const perfectRegions = (slotId: string) => regionsEdit(slotId, 'Perfect all regions', (ch, a, b, sr) => declickOut(declickIn(ch, a, Math.round(0.002 * sr)), b, Math.round(0.002 * sr)));

/** Regions after deleting frames [a, b): later starts move left, markers inside go. */
function regionsAfterDelete(dk: SxDeck, a: number, b: number): SxDeck {
  const L = b - a;
  const out: SxRegion[] = [];
  for (const r of dk.regions) {
    if (r.s > a && r.s < b) continue;
    const s = r.s >= b ? r.s - L : r.s;
    const e = r.e < 0 ? -1 : r.e >= b ? r.e - L : r.e >= a ? Math.max(s, a - 1) : r.e;
    out.push({ ...r, s, e });
  }
  return { ...dk, regions: out };
}

export function deleteSel(slotId: string, ui: DeckUi): void {
  const c = cur(slotId);
  if (!c.audio || !c.v.sel) return;
  const [a, b1] = norm(c.v.sel);
  const b = b1 + 1;
  if (b - a >= c.n) return;
  void audioEdit(slotId, c.d, 'Delete', (ch, sr) => deleteRange(ch, a, b, cf(ui, sr)), (dk) => regionsAfterDelete(dk, a, b))
    .then(() => setSel(slotId, null));
}

export function trimSel(slotId: string): void {
  const c = cur(slotId);
  if (!c.audio || !c.v.sel) return;
  const [a, b1] = norm(c.v.sel);
  const b = b1 + 1;
  void audioEdit(slotId, c.d, 'Trim', (ch) => trimTo(ch, a, b), (dk, n) => ({
    ...dk, regions: dk.regions.filter((r) => r.s >= a && r.s < b).map((r) => ({ ...r, s: r.s - a, e: r.e < 0 ? -1 : Math.min(n - 1, Math.max(r.s - a, r.e - a)) })),
  })).then(() => { setSel(slotId, null); zoomFull(slotId); });
}

export function insertSilenceSel(slotId: string): void {
  const c = cur(slotId);
  if (!c.audio || !c.v.sel) return;
  const [a, b1] = norm(c.v.sel);
  const L = b1 + 1 - a;
  void audioEdit(slotId, c.d, 'Insert silence', (ch) => insertSilence(ch, a, L), (dk) => ({
    ...dk, regions: dk.regions.map((r) => ({ ...r, s: r.s >= a ? r.s + L : r.s, e: r.e >= a ? r.e + L : r.e })),
  }));
}

// ------------------------------------------------------------------ files

/** Save the deck's sample (with its regions as cue points) as a WAV download (FL: Save sample as...). */
export function saveWav(slotId: string, bits: 16 | 24 | 32 = 32): void {
  const c = cur(slotId);
  if (!c.audio) return;
  const markers = c.deck.regions.map((r, i) => ({ pos: r.s, end: r.e >= 0 ? r.e : undefined, name: r.name || `Region #${i + 1}`, info: r.info }));
  const bytes = encodeEdisonWav(c.audio.channels, c.audio.sampleRate, bits, { markers, title: c.deck.title });
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${c.deck.title || 'Slicex'}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** FL's File > New: the deck emptied. */
export function newDeck(slotId: string): void {
  const c = cur(slotId);
  edit(slotId, 'New', (q) => {
    q[deckKey(c.d)] = { title: '', file: '', tempo: 0, beats: 0, regions: [] };
    q[c.d ? 'sampleB' : 'sampleA'] = null;
    q.vSel = null; q.vZoom = null; q.vRegion = 0;
  });
}

type DialogListener = (slotId: string, kind: 'props') => void;
const dialogListeners = new Set<DialogListener>();

/** Open a dialog of the editor showing `slotId` (the editor listens with onDialog). */
export function openDialog(slotId: string, kind: 'props'): void {
  dialogListeners.forEach((l) => l(slotId, kind));
}

export function onDialog(fn: DialogListener): () => void {
  dialogListeners.add(fn);
  return () => { dialogListeners.delete(fn); };
}

/** Sample properties (F2): FL's properties dialog (./dialogs.tsx). */
export function editProperties(slotId: string): void {
  if (cur(slotId).audio) openDialog(slotId, 'props');
}

export const dump = (slotId: string, mode: number, d?: number) => dumpScore(slotId, d ?? cur(slotId).d, mode);

export function transportPlay(slotId: string): void {
  playDeck(slotId);
}

export function transportStop(): void {
  stopRaw();
}

export const playing = isPlaying;

/** Undo history: return to entry k of the past labels (FL's undo history list). */
export function undoTo(k: number): void {
  const n = store.historyLabels().past.length;
  for (let i = n - 1; i > k; i--) store.undo();
}

export const toggleSpec = (slotId: string) => view(slotId, 'Spectrum', (q) => { q.vSpec = q.vSpec ? 0 : 1; });
export const setSnap = (slotId: string, k: number) => view(slotId, 'Snap', (q) => { q.vSnap = k; });
export const toggleDual = (slotId: string) => setViewOption(slotId, 'dual', !cur(slotId).v.dual, 'Display single / dual deck');
