// The Dance plugin's built-in artwork, drawn by code (nothing here is copied
// from FL; FL's character is its own mascot): "Pippin", a little apple with a
// leaf, twig arms and legs and blue sneakers, and a countdown sheet. Both are
// sprite sheets in FL's layout: 8 cells per row, one row per move, the last
// row of Pippin's sheet the "Held" pose, drawn at twice the size they are
// shown at (FL's sheets are @2x: a 220 x 256 cell is a 110 x 128 px window).
//
// A move is 8 poses that loop; frame 0 of every move is the neutral standing
// pose (the character stands like that while the song is stopped).

type Ctx = CanvasRenderingContext2D;

/** One cell of the character sheet in pixels (shown at half size). */
export const CELL_W = 220;
export const CELL_H = 256;
/** One cell of the countdown sheet. */
export const COUNT_CELL = 200;

const rad = (d: number) => (d * Math.PI) / 180;
const OUT = '#3b1a22';

// ------------------------------------------------------------------ poses

export type Eyes = 'open' | 'happy' | 'closed' | 'x' | 'gt' | 'wide';
export type Mouth = 'smile' | 'grin' | 'o' | 'flat' | 'open' | 'zig';

/** A limb as two absolute angles (degrees from straight down, positive = outward / up). */
export type Limb = [number, number];

export interface Pose {
  /** Where the pivot (a point of the character, `px`, `py`) is drawn in the cell. */
  ax: number;
  ay: number;
  px: number;
  py: number;
  /** Rotation about the pivot (degrees, clockwise) and squash / stretch. */
  rot: number;
  sx: number;
  sy: number;
  /** Spin about the vertical axis (degrees; 0 = facing front). */
  yaw: number;
  armL: Limb;
  armR: Limb;
  legL: Limb;
  legR: Limb;
  eyes: Eyes;
  mouth: Mouth;
  /** Pupils' shift (-1..1). */
  look: number;
}

const GROUND_X = 55;
const GROUND_Y = 124;
/** Where the feet stand in a cell (a little above its bottom edge). */
const FEET_Y = 122;
/** The whole character is drawn at this scale about its feet so jumps and outstretched arms have room. */
const SCALE = 0.84;

export function neutralPose(): Pose {
  return {
    ax: GROUND_X, ay: FEET_Y, px: GROUND_X, py: GROUND_Y, rot: 0, sx: 1, sy: 1, yaw: 0,
    armL: [10, 16], armR: [10, 16], legL: [4, 4], legR: [4, 4], eyes: 'open', mouth: 'smile', look: 0,
  };
}

/** Arms-up envelope: 0 on frame 0 (neutral), 1 in the middle of the cycle, back down at its end. */
const ENV = [0, 0.55, 1, 1, 1, 1, 1, 0.55];

