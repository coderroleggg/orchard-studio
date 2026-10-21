// Autogun's Soundgoodizer: the Maximus state FL loads into its hosted SGv2 (Data/SG.dat, a version 7 state: 59 parameters,
// two banks of four band curves). Parameter-level data in the form of Harmor's compression states (harmor/fx-comp.ts): the
// parameters of bank A and its band curves (LOW, MID, HIGH, MASTER) as SGv2 holds them after loading: points [dx, y, shape,
// flag (1 curved, 2 straight), c0, c1, c2]. Parameter 5 (the mix of the three bands, 'magic dust') is replaced by the plugin's
// magic dust value; parameter 6 = 32768 switches the low cut on (20 Hz).

import type { SgPoint, SgPreset } from '../harmor/fx-comp-sg';

const PARAMS = [19800, 1, 48065, 1, 891, 1000, 32768, 0, 1264, 1296, 1000, -1000, 1284, 1115, 0, 2, 5736, 3, 2882, 0, 0, 1340, 1000, -384, 0, 1000, 1115, 0, 2, 5000, 3, 1570, 0, 0, 1364, 1152, 0, -1000, 1000, 1115, 0, 2, 5000, 3, 1186, 0, 0, 1000, 1000, 0, 0, 1000, 1115, 4464, 2, 5000, 3, 1538, 0];

/** Band curve points [dx, y, shape, flag, c0, c1, c2]. */
const CURVES: number[][][] = [
  [[0, 0, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 1, 1.6302682161331177, 0.6133959889411926, 0.9670857787132263], [0.5, 0.5, 0, 2, 0, 0, 0]],
  [[0, 0, 0, 0, 0, 0, 0], [0.3999999940395357, 0.4000000059604645, 0, 2, 0, 0, 0], [0.6000000059604643, 0.6000000238418579, 0, 1, 12.803838729858398, 0.07810157537460327, 2.6249468326568604]],
  [[0, 0, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 1, 5.918312072753906, 0.1689670979976654, 1.9341717958450317], [0.5, 0.5, 0, 2, 0, 0, 0]],
  [[0, 0, 0, 0, 0, 0, 0], [0.4000000059604645, 0.4000000059604645, 0, 2, 0, 0, 0], [0.5999999940395355, 0.5, 0, 1, 189.54762268066406, 0.005275717005133629, 5.249902725219727]],
];

export const AUTOGUN_SG: SgPreset = {
  params: PARAMS,
  oversample: 0,
  curves: CURVES.map((pts) => pts.map(([dx, y, mode, flag, c0, c1, c2]): SgPoint => ({ dx, y, mode, flag, c0, c1, c2 }))),
};
