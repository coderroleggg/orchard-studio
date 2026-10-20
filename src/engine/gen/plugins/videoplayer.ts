// Video Player (FL: Fruity Video Player): plays the audio of the loaded video
// through the channel's mixer track. FL's plugin is a Gen_Render generator that
// streams the video's audio into the mixer while its own window shows the
// picture; here the editor decodes the file's audio into a pool sample (its id
// is the state's `sampleId`, delivered to the engine like every pool sample a
// plugin names) and this module plays it, sample accurately, from the song
// position. Notes do nothing, as in FL (its TriggerVoice returns no voice).
// docs/research/gen/videoplayer.md has the behaviour and what is measured.
//
// - Link transport on: the player follows the song. While the song plays, the
//   video's time is `start` + the song's time in seconds (the song position in
//   ticks at the block's tempo; a negative `start` delays the video), inside
//   the play range [max(0, start), end]; the range wraps with Loop, else the
//   audio ends. The video's clock is real time: a tempo change does not speed
//   the video up; a seek, a pattern / song loop wrap or a restart re-anchors it
//   at the song position (found by comparing the song position with where the
//   last block ended).
// - Link transport off: the player runs by itself from `pos` while the "P lay /
//   pause" parameter is on (the editor's Play / Pause / Stop), until the end of
//   the range (or forever with Loop). Changing `pos` together with `seek` jumps
//   there. At the end and at a pause the plugin reports its own state changes
//   (play = 0, pos) so the editor and the saved project follow.
// - Volume (0..127, linear), Mute audio and the Enable audio option scale the
//   audio (a change ramps over the block it starts in); the channel's own
//   volume and panning do not apply (no voices), as for FL's Gen_Render plugins.
// - The video's audio is resampled (4-point Hermite) when its rate differs from
//   the engine's; at the same rate frames are copied.
// - It renders in WAV export like live: that is how FL's player puts the
//   video's audio into a project export.

import type { GenContext, GenEnv, GenInstance, GenModule } from '../types';
import type { FxMonitor } from '../../effects/types';
import { hermite4 } from '../../dsp/interp';
import { rangeEnd, rangeStart, ticksToSeconds, videoMapTime, volumeGain, vpState, type VpState } from '../../../model/gen/plugins/videoplayer';

/** A song position within this many ticks of where the last block ended is the same stretch of playback. */
const TICK_TOL = 1e-4;
/** Blocks between sample pool lookups while the audio is present / missing. */
const LOOKUP_PRESENT = 64;
const LOOKUP_MISSING = 16;
/** Slack of range boundaries (seconds): far below a frame, far above the rounding of the time arithmetic. */
const EPS = 1e-9;

interface Audio {
  l: Float32Array;
  r: Float32Array;
  len: number;
  rate: number;
}

class VideoPlayer implements GenInstance {
  private readonly sr: number;
  private readonly env: GenEnv;
  private s: VpState = vpState({});
  private inited = false;
  private audio: Audio | null = null;
  private lookup = 0;
  /** The play range in seconds (refreshed with the state and the audio: see range()). */
  private lo = 0;
  private hi = 0;
  /** Video time in seconds at the next frame to render (while running) or the position the player rests at. */
  private x = 0;
  /** Time-advancing playback: the song plays (Link transport) or the player's own Play is on. */
  private running = false;
  private lastPlay = false;
  private lastSeek = 0;
  private hostPlaying = false;
  private expectTick = 0;
  private gain = 0;
  private target = 0;
  /** The video time the editor shows (end of the last block). */
  private vt = 0;
  private changes: [string, unknown][] = [];

  constructor(sampleRate: number, env: GenEnv) {
    this.sr = sampleRate;
    this.env = env;
  }

  /** Always rendered while a clip is loaded: the player's own playback and the song follow need a clock. */
  get tail(): number {
    return this.s.duration > 0 || this.audio ? Infinity : 0;
  }