/** The pose of `move` (0 Waiting .. 8 Dervish, 9 Held) at frame `f` (0..7). */
export function poseOf(move: number, f: number): Pose {
  const P = neutralPose();
  const p = f / 8;
  const s = Math.sin(2 * Math.PI * p);
  const A = ENV[f];
  switch (move) {
    case 0: { // Waiting: breathing, a blink, a glance around
      P.sy = 1 + 0.018 * s;
      P.sx = 1 - 0.01 * s;
      P.armL = [10 + 4 * s, 16 + 6 * s];
      P.armR = [10 + 4 * s, 16 + 6 * s];
      P.eyes = f === 5 ? 'closed' : 'open';
      P.look = f >= 1 && f <= 3 ? -1 : f >= 5 ? 1 : 0;
      break;
    }
    case 1: { // Stepping: weight shifts from foot to foot
      const sp = Math.max(0, s), sn = Math.max(0, -s);
      P.ax += 4.5 * s;
      P.ay -= 1.6 * Math.abs(s);
      P.rot = 3.5 * s;
      P.legL = [4 + 26 * sp, 4 - 74 * sp];
      P.legR = [4 + 26 * sn, 4 - 74 * sn];
      P.armL = [10 - 22 * s, 16 - 22 * s];
      P.armR = [10 + 22 * s, 16 + 22 * s];
      break;
    }
    case 2: { // Jumping: crouch, push off, apex, fall, land
      const J: [number, number, number, number, number, number, number, Eyes, Mouth][] = [
        [0, 1, 1, 10, 16, 4, 4, 'open', 'smile'],
        [0, 1.1, 0.86, -18, -10, 30, -16, 'open', 'smile'],
        [-12, 0.94, 1.1, 60, 70, 6, 6, 'open', 'open'],
        [-25, 1, 1.02, 150, 165, 24, -50, 'happy', 'grin'],
        [-16, 1, 1, 125, 140, 14, -20, 'open', 'open'],
        [0, 1.1, 0.88, 40, 30, 32, -18, 'open', 'smile'],
        [0, 0.98, 1.04, 20, 24, 8, 2, 'open', 'smile'],
        [0, 1, 1.01, 12, 18, 4, 4, 'open', 'smile'],
      ];
      const [dy, sx, sy, a1, a2, l1, l2, eyes, mouth] = J[f];
      P.ay += dy; P.sx = sx; P.sy = sy;
      P.armL = [a1, a2]; P.armR = [a1, a2];
      P.legL = [l1, l2]; P.legR = [l1, l2];
      P.eyes = eyes; P.mouth = mouth;
      break;
    }
    case 3: { // Zombie: arms out, swaying, shuffling
      P.armL = [10 + A * 62, 16 + A * 58];
      P.armR = [10 + A * 62, 16 + A * 58];
      P.rot = A * 3.5 * s;
      P.ax += A * 1.5 * s;
      P.ay -= A * 0.8 * Math.abs(s);
      P.legL = [4 + 10 * A * Math.max(0, s), 4 - 20 * A * Math.max(0, s)];
      P.legR = [4 + 10 * A * Math.max(0, -s), 4 - 20 * A * Math.max(0, -s)];
      P.eyes = A > 0.3 ? 'x' : 'open';
      P.mouth = A > 0.3 ? 'zig' : 'smile';
      break;
    }
    case 4: { // Waving: both arms up, waving in turn
      const w = 2 * Math.PI * 2 * p;
      P.armL = [10 + A * (118 + 26 * Math.sin(w)), 16 + A * (124 + 36 * Math.sin(w + 0.8))];
      P.armR = [10 + A * (118 - 26 * Math.sin(w)), 16 + A * (124 - 36 * Math.sin(w + 0.8))];
      P.rot = A * 3 * s;
      P.ay -= A * 1.2 * Math.abs(Math.sin(w));
      P.eyes = A > 0.5 ? 'happy' : 'open';
      P.mouth = A > 0.5 ? 'grin' : 'smile';
      break;
    }
    case 5: { // Hula: hips and arms sway
      P.ax += A * 7 * s;
      P.rot = -A * 8 * s;
      P.armL = [10 + A * (50 + 16 * s), 16 + A * (56 + 18 * s)];
      P.armR = [10 + A * (50 - 16 * s), 16 + A * (56 - 18 * s)];
      P.legL = [4 + A * 6 * Math.max(0, s), 4 - A * 14 * Math.max(0, s)];
      P.legR = [4 + A * 6 * Math.max(0, -s), 4 - A * 14 * Math.max(0, -s)];
      P.eyes = A > 0.5 ? 'happy' : 'open';
      break;
    }
    case 6: { // Windmill: spins about its middle with the legs in a V
      P.px = 55; P.py = 78; P.ax = 55; P.ay = 76;
      P.rot = 45 * f;
      P.legL = [4 + A * 52, 4 + A * 56];
      P.legR = [4 + A * 52, 4 + A * 56];
      P.armL = [10 + A * 18, 16 + A * 26];
      P.armR = [10 + A * 18, 16 + A * 26];
      P.eyes = A > 0.5 ? 'gt' : 'open';
      P.mouth = A > 0.5 ? 'grin' : 'smile';
      break;
    }
    case 7: { // Zitabata: stamping with a tantrum
      const Z: [Limb, Limb, Limb, Limb, number, number, number][] = [
        // armL, armR, legL, legR, rot, dx, dy
        [[10, 16], [10, 16], [4, 4], [4, 4], 0, 0, 0],
        [[140, 150], [30, 36], [40, -62], [4, 4], -5, -2, 0],
        [[60, 70], [60, 70], [10, 8], [10, 8], 0, 0, 0],
        [[30, 36], [140, 150], [4, 4], [40, -62], 5, 2, 0],
        [[60, 70], [60, 70], [10, 8], [10, 8], 0, 0, 0],
        [[140, 150], [30, 36], [40, -62], [4, 4], -5, -2, 0],
        [[30, 36], [140, 150], [4, 4], [40, -62], 5, 2, 0],
        [[40, 50], [40, 50], [8, 6], [8, 6], 0, 0, 0],
      ];
      const [aL, aR, lL, lR, rot, dx, dy] = Z[f];
      P.armL = aL; P.armR = aR; P.legL = lL; P.legR = lR; P.rot = rot; P.ax += dx; P.ay += dy;
      if (f === 2 || f === 4 || f === 7) P.sy = 0.95;
      P.eyes = f === 0 ? 'open' : 'gt';
      P.mouth = f === 0 ? 'smile' : 'open';
      break;
    }
    case 8: { // Dervish: turns round on the spot, arms out
      P.yaw = 45 * f;
      P.ay -= 3 * Math.abs(Math.sin(rad(2 * P.yaw)));
      P.armL = [10 + A * 70, 16 + A * 72];
      P.armR = [10 + A * 70, 16 + A * 72];
      P.mouth = A > 0.5 ? 'o' : 'smile';
      P.look = f >= 1 && f <= 3 ? 1 : 0;
      break;
    }
    default: { // 9 Held: dangling from the stem, swinging
      P.px = 55; P.py = 38; P.ax = 55; P.ay = 22;
      P.rot = 7 * s;
      P.armL = [4 + 6 * s, 8 + 10 * s];
      P.armR = [4 + 6 * s, 8 + 10 * s];
      P.legL = [3 + 9 * Math.sin(2 * Math.PI * p + 1.2), -4 - 8 * Math.sin(2 * Math.PI * p + 1.2)];
      P.legR = [3 + 9 * Math.sin(2 * Math.PI * p + 1.2), -4 - 8 * Math.sin(2 * Math.PI * p + 1.2)];
      P.eyes = 'wide';
      P.mouth = 'o';
      break;
    }
  }
  return P;
}

