// Audio recording session (engine side). Pure TypeScript like the rest of the
// engine: it runs in the AudioWorklet, in Node tests and nowhere else.
//
// A session records every armed mixer track (those with an audio input, or a
// recording pickup other than EXT) from the moment it begins to the moment it
// is stopped, as one take, or as one take per pass when loop recording is on.
// The captured audio goes to the main thread in chunks ('recData'); the main
// thread builds pool samples and Playlist clips from it (audio/Recorder.ts).
//
// Timing, all in engine frames (the absolute frame counter Engine.frame):
//  - The session begins at an exact frame: right away, at the end of the
//    count-in, at the first sound on an armed input ("Wait for input"), or when
//    the transport reaches the punch-in position. The block that contains this
//    frame is split there (Engine.process), so the transport and the capture
//    start sample-accurately.
//  - Latency compensation moves the recording earlier by `delta` frames: a take
//    whose timeline runs from frame A to frame B (transport frames) captures
//    the input frames A + delta ... B + delta. The sound the performer made
//    while hearing the playback of frame f reaches the engine at
//    f + output latency + input latency, so `delta` is that round trip (plus
//    the plugin delay compensation of the playback chain when "Adjust position
//    of recorded audio" is on, plus the plugin latency of the track for the
//    pickups after its effects, plus the track's manual input delay). Every
//    track has its own delta. The first sample of a take is the one the
//    transport played at the take's start, so a clip placed at the take's
//    start tick lines up with the playback.
//  - A take ends `delta` frames after the transport reached its end; the session
//    stays open until every take is complete ("closing").

import type { MixerTrack } from '../model/types';
import { WAIT_THRESHOLD, inputChannels, type RecPickup, type RecStartOptions, type RecState } from '../model/recording';
import type { FromEngine } from './protocol';
import type { Engine } from './Engine';

/** Frames per 'recData' chunk (about 90 ms: the Playlist draws the recording as the chunks arrive). */
export const REC_CHUNK = 4096;
/** Longest latency compensation either way (seconds). */
export const MAX_DELTA_SECONDS = 5;

/** A take of the session as the transport sees it. */
interface Take {
  id: number;
  /** Transport position (ticks) of the take's first frame. */
  tick0: number;
  /** Engine frame the take starts at (-1: not started). */
  frame0: number;
  /** Engine frame the take ends at (-1: open). */
  frame1: number;
}

/** One track's data of one take. */
interface Run {
  take: number;
  tick0: number;
  /** Capture window in engine frames (b = Infinity while the take is open). */
  a: number;
  b: number;
  /** Frames produced so far (zero padding included). */
  written: number;
  L: Float32Array;
  R: Float32Array;
  fill: number;
  /** Frames already posted. */
  posted: number;
}

type Phase = 'idle' | 'countdown' | 'waiting' | 'punch' | 'recording' | 'closing';

/** A recorded track: where it is picked up, its latency compensation, and its takes in progress. */
class Capture {
  readonly runs: Run[] = [];
  /** Frames the recording moves earlier; kept in two parts so "Wait for input" can drop the automatic one. */
  fixed = 0;
  auto = 0;
  constructor(
    readonly track: number,
    readonly pickup: RecPickup,
    readonly hasExt: boolean,
    readonly rc: RecordingController,
  ) {}

  get delta(): number { return this.fixed + this.auto; }
  get idle(): boolean { return this.runs.length === 0; }

  open(take: Take, a: number): void {
    this.runs.push({
      take: take.id, tick0: take.tick0, a, b: Infinity, written: 0,
      L: new Float32Array(REC_CHUNK), R: new Float32Array(REC_CHUNK), fill: 0, posted: 0,
    });
  }

  /** The take ended at transport frame `frame`: its capture window closes `delta` frames later. */
  close(takeId: number, frame: number): void {
    for (const r of this.runs) if (r.take === takeId) r.b = frame + this.delta;
  }

  discard(): void {
    this.runs.length = 0;
  }

