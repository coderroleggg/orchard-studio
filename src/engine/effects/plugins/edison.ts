// Edison: records the audio passing through its mixer slot and plays its
// sample (from the project's sample pool) into the slot output.
//
// Signal path: the input is captured for recording (pre-fader, at the slot
// position, as in FL), passed through unless "Mute input" is on, and the
// playback / scrub signal is added.
//
// Recording writes into a ring buffer allocated when Edison is first armed
// (in setParams, never in process()). monitor() hands the recorded frames to
// the editor in chunks (at most CHUNK frames per call, ~30 calls a second),
// tagged with a take number and the offset in the take; the editor assembles
// the take and stores it in the sample pool when the take ends (Record off).
// The ring holds RING frames (~21.8 s at 48 kHz) of not-yet-collected audio;
// the total length is limited by the editor (ED_MAX_SECONDS) and by the
// "For" duration setting.
//
// Record modes (FL): Now (record immediately), On input (start when the input
// reaches the threshold, with a pre-record buffer so the attack is kept),
// Input (record only while there is input: pause after HOLD_S of silence,
// resume with the pre-record buffer), On play (record while the host plays;
// a "Song jump" marker at every start and at every backward jump of the song
// position).

import type { EffectInstance, EffectModule, FxContext, FxEnv, FxMonitor } from '../types';
import { ED_MAX_SECONDS, ED_PREFIX, ED_DEFAULT_THRESHOLD } from '../../../model/fx/plugins/edison';

/** Recording ring (frames) between two collections by the editor. */
const RING = 1 << 20;
/** Most frames handed to the editor per monitor() call. */
const CHUNK = 16384;
/** Pre-record buffer for the input-triggered modes (seconds). */
const PRE_S = 0.1;
const PRE_CAP = 1 << 14;
/** Silence after which "Input" mode pauses (seconds). */
const HOLD_S = 0.5;
/** Play start / stop ramp (samples). */
const FADE = 64;
/** Takes waiting for collection. */
const TAKES = 8;
const MAX_MARKS = 64;

type Cmd = { n?: unknown; op?: unknown; pos?: unknown; a?: unknown; b?: unknown };

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function hermite(xm1: number, x0: number, x1: number, x2: number, t: number): number {
  if (t === 0) return x0;
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * t + c2) * t + c1) * t + x0;
}

class Edison implements EffectInstance {
  tail = Infinity; // playback generates sound: never idle the track
  latency = 0;
  private readonly sr: number;
  private readonly env: FxEnv;
  /** Random instance id: lets the editor tell takes of different DSP instances apart. */
  private readonly inst = Math.floor(Math.random() * 1e9);

  // ---- sample
  private sampleId = '';
  private sL: Float32Array | null = null;
  private sR: Float32Array | null = null;
  private len = 0;
  private srcRate = 48000;
  private rate = 1; // sample frames per output frame
  private lookup = 0;

  // ---- transport
  private first = true;
  private cmdN = 0;
  private playParam = false;
  private recParam = false;
  private playing = false;
  private ph = 0; // playhead, sample frames
  private startPos = 0;
  private a = 0;
  private b = 0;
  private loop = false;
  private liveSel = false;
  private sel: [number, number] | null = null;
  private gain = 0;
  private gainTarget = 0;
  private pauseAtZero = false;
  private stopPos = -1;
  private hostDriven = false;
  private sync = false;
  private syncNoOwnSel = false;

  // ---- scrub
  private scrubOn = false;
  private scrubTarget = 0;
  private scrubPos = 0;
  private scrubGain = 0;
  private readonly kScrub: number;
  private readonly kScrubGain: number;

  // ---- input
  private mute = false;
  private pkL = 0;
  private pkR = 0;

  // ---- recording
  private armed = false;
  private recMode = 1;
  private thr = ED_DEFAULT_THRESHOLD;
  /** 0 idle, 1 waiting for the trigger (or paused), 2 recording. */
  private recState = 0;
  private ringL: Float32Array | null = null;
  private ringR: Float32Array | null = null;
  private wAbs = 0;
  private wIdx = 0;
  private rAbs = 0;
  private readonly tId = new Float64Array(TAKES);
  private readonly tStart = new Float64Array(TAKES);
  private readonly tEnd = new Float64Array(TAKES);
  private tHead = 0;
  private tCount = 0;
  private takeSeq = 0;
  private openTake = 0;
  private openStart = 0;
  private finished = 0;
  private readonly capFrames: number;
  private autoStopped = false;
  private preL: Float32Array | null = null;
  private preR: Float32Array | null = null;
  private preIdx = 0;
  private preN = 0;
  private readonly preFrames: number;
  private hold = 0;
  private readonly holdFrames: number;
  private hostWasPlaying = false;
  private lastPos = 0;
  private readonly marks = new Float64Array(MAX_MARKS);
  private markN = 0;