// ------------------------------------------------------------------ drawing

const ARM = [13, 12];
const LEG = [12, 11];
const SHOULDER_Y = 70;
const SHOULDER_X = 28;
const HIP_Y = 96;
const HIP_X = 9;

function limb(g: Ctx, x0: number, y0: number, a: Limb, l: number[], side: number, cos: number): [number, number] {
  const r1 = rad(a[0]), r2 = rad(a[1]);
  const x1 = x0 + side * l[0] * Math.sin(r1) * cos, y1 = y0 + l[0] * Math.cos(r1);
  const x2 = x1 + side * l[1] * Math.sin(r2) * cos, y2 = y1 + l[1] * Math.cos(r2);
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.lineTo(x2, y2);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = OUT;
  g.lineWidth = 7;
  g.stroke();
  g.strokeStyle = '#8a5a3a';
  g.lineWidth = 4.2;
  g.stroke();
  g.strokeStyle = 'rgba(255,214,170,0.55)';
  g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(x0 - 0.8, y0);
  g.lineTo(x1 - 0.8, y1);
  g.lineTo(x2 - 0.8, y2);
  g.stroke();
  return [x2, y2];
}

function shoe(g: Ctx, x: number, y: number, side: number, tilt: number): void {
  g.save();
  g.translate(x + side * 1.5, y + 1.6);
  g.rotate(rad(tilt));
  g.beginPath();
  g.ellipse(0, 0, 8.2, 4.9, 0, 0, Math.PI * 2);
  g.fillStyle = '#4f9fe6';
  g.fill();
  g.lineWidth = 1.8;
  g.strokeStyle = OUT;
  g.stroke();
  g.beginPath();
  g.ellipse(-1, -1.9, 5, 1.7, 0, 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,255,255,0.4)';
  g.fill();
  g.beginPath();
  g.moveTo(-7, 2.6);
  g.lineTo(7, 2.6);
  g.strokeStyle = '#f4f8ff';
  g.lineWidth = 1.5;
  g.stroke();
  g.restore();
}

function hand(g: Ctx, x: number, y: number): void {
  g.beginPath();
  g.arc(x, y, 4.7, 0, Math.PI * 2);
  g.fillStyle = '#ffedc9';
  g.fill();
  g.lineWidth = 1.8;
  g.strokeStyle = OUT;
  g.stroke();
}

