// Sampler channel engine: the Sampler's voice source on FL's shared channel
// note handling (src/engine/InstrumentChannel.ts: polyphony / mono / porta /
// slide notes, echo delay voices, arpeggiator, INS envelopes and LFOs as
// voice levels). Here: sample playback with interpolation, loop points / ping
// pong, start offset, declicking, the INS filter, gain ramps and FL's pan law.

import type { Channel, Id } from '../model/types';
import { type SamplerSettings, type InterpMode, stretchMultiplier, declickTimes } from '../model/sampler';
import { getSincKernel, type SincKernel } from './dsp/sinc';
import { hermite6 } from './dsp/interp';
import { ChannelVoice, CTRL, InstrumentChannel, VOL, type SampleData } from './InstrumentChannel';

export type { SampleData } from './InstrumentChannel';

const SQRT1_2 = Math.SQRT1_2;

/** A Sampler voice: the channel voice plus its sample read position. */
class SamplerVoice extends ChannelVoice {
  pos = 0;
  dir = 1;
  fadeIn = 0; // remaining samples of declick fade-in
  fadeInLen = 0;
  endFrame = Infinity; // trimmed end of playable region
}

export class SamplerChannel extends InstrumentChannel<SamplerVoice> {
  sample: SampleData | null = null;
  private sampleId: Id | null = null;
  private loopStartF = 0;
  private loopEndF = 0;
  private startF = 0;
  private endF = 0;
  private interp: InterpMode = 'sinc24';
  private kernel: SincKernel | null = null;

  constructor(id: Id, sampleRate: number, blockSize: number) {
    super(id, sampleRate, blockSize, () => new SamplerVoice());
  }

  setInterpolation(m: InterpMode): void {
    this.interp = m;
    this.kernel = m.startsWith('sinc') ? getSincKernel(parseInt(m.slice(4), 10)) : null;
  }

  apply(c: Channel, samples: Map<Id, SampleData>): void {
    this.applyChannel(c);
    const s = c.sampler;
    if (this.sampleId !== s.sampleId) {
      this.sampleId = s.sampleId;
      this.allNotesOff(true);
    }
    this.refreshSample(samples);
  }

  refreshSample(samples: Map<Id, SampleData>): void {
    this.sample = this.sampleId ? samples.get(this.sampleId) ?? null : null;
    const s = this.s;
    if (this.sample && s) {
      const f = this.sample.frames;
      this.loopStartF = Math.floor(Math.min(s.loopStart, s.loopEnd) * f);
      this.loopEndF = Math.max(this.loopStartF + 1, Math.floor(Math.max(s.loopStart, s.loopEnd) * f));
      this.startF = Math.floor(Math.max(0, Math.min(0.9999, s.startOffset)) * f);
      this.endF = f;
    }
  }

  protected canPlay(): boolean {
    return !!this.sample;
  }

  protected stopFadeMs(): number {
    const s = this.s;
    return s ? declickTimes(s.declick)[1] : 10;
  }

  protected initVoice(v: SamplerVoice): void {
    const s = this.s!;
    v.dir = 1;
    v.pos = this.startF;
    v.endFrame = this.endF;
    const fi = declickTimes(s.declick)[0];
    v.fadeInLen = this.startF > 0 && fi > 0 ? Math.max(1, Math.round((fi / 1000) * this.sampleRate)) : 0;
    v.fadeIn = v.fadeInLen;
  }

  private readSample(data: Float32Array, pos: number, frames: number, inc: number): number {
    const ip = Math.floor(pos);
    const fr = pos - ip;
    switch (this.interp) {
      case 'linear': {
        const a = at(data, ip, frames), b = at(data, ip + 1, frames);
        return a + (b - a) * fr;
      }
      case 'hermite6':
        return hermite6(at(data, ip - 2, frames), at(data, ip - 1, frames), at(data, ip, frames), at(data, ip + 1, frames), at(data, ip + 2, frames), at(data, ip + 3, frames), fr);
      default:
        if (fr === 0 && inc <= 1) return at(data, ip, frames);
        return this.kernel ? this.kernel.read(data, pos, inc) : at(data, ip, frames);
    }
  }

