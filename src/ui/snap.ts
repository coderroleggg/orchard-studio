// Snap settings shared by the piano roll and playlist.

import type { SnapId } from '../store/ui';
import type { TimeBase } from '../model/timing';
import { store } from '../store';

export const SNAP_OPTIONS: SnapId[] = [
  'main', 'line', 'cell', 'none',
  '1/6step', '1/4step', '1/3step', '1/2step', 'step',
  '1/6beat', '1/4beat', '1/3beat', '1/2beat', 'beat', 'bar',
];

const LABELS: Record<SnapId, string> = {
  main: 'Main', line: 'Line', cell: 'Cell', none: '(none)',
  '1/6step': '1/6 step', '1/4step': '1/4 step', '1/3step': '1/3 step', '1/2step': '1/2 step', step: 'Step',
  '1/6beat': '1/6 beat', '1/4beat': '1/4 beat', '1/3beat': '1/3 beat', '1/2beat': '1/2 beat', beat: 'Beat', bar: 'Bar',
};

export function snapLabel(s: SnapId): string {
  return LABELS[s];
}

/**
 * Snap size in ticks. `gridTicks` is the finest visible grid spacing (used by
 * 'line' and 'cell').
 */
export function snapTicks(s: SnapId, t: TimeBase, gridTicks: number): number {
  const tps = t.ppq / t.stepsPerBeat;
  switch (s) {
    case 'main': return snapTicks(store.ui.mainSnap === 'main' ? 'line' : store.ui.mainSnap, t, gridTicks);
    case 'line': case 'cell': return gridTicks;
    case 'none': return 1;
    case '1/6step': return tps / 6;
    case '1/4step': return tps / 4;
    case '1/3step': return tps / 3;
    case '1/2step': return tps / 2;
    case 'step': return tps;
    case '1/6beat': return t.ppq / 6;
    case '1/4beat': return t.ppq / 4;
    case '1/3beat': return t.ppq / 3;
    case '1/2beat': return t.ppq / 2;
    case 'beat': return t.ppq;
    case 'bar': return t.ppq * t.beatsPerBar;
  }
}

/** Effective snap for a selector: resolves 'main' to the global snap. */
export function resolveSnap(s: SnapId): SnapId {
  return s === 'main' ? (store.ui.mainSnap === 'main' ? 'line' : store.ui.mainSnap) : s;
}

/** Snap a position: 'cell' and fixed values floor when placing, 'line' rounds to the nearest line. */
export function snapPlace(tick: number, s: SnapId, size: number): number {
  return resolveSnap(s) === 'line' ? snapPos(tick, size, 'round') : snapPos(tick, size, 'floor');
}

/** Floor to a grid cell or round to the nearest line. */
export function snapPos(tick: number, size: number, mode: 'floor' | 'round' = 'floor'): number {
  if (size <= 1) return Math.round(tick);
  return mode === 'floor' ? Math.floor(tick / size) * size : Math.round(tick / size) * size;
}
