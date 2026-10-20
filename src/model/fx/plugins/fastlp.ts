// Fast LP (FL: Fruity Fast LP, legacy): a CPU-light resonant low pass. Form:
// 335 x 55, two 0..1024 wheels (Cutoff Tag 0, Resonance Tag 1). FL returns no
// value texts, so its hint shows percentages. Measured on FL's binary (see
// docs/research/fx/fastlp.md): one pole with momentum,
//   v = r v + f (x - y); y += v   (y = f x + (1 + r - f) y1 - r y2)
// with f and r independent of the sample rate.

import type { FxPluginDef } from '../types';
import { pct1024 } from './filter';

/** Cutoff coefficient: 0.000175244 + (1 - 0.000175244) (543.819^t - 1) / 542.819 (t = cutoff / 1024; 1 = no filtering). */
export function fastLpF(cut: number): number {
  const t = Math.min(1024, Math.max(0, cut)) / 1024;
  const lo = 0.000175244, B = 543.81926;
  return lo + ((1 - lo) * (Math.pow(B, t) - 1)) / (B - 1);
}

/** Resonance (momentum) coefficient: 0.98330438 (1 - 0.0183317^t) / (1 - 0.0183317). */
export function fastLpR(res: number): number {
  const t = Math.min(1024, Math.max(0, res)) / 1024;
  const B = 0.018331722;
  return (0.98330438 * (1 - Math.pow(B, t))) / (1 - B);
}

export const def: FxPluginDef = {
  id: 'fastlp',
  name: 'Fast LP',
  category: 'Filter',
  width: 335,
  height: 55,
  hidden: true,
  description: 'CPU-light resonant low pass filter (legacy)',
  params: [
    { key: 'cutoff', name: 'Cutoff', index: 0, min: 0, max: 1024, def: 1024, format: pct1024 },
    { key: 'res', name: 'Resonance', index: 1, min: 0, max: 1024, def: 0, format: pct1024 },
  ],
};