function bodyPath(g: Ctx, sx: number): void {
  // an apple: a dent at the top between two shoulders, a slightly dimpled bottom
  const X = (x: number) => 55 + (x - 55) * sx;
  g.beginPath();
  g.moveTo(X(55), 44);
  g.bezierCurveTo(X(62), 38, X(76), 36, X(83), 45);
  g.bezierCurveTo(X(92), 56, X(91), 77, X(80), 90);
  g.bezierCurveTo(X(73), 99, X(63), 101, X(55), 97.5);
  g.bezierCurveTo(X(47), 101, X(37), 99, X(30), 90);
  g.bezierCurveTo(X(19), 77, X(18), 56, X(27), 45);
  g.bezierCurveTo(X(34), 36, X(48), 38, X(55), 44);
  g.closePath();
}

function drawEyes(g: Ctx, P: Pose, cos: number, shift: number): void {
  const ey = 67;
  for (const side of [-1, 1]) {
    const x = 55 + shift + side * 10.5 * cos;
    const w = Math.max(0.35, cos);
    g.save();
    g.translate(x, ey);
    g.scale(w, 1);
    switch (P.eyes) {
      case 'open': {
        g.beginPath();
        g.ellipse(P.look * 1.4, 0, 3.6, 5.1, 0, 0, Math.PI * 2);
        g.fillStyle = '#2a1519';
        g.fill();
        g.beginPath();
        g.arc(P.look * 1.4 + 1.2, -1.9, 1.35, 0, Math.PI * 2);
        g.fillStyle = '#fff';
        g.fill();
        break;
      }
      case 'wide': {
        g.beginPath();
        g.ellipse(0, 0, 5.2, 5.8, 0, 0, Math.PI * 2);
        g.fillStyle = '#fff';
        g.fill();
        g.lineWidth = 1.5;
        g.strokeStyle = OUT;
        g.stroke();
        g.beginPath();
        g.arc(0, 0.6, 2.4, 0, Math.PI * 2);
        g.fillStyle = '#2a1519';
        g.fill();
        break;
      }
      case 'happy': {
        g.beginPath();
        g.moveTo(-4.2, 2);
        g.quadraticCurveTo(0, -6, 4.2, 2);
        g.lineWidth = 2.2;
        g.lineCap = 'round';
        g.strokeStyle = '#2a1519';
        g.stroke();
        break;
      }
      case 'closed': {
        g.beginPath();
        g.moveTo(-4, 0);
        g.quadraticCurveTo(0, 3.6, 4, 0);
        g.lineWidth = 2.1;
        g.lineCap = 'round';
        g.strokeStyle = '#2a1519';
        g.stroke();
        break;
      }
      case 'x': {
        g.beginPath();
        g.moveTo(-3.6, -3.6); g.lineTo(3.6, 3.6);
        g.moveTo(3.6, -3.6); g.lineTo(-3.6, 3.6);
        g.lineWidth = 2.1;
        g.lineCap = 'round';
        g.strokeStyle = '#2a1519';
        g.stroke();
        break;
      }
      case 'gt': {
        g.beginPath();
        g.moveTo(-3.8 * side, -3.8); g.lineTo(3.2 * side, 0); g.lineTo(-3.8 * side, 3.8);
        g.lineWidth = 2.2;
        g.lineCap = 'round';
        g.lineJoin = 'round';
        g.strokeStyle = '#2a1519';
        g.stroke();
        break;
      }
    }
    g.restore();
  }
}

function drawMouth(g: Ctx, P: Pose, cos: number, shift: number): void {
  const x = 55 + shift, y = 77.5;
  g.save();
  g.translate(x, y);
  g.scale(Math.max(0.35, cos), 1);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  switch (P.mouth) {
    case 'smile':
      g.beginPath();
      g.moveTo(-4.8, 0);
      g.quadraticCurveTo(0, 5.4, 4.8, 0);
      g.lineWidth = 2;
      g.strokeStyle = '#5a1d26';
      g.stroke();
      break;
    case 'grin':
    case 'open': {
      const h = P.mouth === 'grin' ? 5.2 : 6.4;
      g.beginPath();
      g.moveTo(-6, -0.5);
      g.quadraticCurveTo(0, h * 2, 6, -0.5);
      g.closePath();
      g.fillStyle = '#5a1d26';
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = OUT;
      g.stroke();
      g.beginPath();
      g.ellipse(0, h * 0.95, 3, 1.7, 0, 0, Math.PI * 2);
      g.fillStyle = '#ff7d8f';
      g.fill();
      break;
    }
    case 'o':
      g.beginPath();
      g.ellipse(0, 1, 2.9, 3.7, 0, 0, Math.PI * 2);
      g.fillStyle = '#5a1d26';
      g.fill();
      g.lineWidth = 1.4;
      g.strokeStyle = OUT;
      g.stroke();
      break;
    case 'flat':
      g.beginPath();
      g.moveTo(-4, 1);
      g.lineTo(4, 1);
      g.lineWidth = 2;
      g.strokeStyle = '#5a1d26';
      g.stroke();
      break;
    case 'zig':
      g.beginPath();
      g.moveTo(-6, 1);
      g.lineTo(-3, 4);
      g.lineTo(0, 0);
      g.lineTo(3, 4);
      g.lineTo(6, 1);
      g.lineWidth = 2;
      g.strokeStyle = '#5a1d26';
      g.stroke();
      break;
  }
  g.restore();
}

