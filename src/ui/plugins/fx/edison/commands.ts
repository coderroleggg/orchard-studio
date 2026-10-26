// Edison's commands: every edit, tool, region, selection, zoom, file and
// transport action, working on the slot's current audio from the pool. The
// editor (index.tsx), its menus and keyboard shortcuts all call these.

import { host, store } from '../../../../store';
import * as A from '../../../../store/actions';
import * as AC from '../../../../store/audioClipActions';
import { addRaw, decodeFile, storeUserSample } from '../../../../audio/samples';
import { uid } from '../../../../model/defaults';
import { flashHint } from '../../../hint';
import { edState, type EdMarker, type EdState } from '../../../../model/fx/plugins/edison';
import type { SampleInfo } from '../../../../model/types';
import {
  audioOf, commitAudio, commitRegions, getClip, getNoiseProfile, gotoHistory, session, setClip, setNoiseProfile,
  setTransient,
} from './audio';
import {
  CLICK_FREE_S, type Chans, ampRange, clampRange, copyRange, declickIn, declickOut, deleteRange, fadeInRange,
  fadeOutRange, frames, insertSilence, invertRange, loudSegments, markersAfterDelete, markersAfterInsert,
  markersAfterReverse, markersClip, monoIfEqual, normalizeRange, pasteInsert, pasteMix, pasteReplace, peakRange,
  removeDC, resampleChans, reverseRange, silenceRange, swapChannels, toMono, toStereo, trimSideNoise, trimTo,
  zeroCrossNear, gateNoise, concatChans,
} from './ops';
import { SCRIPTS, autoSlice, generateNoise, noiseProfile, type EdScript } from './tools';
import { encodeEdisonWav, readWavMeta } from './wav';

export type DialogKind = 'amp' | 'stretch' | 'eq' | 'reverb' | 'blur' | 'denoise' | 'noise' | 'script' | 'settings' | 'props' | 'message';

export interface DialogSpec {
  kind: DialogKind;
  script?: EdScript;
  text?: string;
}

/** What the commands need from the editor (view, dialogs). */
export interface EdApi {
  slotId: string;
  view(): [number, number];
  setView(a: number, b: number): void;
  dialog(d: DialogSpec | null): void;
}

export interface Cur {
  st: EdState;
  ch: Chans;
  sr: number;
  len: number;
  /** Selection, or the whole sample. */
  a: number;
  b: number;
  hasSel: boolean;
  xf: number;
}

export function cur(slotId: string): Cur {
  const loc = A.findFx(store.project, slotId);
  const st = edState(loc?.fx?.params as Record<string, unknown> | undefined);
  const raw = audioOf(st.sample);
  const ch = raw?.channels ?? [];
  const sr = raw?.sampleRate ?? host.sampleRate;
  const len = frames(ch);
  const sel = st.sel && st.sel[0] < len ? [st.sel[0], Math.min(len, st.sel[1])] : null;
  const hasSel = !!sel && sel[1] > sel[0];
  return {
    st, ch, sr, len,
    a: hasSel ? sel![0] : 0, b: hasSel ? sel![1] : len, hasSel,
    xf: st.clickFree ? Math.round(CLICK_FREE_S * sr) : 0,
  };
}

const frozen = (c: Cur) => {
  if (c.st.freeze) { flashHint('Edison: editing is frozen'); return true; }
  return false;
};

const needAudio = (c: Cur) => {
  if (!c.len) { flashHint('Edison: no sample'); return false; }
  return true;
};

const needSel = (c: Cur) => {
  if (!c.hasSel) { flashHint('Edison: make a selection first'); return false; }
  return true;
};

/** Processing edits leave 32-bit float audio (FL converts 16-bit samples before processing). */
const to32 = (s: Record<string, unknown>) => { s.bits = 32; };

/** Run a processing function on the selection (or whole sample) as one undo step. */
export function applyProcess(api: EdApi, label: string, fn: (c: Cur) => Chans | null, opts: { markers?: (c: Cur, out: Chans) => EdMarker[]; keepSel?: boolean } = {}): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c)) return;
  const out = fn(c);
  if (!out) return;
  commitAudio(api.slotId, out, c.sr, label, {
    markers: opts.markers ? opts.markers(c, out) : undefined,
    extra: to32,
  });
}

// ---------------------------------------------------------------- undo
export function undo(api: EdApi): void {
  const c = cur(api.slotId);
  if (c.st.hpos <= 0 || !gotoHistory(api.slotId, c.st.hpos - 1)) flashHint('Edison: nothing to undo');
}

export function redo(api: EdApi): void {
  const c = cur(api.slotId);
  if (c.st.hpos >= c.st.hist.length - 1 || !gotoHistory(api.slotId, c.st.hpos + 1)) flashHint('Edison: nothing to redo');
}

export function undoTo(api: EdApi, i: number): void {
  gotoHistory(api.slotId, i);
}