  constructor(sampleRate: number, env: FxEnv) {
    this.sr = sampleRate;
    this.env = env;
    this.srcRate = sampleRate;
    this.kScrub = 1 - Math.exp(-1 / (0.025 * sampleRate));
    this.kScrubGain = 1 - Math.exp(-1 / (0.008 * sampleRate));
    this.capFrames = Math.round(ED_MAX_SECONDS * sampleRate);
    this.preFrames = Math.min(PRE_CAP, Math.round(PRE_S * sampleRate));
    this.holdFrames = Math.round(HOLD_S * sampleRate);
  }

  // ------------------------------------------------------------------ state
  setParams(p: unknown): void {
    const q = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const first = this.first;
    this.first = false;
    const id = typeof q.sample === 'string' ? q.sample : '';
    if (id !== this.sampleId) {
      this.sampleId = id;
      this.sL = this.sR = null;
      this.lookup = 0;
      this.findSample();
    }
    this.recMode = Math.min(3, Math.max(0, Math.round(num(q.recMode, 1))));
    this.thr = Math.max(0.0005, num(q.threshold, ED_DEFAULT_THRESHOLD));
    this.mute = !!q.mute;
    this.loop = !!q.loop;
    this.sync = !!q.sync;
    this.syncNoOwnSel = !!q.syncNoOwnSel;
    this.liveSel = num(q.livesel, 0) >= 0.5;
    const s = q.sel;
    this.sel = Array.isArray(s) && s.length === 2 && Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] > s[0] ? [s[0] as number, s[1] as number] : null;
    if (this.liveSel && this.playing && !this.hostDriven) this.setRangeFromSelection();

    const cmd = (q.cmd && typeof q.cmd === 'object' ? q.cmd : null) as Cmd | null;
    if (cmd) {
      const n = num(cmd.n, 0);
      if (first) this.cmdN = n;
      else if (n !== this.cmdN) { this.cmdN = n; this.exec(cmd); }
    }

    const sc = (q.scrub && typeof q.scrub === 'object' ? q.scrub : null) as { pos?: unknown } | null;
    if (sc && Number.isFinite(sc.pos)) {
      const pos = sc.pos as number;
      if (!this.scrubOn) {
        this.scrubOn = true;
        this.scrubPos = pos;
        if (this.playing) { this.playing = false; this.gain = 0; this.gainTarget = 0; }
      }
      this.scrubTarget = pos;
    } else if (this.scrubOn) {
      this.scrubOn = false;
      this.ph = this.scrubPos;
    }