/** Draw one pose into a 110 x 128 cell (the caller scales the context). */
function drawPippin(g: Ctx, P: Pose): void {
  const cos = Math.cos(rad(P.yaw));
  const acos = Math.abs(cos);
  const front = cos > 0.12;
  const back = cos < -0.12;
  g.save();
  g.translate(P.ax, P.ay);
  g.rotate(rad(P.rot));
  g.scale(P.sx * SCALE, P.sy * SCALE);
  g.translate(-P.px, -P.py);
  const mid = 55;
  const X = (x: number) => mid + (x - mid) * acos;

  // seen edge-on the arms are hidden behind the body instead of floating in front of it
  const armsBehind = acos < 0.3;
  const arms = (): void => {
    for (const side of [-1, 1]) {
      const A = side < 0 ? P.armL : P.armR;
      const [hx, hy] = limb(g, X(mid + side * SHOULDER_X * (0.96 + 0.04 * acos)), SHOULDER_Y, A, ARM, side, acos);
      hand(g, hx, hy);
    }
  };
  if (armsBehind) arms();

  // legs and shoes
  for (const side of [-1, 1]) {
    const L = side < 0 ? P.legL : P.legR;
    const [fx, fy] = limb(g, X(mid + side * HIP_X), HIP_Y, L, LEG, side, acos);
    shoe(g, fx, fy, side, side * (L[1] > 0 ? 6 : -10));
  }

  // body
  const bsx = 0.9 + 0.1 * acos;
  bodyPath(g, bsx);
  const grad = g.createRadialGradient(mid - 12 * acos * (front ? 1 : -1), 54, 4, mid, 70, 42);
  if (back) {
    grad.addColorStop(0, '#e8444e');
    grad.addColorStop(0.55, '#cf2f3e');
    grad.addColorStop(1, '#9c1f33');
  } else {
    grad.addColorStop(0, '#ff8a7d');
    grad.addColorStop(0.45, '#f0474f');
    grad.addColorStop(1, '#bf2438');
  }
  g.fillStyle = grad;
  g.fill();
  g.lineWidth = 2.4;
  g.lineJoin = 'round';
  g.strokeStyle = OUT;
  g.stroke();
  // soft rim light and highlight
  g.save();
  bodyPath(g, bsx);
  g.clip();
  g.beginPath();
  g.ellipse(mid - 17 * acos * (front ? 1 : 0) + (back ? 17 * acos : 0), 53, 5.5, 10, rad(-28), 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,255,255,0.34)';
  g.fill();
  g.beginPath();
  g.ellipse(mid, 101, 30, 8, 0, 0, Math.PI * 2);
  g.fillStyle = 'rgba(80,0,20,0.18)';
  g.fill();
  g.restore();

  // face
  if (front) {
    const shift = Math.sin(rad(P.yaw)) * 20;
    for (const side of [-1, 1]) {
      g.beginPath();
      g.ellipse(mid + shift + side * 19 * cos, 76, 5.2 * Math.max(0.35, cos), 3.2, 0, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255,150,170,0.62)';
      g.fill();
    }
    drawEyes(g, P, cos, shift);
    drawMouth(g, P, cos, shift);
  } else if (back) {
    // the back of the apple: a few soft speckles
    g.fillStyle = 'rgba(255,255,255,0.14)';
    for (const [x, y] of [[40, 62], [64, 58], [52, 80], [70, 78], [38, 82]] as const) {
      g.beginPath();
      g.arc(X(x), y, 1.6, 0, Math.PI * 2);
      g.fill();
    }
  }

  // stem and leaf
  g.beginPath();
  g.moveTo(55, 46);
  g.bezierCurveTo(55, 39, 56.5, 34, 60, 30);
  g.lineCap = 'round';
  g.strokeStyle = OUT;
  g.lineWidth = 5.4;
  g.stroke();
  g.strokeStyle = '#7a4e2c';
  g.lineWidth = 3;
  g.stroke();
  g.save();
  g.translate(58.5, 32);
  g.scale(Math.max(0.3, acos * 0.4 + 0.6), 1);
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(5, -9, 17, -13, 27, -8);
  g.bezierCurveTo(23, 2, 11, 7, 0, 0);
  g.closePath();
  const lg = g.createLinearGradient(0, -12, 24, 4);
  lg.addColorStop(0, '#8be07a');
  lg.addColorStop(1, '#3da552');
  g.fillStyle = lg;
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = '#1f4a2b';
  g.stroke();
  g.beginPath();
  g.moveTo(2, -1);
  g.quadraticCurveTo(12, -7, 22, -6);
  g.lineWidth = 1.2;
  g.strokeStyle = 'rgba(230,255,220,0.7)';
  g.stroke();
  g.restore();

  // arms in front
  if (!armsBehind) arms();
  g.restore();
}