// ---------------------------------------------------------------- clipboard
export function copy(api: EdApi): void {
  const c = cur(api.slotId);
  if (!needAudio(c)) return;
  setClip(copyRange(c.ch, c.a, c.b), c.sr);
  flashHint(c.hasSel ? 'Selection copied' : 'Sample copied');
}

export function cut(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c) || !needSel(c)) return;
  setClip(copyRange(c.ch, c.a, c.b), c.sr);
  commitAudio(api.slotId, deleteRange(c.ch, c.a, c.b, c.xf), c.sr, 'Cut', {
    markers: markersAfterDelete(c.st.markers, c.a, c.b), sel: null,
    loopPts: loopAfterDelete(c.st.loopPts, c.a, c.b),
  });
  seek(api, c.a);
}

function clipFor(c: Cur): Chans | null {
  const clip = getClip();
  if (!clip || !frames(clip.ch)) { flashHint('Edison: the clipboard is empty'); return null; }
  return clip.sr !== c.sr ? resampleChans(clip.ch, clip.sr / c.sr) : clip.ch;
}

function insertPoint(api: EdApi, c: Cur): number {
  if (c.hasSel) return c.a;
  const live = session(api.slotId).live;
  return Math.min(c.len, Math.max(0, Math.round(live.pos)));
}

export function pasteInsertCmd(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c)) return;
  const clip = clipFor(c);
  if (!clip) return;
  const at = insertPoint(api, c), k = frames(clip);
  const sr = c.len ? c.sr : getClip()!.sr;
  commitAudio(api.slotId, pasteInsert(c.ch, at, clip), sr, 'Paste insert', {
    markers: markersAfterInsert(c.st.markers, at, k), sel: [at, at + k],
    loopPts: loopAfterInsert(c.st.loopPts, at, k),
  });
}

export function pasteReplaceCmd(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c)) return;
  const clip = clipFor(c);
  if (!clip) return;
  const at = insertPoint(api, c), k = frames(clip);
  commitAudio(api.slotId, pasteReplace(c.ch, at, clip), c.len ? c.sr : getClip()!.sr, 'Paste replace', { sel: [at, at + k] });
}

export function pasteMixCmd(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c)) return;
  const clip = clipFor(c);
  if (!clip) return;
  const at = insertPoint(api, c), k = frames(clip);
  commitAudio(api.slotId, pasteMix(c.ch, at, clip), c.len ? c.sr : getClip()!.sr, 'Paste mix', { sel: [at, at + k], extra: to32 });
}

function loopAfterDelete(lp: [number, number] | null, a: number, b: number): [number, number] | null {
  if (!lp) return null;
  const k = b - a;
  const f = (x: number) => (x >= b ? x - k : x > a ? a : x);
  const r: [number, number] = [f(lp[0]), f(lp[1])];
  return r[1] > r[0] ? r : null;
}

function loopAfterInsert(lp: [number, number] | null, at: number, k: number): [number, number] | null {
  if (!lp) return null;
  return [lp[0] >= at ? lp[0] + k : lp[0], lp[1] > at ? lp[1] + k : lp[1]];
}

// ---------------------------------------------------------------- edit menu
export function clearCmd(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c) || !needSel(c)) return;
  commitAudio(api.slotId, silenceRange(c.ch, c.a, c.b, c.xf), c.sr, 'Clear');
}

export function deleteCmd(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c) || !needSel(c)) return;
  commitAudio(api.slotId, deleteRange(c.ch, c.a, c.b, c.xf), c.sr, 'Delete', {
    markers: markersAfterDelete(c.st.markers, c.a, c.b), sel: null, loopPts: loopAfterDelete(c.st.loopPts, c.a, c.b),
  });
  seek(api, c.a);
}

export function trimCmd(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c) || !needSel(c)) return;
  const ms = markersAfterDelete(markersAfterDelete(c.st.markers, c.b, c.len), 0, c.a);
  const lp = loopAfterDelete(loopAfterDelete(c.st.loopPts, c.b, c.len), 0, c.a);
  commitAudio(api.slotId, trimTo(c.ch, c.a, c.b), c.sr, 'Trim', { markers: ms, sel: null, loopPts: lp });
  api.setView(0, c.b - c.a);
}

export function deleteAfterLoop(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c)) return;
  if (!c.st.loopPts) { flashHint('Edison: no loop points'); return; }
  const e = Math.min(c.len, c.st.loopPts[1]);
  commitAudio(api.slotId, trimTo(c.ch, 0, e), c.sr, 'Delete part after loop', { markers: markersClip(c.st.markers, e) });
}

export function insertSilenceCmd(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needSel(c)) return;
  const k = c.b - c.a;
  commitAudio(api.slotId, insertSilence(c.ch.length ? c.ch : [new Float32Array(0), new Float32Array(0)], c.a, k), c.sr, 'Insert silence', {
    markers: markersAfterInsert(c.st.markers, c.a, k), loopPts: loopAfterInsert(c.st.loopPts, c.a, k),
  });
}

export function newSample(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c)) return;
  commitAudio(api.slotId, [], c.sr, 'New', { markers: [], loopPts: null, sel: null, extra: (s) => { s.title = ''; s.tempo = 0; } });
  api.setView(0, 0);
}