  setParams(raw: unknown): void {
    const q = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const s = vpState(q);
    const prev = this.s;
    this.s = s;
    this.target = s.mute || !s.audio ? 0 : volumeGain(s.volume);
    if (s.sampleId !== prev.sampleId) this.lookup = 0;
    if (!this.inited) {
      // first state (project load, channel creation): rest at the saved position, do not play by itself
      this.inited = true;
      this.gain = this.target;
      this.lastPlay = s.play;
      this.lastSeek = s.seek;
      this.x = s.pos;
      this.vt = s.pos;
      return;
    }
    if (s.link !== prev.link) {
      if (s.link) {
        // following the song again: the next block anchors at the song position; a player that
        // was running by itself stops where it is (Play is off, so unlinking later does not start it)
        if (this.running) this.changes.push(['play', 0], ['pos', this.clampPos(this.x)]);
        this.running = false;
        this.hostPlaying = false;
      } else {
        // the player's own playback takes over from where the video is
        this.running = s.play;
        this.hostPlaying = false;
        if (!s.play) this.changes.push(['pos', this.clampPos(this.vt)]);
        else this.x = this.vt;
      }
    }
    if (!s.link) {
      if (s.seek !== this.lastSeek) {
        this.x = this.running ? this.startPoint(s.pos) : s.pos;
        this.vt = s.pos;
      }
      if (s.play !== this.lastPlay) {
        if (s.play) {
          this.x = this.startPoint(s.pos);
          this.running = true;
        } else if (this.running) {
          this.running = false;
          this.changes.push(['pos', this.clampPos(this.x)]);
        }
      }
    }
    this.lastPlay = s.play;
    this.lastSeek = s.seek;
  }

  /** The player's own Play starts at `pos`, or at the start of the range when `pos` is outside it. */
  private startPoint(pos: number): number {
    this.range();
    return pos >= this.lo && pos < this.hi ? pos : this.lo;
  }

  private clampPos(t: number): number {
    return Number.isFinite(t) ? Math.max(0, t) : 0;
  }

  /** Refresh the play range of the state (the clip's length is the state's duration, else the audio's). */
  private range(): void {
    const a = this.audio;
    const dur = this.s.duration > 0 ? this.s.duration : a ? a.len / a.rate : 0;
    this.lo = rangeStart(this.s.start);
    this.hi = rangeEnd(this.s.end, dur);
  }

  reset(): void {
    this.running = false;
    this.hostPlaying = false;
    this.x = this.s.pos;
    this.vt = this.s.pos;
    this.changes.length = 0;
    this.gain = this.target;
  }

  private refreshAudio(): void {
    if (this.lookup > 0) { this.lookup--; return; }
    const id = this.s.sampleId;
    let next: Audio | null = null;
    const smp = id ? this.env.sample(id) : undefined;
    if (smp && smp.channels.length > 0 && smp.sampleRate > 0) {
      const l = smp.channels[0];
      const r = smp.channels.length > 1 ? smp.channels[1] : l;
      const cur = this.audio;
      if (cur && cur.l === l && cur.r === r && cur.rate === smp.sampleRate) next = cur;
      else next = { l, r, len: Math.min(l.length, r.length), rate: smp.sampleRate };
    }
    this.audio = next;
    this.lookup = next ? LOOKUP_PRESENT : LOOKUP_MISSING;
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    this.refreshAudio();
    const s = this.s;
    this.range();
    const lo = this.lo, hi = this.hi;
    const g0 = this.gain, g1 = this.target;
    this.gain = g1;

    if (s.link) {
      const tps = (ctx.tempo * ctx.ppq) / 60;
      const hp = ctx.playing && tps > 0;
      if (hp) {
        if (!this.hostPlaying || !(Math.abs(ctx.pos - this.expectTick) <= TICK_TOL)) {
          // (re)start, seek or loop wrap: the video's time follows the song position
          this.x = s.start + ticksToSeconds(ctx.pos, ctx.tempo, ctx.ppq);
        }
        this.expectTick = ctx.pos + (n * tps) / this.sr;
        this.hostPlaying = true;
        this.running = true;
        this.run(L, R, n, lo, hi, g0, g1, false);
        this.vt = Math.min(this.x, hi);
      } else {
        this.hostPlaying = false;
        this.running = false;
        this.vt = tps > 0 ? videoMapTime(s.start, lo, hi, s.loop, ticksToSeconds(ctx.pos, ctx.tempo, ctx.ppq)) : lo;
      }
      return;
    }

    if (this.running) {
      this.run(L, R, n, lo, hi, g0, g1, true);
      this.vt = this.x;
    } else {
      this.vt = this.x;
    }
  }