// ------------------------------------------------------------------ sheets

/** Pippin's sheet: 8 x 10 cells of 220 x 256 px, the rows Waiting .. Dervish and Held. */
export function makePippinSheet(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = CELL_W * 8;
  c.height = CELL_H * 10;
  const g = c.getContext('2d');
  if (!g) return c;
  for (let row = 0; row < 10; row++) {
    for (let f = 0; f < 8; f++) {
      g.save();
      g.beginPath();
      g.rect(f * CELL_W, row * CELL_H, CELL_W, CELL_H);
      g.clip();
      g.translate(f * CELL_W, row * CELL_H);
      g.scale(CELL_W / 110, CELL_H / 128);
      drawPippin(g, poseOf(row, f));
      g.restore();
    }
  }
  return c;
}

/** Strokes of the countdown digits in a unit square. */
const DIGITS: Record<number, number[][][]> = {
  1: [[[0.3, 0.3], [0.54, 0.12], [0.54, 0.88]], [[0.32, 0.88], [0.76, 0.88]]],
  2: [[[0.22, 0.3], [0.3, 0.16], [0.5, 0.11], [0.7, 0.17], [0.78, 0.33], [0.68, 0.5], [0.22, 0.88], [0.8, 0.88]]],
  3: [[[0.22, 0.2], [0.46, 0.11], [0.7, 0.18], [0.76, 0.33], [0.62, 0.47], [0.42, 0.5]], [[0.42, 0.5], [0.66, 0.54], [0.8, 0.68], [0.72, 0.84], [0.48, 0.9], [0.2, 0.82]]],
  4: [[[0.64, 0.88], [0.64, 0.1], [0.18, 0.64], [0.86, 0.64]]],
};

function digit(g: Ctx, d: number, cx: number, cy: number, size: number, ghost: boolean): void {
  g.save();
  g.translate(cx - size / 2, cy - size / 2);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.globalAlpha = ghost ? 0.3 : 1;
  const strokes = DIGITS[d] ?? [];
  const path = (): void => {
    g.beginPath();
    for (const s of strokes) {
      s.forEach(([x, y], i) => (i === 0 ? g.moveTo(x * size, y * size) : g.lineTo(x * size, y * size)));
    }
  };
  path();
  g.strokeStyle = ghost ? '#dfe6ff' : '#1a2233';
  g.lineWidth = size * 0.19;
  g.stroke();
  path();
  const grad = g.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, ghost ? '#ffffff' : '#fff3a8');
  grad.addColorStop(1, ghost ? '#cfd8ff' : '#ffb829');
  g.strokeStyle = grad;
  g.lineWidth = size * 0.115;
  g.stroke();
  g.restore();
}

/** The countdown sheet: 8 cells of 200 x 200 px in one row, a bold digit then its ghost for 1, 2, 3 and 4. */
export function makeCountSheet(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = COUNT_CELL * 8;
  c.height = COUNT_CELL;
  const g = c.getContext('2d');
  if (!g) return c;
  for (let f = 0; f < 8; f++) {
    const d = 1 + (f >> 1);
    digit(g, d, f * COUNT_CELL + COUNT_CELL / 2, COUNT_CELL / 2, COUNT_CELL * 0.74, (f & 1) === 1);
  }
  return c;
}