// ---------------------------------------------------------------- tools
export const normalize = (api: EdApi) => applyProcess(api, 'Normalize', (c) => normalizeRange(c.ch, c.a, c.b, 1));
export const reversePolarity = (api: EdApi) => applyProcess(api, 'Reverse polarity', (c) => invertRange(c.ch, c.a, c.b));
export const fadeIn = (api: EdApi) => applyProcess(api, 'Fade in', (c) => fadeInRange(c.ch, c.a, c.b));
export const fadeOut = (api: EdApi) => applyProcess(api, 'Fade out', (c) => fadeOutRange(c.ch, c.a, c.b));
export const center = (api: EdApi) => applyProcess(api, 'Center', (c) => removeDC(c.ch, c.a, c.b));
const DECLICK_S = 0.004;
export const declickInCmd = (api: EdApi) => applyProcess(api, 'Declick in', (c) => declickIn(c.ch, c.a, Math.min(c.b - c.a, Math.round(DECLICK_S * c.sr))));
export const declickOutCmd = (api: EdApi) => applyProcess(api, 'Declick out', (c) => declickOut(c.ch, c.b, Math.min(c.b - c.a, Math.round(DECLICK_S * c.sr))));

export function reverse(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c)) return;
  commitAudio(api.slotId, reverseRange(c.ch, c.a, c.b), c.sr, 'Reverse', { markers: markersAfterReverse(c.st.markers, c.a, c.b) });
}

export function swap(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c)) return;
  if (c.ch.length < 2) { flashHint('Edison: the sample is mono'); return; }
  commitAudio(api.slotId, swapChannels(c.ch), c.sr, 'Swap channels');
}

export function mono(api: EdApi, mode: 0 | 1 | 2): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c)) return;
  if (c.ch.length < 2) { flashHint('Edison: the sample is already mono'); return; }
  const label = mode === 1 ? 'Convert left channel to mono' : mode === 2 ? 'Convert right channel to mono' : 'Convert to mono';
  commitAudio(api.slotId, toMono(c.ch, mode), c.sr, label);
}

export function monoIfSame(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c)) return;
  const m = monoIfEqual(c.ch);
  if (!m) { flashHint('Edison: the channels are not equal'); return; }
  commitAudio(api.slotId, m, c.sr, 'Convert mono signal to mono format');
}

export function stereo(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c) || c.ch.length >= 2) return;
  commitAudio(api.slotId, toStereo(c.ch), c.sr, 'Convert to stereo');
}

/** Format > Resolution: 16-bit quantizes the audio (lossy), 32-bit float keeps it. */
export function setBits(api: EdApi, bits: 16 | 32): void {
  const c = cur(api.slotId);
  if (frozen(c) || c.st.bits === bits) return;
  if (bits === 32 || !c.len) { setTransient(api.slotId, 'Bit depth', (s) => { s.bits = bits; }); return; }
  const q = c.ch.map((x) => { const o = new Float32Array(x.length); for (let i = 0; i < o.length; i++) o[i] = Math.round(Math.max(-1, Math.min(1, x[i])) * 32767) / 32767; return o; });
  commitAudio(api.slotId, q, c.sr, 'Convert to 16Bit', { extra: (s) => { s.bits = 16; } });
}

/** Sample properties > Samplerate: resample the data, or keep it and play it at the new rate. */
export function changeRate(api: EdApi, rate: number, resample: boolean): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c) || rate === c.sr) return;
  const k = resample ? rate / c.sr : 1;
  const out = resample ? resampleChans(c.ch, c.sr / rate) : c.ch.map((x) => new Float32Array(x));
  const sc = (f: number) => Math.round(f * k);
  const ms = c.st.markers.map((m) => ({ ...m, pos: sc(m.pos), ...(m.end !== undefined ? { end: sc(m.end) } : {}) }));
  const lp = c.st.loopPts ? [sc(c.st.loopPts[0]), sc(c.st.loopPts[1])] as [number, number] : null;
  commitAudio(api.slotId, out, rate, resample ? 'Resample' : 'Sample rate', { markers: ms, loopPts: lp, sel: null, extra: resample ? to32 : undefined });
}

export function noise(api: EdApi, vol: number): void {
  const c = cur(api.slotId);
  if (frozen(c)) return;
  commitAudio(api.slotId, generateNoise(c.ch, c.a, c.b, c.sr, vol, Date.now() & 0xffff), c.sr, 'Generate noise', { extra: to32 });
}

export function acquireThreshold(api: EdApi): void {
  const c = cur(api.slotId);
  if (!needAudio(c)) return;
  const pk = Math.max(0.0005, peakRange(c.ch, c.a, c.b));
  setTransient(api.slotId, 'Noise threshold', (s) => { s.threshold = pk; s.noiseView = true; });
  flashHint(`Noise threshold: ${(20 * Math.log10(pk)).toFixed(1)} dB`);
}