  /**
   * Play `n` frames from the video time `this.x` (advancing it): silent before
   * the range, wrapping or ending at its end. `own` = the player's own
   * playback, which stops (and reports it) at the end of the range.
   */
  private run(L: Float32Array, R: Float32Array, n: number, lo: number, hi: number, g0: number, g1: number, own: boolean): void {
    const sr = this.sr;
    let x = this.x;
    if (!Number.isFinite(x)) x = lo;
    let i = 0;
    let guard = 0;
    while (i < n && guard++ < 64) {
      if (!(hi > lo)) {
        // no clip (or an empty range): nothing to play; the player's own Play switches itself off
        if (own) {
          this.running = false;
          this.changes.push(['play', 0], ['pos', this.clampPos(lo)]);
          this.x = this.clampPos(lo);
          return;
        }
        x += (n - i) / sr;
        i = n;
        break;
      }
      if (x < lo - EPS) {
        // before the range (a delayed start): nothing to play yet
        const f = Math.min(n - i, Math.max(1, Math.ceil((lo - x) * sr - 1e-6)));
        x += f / sr;
        i += f;
        continue;
      }
      if (x >= hi - EPS) {
        if (this.s.loop) {
          // wrap into the range (a time a hair below the end, within the slack, counts as the end itself)
          x = lo + (((x < hi ? hi : x) - lo) % (hi - lo));
          continue;
        }
        if (own) {
          // the clip ended: the player stops at its end
          this.running = false;
          this.changes.push(['play', 0], ['pos', hi]);
          x = hi;
          this.x = x;
          return;
        }
        x += (n - i) / sr;
        i = n;
        break;
      }
      const f = Math.min(n - i, Math.max(1, Math.ceil((hi - x) * sr - 1e-6)));
      if (this.audio && (g0 !== 0 || g1 !== 0)) this.mix(L, R, i, f, x, g0, (g1 - g0) / n);
      x += f / sr;
      i += f;
    }
    this.x = x;
  }

  /** Add `f` frames of the audio from video time `x` into the output at `o`, with the gain ramp of the block (frame index `o + j`). */
  private mix(L: Float32Array, R: Float32Array, o: number, f: number, x: number, g0: number, dg: number): void {
    const a = this.audio!;
    const len = a.len;
    const al = a.l, ar = a.r;
    if (a.rate === this.sr) {
      let k = Math.round(x * a.rate);
      for (let j = 0; j < f; j++, k++) {
        if (k < 0 || k >= len) continue;
        const gain = g0 + dg * (o + j + 1);
        let vl = al[k], vr = ar[k];
        if (!(vl > -1e9 && vl < 1e9)) vl = 0;
        if (!(vr > -1e9 && vr < 1e9)) vr = 0;
        L[o + j] += vl * gain;
        R[o + j] += vr * gain;
      }
      return;
    }
    const step = a.rate / this.sr;
    const p0 = x * a.rate;
    for (let j = 0; j < f; j++) {
      const p = p0 + j * step;
      const k = Math.floor(p);
      if (k < 0 || k >= len) continue;
      const t = p - k;
      const gain = g0 + dg * (o + j + 1);
      const m1 = k > 0 ? 1 : 0, p1 = k + 1 < len ? 1 : 0, p2 = k + 2 < len ? 1 : 0;
      let vl = hermite4(m1 ? al[k - 1] : 0, al[k], p1 ? al[k + 1] : 0, p2 ? al[k + 2] : 0, t);
      let vr = al === ar ? vl : hermite4(m1 ? ar[k - 1] : 0, ar[k], p1 ? ar[k + 1] : 0, p2 ? ar[k + 2] : 0, t);
      if (!(vl > -1e9 && vl < 1e9)) vl = 0;
      if (!(vr > -1e9 && vr < 1e9)) vr = 0;
      L[o + j] += vl * gain;
      R[o + j] += vr * gain;
    }
  }

  monitor(): FxMonitor | null {
    return { vt: this.vt, playing: this.running, link: this.s.link, audio: this.audio !== null };
  }

  takeStateChanges(): [string, unknown][] | null {
    if (this.changes.length === 0) return null;
    const out = this.changes;
    this.changes = [];
    return out;
  }
}

export const gen: GenModule = {
  id: 'videoplayer',
  create: (sampleRate, _blockSize, env) => new VideoPlayer(sampleRate, env),
};