  /**
   * Complete the takes whose capture window ended at or before engine frame `frame` (all their audio has been fed).
   * `cut`: complete the others too, ending them where the audio captured so far ends.
   */
  settle(frame: number, cut = false): void {
    for (let k = 0; k < this.runs.length; k++) {
      const run = this.runs[k];
      if (run.b > frame && !cut) continue;
      if (run.b > run.a + run.written && cut) run.b = run.a + run.written;
      this.finish(run);
      this.runs.splice(k, 1);
      k--;
    }
  }

  /** The signal at the pickup point for engine frames f0 ... f0 + n. */
  feed(L: Float32Array, R: Float32Array, n: number, f0: number): void {
    const f1 = f0 + n;
    for (let k = 0; k < this.runs.length; k++) {
      const run = this.runs[k];
      if (run.a >= f1) continue; // starts later
      const s = Math.max(run.a, f0);
      const e = Math.min(run.b, f1);
      if (e > s) {
        const next = run.a + run.written;
        if (s > next) this.pad(run, s - next); // audio from before the capture started: silence
        const from = Math.max(s, run.a + run.written);
        if (e > from) this.write(run, L, R, from - f0, e - f0);
      }
      if (run.b <= f1) {
        this.finish(run);
        this.runs.splice(k, 1);
        k--;
      }
    }
  }

  private pad(run: Run, count: number): void {
    while (count > 0) {
      const room = REC_CHUNK - run.fill;
      const c = Math.min(room, count);
      run.L.fill(0, run.fill, run.fill + c);
      run.R.fill(0, run.fill, run.fill + c);
      run.fill += c;
      run.written += c;
      count -= c;
      if (run.fill === REC_CHUNK) this.post(run, false);
    }
  }

  private write(run: Run, L: Float32Array, R: Float32Array, from: number, to: number): void {
    let i = from;
    while (i < to) {
      const c = Math.min(REC_CHUNK - run.fill, to - i);
      run.L.set(L.subarray(i, i + c), run.fill);
      run.R.set(R.subarray(i, i + c), run.fill);
      run.fill += c;
      run.written += c;
      i += c;
      if (run.fill === REC_CHUNK) this.post(run, false);
    }
  }

  /** Send the chunk in the run's buffers (`last`: it may be partial). */
  private post(run: Run, last: boolean): void {
    const n = run.fill;
    if (n === 0) return;
    const L = last && n < REC_CHUNK ? run.L.slice(0, n) : run.L;
    const R = last && n < REC_CHUNK ? run.R.slice(0, n) : run.R;
    this.rc.send({ t: 'recData', take: run.take, track: this.track, off: run.posted, L, R }, [L.buffer, R.buffer]);
    run.posted += n;
    run.fill = 0;
    if (!last) { run.L = new Float32Array(REC_CHUNK); run.R = new Float32Array(REC_CHUNK); }
  }

  private finish(run: Run): void {
    const want = Math.max(0, run.b - run.a);
    // the take ended before its capture window caught up (negative compensation): the frames
    // past the end belong to the next take, the missing ones are silence
    if (run.written < want) this.pad(run, want - run.written);
    let frames = want;
    // a chunk may hold frames beyond the end of the take: cut them
    if (run.posted + run.fill > want) run.fill = Math.max(0, want - run.posted);
    if (run.fill > 0) this.post(run, true);
    frames = Math.min(frames, run.posted);
    this.rc.send({ t: 'recTake', take: run.take, track: this.track, frames, tick0: run.tick0 });
  }
}

export class RecordingController {
  phase: Phase = 'idle';
  /** Audio device latency in frames (the main thread measures it). */
  latencyIn = 0;
  latencyOut = 0;
  private o: RecStartOptions | null = null;
  private caps: Capture[] = [];
  private takeSeq = 0;
  private cur: Take | null = null;
  private startAt = 0;
  private triggered = false;
  private cancelled = false;

  constructor(private readonly eng: Engine, private readonly out: (msg: FromEngine, transfer?: Transferable[]) => void) {}

  send = (msg: FromEngine, transfer?: Transferable[]): void => this.out(msg, transfer);

