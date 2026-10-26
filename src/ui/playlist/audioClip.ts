// Drawing and hit testing of audio clips in the Playlist (docs/audio-clips.md): the waveform of the sample window
// the clip shows (offset, speed, reverse), the fade and gain handles, the title bar.

import type { Channel, Clip, PlaylistTrack, SampleInfo } from '../../model/types';
import { getRaw } from '../../audio/samples';
import { clipGainLinear, clipSeconds, crossfadeOverlaps, fadeShape, resampleSpeed, stretcherActive } from '../../model/audioclip';
import { CLIP_MENU_MIN_W, CLIP_MENU_W, drawClipMenuArrow } from './autoClip';

/** Height of the title bar of a clip in a track of height `h`. */
export function audioHeadH(h: number): number {
  return Math.min(14, Math.max(10, h * 0.28));
}

// ------------------------------------------------------------------- peaks
interface Level { block: number; min: Float32Array; max: Float32Array }
const BLOCKS = [64, 1024, 16384];
const pyramids = new WeakMap<Float32Array, Level[]>();

function pyramidOf(data: Float32Array): Level[] {
  let p = pyramids.get(data);
  if (p) return p;
  p = [];
  let prevMin: Float32Array | null = null, prevMax: Float32Array | null = null, prevBlock = 1;
  for (const block of BLOCKS) {
    const n = Math.floor(data.length / block);
    if (n < 2) break;
    const mn = new Float32Array(n), mx = new Float32Array(n);
    if (!prevMin || !prevMax) {
      for (let k = 0; k < n; k++) {
        let lo = Infinity, hi = -Infinity;
        for (let i = k * block; i < (k + 1) * block; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        mn[k] = lo; mx[k] = hi;
      }
    } else {
      const f = block / prevBlock;
      for (let k = 0; k < n; k++) {
        let lo = Infinity, hi = -Infinity;
        for (let i = k * f; i < (k + 1) * f; i++) { if (prevMin[i] < lo) lo = prevMin[i]; if (prevMax[i] > hi) hi = prevMax[i]; }
        mn[k] = lo; mx[k] = hi;
      }
    }
    p.push({ block, min: mn, max: mx });
    prevMin = mn; prevMax = mx; prevBlock = block;
  }
  pyramids.set(data, p);
  return p;
}

/** Smallest and largest sample of data[a, b) (fractional bounds are widened to whole frames). */
export function minMax(data: Float32Array, a: number, b: number, out: [number, number] = [0, 0]): [number, number] {
  a = Math.max(0, Math.floor(a));
  b = Math.min(data.length, Math.ceil(b));
  if (b <= a) { out[0] = 0; out[1] = 0; return out; }
  const levels = pyramidOf(data);
  let lo = Infinity, hi = -Infinity;
  const walk = (s: number, e: number): void => {
    if (e <= s) return;
    let L = -1;
    for (let i = levels.length - 1; i >= 0; i--) if (levels[i].block * 2 <= e - s) { L = i; break; }
    if (L < 0) {
      for (let i = s; i < e; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      return;
    }
    const B = levels[L].block, lv = levels[L];
    const f = Math.ceil(s / B), l = Math.floor(e / B);
    for (let k = f; k < l; k++) { if (lv.min[k] < lo) lo = lv.min[k]; if (lv.max[k] > hi) hi = lv.max[k]; }
    walk(s, f * B);
    walk(l * B, e);
  };
  walk(a, b);
  out[0] = lo === Infinity ? 0 : lo;
  out[1] = hi === -Infinity ? 0 : hi;
  return out;
}

/** The fades audio clips play with, automatic crossfades included (clip id -> ticks): what the engine does with the same clips. */
export function effectiveFades(clips: Clip[], tracks: PlaylistTrack[]): Map<string, { fadeIn: number; fadeOut: number }> {
  const list = clips
    .filter((c) => c.kind === 'audio' && !c.muted && tracks[c.track]?.enabled !== false)
    .map((c) => ({ id: c.id, track: c.track, start: c.start, end: c.start + c.length, fadeIn: c.fadeIn ?? 0, fadeOut: c.fadeOut ?? 0 }))
    .sort((a, b) => a.start - b.start);
  crossfadeOverlaps(list);
  return new Map(list.map((x) => [x.id, x]));
}

// ------------------------------------------------------------ source mapping
/** How the clip's window maps to the pool sample's frames (for the waveform and the slip tool). */
export interface SourceMap {
  chans: Float32Array[];
  /** First frame of the sample the channel plays (SMP START) and how many it plays. */
  startFrame: number;
  frames: number;
  /** Raw sample frames played per second of Playlist time. */
  fps: number;
  reverse: boolean;
  sampleRate: number;
}

/**
 * Frames of data[a, b) the Sampler's precomputed tools keep: the trailing
 * silence trim (digital silence, or everything below the TRIM threshold) cuts
 * the end of the sample, and with it the duration TIME and MUL are measured on.
 */
const keptCache = new WeakMap<Float32Array, Map<string, number>>();
function keptFrames(chans: Float32Array[], a: number, b: number, thr: number): number {
  const key = `${a}:${b}:${thr}`;
  let m = keptCache.get(chans[0]);
  if (!m) { m = new Map(); keptCache.set(chans[0], m); }
  const hit = m.get(key);
  if (hit !== undefined) return hit;
  let last = 0;
  for (const c of chans) {
    for (let i = b - 1; i >= a; i--) if (Math.abs(c[i]) > thr) { if (i - a > last) last = i - a; break; }
  }
  const kept = last + 1 < b - a ? Math.max(1, last + 1) : b - a;
  m.set(key, kept);
  return kept;
}

export function sourceMap(ch: Channel, tempo: number): SourceMap | null {
  const id = ch.sampler.sampleId;
  const raw = id ? getRaw(id) : undefined;
  if (!raw || !raw.channels.length || !raw.channels[0].length) return null;
  const s = ch.sampler;
  const total = raw.channels[0].length;
  const a = Math.floor(Math.min(0.999, Math.max(0, s.smpStart)) * total);
  const b = Math.max(a + 1, Math.floor(Math.min(1, Math.max(0, s.length)) * total));
  const frames = keptFrames(raw.channels, a, b, s.trim > 0 ? Math.pow(10, (-90 + s.trim * 60) / 20) : 0);
  const srcSecs = frames / raw.sampleRate;
  const pitch = Math.pow(2, (ch.pitch * s.pitchRange * 100) / 1200);
  let speed = 1;
  if (s.stretchMode === 'resample') speed = resampleSpeed(srcSecs, s, tempo);
  else if (stretcherActive(s)) speed = srcSecs / Math.max(1e-6, clipSeconds(srcSecs, s, tempo));
  return { chans: raw.channels, startFrame: a, frames, fps: raw.sampleRate * pitch * speed, reverse: s.reverse, sampleRate: raw.sampleRate };
}

/** Playlist ticks one pass of the mapped sample lasts. */
export function mapTicks(m: SourceMap, tempo: number, ppq: number): number {
  return (m.frames / m.fps) * ((tempo * ppq) / 60);
}

// ------------------------------------------------------------ handles (hit)
export type AudioZone = 'fadeIn' | 'fadeOut' | 'gain';

const HANDLE = 5; // half size of a handle in px
/** The handles are shown on clips at least this wide. */
export const HANDLES_MIN_W = 40;

export interface Handles {
  fadeIn: { x: number; y: number };
  fadeOut: { x: number; y: number };
  gain: { x: number; y: number };
}

/** Handle positions of a clip drawn at (x, y, w, h) with `ppt` pixels per tick. */
export function handlesOf(c: Clip, x: number, y: number, w: number, h: number, ppt: number): Handles {
  const top = y + audioHeadH(h) + 1 + HANDLE;
  const fi = Math.min(w, (c.fadeIn ?? 0) * ppt), fo = Math.min(w, (c.fadeOut ?? 0) * ppt);
  return {
    fadeIn: { x: x + Math.max(HANDLE, fi), y: top },
    fadeOut: { x: x + w - Math.max(HANDLE, fo), y: top },
    gain: { x: x + w / 2, y: top },
  };
}

/** The fade / gain handle under the pointer (null: none). Fade handles win over the gain handle. */
export function zoneAt(c: Clip, x: number, y: number, w: number, h: number, ppt: number, px: number, py: number): AudioZone | null {
  if (w < HANDLES_MIN_W) return null;
  const hd = handlesOf(c, x, y, w, h, ppt);
  const near = (p: { x: number; y: number }, r = HANDLE + 2) => Math.abs(px - p.x) <= r && Math.abs(py - p.y) <= r;
  if (near(hd.fadeIn)) return 'fadeIn';
  if (near(hd.fadeOut)) return 'fadeOut';
  if (near(hd.gain)) return 'gain';
  return null;
}

// ------------------------------------------------------------------ drawing
export interface AudioClipDraw {
  c: Clip;
  ch: Channel;
  info?: SampleInfo;
  map: SourceMap | null;
  name: string;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Pixels per tick, tempo, and PPQ. */
  ppt: number;
  tempo: number;
  ppq: number;
  /** The visible part of the canvas (x range), so only visible columns are drawn. */
  visL: number;
  visR: number;
  selected: boolean;
  muted: boolean;
  showFades: boolean;
  hover: AudioZone | null;
  /** The fades as played, in ticks: the clip's own, or longer ones from an automatic crossfade (default: the clip's own). */
  fadeIn?: number;
  fadeOut?: number;
}

export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
  if (amt >= 0) { r += (255 - r) * amt; gg += (255 - gg) * amt; b += (255 - b) * amt; }
  else { r *= 1 + amt; gg *= 1 + amt; b *= 1 + amt; }
  return `rgb(${Math.round(r)},${Math.round(gg)},${Math.round(b)})`;
}

export function drawAudioClip(g: CanvasRenderingContext2D, o: AudioClipDraw): void {
  const { c, x, y, w, h, color, muted } = o;
  const headH = audioHeadH(h);
  g.save();
  g.beginPath();
  g.rect(x, y, w, h - 1);
  g.clip();
  g.globalAlpha = muted ? 0.45 : 1;
  g.fillStyle = shade(color, -0.35);
  g.fillRect(x, y, w, h - 1);
  g.fillStyle = shade(color, 0.05);
  g.fillRect(x, y, w, headH);
  g.fillStyle = shade(color, -0.2);
  g.fillRect(x, y + headH, w, h - 1 - headH);

  const bodyTop = y + headH + 1, bodyBot = y + h - 2, bodyH = Math.max(2, bodyBot - bodyTop);
  const cy = bodyTop + bodyH / 2;
  if (o.map && w >= 2) drawWave(g, o, cy, bodyH);
  else if (!o.map) {
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(x, cy, w, 1);
  }

  // fades: the part of the body above the fade curve is shaded and the curve drawn
  const fi = Math.min(w, (o.fadeIn ?? c.fadeIn ?? 0) * o.ppt), fo = Math.min(w, (o.fadeOut ?? c.fadeOut ?? 0) * o.ppt);
  const curve = (x0: number, wd: number, tension: number, fadeIn: boolean): void => {
    if (wd < 1) return;
    g.beginPath();
    const steps = Math.max(4, Math.min(48, Math.round(wd / 3)));
    for (let k = 0; k <= steps; k++) {
      const u = k / steps; // 0..1 along the fade, from its outer end
      const gain = fadeShape(fadeIn ? u : 1 - u, tension);
      const px = x0 + u * wd, py = bodyBot - gain * bodyH;
      if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.lineWidth = 1;
    g.stroke();
    g.lineTo(x0 + wd, bodyTop);
    g.lineTo(x0, bodyTop);
    g.closePath();
    g.fillStyle = 'rgba(0,0,0,0.38)';
    g.fill();
  };
  if (fi > 0) curve(x, fi, c.fadeInTension ?? 0, true);
  if (fo > 0) curve(x + w - fo, fo, c.fadeOutTension ?? 0, false);

  // title bar: menu arrow, name and gain
  g.globalAlpha = 1;
  g.fillStyle = muted ? '#aab4bb' : '#f2f6f8';
  const tx = w >= CLIP_MENU_MIN_W ? x + CLIP_MENU_W : x + 4;
  if (w >= CLIP_MENU_MIN_W) drawClipMenuArrow(g, x, y, headH, g.fillStyle);
  const gain = c.gain ?? 0;
  let label = o.name;
  if (gain !== 0 && w > 90) label += `  ${gain > 0 ? '+' : ''}${Math.abs(gain) >= CLIP_GAIN_LABEL_MIN ? gain.toFixed(1) : gain.toFixed(2)} dB`;
  g.fillText(label, tx, y + headH / 2 + 0.5, Math.max(0, x + w - tx - 4));

  // handles
  if (o.showFades && w >= HANDLES_MIN_W) {
    const hd = handlesOf(c, x, y, w, h, o.ppt);
    const draw = (p: { x: number; y: number }, zone: AudioZone): void => {
      const on = o.hover === zone;
      g.fillStyle = on ? '#ffd9a0' : 'rgba(255,255,255,0.8)';
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.lineWidth = 1;
      if (zone === 'gain') {
        g.beginPath();
        g.moveTo(p.x, p.y - HANDLE + 1);
        g.lineTo(p.x + HANDLE - 1, p.y);
        g.lineTo(p.x, p.y + HANDLE - 1);
        g.lineTo(p.x - HANDLE + 1, p.y);
        g.closePath();
      } else {
        g.beginPath();
        g.rect(p.x - HANDLE + 1.5, p.y - HANDLE + 1.5, 2 * HANDLE - 3, 2 * HANDLE - 3);
      }
      g.fill();
      g.stroke();
    };
    draw(hd.fadeIn, 'fadeIn');
    draw(hd.fadeOut, 'fadeOut');
    draw(hd.gain, 'gain');
  }
  g.restore();
  g.strokeStyle = o.selected ? '#ff9f43' : shade(color, -0.6);
  g.lineWidth = o.selected ? 1.5 : 1;
  g.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), h - 2);
}

