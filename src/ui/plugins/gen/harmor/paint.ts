// Harmor's painted background (original drawing after FL's painters 0xaa690,
// 0xb4720, 0xb59d0, 0xb6a00): the part area (FL's fixed part colour
// #4c2d34 with its light top band, notched at the left buttons and below the
// filters), the dotted separator lines (0xb7940: 2 px dots every 4 px, a black
// dot at alpha 80 and a white one at alpha 20 offset by one pixel), the
// frames of the paired digit wheels and the captions (LABELS, helper 0xb8cb0).

import { LABELS, type HLabel } from './labels';

/** FL's caption fonts: [size px, horizontal aspect, bold]. */
const FONTS: [number, number, boolean][] = [
  [11.5, 0.95, false], // 0 Arial 12 x0.95
  [11.5, 0.85, true], // 1 Arial 12 x0.85 (section captions)
  [15.5, 0.8, false], // 2 Arial 16 x0.8 (section names)
  [8, 1, false], // 3 Arial 8
  [13, 1, false], // 4 glyphs 16
  [18, 1, false], // 5 glyphs 24
  [22, 1, false], // 6 Arial 24
  [10, 1, false], // 7 glyphs 12
];

/** FL glyph codepoints drawn as simple marks (the glyph font itself is FL's): the rest are skipped. */
const GLYPH_TEXT: Record<string, string> = {
  '': '◂', // left marker
  '': '▸', // right marker
  '': '▾', // down marker
  '': '↕',
};

export function drawLabel(g: CanvasRenderingContext2D, l: HLabel): void {
  const [text0, x, y, w, h, al, font, alpha] = l;
  const glyph = font === 4 || font === 5 || font === 7;
  let text = text0;
  if (glyph) {
    if (text === '') {
      // a faint vertical bar (separator glyph)
      g.fillStyle = `rgba(255,255,255,${alpha / 255})`;
      const gx = al === 'l' ? x + 3 : al === 'r' ? x + w - 3 : x + w / 2;
      g.fillRect(Math.round(gx), y + 3, 1, Math.max(4, h - 6));
      return;
    }
    text = GLYPH_TEXT[text] ?? '';
    if (!text) return;
  }
  const [size, aspect, bold] = FONTS[font] ?? FONTS[0];
  g.save();
  g.font = `${bold ? '600 ' : ''}${size}px Arial, Helvetica, sans-serif`;
  g.fillStyle = `rgba(255,255,255,${Math.min(1, alpha / 255)})`;
  g.textBaseline = 'middle';
  const cy = y + h / 2 + 0.5;
  const tw = g.measureText(text).width * aspect;
  const tx = al === 'l' ? x : al === 'r' ? x + w - tw : x + (w - tw) / 2;
  g.translate(tx, cy);
  g.scale(aspect, 1);
  g.fillText(text, 0, 0);
  g.restore();
}

/** Captions of a page ('' = part page and global section). */
export function labelsOf(page: string): HLabel[] {
  return LABELS.filter((l) => (l[8] ?? '') === page);
}

/** FL's dotted separator (0xb7940): horizontal when w > 0, vertical (length h) otherwise. */
export function dots(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const n = Math.floor((w > 0 ? w : h) / 4);
  for (let i = 0; i < n; i++) {
    const dx = w > 0 ? 4 * (i + 1) : 0, dy = w > 0 ? 0 : 4 * (i + 1);
    g.fillStyle = 'rgba(255,255,255,0.078)';
    g.fillRect(x + dx + 1, y + dy + 1, 2, 2);
    g.fillStyle = 'rgba(0,0,0,0.31)';
    g.fillRect(x + dx, y + dy, 2, 2);
  }
}

/** The part page separators: (x, y, horizontal length, vertical length). */
export const SEPARATORS: [number, number, number, number][] = [
  [24, 104, 352, 0], [24, 176, 352, 0], [44, 264, 476, 0], [384, 148, 136, 0],
  [232, 108, 0, 64], [156, 180, 0, 80], [380, 104, 0, 156], [564, 218, 416, 0],
];