  /** The public state of the transport side. */
  get state(): RecState {
    switch (this.phase) {
      case 'countdown': return 'countdown';
      case 'waiting': case 'punch': return 'waiting';
      case 'recording': return 'recording';
      default: return 'idle';
    }
  }

  get active(): boolean { return this.phase !== 'idle'; }

  /** The recorded tracks of the running session. */
  get tracks(): number[] { return this.caps.map((c) => c.track); }

  // ---------------------------------------------------------------- session
  start(o: RecStartOptions): void {
    // a session still playing out its latency tail ends with what it has; anything else running is dropped
    if (this.phase === 'closing') this.settleAll();
    else if (this.phase !== 'idle') this.cancel();
    const e = this.eng;
    this.o = o;
    this.triggered = false;
    this.cancelled = false;
    this.takeSeq = 0;
    this.caps = [];
    const capture = o.capture !== false;
    for (const m of capture ? e.armedTrackModels() : []) {
      const pickup: RecPickup = m.pickup ?? 'ext';
      const hasExt = !!m.input;
      if (pickup === 'ext' && !hasExt) continue; // nothing to record: needs an input
      this.caps.push(new Capture(m.index, pickup, hasExt, this));
    }
    if (capture && !this.caps.length) {
      this.send({ t: 'recDone', cancelled: true });
      return;
    }
    this.computeDeltas();
    if (e.playing) {
      // recording while the transport already plays: right away (no count-in), or at the punch-in position
      if (this.inSpan(e.pos)) this.begin(); else this.setPhase('punch');
      return;
    }
    if (o.countdownBars > 0) {
      this.scheduleCountdown(o.countdownBars);
      this.setPhase('countdown');
      return;
    }
    this.afterCountdown();
  }

  /** The count-in is over or there is none: start the transport, or wait for the punch-in position. */
  private afterCountdown(): void {
    const o = this.o!;
    if (o.waitForInput && this.phase !== 'waiting') { this.setPhase('waiting'); return; }
    this.beginOrPunch();
  }

  /** Begin now when the transport is inside the punch span (or there is none), else play on and wait for the span. */
  private beginOrPunch(): void {
    if (this.inSpan(this.eng.pos)) { this.begin(); return; }
    if (!this.eng.playing) this.eng.play();
    this.setPhase('punch');
  }

  /** Is the position inside the punch span (Start recording ... Stop recording)? Always, when there are no markers. */
  private inSpan(pos: number): boolean {
    const o = this.o!;
    if (o.punchIn !== undefined && pos < o.punchIn - 1e-9) return false;
    if (o.punchOut !== undefined && pos >= o.punchOut - 1e-9) return false;
    return true;
  }

  private setPhase(p: Phase): void {
    this.phase = p;
    this.postState();
  }

  private postState(): void {
    const t = this.cur;
    this.send({ t: 'recState', state: this.state, take: t ? t.id : 0, tick0: t ? t.tick0 : this.eng.pos, frame: this.eng.frame });
  }

  /** Begin recording now: the transport plays (starting it if needed) and the first take opens. */
  private begin(): void {
    const e = this.eng;
    if (!e.playing) e.play();
    // taps: every recorded track hands its pickup signal to its capture
    for (const c of this.caps) {
      e.mixer.setTap(c.track, c.pickup, (L, R, n) => c.feed(L, R, n, e.frame));
    }
    this.openTake(e.frame, e.pos);
    this.setPhase('recording');
  }

  /** Stop recording; the takes complete after their latency compensation tail. The transport is left alone. */
  stop(): void {
    this.stopAt(this.eng.frame);
  }

  /** ... at engine frame `frame` (the transport reached the punch-out position inside the segment being rendered). */
  private stopAt(frame: number): void {
    if (this.phase === 'idle' || this.phase === 'closing') return;
    if (this.phase !== 'recording') { this.cancel(); return; }
    this.endTake(frame);
    // a take whose capture window ended at or before this frame has all its audio already
    for (const c of this.caps) c.settle(this.eng.frame);
    this.phase = 'closing';
    this.postState();
    this.checkClosed();
  }

