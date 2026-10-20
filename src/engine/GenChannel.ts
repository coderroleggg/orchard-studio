// Instrument plugin channel: an instrument plugin (src/engine/gen) played
// through FL's shared channel note handling (src/engine/InstrumentChannel.ts).
//
// 'voices' instruments (FL's TriggerVoice / Voice_Render): the channel decides
// which voices play (key range, time shift, arpeggiator, echo, gate,
// polyphony / mono / porta / slides, cut groups), triggers a plugin voice at
// each voice's first sample and renders it in control steps of 16 samples.
// Before every step it updates the voice's levels (FL's FinalLevels: pitch
// with glides and the channel pitch, volume, panning, Mod X / Y with MISC
// levels and tracking, echo offsets, and the INS envelopes / LFOs for plugins
// FL shows the INS tab for). It then applies, like the Sampler, the INS filter
// (INS plugins), the volume and FL's pan law (unless the plugin applies its
// levels itself, def.levels 'plugin') and the declick fade of forced stops.
//
// 'events' instruments (FL's Gen_Render plugins with their own voices): the
// same note handling, but each voice becomes a note on / note off event with
// its levels (updated once per block) and the plugin renders all of them.

import type { Channel, Id } from '../model/types';
import type { SamplerSettings } from '../model/sampler';
import { genDef } from '../model/gen/registry';
import type { GenPluginDef } from '../model/gen/types';
import { ChannelVoice, CTRL, InstrumentChannel, VOL, type SampleData } from './InstrumentChannel';
import { createGen } from './gen';
import type { GenContext, GenEnv, GenInstance, GenNote, GenVoice } from './gen/types';
import type { FxMonitor } from './effects/types';
import { newLevels, setFinalLevels, setInitLevels, type GenLevels } from './gen/levels';

/** The parameters of a note handed to the plugin (reused per voice slot). */
class NoteParams implements GenNote {
  id = 0;
  key = 60;
  velocity = 100;
  release = 64;
  color = 0;
  length = Infinity;
  frame = 0;
  readonly init: GenLevels = newLevels();
  readonly levels: GenLevels = newLevels();
}

class GenChannelVoice extends ChannelVoice {
  readonly params = new NoteParams();
  /** The plugin's voice ('voices' instruments) once started. */
  gv: GenVoice | null = null;
  /** 'events' instruments: note on sent / note off sent. */
  on = false;
  off = false;
}

/**
 * Fade-out of a forced stop (polyphony limit, mono hand-over to a voice
 * without release, panic) in ms, the Sampler's default declick.
 * TODO(test host): measure how FL stops plugin voices over the polyphony limit.
 */
const STOP_FADE_MS = 10;

export class GenChannel extends InstrumentChannel<GenChannelVoice> {
  /** The instrument plugin id (FL generator). */
  readonly plugin: string;
  readonly def: GenPluginDef | undefined;
  /** The plugin instance (null: plugin unknown to this version, the channel stays silent). */
  readonly inst: GenInstance | null;
  /** MIDI input port (-1 = none): notes MIDI Out channels send on it play the instrument. */
  midiPort = -1;
  private readonly events: boolean;
  private readonly channelLevels: boolean;
  private readonly ctx: GenContext;
  private readonly vL: Float32Array;
  private readonly vR: Float32Array;
  private noteIds = 0;
  /** Frames left of the plugin's tail after its last voice. */
  private tailLeft = 0;
  /** The max polyphony last sent to the plugin (FL's FPE_MaxPoly; -1 = not sent yet). */
  private maxPolySent = -1;

  constructor(id: Id, sampleRate: number, blockSize: number, plugin: string, env: GenEnv, ctx: GenContext) {
    super(id, sampleRate, blockSize, () => new GenChannelVoice());
    this.plugin = plugin;
    this.def = genDef(plugin);
    this.inst = createGen(plugin, sampleRate, blockSize, env);
    this.events = this.def?.notes === 'events';
    // the INS tab acts on voices the channel renders; 'events' plugins render their own
    this.insOn = !!this.def?.ins && !this.events;
    this.channelLevels = this.def?.levels !== 'plugin';
    this.ctx = ctx;
    this.vL = new Float32Array(CTRL);
    this.vR = new Float32Array(CTRL);
  }

  apply(c: Channel, samples?: Map<Id, SampleData>): void {
    void samples;
    this.applyChannel(c);
    const port = c.plugin?.midiPort;
    this.midiPort = typeof port === 'number' && port >= 0 ? Math.min(255, Math.round(port)) : -1;
    if (this.inst && c.plugin) this.inst.setParams(c.plugin.params);
    // FL sends the channel's max polyphony to the plugin when it is loaded and on every change (FPE_MaxPoly)
    const poly = Math.max(0, Math.round(c.sampler.polyMax || 0));
    if (this.inst?.setMaxPoly && poly !== this.maxPolySent) {
      this.maxPolySent = poly;
      this.inst.setMaxPoly(poly);
    }
  }

