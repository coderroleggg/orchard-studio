// Mute 2 (FL: Fruity Mute 2, legacy): an automatable mute for the left, the
// right or both channels. Form: 335 x 55; MuteWheel (Tag 0) and ChannelWheel
// (Tag 1), both 0..1024 with default 512. Mute reads "On" (sound on) from
// 512 up and "Off" (muted) below; Channel picks L / L + R / R in thirds.
// Not listed in FL's plugin database.

import type { FxPluginDef } from '../types';

export const MUTE2_CHANNELS = ['L', 'L + R', 'R'];

function norm(v: number, d: number): number {
  return Math.fround(Math.min(1, Math.max(0, (Number.isFinite(v) ? v : d) / 1024)));
}

/** FL: muted = float32(v / 1024) < 0.5 (the label then reads "Off"). */
export function mute2Muted(v: number): boolean {
  return norm(v, 512) < 0.5;
}

/** FL: trunc(float32(x / float32(1/3))) capped at 2: 0..341 L, 342..682 L + R, 683..1024 R. */
export function mute2Channel(v: number): number {
  return Math.min(2, Math.trunc(Math.fround(norm(v, 512) / Math.fround(1 / 3))));
}

export const def: FxPluginDef = {
  id: 'mute2',
  name: 'Mute 2',
  category: 'Gain',
  width: 335,
  height: 55,
  hidden: true,
  description: 'Mutes the left, the right or both channels (automatable)',
  params: [
    { key: 'mute', name: 'Mute', index: 0, min: 0, max: 1024, def: 512, format: (v) => (mute2Muted(v) ? 'Off' : 'On') },
    { key: 'channel', name: 'Channel', index: 1, min: 0, max: 1024, def: 512, format: (v) => MUTE2_CHANNELS[mute2Channel(v)] },
  ],
};