export const gateNoiseCmd = (api: EdApi) => applyProcess(api, 'Gate noise', (c) =>
  gateNoise(c.ch, c.a, c.b, c.st.threshold, Math.round(0.03 * c.sr), Math.round(0.003 * c.sr)));

export function trimSideNoiseCmd(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c)) return;
  const r = trimSideNoise(c.ch, c.a, c.b, c.st.threshold);
  if (frames(r.result) === c.len) { flashHint('Edison: nothing below the threshold at the sides'); return; }
  const ms = markersAfterDelete(markersAfterDelete(c.st.markers, r.end, c.b), c.a, r.start);
  commitAudio(api.slotId, r.result, c.sr, 'Trim side noise', { markers: ms, sel: null, loopPts: null });
}

export function trimAllNoiseSlice(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c)) return;
  const segs = loudSegments(c.ch, 0, c.len, c.st.threshold, Math.round(0.08 * c.sr));
  if (!segs.length) { flashHint('Edison: everything is below the threshold'); return; }
  let out: Chans = [];
  const markers: EdMarker[] = [];
  const ramp = Math.round(0.002 * c.sr);
  segs.forEach(([s, e], i) => {
    const part = declickOut(declickIn(copyRange(c.ch, s, e), 0, Math.min(ramp, e - s)), e - s, Math.min(ramp, e - s));
    const at = frames(out);
    markers.push({ pos: at, end: at + (e - s), name: `Region ${i + 1}` });
    out = concatChans(out, part);
  });
  commitAudio(api.slotId, out, c.sr, 'Trim all noise & slice up', { markers, sel: null, loopPts: null });
}

export function acquireProfile(api: EdApi): void {
  const c = cur(api.slotId);
  if (!needAudio(c)) return;
  const p = noiseProfile(c.ch, c.a, c.b);
  if (!p) { flashHint('Edison: select a longer piece of noise'); return; }
  setNoiseProfile(p);
  flashHint('Noise profile acquired');
}

export function normalizeRegions(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c)) return;
  const regs = regionSpans(c).filter(([s, e]) => e > c.a && s < c.b);
  if (!regs.length) { flashHint('Edison: no regions'); return; }
  const peaks = regs.map(([s, e]) => peakRange(c.ch, s, e));
  const top = Math.max(...peaks);
  let out = c.ch;
  regs.forEach(([s, e], i) => { if (peaks[i] > 0) out = ampRange(out, s, e, top / peaks[i]); });
  commitAudio(api.slotId, out, c.sr, 'Normalize all regions', { extra: to32 });
}

export function declickRegions(api: EdApi, which: 'in' | 'out' | 'both'): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c)) return;
  const regs = regionSpans(c);
  if (!regs.length) { flashHint('Edison: no regions'); return; }
  const n = Math.round(DECLICK_S * c.sr);
  let out = c.ch;
  for (const [s, e] of regs) {
    const k = Math.min(n, Math.floor((e - s) / 2));
    if (which !== 'out') out = declickIn(out, s, k);
    if (which !== 'in') out = declickOut(out, e, k);
  }
  commitAudio(api.slotId, out, c.sr, which === 'in' ? 'Declick in all regions' : which === 'out' ? 'Declick out all regions' : 'Perfect all regions', { extra: to32 });
}

/** Region spans: regions as they are, markers up to the next marker (FL's export rules). */
export function regionSpans(c: Cur): [number, number][] {
  const ms = [...c.st.markers].sort((x, y) => x.pos - y.pos);
  return ms.map((m, i): [number, number] => [m.pos, m.end ?? (ms[i + 1]?.pos ?? c.len)]).filter(([s, e]) => e > s);
}

// ---------------------------------------------------------------- regions
export function addMarker(api: EdApi, name = ''): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c)) return;
  const pos = c.hasSel ? c.a : Math.round(Math.min(c.len - 1, session(api.slotId).live.pos));
  commitRegions(api.slotId, 'Add marker', [...c.st.markers, { pos, name }], c.st.loopPts);
}

/** Toolbar: add, or remove the marker at the selection start. */
export function toggleMarker(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c)) return;
  const pos = c.hasSel ? c.a : Math.round(session(api.slotId).live.pos);
  const tol = Math.max(1, Math.round((api.view()[1] - api.view()[0]) / 300));
  const i = c.st.markers.findIndex((m) => Math.abs(m.pos - pos) <= tol);
  if (i >= 0) commitRegions(api.slotId, 'Remove marker', c.st.markers.filter((_, k) => k !== i), c.st.loopPts);
  else addMarker(api);
}

export function addRegion(api: EdApi, name = ''): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c) || !needSel(c)) return;
  commitRegions(api.slotId, 'Add region', [...c.st.markers, { pos: c.a, end: c.b, name }], c.st.loopPts);
}

export function setLoop(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c) || !needSel(c)) return;
  commitRegions(api.slotId, 'Set loop', c.st.markers, [c.a, c.b]);
}

