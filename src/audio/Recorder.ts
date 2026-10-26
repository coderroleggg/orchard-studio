// Audio recording, main-thread side: starts the engine's recording session
// (engine/Recording.ts) from the transport's Record button and the toolbar
// switches, collects the audio the engine sends back, and hands the finished
// takes on to be stored as pool samples and placed in the Playlist.
//
// Everything outside the recorder (the engine port, the project, the audio
// input, the store) comes in through RecEnv, so the flow runs in Node tests with
// a stubbed browser (tests/recording-flow.test.ts); audio/recording.ts wires the
// real application to it.

import type { FromEngine, ToEngine } from '../engine/protocol';
import type { Project } from '../model/types';
import { SILENT_PEAK, type RecSettings, type RecStartOptions, type RecState } from '../model/recording';
import { mixerTrackName } from '../model/defaults';

/** Frames per peak of the live display. */
const WAVE_BIN = 512;
/** How long the engine gets to complete the takes after the recording was stopped. */
const STOP_TIMEOUT_MS = 10000;
/** The longest recording the browser is asked to keep in memory (seconds). */
export const MAX_REC_SECONDS = 10 * 60;

/** One recorded track of one take, ready to become a pool sample. */
export interface FinishedTake {
  /** Take number in the session (1-based; loop recording makes several). */
  take: number;
  /** Takes the session made. */
  takes: number;
  track: number;
  /** Where the clip goes: a whole tick, with the sub-tick remainder already moved into the audio. */
  startTick: number;
  L: Float32Array;
  R: Float32Array;
  sampleRate: number;
  /** Suggested name ("Insert 1", "Insert 1 take 2"). */
  name: string;
  /** Peak level of the take. */
  peak: number;
}

/** What the recorder needs from the application. */
export interface RecEnv {
  send(msg: ToEngine): void;
  project(): Project;
  settings(): RecSettings;
  /** The sample rate of the audio context (the rate of the takes). */
  sampleRate(): number;
  /** Start the audio context (needs a user gesture; the Record button is one). */
  resume(): Promise<void>;
  /** The audio input. */
  input: {
    readonly ready: boolean;
    ensureOpen(): Promise<boolean>;
    describe(): string;
    readonly state: { status: string };
  };
  /** Send the current device latency to the engine. */
  updateLatency(): void;
  /** The playhead (ticks) the transport starts from. */
  startTick(): number;
  hint(text: string): void;
  /** The recording ended: store the takes (pool samples, Playlist clips, undo step). */
  commit(takes: FinishedTake[], session: SessionInfo): void;
  /** The Record button follows the session (armed / not). */
  setArmed(on: boolean): void;
  /** Recording into Edison: arm Edison on these mixer tracks (adding it where missing). */
  edisonStart(tracks: number[]): void;
  /** ... and disarm it again. */
  edisonStop(tracks: number[]): void;
  /** The state changed (UI). */
  onState?(s: SessionState): void;
}

export interface SessionInfo {
  /** The tracks that were recorded. */
  tracks: number[];
  /** The session ran in song mode. */
  songMode: boolean;
  settings: RecSettings;
  cancelled: boolean;
  /** The audio went into Edison: there are no takes to store, the tracks are only released. */
  edison?: boolean;
}

/** The level of the recording so far, for the Playlist to draw while it records: the peak of every `bin` frames. */
export interface WavePeaks {
  /** Take the peaks belong to (a new take starts them again). */
  take: number;
  bin: number;
  peaks: Float32Array;
  n: number;
}

export interface SessionState {
  state: RecState;
  tick0: number;
  frames: number;
  tracks: number[];
}

interface Acc {
  take: number;
  track: number;
  chunks: { off: number; L: Float32Array; R: Float32Array }[];
  frames: number;
  tick0: number;
  done: boolean;
}

export class Recorder {
  private acc = new Map<string, Acc>();
  private tracks: number[] = [];
  private toEdison = false;
  private songMode = false;
  private startedWith: RecSettings | null = null;
  state: SessionState = { state: 'idle', tick0: 0, frames: 0, tracks: [] };
  /** True from the moment a session is asked for to the engine's 'recDone'. */
  private busy = false;
  private longest = 0;
  private stopSent = false;
  /** A start is waiting for the audio context or the audio input. */
  private starting = false;
  /** Per recorded track: the peaks of the take being recorded. */
  readonly waves = new Map<number, WavePeaks>();

  constructor(private readonly env: RecEnv) {}

  get active(): boolean {
    return this.busy || this.starting;
  }

  /** Is this mixer track being recorded right now? */
  records(track: number): boolean {
    return this.busy && this.tracks.includes(track);
  }

  private publish(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.env.onState?.(this.state);
  }

  // ---------------------------------------------------------------- start
  /**
   * Start recording the armed mixer tracks. Resolves true when a session began.
   * `playing`: the transport already plays (recording starts at once, without the count-in).
   */
  async start(): Promise<boolean> {
    if (this.busy || this.starting) return false;
    this.starting = true;
    try {
      return await this.begin();
    } finally {
      this.starting = false;
    }
  }

