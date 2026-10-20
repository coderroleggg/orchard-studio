// Harmless editor background: FL paints its sections and captions in code
// (painter 0x5d700); the regions and colours here are an original drawing in
// the spirit of FL's skin (slate top strip, plum articulator area, dark effect
// strip, keyboard well), the captions are FL's (labels.ts, at FL's boxes).

import { HL_LABELS } from './labels';

export const PANEL_W = 848;
export const PANEL_H = 569;
/** FL hides the keyboard by shortening the form to the keyboard's top. */
export const PANEL_H_NOKB = 502;

function vgrad(g: CanvasRenderingContext2D, y0: number, y1: number, c0: string, c1: string): void {
  const gr = g.createLinearGradient(0, y0, 0, y1);
  gr.addColorStop(0, c0);
  gr.addColorStop(1, c1);
  g.fillStyle = gr;
  g.fillRect(0, y0, PANEL_W, y1 - y0);
}

function line(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, c: string): void {
  g.strokeStyle = c;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x0 + 0.5, y0 + 0.5);
  g.lineTo(x1 + 0.5, y1 + 0.5);
  g.stroke();
}

export function paintBackground(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.clearRect(0, 0, w, h);
  vgrad(g, 0, 162, '#33363f', '#2a2c34');
  vgrad(g, 162, 418, '#40303a', '#33252e');
  vgrad(g, 418, 497, '#2a2b31', '#222328');
  vgrad(g, 497, PANEL_H, '#1c1d21', '#18191c');
  line(g, 0, 161, PANEL_W, 161, 'rgba(0,0,0,0.55)');
  line(g, 0, 162, PANEL_W, 162, 'rgba(255,255,255,0.07)');
  line(g, 0, 290, PANEL_W, 290, 'rgba(0,0,0,0.25)');
  line(g, 0, 291, PANEL_W, 291, 'rgba(255,255,255,0.05)');
  line(g, 0, 417, PANEL_W, 417, 'rgba(0,0,0,0.6)');
  line(g, 0, 418, PANEL_W, 418, 'rgba(255,255,255,0.06)');
  line(g, 0, 496, PANEL_W, 496, 'rgba(0,0,0,0.6)');
  // vertical separators of the top strip (sliders | envelope | master) and the articulator area
  for (const x of [244, 580, 680]) line(g, x, 8, x, 154, 'rgba(255,255,255,0.05)');
  for (const x of [640]) line(g, x, 170, x, 284, 'rgba(255,255,255,0.05)');
  for (const x of [366, 675]) line(g, x, 298, x, 410, 'rgba(255,255,255,0.05)');
  for (const x of [180, 400, 560, 700]) line(g, x, 426, x, 488, 'rgba(255,255,255,0.05)');
  // FL's captions
  g.textBaseline = 'middle';
  for (const [text, x, y, bw, bh, al, va, alpha, kind] of HL_LABELS) {
    if (kind === 'g') continue; // FL's glyph-font pictograms
    const title = kind === 'T';
    const size = title ? 15 : 10;
    g.font = title ? `italic 600 ${size}px Georgia, "Times New Roman", serif` : `${size}px Arial, Helvetica, sans-serif`;
    g.fillStyle = `rgba(236,238,242,${(alpha / 255).toFixed(3)})`;
    g.textAlign = al === 'l' ? 'left' : al === 'r' ? 'right' : 'center';
    const tx = al === 'l' ? x : al === 'r' ? x + bw : x + bw / 2;
    const ty = va === 't' ? y + size * 0.6 : va === 'b' ? y + bh - size * 0.6 : y + bh / 2;
    g.fillText(text, tx, ty);
  }
}
