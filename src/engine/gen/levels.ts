// FL's per-voice levels for instrument plugins (TLevelParams in FL's SDK:
// pan, vol, pitch in cents, filter cutoff / resonance = the note's Mod X / Mod Y)
// and the scaling between the channel's values and them, as the FL test host
// measured them (scratchpad fx/host README, "Generators"): FL's InitLevels.Vol is
// the velocity law (11^(vel/100) - 1) / 10, InitLevels.Pitch is 100 x key,
// FinalLevels add the channel (volume gain, e.g. 0.5510106 for the default 78 %
// knob; pitch -100 x root key, so the final pitch is 0 at the root key; panning)
// and FL's instruments play final pitch 0 at 523.25 Hz (3x Osc, key 60).
//
// A voice has two level sets (FL's TVoiceParams):
// - init (InitLevels): the note as triggered: velocity, note panning, pitch
//   (key, fine pitch, the channel's root key and fine tune, echo pitch), Mod X / Y;
// - levels (FinalLevels): what the voice should sound like now: init plus the
//   channel (volume, panning, pitch knob x range, main pitch, MISC levels
//   adjustment and velocity / key tracking, echo offsets), porta / slide glides
//   and, for plugins FL shows the INS tab for, the INS envelopes and LFOs. The
//   channel updates them every control step (16 samples, the Sampler's rate)
//   before the voice renders.

import { velocityGain } from '../../model/sampler';

export interface GenLevels {
  /** Panning -1 (left) .. 1 (right). */
  pan: number;
  /** Volume / velocity: 1 = unity (0 dB), can go above 1. */
  vol: number;
  /** Pitch in cents: PITCH_C5 (6000) is key 60 (C5) at the default root key; 100 per semitone. */
  pitch: number;
  /** Filter cutoff level = Mod X: -1..1 offset (0 = the note's default), can go outside. */
  fcut: number;
  /** Filter resonance level = Mod Y: -1..1 offset (0 = default), can go outside. */
  fres: number;
}

export function newLevels(): GenLevels {
  return { pan: 0, vol: 1, pitch: PITCH_C5, fcut: 0, fres: 0 };
}

/**
 * Cents of key 60 (C5) played at the default root key (C5): FL's
 * InitLevels.Pitch is 100 x key. FL's FinalLevels.Pitch is relative to the
 * root key (0 there); `levels.pitch - PITCH_C5` is that value (flFinalPitch).
 */
export const PITCH_C5 = 6000;

/** Frequency FL's instruments play at final pitch 0 (key 60 at the default root key, C5). */
export const FL_C5_HZ = 523.2511306011972;

/** FL's FinalLevels.Pitch (cents relative to the root key) of our levels. */
export function flFinalPitch(l: GenLevels): number {
  return l.pitch - PITCH_C5;
}

/**
 * Note velocity (FL 0..128) -> InitLevels.Vol: FL's velocity law
 * (11^(vel/100) - 1) / 10, 1 at velocity 100, +6.25 dB at 128 (measured).
 */
export function noteVolume(vel: number): number {
  return velocityGain(vel);
}

/**
 * FL's InitLevels of a note. `relCents` is the note's pitch relative to the
 * channel's root key as the Sampler computes it (100 x (key - root) + fine
 * pitch + MISC fine tune + echo pitch); note pan / Mod X / Mod Y are -1..1.
 */
export function setInitLevels(out: GenLevels, relCents: number, vel: number, notePan: number, noteModX: number, noteModY: number): void {
  out.pitch = PITCH_C5 + relCents;
  out.vol = noteVolume(vel);
  out.pan = notePan;
  out.fcut = noteModX;
  out.fres = noteModY;
}

/**
 * FL's FinalLevels from the channel's control values for one control step:
 * `relCents` = the voice's pitch relative to the root key with glides, the
 * channel pitch knob, main pitch and (INS) pitch envelope / LFO; `vol` =
 * velocity gain x channel volume x MISC volume x echo gain (x INS volume
 * envelope / LFO); `pan` = the clamped panning; `modX` / `modY` = the Mod X / Y
 * offsets (note, MISC levels and tracking, echo, INS envelopes / LFOs) without
 * the INS filter's own cutoff / resonance knobs. Measured: Final.Vol = Init.Vol
 * x channel volume gain (only the channel's part for plugins that handle
 * velocity themselves, GenPluginDef.velocity 'plugin'), Final.Pitch = Init +
 * channel pitch (+ fine pitch, slides), panning by FL's circular law.
 */
export function setFinalLevels(out: GenLevels, relCents: number, vol: number, pan: number, modX: number, modY: number): void {
  out.pitch = PITCH_C5 + relCents;
  out.vol = vol;
  out.pan = pan;
  out.fcut = modX;
  out.fres = modY;
}

/**
 * FL's ComputeLRVol: left / right gains for a pan (-1..1) and volume, FL's
 * circular law (0.7071 each side at the centre; measured).
 */
export function computeLRVol(pan: number, vol: number, out: { l: number; r: number }): void {
  const p = pan < -1 ? -1 : pan > 1 ? 1 : pan;
  const th = ((p + 1) * Math.PI) / 4;
  out.l = Math.cos(th) * vol;
  out.r = Math.sin(th) * vol;
}

/**
 * Frequency in Hz FL's instruments play for a pitch in our cents (PITCH_C5 =
 * final pitch 0 = 523.25 Hz, measured on 3x Osc at key 60).
 */
export function pitchToHz(cents: number): number {
  return FL_C5_HZ * Math.pow(2, (cents - PITCH_C5) / 1200);
}