export function setDownbeat(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c)) return;
  const pos = c.hasSel ? c.a : Math.round(session(api.slotId).live.pos);
  commitRegions(api.slotId, 'Set first downbeat', [...c.st.markers.filter((m) => m.purpose !== 2), { pos, name: 'Downbeat', purpose: 2 }], c.st.loopPts);
}

/** Regions > Delete: the markers / regions in the selection, or the loop when it is selected. */
export function deleteRegions(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c)) return;
  if (c.st.loopPts && c.hasSel && c.st.loopPts[0] === c.a && c.st.loopPts[1] === c.b) {
    commitRegions(api.slotId, 'Delete loop', c.st.markers, null);
    return;
  }
  const keep = c.st.markers.filter((m) => !(m.pos >= c.a && m.pos < c.b && (c.hasSel || m.pos === Math.round(session(api.slotId).live.pos))));
  if (keep.length === c.st.markers.length) { flashHint('Edison: no marker in the selection'); return; }
  commitRegions(api.slotId, 'Delete region', keep, c.st.loopPts);
}

export function renameAll(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c) || !c.st.markers.length) return;
  const ms = c.st.markers.map((m) => ({ ...m }));
  for (let i = 0; i < ms.length; i++) {
    const n = prompt(`Region ${i + 1} name`, ms[i].name);
    if (n === null) break;
    ms[i].name = n;
  }
  commitRegions(api.slotId, 'Rename regions', ms, c.st.loopPts);
}

export function assignNotes(api: EdApi, mode: 'all' | 'white' | 'black' | 'none'): void {
  const c = cur(api.slotId);
  if (frozen(c) || !c.st.markers.length) return;
  const white = [0, 2, 4, 5, 7, 9, 11];
  let key = 60;
  const next = () => {
    while (mode === 'white' ? !white.includes(key % 12) : mode === 'black' ? white.includes(key % 12) : false) key++;
    return key++;
  };
  const ms = c.st.markers.map((m) => {
    const o: EdMarker = { ...m };
    if (mode === 'none') delete o.key; else o.key = next();
    return o;
  });
  commitRegions(api.slotId, 'Assign trigger notes', ms, c.st.loopPts);
}

export function autoSliceCmd(api: EdApi, sens: 0 | 1 | 2): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c)) return;
  const pos = autoSlice(c.ch, c.sr, sens);
  const label = ['Dull auto-slicing', 'Medium auto-slicing', 'Sharp auto-slicing'][sens];
  commitRegions(api.slotId, label, pos.map((p, i) => ({ pos: p, name: `#${i + 1}` })), c.st.loopPts);
}

export function gridSlice(api: EdApi, size: 0 | 1 | 2): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c)) return;
  const p = store.project;
  const tempo = c.st.tsync || !c.st.tempo ? p.tempo : c.st.tempo;
  const beat = (c.sr * 60) / tempo;
  const step = size === 0 ? beat / 4 : size === 1 ? beat : beat * p.beatsPerBar;
  const ms: EdMarker[] = [];
  for (let f = 0, i = 1; f < c.len - 1; f += step, i++) ms.push({ pos: Math.round(f), name: `#${i}` });
  commitRegions(api.slotId, ['Small grid-slicing', 'Medium grid-slicing', 'Large grid-slicing'][size], ms, c.st.loopPts);
}

export function zeroCrossAll(api: EdApi): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c)) return;
  const r = Math.round(0.01 * c.sr);
  const ms = c.st.markers.map((m) => {
    const o = { ...m, pos: zeroCrossNear(c.ch, m.pos, r) };
    if (m.end !== undefined) o.end = Math.max(o.pos + 1, zeroCrossNear(c.ch, m.end, r));
    return o;
  });
  commitRegions(api.slotId, 'Zero-cross check all regions', ms, c.st.loopPts);
}

export function editMarker(api: EdApi, index: number, label: string, fn: (m: EdMarker) => EdMarker | null): void {
  const c = cur(api.slotId);
  if (frozen(c)) return;
  const ms: EdMarker[] = [];
  c.st.markers.forEach((m, i) => { if (i !== index) ms.push(m); else { const r = fn({ ...m }); if (r) ms.push(r); } });
  commitRegions(api.slotId, label, ms, c.st.loopPts);
}

// ---------------------------------------------------------------- select
export function setSel(api: EdApi, sel: [number, number] | null): void {
  const c = cur(api.slotId);
  let s = sel;
  if (s) {
    const [x, y] = clampRange(c.ch.length ? c.ch : [new Float32Array(c.len)], s[0], s[1]);
    s = y > x ? [x, y] : null;
  }
  setTransient(api.slotId, 'Selection', (q) => { q.sel = s; });
}

export function selectBefore(api: EdApi): void { const c = cur(api.slotId); if (c.hasSel && c.a > 0) setSel(api, [0, c.a]); }
export function selectAfter(api: EdApi): void { const c = cur(api.slotId); if (c.hasSel && c.b < c.len) setSel(api, [c.b, c.len]); }
export function selectZoomed(api: EdApi): void { const [a, b] = api.view(); setSel(api, [a, b]); }

