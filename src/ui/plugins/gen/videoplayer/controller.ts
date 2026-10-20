// The picture side of a Video Player: one controller per plugin instance owns
// the <video> element (muted: the sound comes from the engine plugin, which
// plays the file's audio), keeps it in step with the song position or with the
// engine plugin's own playback clock, and paints its frames into the canvases
// of the views (the channel's PLUGIN tab and the detached window) that are
// open. It also holds what the views need to show: the load status, the
// position the user scrubbed to while the song is stopped, and the engine's
// monitor data. The state itself (file reference, options, range) is the
// plugin's params, edited through the kit's actions (never written here).

import { useEffect, useLayoutEffect } from 'react';
import { store, host } from '../../../../store';
import * as A from '../../../../store/actions';
import { currentTick, live, subscribeLive } from '../../../../audio/live';
import { flashHint } from '../../../hint';
import { playRange, videoMap, vpState, type VpState } from '../../../../model/gen/plugins/videoplayer';
import type { FxMonitor } from '../../../../engine/effects/types';
import { getVideo } from './files';
import { hiddenVideo } from './media';

export type VideoStatus = 'none' | 'loading' | 'ready' | 'missing' | 'error';

/** What the views show at a moment: the video's time, whether it plays and whether it is inside its range. */
export interface VideoTime {
  t: number;
  playing: boolean;
  on: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export class VideoController {
  readonly slotId: string;
  /** Mounted users (the persistent part and the open editors); the controller goes when none is left. */
  refs = 0;
  s: VpState = vpState({});
  status: VideoStatus = 'none';
  private statusSubs = new Set<() => void>();
  video: HTMLVideoElement | null = null;
  /** The file being shown (key of the file store) and its bytes. */
  key = '';
  blob: Blob | null = null;
  /** Engine monitor data (the player's own playback clock). */
  mon = { vt: 0, playing: false, link: true, audio: false, recv: 0 };
  private url = '';
  private token = 0;
  private adopted: { key: string; blob: Blob } | null = null;
  private views = new Set<() => void>();
  private raf = 0;
  private extra = 0;
  private lastSeekWall = 0;
  private pendingSeek: number | null = null;
  private liveOff: (() => void) | null = null;
  private liveKey = '';
  /** The position the user scrubbed to while the song is stopped (valid for that song position). */
  private override: { t: number; tick: number } | null = null;

  constructor(slotId: string) {
    this.slotId = slotId;
  }

  // ------------------------------------------------------------------ state

  /** The plugin's params changed (called on every render of the persistent part). */
  setParams(params: Record<string, unknown>): void {
    const s = vpState(params);
    this.s = s;
    if (s.videoKey !== this.key) void this.openKey(s.videoKey);
    this.invalidate();
  }

  onMonitor(d: FxMonitor): void {
    this.mon = { vt: Number(d.vt) || 0, playing: !!d.playing, link: !!d.link, audio: !!d.audio, recv: performance.now() };
    if (this.s.play || this.mon.playing) this.invalidate();
  }

  /** useSyncExternalStore plumbing for the load status. */
  subscribeStatus = (fn: () => void): (() => void) => {
    this.statusSubs.add(fn);
    return () => { this.statusSubs.delete(fn); };
  };

  getStatus = (): VideoStatus => this.status;

  private setStatus(st: VideoStatus): void {
    if (this.status === st) return;
    this.status = st;
    for (const fn of this.statusSubs) fn();
  }

  /** The loader hands over the file it just stored, so it need not be read back. */
  adopt(key: string, blob: Blob): void {
    this.adopted = { key, blob };
  }

  /** Clip length in seconds: the state's, else the element's. */
  duration(): number {
    if (this.s.duration > 0) return this.s.duration;
    const d = this.video?.duration;
    return d && Number.isFinite(d) ? d : 0;
  }

  /** Frame rate for stepping and the SMPTE display (25 when unknown). */
  fps(): number {
    return this.s.fps > 0 ? this.s.fps : 25;
  }

  // ------------------------------------------------------------------ media

  private async openKey(key: string): Promise<void> {
    const token = ++this.token;
    this.key = key;
    this.unload();
    if (!key) { this.setStatus('none'); this.invalidate(); return; }
    this.setStatus('loading');
    this.invalidate();
    let blob: Blob | undefined;
    if (this.adopted?.key === key) { blob = this.adopted.blob; this.adopted = null; } else blob = await getVideo(key);
    if (token !== this.token) return;
    if (!blob) { this.setStatus('missing'); this.invalidate(); return; }
    this.attach(blob, token);
  }

  private attach(blob: Blob, token: number): void {
    const v = hiddenVideo();
    this.blob = blob;
    this.url = URL.createObjectURL(blob);
    v.onloadeddata = () => {
      if (token !== this.token) return;
      this.setStatus('ready');
      this.invalidate();
    };
    v.onerror = () => {
      if (token !== this.token) return;
      this.setStatus('error');
      this.invalidate();
    };
    v.onseeked = () => {
      this.flushSeek();
      this.invalidate();
    };
    document.body.appendChild(v);
    v.src = this.url;
    this.video = v;
  }

  private unload(): void {
    const v = this.video;
    if (v) {
      v.onloadeddata = null;
      v.onerror = null;
      v.onseeked = null;
      try { v.pause(); } catch { /* ignore */ }
      v.removeAttribute('src');
      v.load();
      v.remove();
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.video = null;
    this.url = '';
    this.blob = null;
    this.pendingSeek = null;
  }

  dispose(): void {
    this.token++;
    this.unload();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.liveOff?.();
    this.liveOff = null;
    this.views.clear();
  }

  // ------------------------------------------------------------------ time

  private tps(): number {
    if (live.ticksPerSecond > 0) return live.ticksPerSecond;
    const p = store.project;
    return (p.tempo * p.ppq) / 60;
  }

  /** The song's time in seconds (the audible position while it plays). */
  songSeconds(): number {
    const tps = this.tps();
    return tps > 0 ? currentTick() / tps : 0;
  }

  /** Where the video is now (see VideoTime). */
  time(): VideoTime {
    const s = this.s;
    const { lo, hi } = playRange(s.start, s.end, this.duration());
    if (s.link) {
      const tps = this.tps();
      if (live.playing) {
        this.override = null;
        const m = videoMap(s.start, lo, hi, s.loop, tps > 0 ? currentTick() / tps : 0);
        return { t: m.t, playing: true, on: m.on };
      }
      const o = this.override;
      if (o && o.tick === live.anchorTick) return { t: o.t, playing: false, on: false };
      this.override = null;
      const m = videoMap(s.start, lo, hi, s.loop, tps > 0 ? live.anchorTick / tps : 0);
      return { t: m.t, playing: false, on: false };
    }
    const m = this.mon;
    if (s.play && !m.link && m.playing && performance.now() - m.recv < 500) {
      const lat = live.latencySec;
      return { t: Math.max(0, m.vt + (performance.now() - m.recv) / 1000 - lat), playing: true, on: true };
    }
    return { t: s.pos, playing: false, on: false };
  }

  /** Whether the player plays: the song (Link transport) or its own Play. */
  isPlaying(): boolean {
    return this.s.link ? live.playing : this.s.play;
  }

  // ------------------------------------------------------------------ sync and painting

  /** Ask for a repaint (and the sync that goes with it). */
  invalidate(): void {
    this.extra = 3;
    if (!this.raf && this.views.size > 0) this.raf = requestAnimationFrame(this.frame);
  }

  /** The song position moved (a seek, the transport): the picture follows when the video's time changed. */
  private onLive = (): void => {
    const t = this.time();
    const k = `${t.t.toFixed(4)}${t.playing ? 'p' : ''}${t.on ? 'o' : ''}`;
    if (k !== this.liveKey) { this.liveKey = k; this.invalidate(); }
  };

  /** A view (canvas) to repaint on every frame while the video moves; returns its removal. */
  addView(draw: () => void): () => void {
    this.views.add(draw);
    if (!this.liveOff) this.liveOff = subscribeLive(this.onLive);
    this.invalidate();
    return () => {
      this.views.delete(draw);
      if (this.views.size === 0) {
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = 0;
        this.liveOff?.();
        this.liveOff = null;
        // nobody sees the picture: stop decoding
        if (this.video && !this.video.paused) this.video.pause();
      }
    };
  }

  private frame = (): void => {
    this.raf = 0;
    if (this.views.size === 0) return;
    const t = this.time();
    this.syncVideo(t);
    for (const draw of this.views) draw();
    const v = this.video;
    // keep going while the video plays (also before a delayed start, when it begins by itself) or is seeking
    if (t.playing || (v && v.seeking) || this.extra-- > 0) this.raf = requestAnimationFrame(this.frame);
  };

  private syncVideo(t: VideoTime): void {
    const v = this.video;
    if (!v || this.status !== 'ready') return;
    const dur = this.duration() || v.duration || 0;
    const target = clamp(t.t, 0, Math.max(0, dur - 0.04));
    if (t.playing && t.on) {
      if (v.paused) {
        v.playbackRate = 1;
        v.currentTime = target;
        this.lastSeekWall = performance.now();
        void v.play().catch(() => { /* blocked: the next frame tries again */ });
        return;
      }
      const drift = v.currentTime - target;
      const now = performance.now();
      if (Math.abs(drift) > 0.25 && now - this.lastSeekWall > 400) {
        v.currentTime = target;
        this.lastSeekWall = now;
      } else {
        // small drift: nudge the rate (the element is muted, so nothing is heard) so picture and sound meet again without a jump
        v.playbackRate = Math.abs(drift) < 0.012 ? 1 : clamp(1 - drift * 2.5, 0.9, 1.1);
      }
      return;
    }
    if (!v.paused) v.pause();
    if (v.playbackRate !== 1) v.playbackRate = 1;
    this.seekVideo(target);
  }

  private seekVideo(target: number): void {
    const v = this.video;
    if (!v) return;
    const half = (0.5 / this.fps()) * 0.9;
    if (v.seeking) { this.pendingSeek = target; return; }
    if (Math.abs(v.currentTime - target) <= half) return;
    this.pendingSeek = null;
    v.currentTime = target;
  }

  private flushSeek(): void {
    if (this.pendingSeek === null) return;
    const t = this.pendingSeek;
    this.pendingSeek = null;
    this.seekVideo(t);
  }

  /** Paint the current frame into a canvas context of size w x h (CSS pixels). */
  paint(g: CanvasRenderingContext2D, w: number, h: number): void {
    const v = this.video;
    if (!v || this.status !== 'ready') {
      g.fillStyle = '#000';
      g.fillRect(0, 0, w, h);
      return;
    }
    // between frames (a seek in progress) the last painted picture stays
    if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) return;
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    let dx = 0, dy = 0, dw = w, dh = h;
    if (this.s.aspect) {
      const k = Math.min(w / v.videoWidth, h / v.videoHeight);
      dw = v.videoWidth * k;
      dh = v.videoHeight * k;
      dx = (w - dw) / 2;
      dy = (h - dh) / 2;
    }
    g.drawImage(v, dx, dy, dw, dh);
  }

  // ------------------------------------------------------------------ user actions

  /** Move the video to a time (the scrub bar, the time labels, the arrow keys). */
  seek(t: number): void {
    const s = this.s;
    const dur = this.duration();
    const to = clamp(t, 0, dur > 0 ? dur : Math.max(t, 0));
    if (s.link) {
      if (live.playing) { flashHint('Link transport is on: FL Studio drives the video'); return; }
      this.override = { t: to, tick: live.anchorTick };
      this.invalidate();
      return;
    }
    A.setFxStateNoHistory(this.slotId, 'Video position', (p) => { p.pos = to; p.seek = (Number(p.seek) || 0) + 1; });
  }

  /** Left / Right arrow keys while stopped: the previous / next frame. */
  nudge(dir: -1 | 1): void {
    if (this.isPlaying()) return;
    this.seek(this.time().t + dir / this.fps());
  }

  /** A parameter written like a knob tweak (no undo step unless "Undo knob tweaks" is on): the transport's own toggles. */
  private tweak(key: string, v: number, label: string): void {
    store.nextGestureIsKnob = true;
    store.beginGesture(label);
    try { A.setFxParam(this.slotId, key, v, label); } finally { store.endGesture(); }
  }

  /** Play / pause: FL's transport while linked, the player's own Play otherwise. */
  togglePlay(): void {
    if (this.s.link) { void A.togglePause(); return; }
    void host.resume();
    this.tweak('play', this.s.play ? 0 : 1, 'P lay / pause');
  }

  /** Stop: FL's transport while linked, else the player's own (back to the start of the range). */
  stop(): void {
    if (this.s.link) { host.stop(); return; }
    const lo = playRange(this.s.start, this.s.end, this.duration()).lo;
    // the position first, then Play off: the engine reports the position it pauses at, which is then the new one
    A.setFxStateNoHistory(this.slotId, 'Stop', (p) => { p.pos = lo; p.seek = (Number(p.seek) || 0) + 1; });
    this.tweak('play', 0, 'P lay / pause');
  }

  /** "Set current position as start time" (S). */
  setStartHere(): void {
    this.setStart(this.time().t);
  }

  setStart(t: number): void {
    const end = this.s.end;
    if (end > 0 && t >= end) { flashHint('The start time must be before the end time'); return; }
    A.editFx(this.slotId, 'Set start time', (p) => { p.start = Math.max(0, t); });
  }

  /** "Set current position as end time" (E). */
  setEndHere(): void {
    this.setEnd(this.time().t);
  }

  setEnd(t: number): void {
    const { lo } = playRange(this.s.start, 0, this.duration());
    if (t <= lo) { flashHint('The end time must be after the start time'); return; }
    const dur = this.duration();
    A.editFx(this.slotId, 'Set end time', (p) => { p.end = dur > 0 && t >= dur ? 0 : t; });
  }

  /** "Delay playback by <song position>": the video starts when the song reaches this position. */
  delayHere(): void {
    const sec = Math.max(0, this.songSeconds());
    A.editFx(this.slotId, 'Delay playback', (p) => { p.start = -sec; });
  }
}

// ------------------------------------------------------------------ registry

const controllers = new Map<string, VideoController>();

/** The controller of a plugin instance, if one exists. */
export function controllerOf(slotId: string): VideoController | undefined {
  return controllers.get(slotId);
}

/**
 * The controller of a plugin instance (created on first use, dropped when its
 * last user unmounts), told the plugin's current state.
 */
export function useController(slotId: string, params: Record<string, unknown>): VideoController {
  let c = controllers.get(slotId);
  if (!c) { c = new VideoController(slotId); controllers.set(slotId, c); }
  useEffect(() => {
    const ctl = controllers.get(slotId) ?? c!;
    controllers.set(slotId, ctl);
    ctl.refs++;
    return () => {
      ctl.refs--;
      // a remount right after (React re-running effects) keeps it
      setTimeout(() => {
        if (ctl.refs <= 0 && controllers.get(slotId) === ctl) { ctl.dispose(); controllers.delete(slotId); }
      }, 0);
    };
  }, [slotId]);
  useLayoutEffect(() => { c!.setParams(params); }, [c, params]);
  return c;
}