const CLIP_GAIN_LABEL_MIN = 10;

function drawWave(g: CanvasRenderingContext2D, o: AudioClipDraw, cy: number, bodyH: number): void {
  const m = o.map!;
  const { c, x, w, ppt } = o;
  const spt = 60 / (o.tempo * o.ppq); // seconds per tick
  const amp = (bodyH / 2) * Math.min(4, clipGainLinear(c.gain)) * 0.95;
  const i0 = Math.max(0, Math.floor(o.visL - x) - 1), i1 = Math.min(Math.ceil(w), Math.ceil(o.visR - x) + 1);
  g.fillStyle = o.muted ? 'rgba(210,220,226,0.55)' : 'rgba(228,238,242,0.9)';
  const mm: [number, number] = [0, 0];
  const per = m.chans.length;
  for (let i = i0; i < i1; i++) {
    const p0 = (c.offset + i / ppt) * spt * m.fps;
    const p1 = (c.offset + (i + 1) / ppt) * spt * m.fps;
    if (p0 >= m.frames) break;
    if (p1 <= 0) continue;
    const q0 = Math.max(0, p0), q1 = Math.min(m.frames, Math.max(p1, p0 + 1));
    // frames of the raw sample: reversed sample windows run backwards from the end of the trimmed part
    const a = m.reverse ? m.startFrame + m.frames - q1 : m.startFrame + q0;
    const b = m.reverse ? m.startFrame + m.frames - q0 : m.startFrame + q1;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < per; k++) {
      minMax(m.chans[k], a, b, mm);
      if (mm[0] < lo) lo = mm[0];
      if (mm[1] > hi) hi = mm[1];
    }
    const top = cy - Math.min(1, hi) * amp, bot = cy - Math.max(-1, lo) * amp;
    g.fillRect(x + i, top, 1, Math.max(1, bot - top));
  }
}
