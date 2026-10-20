// Slicex editor operations (main thread): loading samples into the decks (Browser drag, OS files, file
// picker; FL's WAV region chunks are read from files), region and slicing edits through the model
// operations (./model.ts), the score dump into the channel's piano roll (and FL's AUTO-DUMP of deck A),
// destructive audio edits of a deck (Edison's tools on the deck's sample: a new pool sample, one undo
// step), raw region auditions (FL: right-click a region plays its audio without articulation) and the
// deck transport (Loop / Play / Stop: the deck's selection or sample, raw). Every state change is one
// undo step through the store.

import { host, store } from '../../../../store';
import * as A from '../../../../store/actions';
import { decodeFile, getRaw } from '../../../../audio/samples';
import { uid } from '../../../../model/defaults';
import type { Note } from '../../../../model/types';
import type { FxParams } from '../../../../model/fx/types';
import { channelOfSlot } from '../../../../model/gen/ids';
import type { SxDeck } from '../../../../model/gen/plugins/slicex/types';
import { addPoolSample, baseName, parseWav } from '../bassdrum/flimport';
import { encodeEdisonWav } from '../../fx/edison/wav';
import type { Chans } from '../../fx/edison/ops';
import { deckKey, deckOf, optOf, regionSpan, sampleKey, sampleOf, sxDumpScore, sxLoadDeck, sxSetOption, viewOf, type Range, type SxAudio } from './model';

type Draft = Record<string, unknown>;

/** The plugin state now (outside React renders). */
export function paramsNow(slotId: string): FxParams {
  return (A.findFx(store.project, slotId)?.fx.params ?? {}) as FxParams;
}

/** The audio of deck d (pool sample), if loaded. */
export function audioOf(p: FxParams, d: number): { channels: Float32Array[]; sampleRate: number } | null {
  const id = sampleOf(p, d);
  const r = id ? getRaw(id) : undefined;
  return r && r.channels.length && r.channels[0].length ? { channels: r.channels, sampleRate: r.sampleRate } : null;
}

export const framesOf = (a: SxAudio | null) => a?.channels[0]?.length ?? 0;

/** One undo step for everything `fn` does. */
export function step(label: string, fn: () => void): void {
  if (store.inGesture) { fn(); return; }
  store.beginGesture(label);
  try { fn(); } finally { store.endGesture(); }
}

export function edit(slotId: string, label: string, fn: (d: Draft) => void, merge?: string): void {
  A.editFx(slotId, label, (d) => fn(d as Draft), merge);
}

export function view(slotId: string, label: string, fn: (d: Draft) => void): void {
  A.setFxStateNoHistory(slotId, label, (d) => fn(d as Draft));
}

// ------------------------------------------------------------------ loading

const MAX_BYTES = 512 << 20;

/** Put a loaded sample and its deck into deck d (FL resets the deck's view; AUTO-DUMP for deck A). */
function commitLoad(slotId: string, d: number, sampleId: string, deck: SxDeck): void {
  step('Load sample', () => {
    edit(slotId, 'Load sample', (q) => {
      q[sampleKey(d)] = sampleId;
      q[deckKey(d)] = deck;
      q.vDeck = d;
      q.vRegion = 0;
      q.vSel = null;
      q.vZoom = null;
    });
    if (d === 0) autoDump(slotId);
  });
}

/** Load OS files (the first one: FL loads one sample per deck). */
export async function loadFiles(slotId: string, d: number, files: File[]): Promise<void> {
  const f = files[0];
  if (!f || f.size > MAX_BYTES) return;
  const bytes = await f.arrayBuffer();
  let id: string, audio: SxAudio;
  const wav = /\.wav$/i.test(f.name) ? parseWav(bytes) : null;
  if (wav) {
    const info = await addPoolSample(baseName(f), wav, bytes, 'Load sample');
    id = info.id;
    audio = wav;
  } else {
    try {
      const r = await decodeFile(f, baseName(f), host.ctx ?? undefined);
      store.update('Load sample', (q) => { q.samples[r.info.id] = r.info; });
      id = r.info.id;
      audio = { channels: r.raw.channels, sampleRate: r.raw.sampleRate };
    } catch {
      return;
    }
  }
  commitLoad(slotId, d, id, sxLoadDeck(audio, wav ? new Uint8Array(bytes) : null, f.name, store.project.tempo));
}

/** Load a pool sample (Browser drag: 'text/x-orchard-sample'). */
export function loadPool(slotId: string, d: number, id: string): void {
  const r = getRaw(id);
  const info = store.project.samples[id];
  if (!r || !r.channels.length) return;
  commitLoad(slotId, d, id, sxLoadDeck({ channels: r.channels, sampleRate: r.sampleRate }, null, info?.name ?? r.name, store.project.tempo));
}

