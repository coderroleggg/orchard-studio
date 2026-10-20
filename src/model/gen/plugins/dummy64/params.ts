// Parameters of FL 2026's 64-bit dummies (Wasp, Wasp XT, FL Slayer; docs/research/gen/wasp.md).
// flfxhost info reads every parameter with no name and no value text, on the range
// 0..1073741824 with default 0, and reads back 0 whatever was set. That range is the host's
// identity translation of the normalized range (the dummies define none): the dummies have
// no controls and ignore their parameters. The definitions keep FL's count and that range.

import type { FxParamDef } from '../../../fx/types';

/** The range flfxhost info reports for the dummies' parameters (identity translation, none defined). */
export const DUMMY64_MAX = 1073741824;

/** FL's parameters of a 64-bit dummy: `count` unnamed parameters, default 0, empty value texts. */
export function dummy64Params(count: number): FxParamDef[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `p${i}`, name: '', index: i, min: 0, max: DUMMY64_MAX, def: 0, format: () => '',
  }));
}