  protected canPlay(): boolean {
    return !!this.inst;
  }

  /** Plugin voices take every note off, mono hand-over and cut as a release (FL: Voice_Release). */
  protected releasable(): boolean {
    return true;
  }

  protected stopFadeMs(): number {
    return STOP_FADE_MS;
  }

  private tailFrames(): number {
    const t = this.inst?.tail ?? 0;
    return t === Infinity ? Infinity : Math.round(Math.max(0, t) * this.sampleRate);
  }

  isActive(): boolean {
    if (super.isActive()) return true;
    const inst = this.inst;
    if (!inst) return false;
    if (inst.tail === Infinity || this.tailLeft > 0) return true;
    return !!inst.isActive?.();
  }

  protected initVoice(v: GenChannelVoice): void {
    const s = this.s!;
    const p = v.params;
    p.id = ++this.noteIds;
    p.key = s.addToKey ? Math.max(0, Math.min(131, v.key + 60 - s.rootKey)) : v.key;
    p.velocity = v.vel;
    p.release = v.rel;
    p.color = v.color;
    p.length = v.length;
    setInitLevels(p.init, v.glideTarget, v.vel, v.notePan, v.noteModX, v.noteModY);
    p.levels.pitch = p.init.pitch; p.levels.vol = p.init.vol; p.levels.pan = p.init.pan; p.levels.fcut = p.init.fcut; p.levels.fres = p.init.fres;
    v.gv = null;
    v.on = false;
    v.off = false;
    const t = this.tailFrames();
    if (t > this.tailLeft) this.tailLeft = t;
  }

  protected endVoice(v: GenChannelVoice): void {
    if (v.gv) { v.gv.kill(); v.gv = null; }
    if (this.events && v.on && !v.off) { v.off = true; this.inst?.killNote ? this.inst.killNote(v.params) : this.inst?.noteOff?.(v.params, 0); }
    v.active = false;
  }

  /** The voice's FinalLevels for the control step just computed (this.cl). */
  private updateLevels(v: GenChannelVoice, s: SamplerSettings): void {
    const c = this.cl;
    // a plugin that handles velocity itself gets only the channel's part of the volume (FL)
    let vol = c.amp;
    if (this.def?.velocity === 'plugin') { const vg = v.velGain; vol = vg > 1e-9 ? c.amp / vg : 0; }
    // Mod X / Y levels are offsets: the INS filter's own cutoff / resonance knobs are not part of them
    setFinalLevels(v.params.levels, c.cents, vol, c.pan, c.mx - s.modX, c.my - s.modY);
  }

  protected renderVoice(v: GenChannelVoice, s: SamplerSettings, outL: Float32Array, outR: Float32Array, n: number): void {
    if (this.events) { this.runNote(v, s, n); return; }
    const inst = this.inst!;
    let i = 0;
    if (v.delay > 0) {
      const d = Math.min(v.delay, n);
      v.delay -= d;
      i = d;
      if (v.untilRelease !== Infinity) v.untilRelease -= d;
      if (i >= n) return;
    }
    const base = this.voiceBase(v, s);
    const volEnvOn = this.envOn[VOL];
    // with the INS volume envelope on (INS plugins), its release is the voice's release:
    // the plugin voice keeps sounding until the envelope ends
    const pluginRelease = !volEnvOn;
    const vl = this.vL, vr = this.vR;
    while (i < n) {
      let chunk = Math.min(CTRL, n - i);
      v.params.frame = i;
      // note off: the INS envelopes release, and the plugin voice (FL's Voice_Release)
      if (!v.released && v.untilRelease !== Infinity) {
        if (v.untilRelease <= 0) {
          v.released = true;
          for (let k = 0; k < 5; k++) v.env[k].release();
          if (pluginRelease) v.gv?.release();
        } else if (v.untilRelease < chunk) chunk = Math.max(1, Math.floor(v.untilRelease));
      }
      let stopping = false;
      if (v.stopping) {
        if (v.stopAt > 0) { if (v.stopAt < chunk) chunk = v.stopAt; }
        else stopping = true;
      }

      // ---- control rate: levels, then the plugin voice (triggered at its first sample)
      const c = this.controlStep(v, s, base, chunk);
      this.updateLevels(v, s);
      if (!v.started) {
        v.started = true;
        v.gv = inst.triggerVoice?.(v.params) ?? null;
        if (v.gv && v.released && pluginRelease) v.gv.release();
      }
      const gv = v.gv;
      if (!gv) { this.endVoice(v); return; }
      vl.fill(0, 0, chunk);
      vr.fill(0, 0, chunk);
      const alive = gv.render(vl, vr, chunk);
      if (this.filterOn) this.setFilter(v, s, c.mx, c.my);
      const x2 = s.filterType === 'lpx2' || s.filterType === 'svflpx2';

      // ---- audio rate: INS filter, volume and pan law (ramped per step), declick of forced stops
      const lv = this.channelLevels;
      const pL = lv ? c.pL : 1, pR = lv ? c.pR : 1;
      const a1 = lv ? c.amp : 1;
      const a0 = Number.isNaN(v.gain) ? a1 : v.gain;
      const da = (a1 - a0) / chunk;
      const pl0 = Number.isNaN(v.panL) ? pL : v.panL, pr0 = Number.isNaN(v.panR) ? pR : v.panR;
      const dpl = (pL - pl0) / chunk, dpr = (pR - pr0) / chunk;
      let ended = false;
      for (let k = 0; k < chunk; k++) {
        let xl = vl[k], xr = vr[k];
        if (this.filterOn) {
          xl = v.fL.tick(v.coefs, xl);
          xr = v.fR.tick(v.coefs, xr);
          if (x2) { xl = v.fL2.tick(v.coefs, xl); xr = v.fR2.tick(v.coefs, xr); }
        }
        let gain = a0 + da * k;
        if (stopping) {
          gain *= 0.5 + 0.5 * Math.cos(Math.PI * (1 - v.stopGain));
          v.stopGain -= v.stopStep;
          if (v.stopGain <= 0) ended = true;
        }
        const j = i + k;
        outL[j] += xl * gain * (pl0 + dpl * k);
        outR[j] += xr * gain * (pr0 + dpr * k);
        if (ended) break;
      }
      v.gain = a1;
      v.panL = pL; v.panR = pR;
      if (v.untilRelease !== Infinity) v.untilRelease -= chunk;
      if (v.stopping && v.stopAt > 0) v.stopAt -= chunk;
      i += chunk;
      if (ended || !alive || (volEnvOn && v.env[VOL].done)) { this.endVoice(v); return; }
    }
  }