export function pickAndLoad(slotId: string, d: number): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.wav,.mp3,.ogg,.flac,.aif,.aiff,audio/*';
  input.onchange = () => { void loadFiles(slotId, d, input.files ? [...input.files] : []); };
  input.click();
}

export const acceptsDrop = (e: React.DragEvent) => e.dataTransfer.types.includes('text/x-orchard-sample') || e.dataTransfer.types.includes('Files');

/** A drop on the editor or a deck: loads into deck d. */
export function dropOnDeck(slotId: string, d: number, e: React.DragEvent): void {
  const id = e.dataTransfer.getData('text/x-orchard-sample');
  if (id) { e.preventDefault(); e.stopPropagation(); loadPool(slotId, d, id); return; }
  const files = [...(e.dataTransfer.files ?? [])];
  if (files.length) { e.preventDefault(); e.stopPropagation(); void loadFiles(slotId, d, files); }
}

// ------------------------------------------------------------------ deck edits

export interface DeckEditResult { deck: SxDeck; index?: number }

/**
 * Edit deck d through a model operation (one undo step); `index` selects that region. With `dump`, the
 * AUTO-DUMP follows (FL dumps deck A after editing).
 */
export function deckEdit(slotId: string, d: number, label: string, f: (deck: SxDeck, audio: SxAudio | null, frames: number) => DeckEditResult | SxDeck | null, opts: { dump?: boolean; merge?: string } = {}): number {
  const p = paramsNow(slotId);
  const audio = audioOf(p, d);
  const r = f(deckOf(p, d), audio, framesOf(audio));
  if (!r) return -1;
  const res: DeckEditResult = 'regions' in r ? { deck: r } : r;
  const run = () => {
    edit(slotId, label, (q) => {
      q[deckKey(d)] = res.deck;
      if (res.index !== undefined && res.index >= 0) q.vRegion = res.index;
      else if (Number(q.vRegion ?? 0) >= res.deck.regions.length) q.vRegion = Math.max(0, res.deck.regions.length - 1);
    }, opts.merge);
    if (opts.dump !== false && d === 0) autoDump(slotId);
  };
  if (opts.merge) run(); else step(label, run);
  return res.index ?? -1;
}

/** Edit one field set of region r of deck d (state controls; merges a gesture). */
export function regionEdit(slotId: string, d: number, r: number, label: string, f: (rg: SxDeck['regions'][number]) => void, merge?: string): void {
  edit(slotId, label, (q) => {
    const deck = q[deckKey(d)] as SxDeck | undefined;
    const rg = deck?.regions[r];
    if (rg) f(rg);
  }, merge);
}

// ------------------------------------------------------------------ dump

/** Dump deck d's score into the channel's piano roll (FL: the current pattern, emptied first; deck B's notes on colour 2). */
export function dumpScore(slotId: string, d: number, mode: number): void {
  const p = paramsNow(slotId);
  const chId = channelOfSlot(slotId);
  const audio = audioOf(p, d);
  const deck = deckOf(p, d);
  if (!chId || !audio || !deck.regions.length) return;
  const pr = store.project;
  const notes = sxDumpScore(deck, mode, { ppq: pr.ppq, stepsPerBeat: pr.stepsPerBeat, tempo: pr.tempo, frames: framesOf(audio), sampleRate: audio.sampleRate }, d);
  const out: Note[] = notes.map((n) => ({
    id: uid('n'), key: Math.max(0, Math.min(131, n.key)), pos: Math.max(0, n.pos), len: Math.max(1, n.len), vel: Math.max(0, Math.min(128, Math.round(n.vel))), rel: 64,
    pan: Math.max(0, Math.min(128, 64 + Math.round(n.pan))), fine: Math.max(0, Math.min(240, 120 + Math.round(n.pitch / 10))),
    modX: 128, modY: 128, color: Math.max(0, Math.min(15, n.color)), slide: false, porta: false, muted: false,
  }));
  A.setChannelNotes(pr.currentPatternId, chId, out, 'Dump score to piano roll');
}

/** FL's AUTO-DUMP: deck A's score after loading / editing it. */
export function autoDump(slotId: string): void {
  if (optOf(paramsNow(slotId)).autoDump) dumpScore(slotId, 0, 0);
}

// ------------------------------------------------------------------ destructive audio edits