export function selectRegion(api: EdApi, dir: -1 | 1): void {
  const c = cur(api.slotId);
  const spans = regionSpans(c);
  if (!spans.length) return;
  let i: number;
  if (!c.hasSel) i = dir > 0 ? 0 : spans.length - 1;
  else {
    const k = spans.findIndex(([s]) => s === c.a);
    i = k < 0 ? (dir > 0 ? spans.findIndex(([s]) => s > c.a) : spans.length - 1 - [...spans].reverse().findIndex(([s]) => s < c.a)) : k + dir;
  }
  if (i < 0 || i >= spans.length) return;
  setSel(api, spans[i]);
  const [v0, v1] = api.view();
  if (spans[i][0] < v0 || spans[i][1] > v1) {
    const span = Math.max(v1 - v0, spans[i][1] - spans[i][0]);
    api.setView(Math.max(0, spans[i][0] - (span - (spans[i][1] - spans[i][0])) / 2), 0);
  }
}

// ---------------------------------------------------------------- zoom
export function zoomBy(api: EdApi, k: number, around?: number): void {
  const c = cur(api.slotId);
  const [v0, v1] = api.view();
  const span = v1 - v0;
  const ns = Math.min(Math.max(16, span * k), Math.max(16, c.len));
  const mid = around ?? (c.hasSel && c.a >= v0 && c.a <= v1 ? (c.a + c.b) / 2 : (v0 + v1) / 2);
  const t = span > 0 ? (mid - v0) / span : 0.5;
  const s = Math.min(Math.max(0, mid - ns * t), Math.max(0, c.len - ns));
  api.setView(s, s + ns);
}

export function zoomFull(api: EdApi): void { const c = cur(api.slotId); api.setView(0, c.len); }
export function zoomSel(api: EdApi): void { const c = cur(api.slotId); if (c.hasSel) api.setView(c.a, c.b); }
export function zoomEdge(api: EdApi, edge: 'left' | 'right'): void {
  const c = cur(api.slotId);
  if (!c.hasSel) return;
  const f = edge === 'left' ? c.a : c.b;
  const span = 256;
  api.setView(Math.max(0, f - span / 2), Math.max(0, f - span / 2) + span);
}

// ---------------------------------------------------------------- transport
function cmd(api: EdApi, op: 'play' | 'pause' | 'stop' | 'seek', pos: number, a = 0, b = 0): void {
  setTransient(api.slotId, op === 'play' ? 'Play' : op === 'pause' ? 'Pause' : op === 'stop' ? 'Stop' : 'Position', (s) => {
    const n = (s.cmd && typeof (s.cmd as { n?: unknown }).n === 'number' ? (s.cmd as { n: number }).n : 0) + 1;
    s.cmd = { n, op, pos: Math.round(pos), a: Math.round(a), b: Math.round(b) };
  });
}

/** Play range: the selection, else the loop points (when looping), else the whole sample. */
export function playRange(c: Cur): [number, number] {
  if (c.hasSel) return [c.a, c.b];
  if (c.st.loop && c.st.loopPts) return [Math.min(c.st.loopPts[0], c.len), Math.min(c.st.loopPts[1], c.len)];
  return [0, c.len];
}

export function playPause(api: EdApi): void {
  const c = cur(api.slotId);
  const live = session(api.slotId).live;
  if (live.play) { cmd(api, 'pause', live.pos); return; }
  if (!c.len) return;
  const [a, b] = playRange(c);
  const pos = live.pos >= a && live.pos < b ? live.pos : a;
  cmd(api, 'play', pos, a, b);
}

export function playFrom(api: EdApi, pos: number): void {
  const c = cur(api.slotId);
  if (!c.len) return;
  const [a, b] = c.hasSel && pos >= c.a && pos < c.b ? [c.a, c.b] : [0, c.len];
  cmd(api, 'play', pos, a, b);
}

export function stop(api: EdApi): void {
  const c = cur(api.slotId);
  cmd(api, 'stop', c.hasSel ? c.a : 0);
  if (c.st.rec >= 0.5) setTransient(api.slotId, 'Record', (s) => { s.rec = 0; });
}

export function seek(api: EdApi, pos: number): void {
  cmd(api, 'seek', Math.max(0, pos));
}

export function scrub(api: EdApi, pos: number | null): void {
  setTransient(api.slotId, 'Scrub', (s) => {
    const prev = s.scrub as { n?: number } | null;
    s.scrub = pos === null ? null : { n: (prev?.n ?? 0) + 1, pos: Math.max(0, pos) };
  });
}

export function toggleRecord(api: EdApi): void {
  const c = cur(api.slotId);
  setTransient(api.slotId, 'Record', (s) => { s.rec = c.st.rec >= 0.5 ? 0 : 1; });
}

export function toggle(api: EdApi, key: keyof EdState, label: string): void {
  const c = cur(api.slotId);
  const v = c.st[key];
  setTransient(api.slotId, label, (s) => { s[key] = typeof v === 'number' ? (v ? 0 : 1) : !v; });
}