  private async begin(): Promise<boolean> {
    const s = this.env.settings();
    const p = this.env.project();
    if (!s.filterAudio) {
      this.env.hint('Nothing to record: audio is not ticked in the recording filter (right-click the Record button)');
      return false;
    }
    const armed = p.mixer.tracks.filter((t) => t.armed && t.index >= 1 && t.index <= 125);
    if (!armed.length) {
      this.env.hint('Arm a mixer track to record audio (the Arm disk recording button) and choose its input');
      return false;
    }
    const usable = [];
    for (const t of armed) {
      if ((t.pickup ?? 'ext') === 'ext' && !t.input) {
        // FL's words
        this.env.hint(`${mixerTrackName(t)} won't record anything unless you select an input!`);
        continue;
      }
      usable.push(t);
    }
    if (!usable.length) return false;
    await this.env.resume();
    if (usable.some((t) => t.input)) {
      if (!(await this.env.input.ensureOpen())) {
        this.env.hint(this.env.input.state.status === 'off' ? 'Audio input needed: please select an audio input first (Options > Audio settings)' : this.env.input.describe());
        return false;
      }
    }
    this.env.updateLatency();
    const o: RecStartOptions = {
      countdownBars: s.countdown ? s.countdownBars : 0,
      waitForInput: s.waitForInput,
      loop: s.loop,
      latencyComp: s.latencyComp,
    };
    if (s.markers) {
      const m = punchMarkers(p);
      if (m) { o.punchIn = m.start; o.punchOut = m.end; }
      else this.env.hint('Enable recording markers is on, but the Playlist has no Start recording / Stop recording pair: recording as usual');
    }
    this.acc.clear();
    this.tracks = usable.map((t) => t.index);
    this.toEdison = s.audioTo === 'edison';
    this.songMode = p.songMode;
    this.startedWith = { ...s };
    this.longest = 0;
    this.stopSent = false;
    this.busy = true;
    this.publish({ state: 'idle', tick0: this.env.startTick(), frames: 0, tracks: this.tracks });
    if (this.toEdison) {
      // the audio goes into Edison: it records the track's signal itself while the transport plays
      this.env.edisonStart(this.tracks);
      this.env.send({ t: 'recStart', o: { ...o, capture: false } });
    } else {
      this.env.send({ t: 'recStart', o });
    }
    return true;
  }

  /** End the recording; the transport is left playing. */
  stop(): void {
    if (!this.busy || this.stopSent) return;
    this.stopSent = true;
    this.env.send({ t: 'recStop' });
    // the engine finishes the takes within a few seconds at most; if it never answers, keep what arrived
    const t = setTimeout(() => { if (this.busy && this.stopSent) this.finish(false); }, STOP_TIMEOUT_MS);
    (t as { unref?: () => void }).unref?.();
  }

  /** Throw the recording away. */
  cancel(): void {
    if (!this.busy) return;
    this.env.send({ t: 'recCancel' });
  }

  // ---------------------------------------------------------------- engine
  onEngine(m: FromEngine): void {
    switch (m.t) {
      case 'recState':
        if (!this.busy) return;
        this.publish({ state: m.state, tick0: m.tick0 });
        break;
      case 'recData': {
        if (!this.busy) return;
        const a = this.accFor(m.take, m.track);
        a.chunks.push({ off: m.off, L: m.L, R: m.R });
        a.frames = Math.max(a.frames, m.off + m.L.length);
        this.addPeaks(m.take, m.track, m.off, m.L, m.R);
        if (a.frames > this.longest) {
          this.longest = a.frames;
          this.publish({ frames: this.longest });
          if (this.longest > MAX_REC_SECONDS * this.env.sampleRate()) {
            this.env.hint(`The recording reached the limit of ${MAX_REC_SECONDS / 60} minutes and was stopped`);
            this.stop();
          }
        }
        break;
      }
      case 'recTake': {
        if (!this.busy) return;
        const a = this.accFor(m.take, m.track);
        a.frames = m.frames;
        a.tick0 = m.tick0;
        a.done = true;
        break;
      }
      case 'recDone':
        this.finish(m.cancelled);
        break;
    }
  }

  /** Fold a chunk into the track's peaks (the Playlist draws them as the recording grows). */
  private addPeaks(take: number, track: number, off: number, L: Float32Array, R: Float32Array): void {
    let w = this.waves.get(track);
    if (!w || w.take !== take) {
      w = { take, bin: WAVE_BIN, peaks: new Float32Array(1024), n: 0 };
      this.waves.set(track, w);
    }
    const bin = w.bin;
    for (let i = 0; i < L.length; i++) {
      const k = Math.floor((off + i) / bin);
      if (k >= w.peaks.length) { const g = new Float32Array(Math.max(k + 1, w.peaks.length * 2)); g.set(w.peaks); w.peaks = g; }
      const a = L[i] < 0 ? -L[i] : L[i], b = R[i] < 0 ? -R[i] : R[i];
      const v = a > b ? a : b;
      if (v > w.peaks[k]) w.peaks[k] = v;
      if (k + 1 > w.n) w.n = k + 1;
    }
  }