  protected renderVoice(v: SamplerVoice, s: SamplerSettings, outL: Float32Array, outR: Float32Array, n: number): void {
    const smp = this.sample!;
    let i = 0;
    if (v.delay > 0) {
      const d = Math.min(v.delay, n);
      v.delay -= d;
      i = d;
      if (v.untilRelease !== Infinity) v.untilRelease -= d;
      if (i >= n) return;
    }
    v.started = true;
    const dataL = smp.channels[0];
    const stereo = smp.channels.length > 1;
    const dataR = stereo ? smp.channels[1] : dataL;
    const frames = smp.frames;
    const looping = s.useLoopPoints || s.pingPong;
    const pingPong = s.pingPong;
    const lStart = s.useLoopPoints ? this.loopStartF : 0;
    const lEnd = s.useLoopPoints ? this.loopEndF : frames;
    const g = this.g;
    let stretch = 1;
    if (s.stretchMode === 'resample') {
      const mul = stretchMultiplier(s.stretchMul);
      if (s.stretchTimeBeats > 0) stretch = (frames / smp.sampleRate) / (s.stretchTimeBeats * 60 / g.tempo * mul);
      else stretch = 1 / mul;
    }
    const rateRatio = (smp.sampleRate / this.sampleRate) * stretch;
    const volEnvOn = this.envOn[VOL];
    const base = this.voiceBase(v, s);

    while (i < n) {
      let chunk = Math.min(CTRL, n - i);
      // note-off: only meaningful with the volume envelope or a loop
      if (!v.released && v.untilRelease !== Infinity) {
        if (v.untilRelease <= 0) {
          v.released = true;
          for (let k = 0; k < 5; k++) v.env[k].release();
          if (!volEnvOn && looping) this.forceStop(v, 0);
        } else if (v.untilRelease < chunk) chunk = Math.max(1, Math.floor(v.untilRelease));
      }
      let stopping = false;
      if (v.stopping) {
        if (v.stopAt > 0) { if (v.stopAt < chunk) chunk = v.stopAt; }
        else stopping = true;
      }

      // ---- control rate
      const c = this.controlStep(v, s, base, chunk);
      const inc = rateRatio * Math.pow(2, c.cents / 1200);
      const pL = c.pL, pR = c.pR;
      if (this.filterOn) this.setFilter(v, s, c.mx, c.my);
      const x2 = s.filterType === 'lpx2' || s.filterType === 'svflpx2';

      // ---- audio rate
      const a1 = c.amp;
      const a0 = Number.isNaN(v.gain) ? a1 : v.gain;
      const da = (a1 - a0) / chunk;
      const pl0 = Number.isNaN(v.panL) ? pL : v.panL, pr0 = Number.isNaN(v.panR) ? pR : v.panR;
      const dpl = (pL - pl0) / chunk, dpr = (pR - pr0) / chunk;
      let pos = v.pos;
      let ended = false;
      const end = i + chunk;
      const endF = v.endFrame;
      for (let j = i; j < end; j++) {
        let xl = this.readSample(dataL, pos, frames, inc);
        let xr = stereo ? this.readSample(dataR, pos, frames, inc) : xl;
        if (this.filterOn) {
          xl = v.fL.tick(v.coefs, xl);
          if (x2) xl = v.fL2.tick(v.coefs, xl);
          if (stereo) { xr = v.fR.tick(v.coefs, xr); if (x2) xr = v.fR2.tick(v.coefs, xr); } else xr = xl;
        }
        const k = j - i;
        let gain = a0 + da * k;
        if (v.fadeIn > 0) {
          const t = 1 - v.fadeIn / v.fadeInLen;
          gain *= 0.5 - 0.5 * Math.cos(Math.PI * t);
          v.fadeIn--;
        }
        if (stopping) {
          gain *= 0.5 + 0.5 * Math.cos(Math.PI * (1 - v.stopGain));
          v.stopGain -= v.stopStep;
          if (v.stopGain <= 0) ended = true;
        }
        outL[j] += xl * gain * (pl0 + dpl * k);
        outR[j] += xr * gain * (pr0 + dpr * k);
        if (ended) break;
        pos += inc * v.dir;
        if (looping) {
          if (pingPong) {
            if (v.dir > 0 && pos >= lEnd) { pos = lEnd - (pos - lEnd); v.dir = -1; }
            else if (v.dir < 0 && pos < lStart) { pos = lStart + (lStart - pos); v.dir = 1; }
          } else if (pos >= lEnd) pos -= lEnd - lStart;
        } else if (pos >= endF) { ended = true; break; }
      }
      v.pos = pos;
      v.gain = a1;
      v.panL = pL; v.panR = pR;
      if (v.untilRelease !== Infinity) v.untilRelease -= chunk;
      if (v.stopping && v.stopAt > 0) v.stopAt -= chunk;
      i += chunk;
      if (ended || (volEnvOn && v.env[VOL].done)) { this.endVoice(v); return; }
    }
  }
}

function at(d: Float32Array, i: number, frames: number): number {
  return i >= 0 && i < frames ? d[i] : 0;
}

void SQRT1_2;
