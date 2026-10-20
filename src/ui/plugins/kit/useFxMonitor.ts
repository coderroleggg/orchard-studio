// Subscribe an editor display to its effect's monitor data (meters, envelopes, spectra).

import { useEffect, useRef } from 'react';
import { host } from '../../../store';
import type { FxMonitor } from '../../../engine/effects/types';

/** Calls `fn` with the effect's display data (~30x/s) while the component is mounted. */
export function useFxMonitor(slotId: string, fn: (data: FxMonitor) => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => host.watchFx(slotId, (d) => ref.current(d)), [slotId]);
}