    const play = num(q.play, 0) >= 0.5;
    const rec = num(q.rec, 0) >= 0.5;
    if (first) {
      this.playParam = play;
      this.recParam = rec;
      if (rec) this.arm();
    } else {
      if (play !== this.playParam) {
        this.playParam = play;
        if (play) { if (!this.playing) this.startFromSelection(this.ph); } else this.pause();
      }
      if (rec !== this.recParam) {
        this.recParam = rec;
        if (rec) this.arm(); else this.disarm();
      }
    }
  }

  private findSample(): void {
    if (!this.sampleId) { this.len = 0; return; }
    const s = this.env.sample(ED_PREFIX + this.sampleId);
    if (!s || !s.channels.length || !s.channels[0].length) { this.len = 0; return; }
    this.sL = s.channels[0];
    this.sR = s.channels[1] ?? s.channels[0];
    this.len = this.sL.length;
    this.srcRate = s.sampleRate > 0 ? s.sampleRate : this.sr;
    this.rate = this.srcRate / this.sr;
    if (this.b > this.len || this.b <= this.a) { this.b = this.len; if (this.a >= this.b) this.a = 0; }
    if (this.ph > this.len) this.ph = this.len;
  }

  // -------------------------------------------------------------- transport
  private clampPos(v: number): number {
    return Math.min(Math.max(0, v), this.len);
  }

  private setRangeFromSelection(): void {
    if (this.sel) { this.a = this.clampPos(this.sel[0]); this.b = this.clampPos(this.sel[1]); }
    else { this.a = 0; this.b = this.len; }
    if (this.b <= this.a) { this.a = 0; this.b = this.len; }
  }

  private start(pos: number, a: number, b: number): void {
    if (!this.sL || this.len <= 0) return;
    this.a = this.clampPos(a);
    this.b = this.clampPos(b);
    if (this.b <= this.a) { this.a = 0; this.b = this.len; }
    this.ph = Math.min(Math.max(this.clampPos(pos), this.a), this.b);
    if (this.ph >= this.b) this.ph = this.a;
    this.startPos = this.ph;
    this.playing = true;
    this.hostDriven = false;
    this.pauseAtZero = false;
    this.stopPos = -1;
    // from the start of the range the sample plays untouched; elsewhere a short ramp avoids a click
    this.gain = this.ph === this.a ? 1 : 0;
    this.gainTarget = 1;
  }

  private startFromSelection(pos: number): void {
    this.setRangeFromSelection();
    this.start(pos >= this.a && pos < this.b ? pos : this.a, this.a, this.b);
  }

  private pause(stopAt = -1): void {
    if (this.playing) {
      this.gainTarget = 0;
      this.pauseAtZero = true;
      this.stopPos = stopAt;
    } else if (stopAt >= 0) {
      this.ph = this.clampPos(stopAt);
    }
  }

  private exec(c: Cmd): void {
    const pos = num(c.pos, 0);
    switch (c.op) {
      case 'play': this.start(pos, num(c.a, 0), num(c.b, 0)); break;
      case 'pause': this.pause(); break;
      case 'stop':
        this.scrubOn = false;
        this.hostDriven = false;
        this.pause(pos);
        break;
      case 'seek':
        this.ph = this.clampPos(pos);
        if (this.playing && (this.ph < this.a || this.ph >= this.b)) { this.a = 0; this.b = this.len; }
        this.startPos = this.ph;
        break;
    }
  }

  // ------------------------------------------------------------- recording
  private arm(): void {
    if (!this.ringL) {
      this.ringL = new Float32Array(RING);
      this.ringR = new Float32Array(RING);
      this.preL = new Float32Array(PRE_CAP);
      this.preR = new Float32Array(PRE_CAP);
    }
    if (this.openTake) this.closeTake();
    this.armed = true;
    this.autoStopped = false;
    this.preN = 0;
    this.hold = 0;
    this.hostWasPlaying = false;
    this.recState = this.recMode === 0 ? 2 : 1;
    // a new take (the oldest uncollected one is dropped when the queue is full)
    if (this.tCount === TAKES) {
      const h = this.tHead;
      this.finished = this.tId[h];
      if (this.rAbs < this.tEnd[h]) this.rAbs = this.tEnd[h];
      this.tHead = (h + 1) % TAKES;
      this.tCount--;
    }
    const k = (this.tHead + this.tCount) % TAKES;
    this.openTake = ++this.takeSeq;
    this.openStart = this.wAbs;
    this.tId[k] = this.openTake;
    this.tStart[k] = this.wAbs;
    this.tEnd[k] = -1;
    this.tCount++;
  }

  private closeTake(): void {
    for (let i = 0; i < this.tCount; i++) {
      const k = (this.tHead + i) % TAKES;
      if (this.tId[k] === this.openTake) this.tEnd[k] = this.wAbs;
    }
    this.openTake = 0;
  }

  private disarm(): void {
    if (!this.armed) return;
    this.armed = false;
    this.recState = 0;
    this.closeTake();
  }

  private push(l: number, r: number): void {
    const RL = this.ringL!, RR = this.ringR!;
    RL[this.wIdx] = l;
    RR[this.wIdx] = r;
    if (++this.wIdx === RING) this.wIdx = 0;
    this.wAbs++;
  }

  private flushPre(): void {
    const n = this.preN, PL = this.preL!, PR = this.preR!;
    let k = (this.preIdx - n + PRE_CAP) % PRE_CAP;
    for (let i = 0; i < n; i++) {
      this.push(PL[k], PR[k]);
      if (++k === PRE_CAP) k = 0;
    }
    this.preN = 0;
  }

  private mark(): void {
    if (this.markN < MAX_MARKS) this.marks[this.markN++] = this.wAbs - this.openStart;
  }

  private capture(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    const mode = this.recMode;
    if (mode === 3) {
      // On play: record while the host transport runs
      if (ctx.playing) {
        if (this.recState === 1) { this.recState = 2; this.mark(); }
        else if (this.hostWasPlaying && ctx.pos + 1e-6 < this.lastPos) this.mark(); // song jumped back (loop)
      } else if (this.recState === 2) this.recState = 1;
      this.hostWasPlaying = ctx.playing;
      this.lastPos = ctx.pos;
      if (this.recState !== 2) return;
      for (let i = 0; i < n; i++) this.push(L[i], R[i]);
    } else if (mode === 0) {
      for (let i = 0; i < n; i++) this.push(L[i], R[i]);
    } else {
      const thr = this.thr, PL = this.preL!, PR = this.preR!;
      for (let i = 0; i < n; i++) {
        const l = L[i], r = R[i];
        const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
        const loud = (al > ar ? al : ar) >= thr;
        if (this.recState === 1) {
          if (loud) {
            this.flushPre();
            this.recState = 2;
            this.hold = this.holdFrames;
            this.push(l, r);
          } else {
            PL[this.preIdx] = l;
            PR[this.preIdx] = r;
            if (++this.preIdx === PRE_CAP) this.preIdx = 0;
            if (this.preN < this.preFrames) this.preN++;
          }
        } else {
          this.push(l, r);
          if (mode === 2) {
            if (loud) this.hold = this.holdFrames;
            else if (--this.hold <= 0) { this.recState = 1; this.preN = 0; }
          }
        }
      }
    }
    if (this.wAbs - this.openStart >= this.capFrames) {
      // the recording cap (Forever): stop; the editor wraps shorter durations itself
      this.disarm();
      this.autoStopped = true;
    }
  }

  // ------------------------------------------------------------- processing
  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    if (this.sampleId && !this.sL && --this.lookup <= 0) { this.lookup = 50; this.findSample(); }

    // input level and recording (pre-mute, pre-playback)
    let pl = this.pkL, pr = this.pkR;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > pl) pl = al;
      if (ar > pr) pr = ar;
    }
    if (this.armed) this.capture(L, R, n, ctx);
    if (this.mute) { L.fill(0, 0, n); R.fill(0, 0, n); }

    const sL = this.sL, sR = this.sR, len = this.len;
    if (!sL || !sR || len <= 0) { this.pkL = pl; this.pkR = pr; return; }

    // slave playback to host: follow the song position while the host plays
    if (this.sync && !(this.armed && this.recState === 2)) {
      if (ctx.playing) {
        const t = (ctx.pos / Math.max(1, ctx.ppq)) * (60 / Math.max(1, ctx.tempo));
        const base = this.sel && !this.syncNoOwnSel ? this.sel[0] : 0;
        const target = base + t * this.srcRate;
        if (!this.playing || !this.hostDriven) {
          this.start(target, 0, len);
          this.ph = Math.max(0, target);
          this.hostDriven = true;
        } else if (Math.abs(target - this.ph) > 2 * n * this.rate + 2) {
          this.ph = Math.max(0, target); // song jump
        }
      } else if (this.hostDriven && this.playing) {
        this.hostDriven = false;
        this.pause();
      }
    }

    if (this.scrubOn || this.scrubGain > 1e-4) {
      // scrub: the head follows the (smoothed) mouse position; louder when moving
      const k = this.kScrub, kg = this.kScrubGain;
      let pos = this.scrubPos, g = this.scrubGain;
      const target = this.scrubOn ? Math.min(Math.max(0, this.scrubTarget), len - 1) : pos;
      for (let i = 0; i < n; i++) {
        const prev = pos;
        pos += (target - pos) * k;
        const v = pos - prev;
        const speed = v < 0 ? -v : v;
        const gt = this.scrubOn ? Math.min(1, speed * 3) : 0;
        g += (gt - g) * kg;
        const x = Math.floor(pos);
        const t = pos - x;
        const vl = this.read(sL, x, t), vr = sR === sL ? vl : this.read(sR, x, t);
        const ol = vl * g, or = vr * g;
        L[i] += ol;
        R[i] += or;
        const al = ol < 0 ? -ol : ol, ar = or < 0 ? -or : or;
        if (al > pl) pl = al;
        if (ar > pr) pr = ar;
      }
      this.scrubPos = pos;
      this.scrubGain = g;
      if (!this.scrubOn) this.ph = pos;
    }

    if (this.playing) {
      const rate = this.rate;
      const step = 1 / FADE;
      let ph = this.ph, g = this.gain;
      const gt = this.gainTarget;
      for (let i = 0; i < n; i++) {
        if (g !== gt) g = gt > g ? Math.min(gt, g + step) : Math.max(gt, g - step);
        if (this.pauseAtZero && g <= 0) {
          this.playing = false;
          this.pauseAtZero = false;
          if (this.stopPos >= 0) { ph = this.clampPos(this.stopPos); this.stopPos = -1; }
          break;
        }
        if (ph >= 0 && ph < len) {
          const x = Math.floor(ph);
          const t = ph - x;
          const vl = this.read(sL, x, t) * g;
          const vr = (sR === sL ? this.read(sL, x, t) : this.read(sR, x, t)) * g;
          L[i] += vl;
          R[i] += vr;
          const al = vl < 0 ? -vl : vl, ar = vr < 0 ? -vr : vr;
          if (al > pl) pl = al;
          if (ar > pr) pr = ar;
        }
        ph += rate;
        if (ph >= this.b && !this.hostDriven) {
          if (this.loop && this.b > this.a) ph = this.a + ((ph - this.b) % (this.b - this.a));
          else { this.playing = false; g = 0; ph = this.startPos; break; }
        } else if (this.hostDriven && ph >= len) {
          ph = len; // past the end: silent until the host stops or jumps
        }
      }
      this.ph = ph;
      this.gain = g;
    }
    this.pkL = pl;
    this.pkR = pr;
  }

  /** 4-point Hermite read (exact at integer positions). */
  private read(s: Float32Array, x: number, t: number): number {
    const n = s.length;
    if (t === 0) return x >= 0 && x < n ? s[x] : 0;
    const xm1 = x - 1 >= 0 && x - 1 < n ? s[x - 1] : 0;
    const x0 = x >= 0 && x < n ? s[x] : 0;
    const x1 = x + 1 < n ? s[x + 1] : 0;
    const x2 = x + 2 < n ? s[x + 2] : 0;
    return hermite(xm1, x0, x1, x2, t);
  }

  reset(): void {
    this.playing = false;
    this.gain = 0;
    this.gainTarget = 0;
    this.scrubOn = false;
    this.scrubGain = 0;
    this.pkL = this.pkR = 0;
  }

  // --------------------------------------------------------------- monitor
  monitor(): FxMonitor {
    const m: FxMonitor = {
      inst: this.inst,
      pkL: this.pkL,
      pkR: this.pkR,
      pos: this.scrubOn ? this.scrubPos : this.ph,
      play: this.playing && !this.pauseAtZero ? 1 : 0,
      scrub: this.scrubOn ? 1 : 0,
      host: this.hostDriven ? 1 : 0,
      armed: this.armed ? 1 : 0,
      rec: this.recState,
      auto: this.autoStopped ? 1 : 0,
      loaded: this.sL ? 1 : 0,
      len: this.len,
      sr: this.sr,
    };
    this.pkL = this.pkR = 0;
    if (this.openTake) {
      m.take = this.openTake;
      m.recW = this.wAbs - this.openStart;
    }
    // recorded audio: next chunk of the oldest uncollected take
    if (this.ringL && this.ringR) {
      if (this.wAbs - this.rAbs > RING) this.rAbs = this.wAbs - RING; // overrun: frames lost
      while (this.tCount > 0) {
        const h = this.tHead;
        if (this.tEnd[h] >= 0 && this.rAbs >= this.tEnd[h]) {
          this.finished = this.tId[h];
          this.tHead = (h + 1) % TAKES;
          this.tCount--;
          continue;
        }
        break;
      }
      if (this.tCount > 0) {
        const h = this.tHead;
        const start = this.tStart[h];
        const end = this.tEnd[h] >= 0 ? this.tEnd[h] : this.wAbs;
        if (this.rAbs < start) this.rAbs = start;
        const avail = end - this.rAbs;
        if (avail > 0) {
          const cnt = Math.min(avail, CHUNK);
          const oL = new Float32Array(cnt), oR = new Float32Array(cnt);
          let k = this.rAbs % RING;
          const RL = this.ringL, RR = this.ringR;
          for (let i = 0; i < cnt; i++) {
            oL[i] = RL[k];
            oR[i] = RR[k];
            if (++k === RING) k = 0;
          }
          m.ctake = this.tId[h];
          m.off = this.rAbs - start;
          m.recL = oL;
          m.recR = oR;
          this.rAbs += cnt;
          if (this.tEnd[h] >= 0 && this.rAbs >= this.tEnd[h]) {
            this.finished = this.tId[h];
            this.tHead = (h + 1) % TAKES;
            this.tCount--;
          }
        }
      }
    }
    m.fin = this.finished;
    if (this.markN) {
      const a: number[] = [];
      for (let i = 0; i < this.markN; i++) a.push(this.marks[i]);
      m.marks = a;
      m.mtake = this.openTake || this.takeSeq;
      this.markN = 0;
    }
    return m;
  }
}

export const effect: EffectModule = {
  id: 'edison',
  create: (sampleRate, _blockSize, env) => new Edison(sampleRate, env),
};
