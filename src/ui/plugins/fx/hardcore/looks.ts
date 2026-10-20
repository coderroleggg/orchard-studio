// Hardcore pedal faces: colours sampled from FL's manual screenshots, knob
// layout per pedal and the title lettering (system fonts that approximate
// each pedal's style; widths are forced so the layout never depends on the font).

import { HcType } from '../../../../model/fx/plugins/hardcore';

export interface PedalLook {
  face: string;
  knob: string;
  label: string;
  dot: string;
  title: string;
  titleColor: string;
  titleFont: string;
  titleWeight: number;
  titleSize: number;
  /** Forced text width (SVG textLength). */
  titleWidth: number;
  titleStroke?: string;
  /** 4 knobs in a square, 3 knobs (two up, one below) or the Tubedrive layout (LED between). */
  layout: 4 | 3 | 'tube';
  /** Strength of the mottled lacquer texture. */
  mottle: number;
  /** Knob caption size / weight. */
  capSize: number;
  capWeight: number;
}

const SERIF = '"Times New Roman", Times, "Liberation Serif", serif';
const BLACK = '"Arial Black", "Arial Bold", Gadget, "Helvetica Neue", Arial, sans-serif';
const SLAB = '"Cooper Black", "Rockwell Extra Bold", "Rockwell", "Bookman Old Style", Georgia, serif';

export const LOOKS: Record<number, PedalLook> = {
  [HcType.Distortion]: { face: '#36363d', knob: '#ffbe00', label: '#f2a400', dot: '#f2a400', title: 'DISTORTION', titleColor: '#ffc100', titleFont: BLACK, titleWeight: 900, titleSize: 12.5, titleWidth: 95, titleStroke: '#1a1a1e', layout: 4, mottle: 0.3, capSize: 8.8, capWeight: 700 },
  [HcType.Chorus]: { face: '#88bf57', knob: '#fffff4', label: '#16200c', dot: '#f4f4e6', title: 'CHORUS', titleColor: '#000000', titleFont: SLAB, titleWeight: 900, titleSize: 18, titleWidth: 93, layout: 3, mottle: 0.24, capSize: 9.4, capWeight: 400 },
  [HcType.Flanger]: { face: '#0f5a8f', knob: '#ffffff', label: '#ffffff', dot: '#e8eef4', title: 'FLANGER', titleColor: '#ffffff', titleFont: SERIF, titleWeight: 700, titleSize: 17, titleWidth: 92, layout: 3, mottle: 0.21, capSize: 9.4, capWeight: 400 },
  [HcType.Phaser]: { face: '#6ab2d9', knob: '#fffff6', label: '#0e2a3a', dot: '#fff4c8', title: 'PHASER', titleColor: '#060d11', titleFont: BLACK, titleWeight: 900, titleSize: 14, titleWidth: 88, layout: 4, mottle: 0.25, capSize: 8.8, capWeight: 400 },
  [HcType.Reverb]: { face: '#f7841d', knob: '#fefeb2', label: '#3c1c03', dot: '#fff2a6', title: 'REVERB', titleColor: '#3c1c03', titleFont: SLAB, titleWeight: 900, titleSize: 16, titleWidth: 92, layout: 3, mottle: 0.24, capSize: 9.4, capWeight: 400 },
  [HcType.Delay]: { face: '#1b433c', knob: '#a8fcaa', label: '#94fda3', dot: '#94fda3', title: 'DELAY', titleColor: '#94fda3', titleFont: BLACK, titleWeight: 900, titleSize: 16, titleWidth: 88, layout: 3, mottle: 0.28, capSize: 9.4, capWeight: 400 },
  [HcType.NoiseGate]: { face: '#bf9376', knob: '#ffffff', label: '#22140c', dot: '#fff8f0', title: 'NOISE GATE', titleColor: '#1c1c1c', titleFont: '"Arial Narrow", "Helvetica Neue", Arial, sans-serif', titleWeight: 400, titleSize: 14, titleWidth: 94, layout: 3, mottle: 0.21, capSize: 9.4, capWeight: 400 },
  [HcType.Equalizer]: { face: '#d398c1', knob: '#fefec0', label: '#2a1020', dot: '#fff8c4', title: 'EQUALIZER', titleColor: '#000000', titleFont: BLACK, titleWeight: 900, titleSize: 12.5, titleWidth: 96, layout: 4, mottle: 0.21, capSize: 9.4, capWeight: 400 },
  [HcType.Compressor]: { face: '#663218', knob: '#ffbe00', label: '#ffa200', dot: '#ffa200', title: 'COMPRESSOR', titleColor: '#ffc100', titleFont: SERIF, titleWeight: 700, titleSize: 14, titleWidth: 98, titleStroke: '#3a1600', layout: 4, mottle: 0.3, capSize: 8.8, capWeight: 400 },
  [HcType.Modulator]: { face: '#ff9188', knob: '#ffffff', label: '#2c0e0c', dot: '#fff4f2', title: 'MODULATOR', titleColor: '#000000', titleFont: '"Arial", "Helvetica Neue", Helvetica, sans-serif', titleWeight: 700, titleSize: 15, titleWidth: 94, layout: 4, mottle: 0.21, capSize: 9.4, capWeight: 400 },
  [HcType.TubeStage]: { face: '#0c8062', knob: '#99dacc', label: '#071a14', dot: '#b4dcd2', title: 'TUBEDRIVE', titleColor: '#000000', titleFont: SERIF, titleWeight: 400, titleSize: 19, titleWidth: 104, layout: 'tube', mottle: 0.24, capSize: 9.4, capWeight: 400 },
};

/** Knob centres on the 117 x 138 face for each layout (knob order = parameter order). */
export const KNOB_POS: Record<string, [number, number][]> = {
  '4': [[28, 21], [87, 21], [28, 76], [87, 76]],
  '3': [[28, 21], [87, 21], [57.5, 76]],
  tube: [[28, 21], [87, 21], [57.5, 76]],
};

/** LED centre on the face. */
export const LED_POS: Record<string, [number, number]> = { '4': [57.5, 14], '3': [57.5, 14], tube: [57.5, 53] };