/** Replace deck d's audio by `f(channels)` (a new pool sample; regions kept or remapped by `regions`). */
export async function audioEdit(slotId: string, d: number, label: string, f: (ch: Chans, sr: number) => Chans | null, regions?: (deck: SxDeck, frames: number) => SxDeck): Promise<void> {
  const p = paramsNow(slotId);
  const audio = audioOf(p, d);
  if (!audio) return;
  const out = f(audio.channels.map((c) => c), audio.sampleRate);
  if (!out || !out.length || !out[0].length) return;
  const deck = deckOf(p, d);
  const bytes = encodeEdisonWav(out, audio.sampleRate, 32);
  const name = `${deck.title || 'Slicex'} (edited)`;
  store.beginGesture(label);
  try {
    const info = await addPoolSample(name, { channels: out, sampleRate: audio.sampleRate }, bytes, label);
    edit(slotId, label, (q) => {
      q[sampleKey(d)] = info.id;
      if (regions) q[deckKey(d)] = regions(deck, out[0].length);
    });
  } finally {
    store.endGesture();
  }
}

// ------------------------------------------------------------------ raw playback (auditions, transport)

interface Playing { src: AudioBufferSourceNode; t0: number; from: number; to: number; loop: boolean; sr: number; slotId: string; deck: number; region: number }
let playing: Playing | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function onTransport(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The raw playback position of a slot: [deck, frame, region] or null. */
export function rawPosition(slotId: string): [number, number, number] | null {
  const pl = playing;
  const ctx = host.ctx;
  if (!pl || pl.slotId !== slotId || !ctx) return null;
  const len = pl.to - pl.from;
  let f = (ctx.currentTime - pl.t0) * pl.sr;
  if (pl.loop && len > 0) f %= len;
  if (f > len) return null;
  return [pl.deck, pl.from + f, pl.region];
}

export function isPlaying(slotId: string): boolean {
  return !!playing && playing.slotId === slotId && playing.region < 0;
}

export function stopRaw(): void {
  const pl = playing;
  playing = null;
  if (pl) { try { pl.src.stop(); } catch { /* already stopped */ } }
  emit();
}

/** Play frames [from, to] of deck d raw (region >= 0: an audition of that region). */
export function playRaw(slotId: string, d: number, from: number, to: number, loop: boolean, region = -1): void {
  stopRaw();
  const p = paramsNow(slotId);
  const audio = audioOf(p, d);
  const ctx = host.ctx;
  void host.resume();
  if (!audio || !ctx) return;
  const n = framesOf(audio);
  const a = Math.max(0, Math.min(n - 1, Math.round(from))), b = Math.max(a + 1, Math.min(n, Math.round(to) + 1));
  const buf = ctx.createBuffer(audio.channels.length, b - a, audio.sampleRate);
  audio.channels.forEach((c, i) => buf.copyToChannel(c.slice(a, b), i));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = loop;
  const g = ctx.createGain();
  g.gain.value = 0.8;
  src.connect(g).connect(ctx.destination);
  src.start();
  const pl: Playing = { src, t0: ctx.currentTime, from: a, to: b - 1, loop, sr: audio.sampleRate, slotId, deck: d, region };
  src.onended = () => { if (playing === pl) { playing = null; emit(); } };
  playing = pl;
  emit();
}

/** FL's right-click on a region: its raw audio. */
export function auditionRegion(slotId: string, d: number, r: number): void {
  const p = paramsNow(slotId);
  const audio = audioOf(p, d);
  if (!audio) return;
  const [s, e] = regionSpan(deckOf(p, d), r, framesOf(audio));
  playRaw(slotId, d, s, e, false, r);
}

/** The transport's Play: the current deck's selection (or the whole sample), looped with Loop (FL's option byte). */
export function playDeck(slotId: string, loop = optOf(paramsNow(slotId)).loop): void {
  if (isPlaying(slotId)) { stopRaw(); return; }
  const p = paramsNow(slotId);
  const v = viewOf(p);
  const n = framesOf(audioOf(p, v.deck));
  if (!n) return;
  const sel: Range = v.sel && Math.abs(v.sel[1] - v.sel[0]) > 0 ? [Math.min(v.sel[0], v.sel[1]), Math.max(v.sel[0], v.sel[1])] : [0, n - 1];
  playRaw(slotId, v.deck, sel[0], sel[1], loop);
}

/**
 * A display setting FL keeps in its option block (Loop, keyboard shown, no auto-scroll, dual deck, display
 * mode): saved with the plugin's state, changed without an undo step.
 */
export function setViewOption(slotId: string, key: 'loop' | 'kbShown' | 'noAutoScroll' | 'dual' | 'dispMode', value: boolean | number, label: string): void {
  view(slotId, label, (q) => { q.opt = sxSetOption(optOf(q), key, value); });
}
