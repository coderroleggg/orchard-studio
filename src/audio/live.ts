// High-frequency playback state (position, meters) kept outside React state.
// Canvas views read it every animation frame; small components can subscribe.

import { useSyncExternalStore } from 'react';
import type { Id } from '../model/types';

export interface LiveState {
  playing: boolean;
  tick: number; // estimated audible position (ticks)
  songMode: boolean;
  patternId: Id;
  mixerPeaks: Float32Array; // display level with meter ballistics (linear)
  mixerHold: Float32Array; // peak-hold marker (linear)
  mixerHoldAge: Float32Array; // seconds since the hold value was set
  channelPeaks: Map<Id, number>;
  voices: number;
  cpu: number;
  /** Raw anchor from the engine for interpolation. */
  anchorTick: number;
  anchorTime: number; // performance.now() when anchor was received
  ticksPerSecond: number;
  latencySec: number;
  version: number;
}

export const live: LiveState = {
  playing: false,
  tick: 0,
  songMode: false,
  patternId: '',
  mixerPeaks: new Float32Array(127 * 2),
  mixerHold: new Float32Array(127 * 2),
  mixerHoldAge: new Float32Array(127 * 2),
  channelPeaks: new Map(),
  voices: 0,
  cpu: 0,
  anchorTick: 0,
  anchorTime: 0,
  ticksPerSecond: 0,
  latencySec: 0,
  version: 0,
};

const listeners = new Set<() => void>();
export function subscribeLive(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emitLive(): void {
  live.version++;
  listeners.forEach((l) => l());
}

/** Subscribe a component to coarse live values (re-renders at status rate). */
export function useLive<T>(sel: (l: LiveState) => T): T {
  return useSyncExternalStore(subscribeLive, () => sel(live));
}

/** Current interpolated playhead position in ticks. */
export function currentTick(): number {
  if (!live.playing) return live.anchorTick;
  const dt = (performance.now() - live.anchorTime) / 1000 - live.latencySec;
  return live.anchorTick + Math.max(-0.5, dt) * live.ticksPerSecond;
}
