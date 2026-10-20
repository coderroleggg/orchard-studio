// 7 Band EQ (FL: Fruity 7 Band EQ, legacy): seven level sliders (-18..+18 dB,
// Tags 0-6, value -1800..1800 = dB x 100, FL text "0.0dB"). Form: 340 x 150.
// Bands (measured on FL's binary, see docs/research/fx/eq7.md): 63 Hz first
// order low shelf, 250 / 500 / 1500 Hz peaking (2 octaves), 3000 / 5000 Hz
// peaking (1 octave), 8000 Hz first order high shelf; designed for 44.1 kHz
// at every sample rate.

import type { FxParamDef, FxPluginDef } from '../types';

export const EQ7_FREQS = [63, 250, 500, 1500, 3000, 5000, 8000];
export const EQ7_BW = [0, 2, 2, 2, 1, 1, 0];

const dbText = (v: number) => `${(Math.round(v) / 100).toFixed(1)}dB`;

const params: FxParamDef[] = EQ7_FREQS.map((_, i) => ({
  key: `band${i + 1}`, name: `Band ${i + 1} level`, index: i, min: -1800, max: 1800, def: 0, format: dbText, bipolar: true,
}));

const P = (b: number[]) => Object.fromEntries(b.map((v, i) => [`band${i + 1}`, v]));

export const def: FxPluginDef = {
  id: 'eq7',
  name: '7 Band EQ',
  category: 'Filter',
  width: 340,
  height: 150,
  hidden: true,
  description: 'Seven band graphic equalizer (legacy)',
  params,
  // FL's factory presets (values read from the .fst states with the test host)
  presets: [
    { name: 'Default', params: P([0, 0, 0, 0, 0, 0, 0]) },
    { name: 'Cut High', params: P([675, 675, 506, -56, -731, -900, -900]) },
    { name: 'Cut Low', params: P([-1350, -1350, -1238, 112, 225, 337, 450]) },
    { name: 'Cut Middle', params: P([675, 675, 0, -562, 0, 675, 675]) },
    { name: 'Flat', params: P([0, 0, 0, 0, 0, 0, 0]) },
    { name: 'Live performance', params: P([-394, 619, 506, 506, 562, 281, 225]) },
    { name: 'Old Radio', params: P([-1800, -788, 619, 450, 787, -1800, -1800]) },
    { name: 'Style - Ambiance', params: P([169, 169, 169, 112, -562, -562, -562]) },
    { name: 'Style - Club', params: P([169, 225, 337, 337, 225, 169, 56]) },
    { name: 'Style - Dance', params: P([506, 506, 281, 56, 56, 506, 281]) },
    { name: 'Style - Hip-hop', params: P([225, 225, -506, 506, 56, 112, 0]) },
    { name: 'Style - Rock', params: P([169, 169, -169, -338, -112, -112, 0]) },
    { name: 'Style - Techno', params: P([450, 450, -225, -225, 450, 506, 169]) },
    { name: 'Telephone', params: P([-1800, -1800, -56, 1800, 1181, -900, -1800]) },
  ],
};
