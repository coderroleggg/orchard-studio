// Fruity Granulizer's transient detection (TRANSIENTS: DETECT): FL's BeatSlicer detector, the one
// Fruity Slicer's auto-slicing uses (src/model/gen/plugins/slicer/slicing.ts), with the Granulizer's
// own sensitivity: both bands' threshold factors are set to 2.0 (Fruity Granulizer_x64.dylib
// 0x9e110, fields +0x5c / +0x60), which is the factor of the Slicer's wheel at 100 log2(3). The
// detector's start frames in order are the sample's transients, sorted as FL's region list
// (0x73510).

import { autoSlice, thresholdFactor } from '../slicer/slicing';

/** The Slicer wheel value whose threshold factor is exactly FL's 2.0 (float32). */
export const DETECT_WHEEL = 158.49625;

/** Transient start frames of a sample, ascending. */
export function detectTransients(channels: readonly Float32Array[], sampleRate: number): number[] {
  return autoSlice(channels, sampleRate, DETECT_WHEEL, DETECT_WHEEL).sort((a, b) => a - b);
}

export { thresholdFactor };