  /** Drop everything. */
  cancel(): void {
    if (this.phase === 'idle') return;
    if (this.phase === 'countdown') this.eng.clearClicks(); // the rest of the count-in is not played
    this.cancelled = true;
    for (const c of this.caps) c.discard();
    this.cur = null;
    this.finish();
  }

  private finish(): void {
    const e = this.eng;
    for (const c of this.caps) e.mixer.setTap(c.track, null, null);
    this.caps = [];
    this.o = null;
    this.phase = 'idle';
    this.postState();
    this.send({ t: 'recDone', cancelled: this.cancelled });
    this.cancelled = false;
  }

  private checkClosed(): void {
    if (this.phase !== 'closing') return;
    if (this.caps.every((c) => c.idle)) this.finish();
  }

  /** End a closing session now: each take keeps the audio it has captured. */
  private settleAll(): void {
    for (const c of this.caps) c.settle(Infinity, true);
    this.finish();
  }

  // ------------------------------------------------------------------ takes
  private openTake(frame: number, tick0: number): void {
    const take: Take = { id: ++this.takeSeq, tick0, frame0: frame, frame1: -1 };
    this.cur = take;
    for (const c of this.caps) c.open(take, frame + c.delta);
  }

  private endTake(frame: number): void {
    const t = this.cur;
    if (!t) return;
    t.frame1 = frame;
    this.cur = null;
    for (const c of this.caps) c.close(t.id, frame);
  }

  /**
   * The transport looped: `at` is the (fractional) frame offset in the segment being scheduled where
   * the loop start plays, `tick` the loop start, `loopEnd` the end it wrapped at. With loop recording
   * a new take starts there; without it the recording goes on, unless the loop end is at or past the
   * punch-out position: the transport has passed the Stop recording marker by wrapping.
   */
  onWrap(at: number, tick: number, loopEnd: number): void {
    if (this.phase !== 'recording' || !this.o) return;
    const f = Math.round(this.eng.frame + at);
    if (!this.o.loop) {
      if (this.o.punchOut !== undefined && loopEnd >= this.o.punchOut - 1e-9) this.stopAt(f);
      return;
    }
    this.endTake(f);
    this.openTake(f, tick);
    this.postState();
  }

  /** The playhead was moved while recording: the take ends and a new one starts at the new position. */
  onSeek(tick: number): void {
    if (this.phase !== 'recording') return;
    const f = this.eng.frame;
    this.endTake(f);
    this.openTake(f, tick);
    this.postState();
  }

  /** The transport stopped or paused. */
  transportStopped(): void {
    if (this.phase === 'idle' || this.phase === 'closing') return;
    this.stop();
  }

  /** Song mode with no loop region: does the transport run on past the end of the song instead of looping? */
  get runsPastSongEnd(): boolean {
    return this.phase === 'recording' && !this.o?.loop;
  }

  // --------------------------------------------------------------- latency
  private computeDeltas(): void {
    const e = this.eng;
    const sr = e.sampleRate;
    const max = Math.round(MAX_DELTA_SECONDS * sr);
    const o = this.o!;
    const mx = e.mixer;
    for (const c of this.caps) {
      const m = e.trackModel(c.track);
      const postFx = c.pickup === 'ext' || c.pickup === 'mix' ? 0 : mx.tracks[c.track].latency();
      let auto = 0;
      if (c.hasExt) {
        // sound made while hearing the playback: the round trip through the audio device, and the
        // plugin delay compensation of the chain the playback comes through (unless switched off)
        if (o.latencyComp) auto += this.latencyIn + this.latencyOut;
        if (m?.inputAdjust !== false) auto += mx.playbackLag();
      } else {
        // internal audio only: it is late by the plugin delay compensation of the route into the track
        auto += mx.trackArrival(c.track);
      }
      const manual = Math.round(((m?.inputDelay ?? 0) * sr) / 1000);
      c.fixed = Math.max(-max, Math.min(max, manual + postFx));
      c.auto = Math.max(-max, Math.min(max, auto));
    }
  }

