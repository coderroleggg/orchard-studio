// Morphine editor background: an original drawing of FL's page layout (top
// bar with the program box and master section, page column with the
// resynthesis box, the page frame, the effect strip) and the page panels; the
// captions sit where FL's page backgrounds print them.

import { BIG_KNOBS, EQ_FADERS, FX_TITLES, PANEL_H, PANEL_W } from './layout';

const LAV = '#a6abef';
const TXT = '#d4d6e6';
const DIM = '#8d90a8';

function vg(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c0: string, c1: string): void {
  const gr = g.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, c0);
  gr.addColorStop(1, c1);
  g.fillStyle = gr;
  g.fillRect(x, y, w, h);
}

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function panel(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill = '#0e1020', stroke = '#2c2f4a'): void {
  rr(g, x + 0.5, y + 0.5, w - 1, h - 1, 4);
  g.fillStyle = fill;
  g.fill();
  g.strokeStyle = stroke;
  g.lineWidth = 1;
  g.stroke();
}

function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'center', weight = 700): void {
  g.font = `${weight} ${size}px Arial, Helvetica, sans-serif`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(s, x, y);
}

function title(g: CanvasRenderingContext2D, s: string, x: number, y: number): void {
  g.font = '700 12px "Arial Narrow", Arial, sans-serif';
  g.fillStyle = '#c8cad6';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(s, x, y);
}

/** The frame, top bar, left column and effect strip (all pages); `wide` = the morphing / modulation pages' frame. */
export function paintFrame(g: CanvasRenderingContext2D, wide = false): void {
  g.clearRect(0, 0, PANEL_W, PANEL_H);
  vg(g, 0, 0, PANEL_W, 100, '#45474e', '#26272c');
  vg(g, 0, 100, PANEL_W, 340, '#2a2b30', '#1d1e22');
  vg(g, 0, 440, PANEL_W, 112, '#3a3b41', '#202126');
  // top bar: program box
  panel(g, 6, 6, 270, 86, '#101223', '#5a5e80');
  text(g, 'PROGRAM NAME:', 80, 24, 11, LAV);
  for (const [s, x] of [['POLY', 44], ['TRANSP', 108], ['FINE', 172], ['G-MODE', 238]] as [string, number][]) text(g, s, x, 94, 10, TXT);
  // logo
  g.font = 'italic 800 34px Arial Black, Arial, sans-serif';
  g.fillStyle = 'rgba(230,232,240,0.85)';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('Morphine', 352, 44);
  text(g, 'ADDITIVE SYNTHESIZER', 352, 68, 9, 'rgba(220,222,232,0.7)', 'center', 800);
  // master envelope / master
  title(g, 'MASTER ENVELOPE', 654, 13);
  title(g, 'MASTER', 826, 13);
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(538, 2, 1, 96);
  g.fillRect(768, 2, 1, 96);
  g.fillRect(422, 2, 1, 96);
  for (const [, x, y, cap] of BIG_KNOBS) text(g, cap, x + 26, y + (y < 100 ? 61 : 59), 10, TXT);
  // left column: resynthesis box
  panel(g, 4, 246, 104, 128, '#15172a', '#3b3f62');
  title(g, 'RESYNTHESIS', 56, 260);
  for (const [s, y] of [['NOTE', 323], ['DETUNE', 343], ['RESOLUTION', 363]] as [string, number][]) text(g, s, 11, y, 8, DIM, 'left');
  text(g, 'BALANCE', 32, 433, 10, TXT);
  text(g, 'TEST', 78, 433, 10, TXT);
  // page frame
  rr(g, 110.5, 102.5, wide ? 774 : 652, 336, 8);
  g.strokeStyle = '#8f93a6';
  g.lineWidth = 2;
  g.stroke();
  // effect strip
  for (const [s, x] of FX_TITLES) title(g, s, x, 456);
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (const x of [174, 460, 634]) g.fillRect(x, 444, 1, 106);
  for (const [, x, , cap] of EQ_FADERS) text(g, cap, x + 13, 544, 9, TXT);
}

/** Generator page panels. */
export function paintGenPage(g: CanvasRenderingContext2D): void {
  panel(g, 117, 111, 643, 103);
  panel(g, 117, 216, 643, 120);
  panel(g, 117, 338, 643, 96);
  // right column: control range, PWM filter
  panel(g, 766, 106, 116, 140, '#15172a', '#3b3f62');
  title(g, 'CONTROL RANGE', 824, 120);
  text(g, 'DETUNE', 788, 231, 9, TXT);
  text(g, 'PAN', 862, 231, 9, TXT);
  panel(g, 766, 252, 116, 182, '#15172a', '#3b3f62');
  title(g, 'PWM FILTER', 824, 266);
  text(g, 'RATE', 788, 383, 9, TXT);
  text(g, 'PHASE', 858, 383, 9, TXT);
  text(g, 'MODE', 824, 403, 9, DIM);
  for (const [s, x] of [['RATE', 527], ['RATE K-TRK', 604], ['RATE V-TRK', 696]] as [string, number][]) text(g, s, x, 230, 9, DIM);
  text(g, 'LOOP:', 214, 231, 9, DIM, 'left');
}

/** Modulation page panels. */
export function paintModPage(g: CanvasRenderingContext2D): void {
  panel(g, 117, 111, 643 + 112, 196);
  text(g, 'PITCH-BEND AMOUNT', 744, 128, 9, TXT);
  for (const dx of [0, 375]) {
    text(g, 'SOURCE', 221 + dx, 151, 9, TXT);
    text(g, 'AMOUNT', 297 + dx, 151, 9, TXT);
    text(g, 'DESTINATION', 403 + dx, 151, 9, TXT);
    for (let r = 0; r < 6; r++) {
      const y = 158 + 23 * r;
      panel(g, 128 + dx, y, 26, 19, '#2d3052', '#4a4e78');
      text(g, String(r + 1 + (dx ? 6 : 0)), 141 + dx, y + 10, 10, TXT);
    }
  }
  panel(g, 117, 310, 643 + 112, 124);
  for (const [s, x] of [['RATE', 586], ['RATE K-TRK', 663], ['RATE V-TRK', 754], ['VEL', 832]] as [string, number][]) text(g, s, x, 323, 9, DIM);
  text(g, 'LOOP:', 214, 323, 9, DIM, 'left');
}

/** Morph page panels. */
export function paintMorphPage(g: CanvasRenderingContext2D): void {
  panel(g, 117, 111, 333, 323);
  panel(g, 155, 143, 254, 254, '#090a13', '#3b3f62');
  for (const [s, x, y] of [['MIX', 137, 151], ['PAN', 137, 196], ['MIX', 430, 151], ['PAN', 430, 196], ['MIX', 137, 298], ['PAN', 137, 343], ['MIX', 430, 298], ['PAN', 430, 343]] as [string, number, number][]) text(g, s, x, y, 9, TXT);
  panel(g, 455, 106, 427, 228);
  text(g, 'LOOP:', 462, 321, 9, DIM, 'left');
  for (const [s, x] of [['RATE', 645], ['RATE K-TRK', 722], ['RATE V-TRK', 813]] as [string, number][]) text(g, s, x, 321, 9, DIM);
  panel(g, 455, 334, 427, 100);
  text(g, 'NOISE SMP', 490, 347, 9, LAV);
  for (const [s, x] of [['MIX', 494], ['PAN', 549], ['RATIO', 601], ['VEL', 653], ['CUTOFF', 732], ['RESO', 784], ['FLT K-TRK', 836]] as [string, number][]) text(g, s, x, 422, 9, TXT);
}