export function setField(api: EdApi, key: keyof EdState, value: unknown, label: string): void {
  setTransient(api.slotId, label, (s) => { s[key] = value; });
}

// ---------------------------------------------------------------- files
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/** Load an audio file into Edison (replace, or at the selection / append with `mode`). */
export async function loadFile(api: EdApi, f?: File | null, mode: 'replace' | 'append' | 'replaceSel' = 'replace'): Promise<void> {
  const file = f ?? await pickFile('audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff,.m4a');
  if (!file) return;
  const c = cur(api.slotId);
  if (frozen(c)) return;
  try {
    const name = file.name.replace(/\.[^.]+$/, '');
    const { raw } = await decodeFile(file, name, host.ctx ?? undefined);
    let meta: ReturnType<typeof readWavMeta> = {};
    if (/\.wav$/i.test(file.name)) { try { meta = readWavMeta(await file.arrayBuffer()); } catch { meta = {}; } }
    if (mode === 'replace' || !c.len) {
      commitAudio(api.slotId, raw.channels, raw.sampleRate, 'Load sample', {
        markers: meta.markers ?? [], loopPts: meta.loop ?? null, sel: null,
        extra: (s) => { s.title = meta.title || name; if (meta.root !== undefined) s.root = meta.root; s.bits = 32; },
      });
      api.setView(0, raw.channels[0].length);
    } else {
      const ch = raw.sampleRate !== c.sr ? resampleChans(raw.channels, raw.sampleRate / c.sr) : raw.channels;
      const at = mode === 'append' ? c.len : c.a;
      const base = mode === 'replaceSel' && c.hasSel ? deleteRange(c.ch, c.a, c.b) : c.ch;
      const out = pasteInsert(base, at, ch);
      // a slice marker with the sample's name at the splice point (FL)
      const kept = mode === 'replaceSel' && c.hasSel ? markersAfterDelete(c.st.markers, c.a, c.b) : c.st.markers;
      const ms = [...markersAfterInsert(kept, at, frames(ch)), { pos: at, name }];
      commitAudio(api.slotId, out, c.sr, mode === 'append' ? 'Append sample' : 'Replace selection', { markers: ms });
    }
    flashHint(`Edison: loaded ${file.name}`);
  } catch {
    flashHint(`Edison: could not decode ${file.name}`);
  }
}