  // ---------------------------------------------------------------- count-in
  private scheduleCountdown(bars: number): void {
    const e = this.eng;
    const g = e.globals;
    const beats = Math.max(1, Math.round(bars * g.beatsPerBar));
    const fpb = (e.sampleRate * 60) / g.tempo;
    for (let k = 0; k < beats; k++) e.queueClick(Math.round(k * fpb), k % g.beatsPerBar === 0);
    this.startAt = e.frame + Math.round(beats * fpb);
  }

  // ------------------------------------------------------------- the engine
  /**
   * Called before every segment of the block being rendered (Engine.process): fires the events
   * that are due now and returns how many frames the segment is to be cut to (0: render all `left`
   * frames), so that the next event falls on a segment boundary.
   */
  plan(left: number, input: Float32Array[] | undefined, off: number): number {
    const e = this.eng;
    for (let guard = 0; guard < 8; guard++) {
      switch (this.phase) {
        case 'idle':
          return 0;
        case 'countdown': {
          const k = this.startAt - e.frame;
          if (k <= 0) { this.afterCountdown(); continue; }
          return k < left ? k : 0;
        }
        case 'waiting': {
          const j = this.findTrigger(left, input, off);
          if (j === 0) { this.triggered = true; this.dropAutoLatency(); this.afterTrigger(); continue; }
          return j > 0 && j < left ? j : 0;
        }
        case 'punch': {
          const pi = this.o!.punchIn;
          const fpt = (e.sampleRate * 60) / (e.globals.tempo * e.globals.ppq);
          if (e.playing && this.inSpan(e.pos)) { this.begin(); continue; }
          if (!e.playing || pi === undefined || e.pos >= pi) return 0; // past the span: wait for the transport to come round again
          const k = Math.ceil((pi - e.pos) * fpt - 1e-9);
          return k > 0 && k < left ? k : 0;
        }
        case 'recording': {
          const po = this.o?.punchOut;
          if (po === undefined) return 0;
          const fpt = (e.sampleRate * 60) / (e.globals.tempo * e.globals.ppq);
          if (e.pos >= po - 1e-9) { this.stop(); continue; }
          const k = Math.ceil((po - e.pos) * fpt - 1e-9);
          return k > 0 && k < left ? k : 0;
        }
        case 'closing':
          this.checkClosed();
          return 0;
      }
    }
    return 0;
  }

  /** "Wait for input" triggered: with a punch-in still ahead, wait for it, else begin. */
  private afterTrigger(): void {
    this.beginOrPunch();
  }

  /** Without a performer reacting to the playback, there is nothing to compensate (the first sound starts the take). */
  private dropAutoLatency(): void {
    for (const c of this.caps) c.auto = 0;
  }

  /** Index (in the segment) of the first frame at which an armed input has sound, or -1. */
  private findTrigger(left: number, input: Float32Array[] | undefined, off: number): number {
    if (!input || !input.length) return -1;
    const chans: Float32Array[] = [];
    // the inputs of the recorded tracks (a session that only runs the transport watches the armed ones)
    const models = this.caps.length ? this.caps.filter((c) => c.hasExt).map((c) => this.eng.trackModel(c.track)) : this.eng.armedTrackModels();
    for (const m of models) {
      if (!m?.input) continue;
      for (const ch of inputChannels(m.input)) if (input[ch] && !chans.includes(input[ch])) chans.push(input[ch]);
    }
    for (let j = 0; j < left; j++) {
      for (const a of chans) {
        const v = a[off + j];
        if (v >= WAIT_THRESHOLD || v <= -WAIT_THRESHOLD) return j;
      }
    }
    return -1;
  }
}

/** The track models the engine currently has armed, in track order (used by the controller). */
export function armedModels(models: readonly (MixerTrack | undefined)[]): MixerTrack[] {
  const out: MixerTrack[] = [];
  for (const m of models) if (m && m.armed && m.index >= 1 && m.index <= 125) out.push(m);
  return out;
}