  /**
   * 'events' instruments: the voice's note on, levels (once per block), note
   * off and forced stop become events for the plugin, at their sample.
   */
  private runNote(v: GenChannelVoice, s: SamplerSettings, n: number): void {
    const inst = this.inst!;
    let i = 0;
    if (v.delay > 0) {
      const d = Math.min(v.delay, n);
      v.delay -= d;
      i = d;
      if (v.untilRelease !== Infinity) v.untilRelease -= d;
      if (i >= n) return;
    }
    const left = n - i;
    v.params.frame = i;
    this.controlStep(v, s, this.voiceBase(v, s), left);
    this.updateLevels(v, s);
    if (!v.started) {
      v.started = true;
      v.on = true;
      inst.noteOn?.(v.params, i);
    }
    // forced stop (polyphony limit, panic): the note is killed at its sample
    if (v.stopping) {
      if (v.stopAt < left) {
        v.off = true;
        if (inst.killNote) inst.killNote(v.params); else inst.noteOff?.(v.params, i + Math.max(0, v.stopAt));
        v.active = false;
        return;
      }
      v.stopAt -= left;
    }
    if (!v.released && v.untilRelease !== Infinity) {
      if (v.untilRelease < left) {
        v.released = true;
        v.off = true;
        inst.noteOff?.(v.params, i + Math.max(0, Math.floor(v.untilRelease)));
        // the plugin plays the release; the channel's voice slot is free
        v.active = false;
        return;
      }
      v.untilRelease -= left;
    }
  }

  protected afterVoices(bl: Float32Array, br: Float32Array, n: number): void {
    const inst = this.inst;
    if (!inst) return;
    if (inst.render) {
      this.ctx.track = this.mixerTrack;
      inst.render(bl, br, n, this.ctx);
    }
    if (this.voiceCount() > 0) this.tailLeft = Math.max(this.tailLeft, this.tailFrames());
    else if (this.tailLeft > 0 && this.tailLeft !== Infinity) this.tailLeft = Math.max(0, this.tailLeft - n);
  }

  /** The project's resampling quality, forwarded to plugins that resample samples themselves. */
  override setInterpolation(m: import('../model/sampler').InterpMode): void {
    this.inst?.setInterpolation?.(m);
  }

  /** Panic: the channel stops its voices at once and the plugin forgets its notes. */
  panic(): void {
    this.allNotesOff(true);
    this.inst?.allNotesOff?.();
  }

  /** The plugin's editor display data (plus `__active`: false once the channel no longer renders). */
  monitor(): FxMonitor | null {
    const d = this.inst?.monitor?.() ?? null;
    if (d) d.__active = this.isActive();
    return d;
  }

  /** Controller outputs (Link to controller). */
  controls(): ArrayLike<number> | undefined {
    return this.inst?.controls?.();
  }

  takeStateChanges(): [string, unknown][] | null {
    return this.inst?.takeStateChanges?.() ?? null;
  }
}
