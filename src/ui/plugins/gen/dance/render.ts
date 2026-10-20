// Drawing the Dance character into its window's canvas: the current sprite
// sheet cell and, while Motion blending mixes frames, the next one (a linear
// mix, as measured on FL), mirrored on request, with the reflection below
// the feet (the character flipped, fading out linearly from Reflect / 256 to
// nothing over a third of its height).

import type { DanceBox } from '../../../../model/gen/plugins/dance';
import type { AnimFrame } from './anim';
import type { SpriteSheet } from './sheets';

/** Draws frames into one canvas. */
export class CharacterRenderer {
  private refl: HTMLCanvasElement | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** Size the canvas for `box` at `dpr` device pixels per CSS pixel. */
  fit(box: DanceBox, dpr: number): CanvasRenderingContext2D | null {
    const w = Math.max(1, Math.round(box.w * dpr)), h = Math.max(1, Math.round((box.h + box.refl) * dpr));
    const c = this.canvas;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return c.getContext('2d');
  }

  draw(sheet: SpriteSheet, f: AnimFrame, box: DanceBox, reflect: number, dpr: number): void {
    const g = this.fit(box, dpr);
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.save();
    g.scale(dpr, dpr);
    const rows = sheet.names.length;
    const cell = (row: number, col: number, mirror: boolean, alpha: number, add: boolean): void => {
      const r = Math.max(0, Math.min(rows - 1, row));
      g.save();
      g.globalAlpha = alpha;
      g.globalCompositeOperation = add ? 'lighter' : 'source-over';
      if (mirror) { g.translate(box.w, 0); g.scale(-1, 1); }
      g.drawImage(sheet.image, col * sheet.cellW, r * sheet.cellH, sheet.cellW, sheet.cellH, 0, 0, box.w, box.h);
      g.restore();
    };
    const same = f.row === f.row2 && f.col === f.col2 && f.mirror === f.mirror2;
    if (f.t <= 0 || same) {
      cell(f.row, f.col, f.mirror, 1, false);
    } else {
      cell(f.row, f.col, f.mirror, 1 - f.t, false);
      cell(f.row2, f.col2, f.mirror2, f.t, true);
    }
    g.restore();
    if (box.refl > 0 && reflect > 0) this.reflection(g, box, reflect, dpr);
  }

  /** The reflection: the last `refl` rows of the character, flipped, faded. */
  private reflection(g: CanvasRenderingContext2D, box: DanceBox, reflect: number, dpr: number): void {
    const W = Math.max(1, Math.round(box.w * dpr));
    const R = Math.max(1, Math.round(box.refl * dpr));
    const H = Math.max(1, Math.round(box.h * dpr));
    let rc = this.refl;
    if (!rc) rc = this.refl = document.createElement('canvas');
    if (rc.width !== W || rc.height !== R) { rc.width = W; rc.height = R; }
    const r = rc.getContext('2d');
    if (!r) return;
    r.setTransform(1, 0, 0, 1, 0, 0);
    r.globalCompositeOperation = 'source-over';
    r.globalAlpha = 1;
    r.clearRect(0, 0, W, R);
    // the cell's bottom rows, flipped: the row under the feet shows the last row of the cell
    r.save();
    r.translate(0, R);
    r.scale(1, -1);
    r.drawImage(this.canvas, 0, Math.max(0, H - R), W, Math.min(R, H), 0, 0, W, R);
    r.restore();
    // fade: Reflect / 256 at the feet to 0 at the bottom of the reflection
    r.globalCompositeOperation = 'destination-in';
    const grad = r.createLinearGradient(0, 0, 0, R);
    const a = Math.max(0, Math.min(1, reflect / 256));
    grad.addColorStop(0, `rgba(0,0,0,${a})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    r.fillStyle = grad;
    r.fillRect(0, 0, W, R);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.drawImage(rc, 0, H);
    g.restore();
  }
}
