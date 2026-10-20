// Proportional layout of the Parametric EQ 2 editor. Designed at 700 x 350 px
// (docs/research/peq2.md 5.1): graph 73 % x 82 %, band panel 27 % of the
// width, bottom bar 18 % of the height. Everything scales with the window.

export const BASE_W = 700;
export const BASE_H = 350;

export interface Layout {
  W: number;
  H: number;
  /** Uniform scale for sizes and fonts (1 at 700 x 350). */
  s: number;
  graphW: number;
  topH: number;
  panelW: number;
  bottomH: number;
  /** Panel columns: column 0 = main level / captions, 1..7 = bands. */
  colW: number;
  colX0: number;
  tileY: number;
  tileW: number;
  tileH: number;
  faderY: number;
  faderLen: number;
  faderThick: number;
  capLen: number;
  switchY: number;
  switchW: number;
  switchH: number;
  knob1Y: number;
  knob2Y: number;
  knobSize: number;
}

export function computeLayout(W: number, H: number): Layout {
  const s = Math.min(3, Math.max(0.55, Math.min(W / BASE_W, H / BASE_H)));
  const bottomH = Math.max(28, Math.round(H * 0.18));
  const topH = Math.max(60, H - bottomH);
  const graphW = Math.max(100, Math.round(W * 0.73));
  const panelW = Math.max(60, W - graphW);
  const padX = Math.max(2, Math.round(3 * s));
  const colW = (panelW - 2 * padX) / 8;
  const knobSize = Math.max(12, Math.floor(Math.min(colW - 2, 24 * s)));
  const tileW = Math.max(10, Math.floor(Math.min(colW - 3, 21 * s)));
  const tileH = Math.round(tileW * 1.3);
  const padTop = Math.max(2, Math.round(4 * s));
  const gap = Math.max(2, Math.round(3 * s));
  const switchH = Math.max(5, Math.round(8 * s));
  const switchW = Math.max(8, Math.floor(Math.min(colW - 6, 17 * s)));
  const faderThick = Math.max(10, Math.floor(Math.min(colW - 4, 18 * s)));
  const capLen = Math.max(8, Math.round(11 * s));
  const tileY = padTop;
  const faderY = tileY + tileH + gap;
  const below = gap + switchH + gap + knobSize + gap + knobSize + padTop;
  const faderLen = Math.max(40, Math.floor(topH - faderY - below));
  const switchY = faderY + faderLen + gap;
  const knob1Y = switchY + switchH + gap;
  const knob2Y = knob1Y + knobSize + gap;
  return {
    W, H, s, graphW, topH, panelW, bottomH, colW, colX0: padX,
    tileY, tileW, tileH, faderY, faderLen, faderThick, capLen,
    switchY, switchW, switchH, knob1Y, knob2Y, knobSize,
  };
}
