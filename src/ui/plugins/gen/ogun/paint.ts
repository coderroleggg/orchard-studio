// Ogun's painted background (original drawing: the section panels of FL's editor with their vertical gradients, sampled from
// FL's plugin thumbnail): the top bar (master sliders, X / Y pad, modulation, info), the TIMBRE / UNISON / FILTER sections, the
// articulator row, the EQ panel and the effects row (chorus, delay, reverb). FL paints these in the form's OnPaint; the
// controls and their captions sit on top at the form's own coordinates.

type Rect = [number, number, number, number];

function panel(g: CanvasRenderingContext2D, [x, y, w, h]: Rect, top: string, bottom: string, r = 4, edge = 'rgba(0,0,0,0.5)'): void {
  const grad = g.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, top);
  grad.addColorStop(1, bottom);
  g.beginPath();
  g.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r);
  g.fillStyle = grad;
  g.fill();
  g.strokeStyle = edge;
  g.lineWidth = 1;
  g.stroke();
  // the light inner edge
  g.beginPath();
  g.roundRect(x + 1.5, y + 1.5, w - 3, h - 3, Math.max(0, r - 1));
  g.strokeStyle = 'rgba(255,255,255,0.04)';
  g.stroke();
}

/** FL's dotted separator: 2 px dots every 4 px (a dark dot and a light one one pixel apart). */
function dots(g: CanvasRenderingContext2D, x: number, y: number, len: number, vertical: boolean): void {
  const n = Math.floor(len / 4);
  for (let i = 0; i < n; i++) {
    const dx = vertical ? 0 : 4 * i, dy = vertical ? 4 * i : 0;
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(x + dx + 1, y + dy + 1, 2, 2);
    g.fillStyle = 'rgba(0,0,0,0.32)';
    g.fillRect(x + dx, y + dy, 2, 2);
  }
}

/** The background panels (form coordinates of FL's 560 x 640 panel; the keyboard strip is drawn by the keyboard). */
export const PANELS: { name: string; rect: Rect }[] = [
  { name: 'top', rect: [0, 0, 560, 93] },
  { name: 'timbre', rect: [4, 95, 233, 118] },
  { name: 'unison', rect: [240, 95, 157, 118] },
  { name: 'filter', rect: [400, 95, 156, 118] },
  { name: 'editor', rect: [4, 215, 436, 214] },
  { name: 'eq', rect: [445, 248, 111, 182] },
  { name: 'chorus', rect: [3, 433, 172, 114] },
  { name: 'delay', rect: [180, 433, 165, 114] },
  { name: 'reverb', rect: [348, 433, 209, 114] },
];

export function paintBackground(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.fillStyle = '#444b51';
  g.fillRect(0, 0, w, h);
  // top bar
  const top = g.createLinearGradient(0, 0, 0, 93);
  top.addColorStop(0, '#272c30');
  top.addColorStop(1, '#14181b');
  g.fillStyle = top;
  g.fillRect(0, 0, 560, 93);
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(0, 92, 560, 1);
  g.fillStyle = 'rgba(255,255,255,0.05)';
  g.fillRect(0, 93, 560, 1);
  // the modulation block is a little darker, the master sliders have their own well
  panel(g, [4, 2, 90, 86], '#23282b', '#171b1e', 3);
  panel(g, [178, 4, 136, 82], '#1b2225', '#0d1417', 3);
  // sections
  panel(g, PANELS[1].rect, '#41484e', '#2b3135');
  panel(g, PANELS[2].rect, '#41484e', '#2b3135');
  panel(g, PANELS[3].rect, '#454c52', '#30373b');
  // section title bars
  for (const i of [1, 2, 3]) {
    const [x, y, pw] = PANELS[i].rect;
    g.fillStyle = 'rgba(255,255,255,0.045)';
    g.fillRect(x + 2, y + 2, pw - 4, 19);
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.fillRect(x + 2, y + 21, pw - 4, 1);
  }
  // articulator row and the EQ panel
  panel(g, PANELS[4].rect, '#3d4449', '#363c41', 4);
  panel(g, PANELS[5].rect, '#3c4347', '#2e3437');
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.fillRect(448, 276, 106, 1);
  // effects row: the wheels' lanes
  panel(g, PANELS[6].rect, '#23282b', '#14181b');
  panel(g, PANELS[7].rect, '#23282b', '#14181b');
  panel(g, PANELS[8].rect, '#23282b', '#14181b');
  // separators inside the unison section and the effects panels
  dots(g, 244, 190, 150, false);
  dots(g, 228, 108, 82, true);
  // lane lines of the effects sliders (FL draws the slider wells)
  g.fillStyle = 'rgba(255,255,255,0.03)';
  for (const [x0, n] of [[36, 6], [245, 4], [379, 8]] as const) {
    for (let i = 0; i < n; i++) g.fillRect(x0 + i * 22 - 1, 450, 22, 88);
  }
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(0, 430, 560, 1);
  g.fillStyle = 'rgba(255,255,255,0.05)';
  g.fillRect(0, 431, 560, 1);
}