  private accFor(take: number, track: number): Acc {
    const k = `${take}:${track}`;
    let a = this.acc.get(k);
    if (!a) { a = { take, track, chunks: [], frames: 0, tick0: 0, done: false }; this.acc.set(k, a); }
    return a;
  }

  private finish(cancelled: boolean): void {
    if (!this.busy) return;
    this.busy = false;
    this.waves.clear();
    const s = this.startedWith ?? this.env.settings();
    const tracks = this.tracks;
    if (this.toEdison) this.env.edisonStop(tracks);
    const takes = cancelled || this.toEdison ? [] : this.assemble(s);
    this.acc.clear();
    this.publish({ state: 'idle', frames: 0 });
    if (!cancelled) this.env.commit(takes, { tracks, songMode: this.songMode, settings: s, cancelled, edison: this.toEdison });
    // Record releases when the recording is over ("Disarm on stop")
    if (s.disarmOnStop || cancelled) this.env.setArmed(false);
  }

  /** The takes the engine sent, as audio ready to be stored. */
  private assemble(s: RecSettings): FinishedTake[] {
    const p = this.env.project();
    const sr = this.env.sampleRate();
    const fpt = (sr * 60) / (p.tempo * p.ppq);
    const list = [...this.acc.values()].filter((a) => a.done && a.frames > 0).sort((a, b) => a.take - b.take || a.track - b.track);
    // the engine numbers takes across sessions: within this one they are 1, 2, 3 ...
    const order = [...new Set(list.map((a) => a.take))].sort((a, b) => a - b);
    const takeCount = order.length;
    const perTrack = new Map<number, number>();
    const bases = new Map<number, string>();
    const handedOut = new Set<string>();
    const out: FinishedTake[] = [];
    for (const a of list) {
      let L: Float32Array<ArrayBufferLike> = new Float32Array(a.frames);
      let R: Float32Array<ArrayBufferLike> = new Float32Array(a.frames);
      for (const c of a.chunks) {
        if (c.off >= a.frames) continue;
        const n = Math.min(c.L.length, a.frames - c.off);
        L.set(c.L.subarray(0, n), c.off);
        R.set(c.R.subarray(0, n), c.off);
      }
      // the clip starts on a tick; the rest of the position is moved into the audio
      let startTick = Math.max(0, Math.round(a.tick0));
      const shift = Math.round((a.tick0 - startTick) * fpt);
      if (shift > 0) {
        const L2 = new Float32Array(L.length + shift), R2 = new Float32Array(R.length + shift);
        L2.set(L, shift); R2.set(R, shift);
        L = L2; R = R2;
      } else if (shift < 0 && -shift < L.length) {
        L = L.slice(-shift); R = R.slice(-shift);
      }
      let peak = 0;
      for (let i = 0; i < L.length; i++) {
        const l = L[i] < 0 ? -L[i] : L[i], r = R[i] < 0 ? -R[i] : R[i];
        if (l > peak) peak = l;
        if (r > peak) peak = r;
      }
      const n = (perTrack.get(a.track) ?? 0) + 1;
      perTrack.set(a.track, n);
      const tr = p.mixer.tracks[a.track];
      let base = bases.get(a.track);
      if (!base) {
        // a name no channel or pool sample has yet: recording again on Insert 4 gives "Insert 4 2", not a second "Insert 4"
        base = freeName(p, tr?.recordName?.trim() || (tr ? mixerTrackName(tr) : `Insert ${a.track}`), handedOut);
        bases.set(a.track, base);
        handedOut.add(base);
      }
      if (s.ignoreSilent && peak < SILENT_PEAK) {
        this.env.hint(`${base}: a silent take was ignored`);
        continue;
      }
      const take = order.indexOf(a.take) + 1;
      out.push({
        take, takes: takeCount, track: a.track, startTick, L: L as Float32Array, R: R as Float32Array, sampleRate: sr,
        name: takeCount > 1 ? `${base} take ${take}` : base, peak,
      });
    }
    return out;
  }
}

/** `base`, or `base 2`, `base 3` ... the first that no channel or pool sample of the project (nor `used`) is named, or has as the start of its take names. */
export function freeName(p: Project, base: string, used: ReadonlySet<string> = new Set()): string {
  const names = [...p.channels.map((c) => c.name), ...Object.values(p.samples).map((s) => s.name)];
  const taken = (b: string) => used.has(b) || names.some((n) => n === b || n.startsWith(b + ' take '));
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base} ${n}`)) return `${base} ${n}`;
}

/** The Start recording / Stop recording markers of the Playlist (ticks), when both exist and are in order. */
export function punchMarkers(p: Project): { start: number; end: number } | null {
  let start: number | null = null, end: number | null = null;
  for (const m of p.playlist.markers) {
    if (m.kind === 'recStart') start = start === null ? m.pos : Math.min(start, m.pos);
    else if (m.kind === 'recStop') end = end === null ? m.pos : Math.max(end, m.pos);
  }
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}