function download(data: ArrayBuffer | Blob, name: string, type = 'audio/wav'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function fileBase(c: Cur): string {
  return (c.st.title || 'Edison').replace(/[\\/:*?"<>|]+/g, '_');
}

/** Save the selection (or the whole sample) as a WAV download. */
export function saveWav(api: EdApi, bits?: 16 | 24 | 32): void {
  const c = cur(api.slotId);
  if (!needAudio(c)) return;
  const ch = copyRange(c.ch, c.a, c.b);
  const ms = c.hasSel ? markersAfterDelete(markersAfterDelete(c.st.markers, c.b, c.len), 0, c.a) : c.st.markers;
  const lp = c.hasSel ? loopAfterDelete(loopAfterDelete(c.st.loopPts, c.b, c.len), 0, c.a) : c.st.loopPts;
  const b = bits ?? c.st.bits;
  download(encodeEdisonWav(ch, c.sr, b, { markers: ms, loop: lp, root: c.st.root, title: c.st.title }), `${fileBase(c)}.wav`);
  flashHint(`Saved ${fileBase(c)}.wav (${b === 32 ? '32Bit float' : b + 'Bit'})`);
}

/** Regions > Export regions: one WAV per region / marker span ("for sampler use" adds the root note). */
export async function exportRegions(api: EdApi, sampler: boolean): Promise<void> {
  const c = cur(api.slotId);
  if (!needAudio(c)) return;
  const spans = regionSpans(c);
  if (!spans.length) { flashHint('Edison: no regions'); return; }
  const ms = [...c.st.markers].sort((x, y) => x.pos - y.pos);
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  for (let i = 0; i < spans.length; i++) {
    const [s, e] = spans[i];
    const m = ms[i];
    const root = m?.key ?? c.st.root;
    let name = (m?.name || `${fileBase(c)} ${i + 1}`).replace(/[\\/:*?"<>|]+/g, '_');
    if (sampler) name += ` ${NOTES[root % 12]}${Math.floor(root / 12)}`;
    download(encodeEdisonWav(copyRange(c.ch, s, e), c.sr, c.st.bits, { root }), `${name}.wav`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------------------------------------------------------------- send
function newPoolSample(c: Cur, name: string): SampleInfo {
  const ch = copyRange(c.ch, c.a, c.b);
  const id = uid('s');
  addRaw({ id, name, channels: ch, sampleRate: c.sr });
  void storeUserSample(id, encodeEdisonWav(ch, c.sr, 32));
  return { id, name, frames: frames(ch), sampleRate: c.sr, channels: ch.length, source: { kind: 'user', key: id } };
}

/** Send to selected channel: the selection replaces the selected Sampler channel's sample. */
export function sendToChannel(api: EdApi): void {
  const c = cur(api.slotId);
  if (!needAudio(c)) return;
  const chId = store.ui.selectedChannels[0];
  if (!chId) { flashHint('Edison: no channel selected'); return; }
  const info = newPoolSample(c, fileBase(c));
  store.update('Send to selected channel', (d) => {
    d.samples[info.id] = info;
    const ch = d.channels.find((x) => x.id === chId);
    if (ch) { ch.sampler.sampleId = info.id; ch.name = info.name; }
  });
  flashHint(`Edison: sent to ${store.project.channels.find((x) => x.id === chId)?.name ?? 'channel'}`);
}

/**
 * Send to playlist as audio clip: the selection becomes an Audio Clip (a new
 * Audio Clip channel and a clip of its length in the Playlist, at the time
 * selection or the playhead).
 */
export function sendToPlaylist(api: EdApi): void {
  const c = cur(api.slotId);
  if (!needAudio(c)) return;
  AC.sendToPlaylist(newPoolSample(c, fileBase(c)));
}

/** A WAV file of the selection for HTML drag and drop (drag / copy sample button). */
export function selectionFile(slotId: string): File | null {
  const c = cur(slotId);
  if (!c.len) return null;
  const buf = encodeEdisonWav(copyRange(c.ch, c.a, c.b), c.sr, 32, { root: c.st.root });
  return new File([buf], `${fileBase(c)}.wav`, { type: 'audio/wav' });
}

// ---------------------------------------------------------------- scripts
let lastScript: { script: EdScript; values: number[] } | null = null;

export function runScript(api: EdApi, script: EdScript, values: number[]): void {
  const c = cur(api.slotId);
  if (frozen(c)) return;
  const res = script.run({ ch: c.ch, sr: c.sr, a: c.a, b: c.b, clip: getClip()?.ch ?? null, markers: c.st.markers }, values);
  lastScript = { script, values };
  if (!res) { flashHint(`${script.title}: nothing to do`); return; }
  if (res.ch) commitAudio(api.slotId, res.ch, res.sr ?? c.sr, script.title, { markers: res.markers, extra: to32 });
  else if (res.markers) commitRegions(api.slotId, script.title, res.markers, c.st.loopPts);
}

export function runLastScript(api: EdApi): void {
  if (!lastScript) { flashHint('Edison: no script run yet'); return; }
  runScript(api, lastScript.script, lastScript.values);
}

export { SCRIPTS, getNoiseProfile };

// ---------------------------------------------------------------- envelopes
/** Tools > Amp > Mixdown amp envelopes: apply pan / volume / stereo separation envelopes and clear them. */
export function mixdownEnvelopes(api: EdApi, envAt: (pts: [number, number][], f: number, def: number) => number): void {
  const c = cur(api.slotId);
  if (frozen(c) || !needAudio(c)) return;
  const e = c.st.envs;
  if (!e.pan.length && !e.vol.length && !e.sep.length) { flashHint('Edison: no envelopes to mix down'); return; }
  const st = c.ch.length >= 2 ? c.ch : toStereo(c.ch);
  const L = new Float32Array(st[0]), R = new Float32Array(st[1]);
  for (let i = 0; i < L.length; i++) {
    const vol = e.vol.length ? envAt(e.vol, i, 0.5) * 2 : 1; // 0..200 %
    const pan = e.pan.length ? 1 - 2 * envAt(e.pan, i, 0.5) : 0; // top = left
    const sep = e.sep.length ? (envAt(e.sep, i, 0.5) - 0.5) * 2 : 0; // top = mono, bottom = wide
    const l = st[0][i], r = st[1][i];
    const m = (l + r) / 2, s = ((l - r) / 2) * (1 - sep);
    const gl = vol * (pan > 0 ? 1 - pan : 1), gr = vol * (pan < 0 ? 1 + pan : 1);
    L[i] = (m + s) * gl;
    R[i] = (m - s) * gr;
  }
  commitAudio(api.slotId, [L, R], c.sr, 'Mixdown amp envelopes', { extra: (s) => { s.bits = 32; s.envs = { pan: [], vol: [], sep: [], ap: e.ap }; } });
}

export function cancelEnvelopes(api: EdApi): void {
  setTransient(api.slotId, 'Cancel all envelopes', (s) => { s.envs = { pan: [], vol: [], sep: [], ap: [] }; });
}

export function addEnvPointsAtSelection(api: EdApi): void {
  const c = cur(api.slotId);
  if (!c.hasSel || c.st.envSel === 0) return;
  const key = (['', 'pan', 'vol', 'sep', 'ap'] as const)[c.st.envSel] as 'pan' | 'vol' | 'sep' | 'ap';
  const pts = [...c.st.envs[key]];
  const def = key === 'ap' ? 1 : 0.5;
  for (const f of [c.a, (c.a + c.b) / 2, c.b]) pts.push([Math.round(f), def]);
  pts.sort((x, y) => x[0] - y[0]);
  setTransient(api.slotId, 'Add points at selection', (s) => { s.envs = { ...c.st.envs, [key]: pts }; });
}