/** The part area outline: x 13..1011 from the top, notched to x 34 below y 236 (left buttons) and to x 988 below y 230 (visual feedback buttons). */
export function partPath(g: CanvasRenderingContext2D): void {
  const r = 6;
  g.beginPath();
  g.moveTo(13, 0);
  g.lineTo(1011, 0);
  g.lineTo(1011, 224 - r);
  g.quadraticCurveTo(1011, 224, 1011 - r, 224);
  g.lineTo(988 + r, 224);
  g.quadraticCurveTo(988, 224, 988, 224 + r);
  g.lineTo(988, 329 - r);
  g.quadraticCurveTo(988, 329, 988 - r, 329);
  g.lineTo(34 + r, 329);
  g.quadraticCurveTo(34, 329, 34, 329 - r);
  g.lineTo(34, 236 + r);
  g.quadraticCurveTo(34, 236, 34 - r, 236);
  g.lineTo(13 + r, 236);
  g.quadraticCurveTo(13, 236, 13, 236 - r);
  g.closePath();
}

/** The fixed background of the whole panel (part area, global section). */
export function paintBackground(g: CanvasRenderingContext2D, w: number, h: number): void {
  // panel
  g.fillStyle = '#26282d';
  g.fillRect(0, 0, w, h);
  // part area
  g.save();
  partPath(g);
  g.clip();
  const grad = g.createLinearGradient(0, 0, 0, 330);
  grad.addColorStop(0, '#4a2c33');
  grad.addColorStop(1, '#5b3840');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1024, 330);
  const side = g.createLinearGradient(13, 0, 1011, 0);
  side.addColorStop(0, 'rgba(0,0,0,0.16)');
  side.addColorStop(0.08, 'rgba(0,0,0,0)');
  side.addColorStop(0.92, 'rgba(0,0,0,0)');
  side.addColorStop(1, 'rgba(0,0,0,0.12)');
  g.fillStyle = side;
  g.fillRect(0, 0, 1024, 330);
  // FL's light top band (#685458) over the part colour
  const band = g.createLinearGradient(0, 0, 0, 14);
  band.addColorStop(0, 'rgba(120,98,104,0.85)');
  band.addColorStop(0.55, 'rgba(104,84,88,0.55)');
  band.addColorStop(1, 'rgba(104,84,88,0)');
  g.fillStyle = band;
  g.fillRect(0, 0, 1024, 14);
  // fine grain
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * 1000 + 13, y = rnd() * 329;
    g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.05)';
    g.fillRect(x | 0, y | 0, 1, 1);
  }
  g.restore();
  // outline
  partPath(g);
  g.strokeStyle = 'rgba(15,10,12,0.9)';
  g.lineWidth = 1;
  g.stroke();
  // separators
  for (const [x, y, sw, sh] of SEPARATORS) dots(g, x, y, sw, sh);
  // paired digit wheel frames (0xb3d00): harmonizer shift / gap, freq / detune
  const frame = (x: number, y: number, ww: number, hh: number) => {
    g.fillStyle = 'rgba(0,0,0,0.38)';
    g.beginPath();
    g.roundRect(x - 2, y - 2, ww + 4, hh + 4, 3);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.stroke();
  };
  frame(332, 206, 36, 19);
  frame(332, 228, 36, 19);
  frame(139, 276, 97, 19);
  frame(139, 299, 97, 19);
  // global section well
  g.fillStyle = '#2a2c31';
  g.beginPath();
  g.roundRect(4, 334, 383, 276, 4);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.5)';
  g.stroke();
  // captions of the part page and the global section
  for (const l of labelsOf('')) drawLabel(g, l);
}

/** Background of a bottom page panel (IMG / FX / ADV at (392, 330), 632 x 272) with its captions. */
export function paintPage(g: CanvasRenderingContext2D, page: string, ox: number, oy: number, w: number, h: number): void {
  g.fillStyle = '#282b2e';
  g.fillRect(0, 0, w, h);
  g.save();
  g.translate(-ox, -oy);
  for (const l of labelsOf(page)) drawLabel(g, l);
  g.restore();
}
