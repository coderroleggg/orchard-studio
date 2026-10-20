// Procedural textures for the Hardcore editor (brushed metal, the board's dark
// grain, rubber and the mottled pedal faces), drawn once into a canvas and
// cached as data URLs. Seeded, so every render looks the same.

const cache = new Map<string, string>();

function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Smooth 1-D noise along a row: random values every `len` px, cosine interpolated. */
function noiseRow(w: number, len: number, r: () => number): Float32Array {
  const n = Math.ceil(w / len) + 2;
  const k = Array.from({ length: n }, () => r() * 2 - 1);
  const out = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const p = x / len, i = Math.floor(p), f = p - i;
    const t = (1 - Math.cos(Math.PI * f)) / 2;
    out[x] = k[i] * (1 - t) + k[i + 1] * t;
  }
  return out;
}

function make(key: string, w: number, h: number, paint: (d: Uint8ClampedArray, w: number, h: number) => void): string {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let url = '';
  try {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (g) {
      const img = g.createImageData(w, h);
      paint(img.data, w, h);
      g.putImageData(img, 0, 0);
      url = c.toDataURL('image/png');
    }
  } catch { url = ''; }
  cache.set(key, url);
  return url;
}

/**
 * Brushed metal: grey rows of long streaks. `base` mean level (0..255), `amp`
 * streak contrast, `grain` per-pixel noise, `len` streak length (px).
 */
export function brushed(key: string, w: number, h: number, base: number, amp: number, grain: number, len: number, seed: number, vertical = false): string {
  return make(`brushed:${key}`, w, h, (d) => {
    const r = rng(seed);
    const rows = vertical ? w : h, cols = vertical ? h : w;
    for (let y = 0; y < rows; y++) {
      const a = noiseRow(cols, len * (0.6 + r() * 0.8), r);
      const b = noiseRow(cols, len * 0.15 + 2, r);
      const rowOff = (r() * 2 - 1) * amp * 0.6;
      for (let x = 0; x < cols; x++) {
        const v = base + rowOff + amp * (0.7 * a[x] + 0.3 * b[x]) + (r() * 2 - 1) * grain;
        const i = vertical ? (x * w + y) * 4 : (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
    }
  });
}

/** Translucent mottled overlay (grey, alpha) for the coloured pedal faces. */
export function mottle(key: string, w: number, h: number, seed: number, strength: number): string {
  return make(`mottle:${key}`, w, h, (d) => {
    const r = rng(seed);
    // value noise, three octaves
    const oct = [12, 5, 2.2].map((cell) => {
      const gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2;
      const g = Float32Array.from({ length: gw * gh }, () => r() * 2 - 1);
      return { cell, gw, g };
    });
    // a few thin dark veins (the cracked lacquer of the original faces)
    const veins = new Float32Array(w * h);
    for (let v = 0; v < 14; v++) {
      let x = r() * w, y = r() * h, ang = r() * Math.PI * 2;
      const steps = 20 + r() * 60;
      for (let s = 0; s < steps; s++) {
        ang += (r() - 0.5) * 0.9;
        x += Math.cos(ang); y += Math.sin(ang);
        const xi = Math.round(x), yi = Math.round(y);
        if (xi >= 0 && yi >= 0 && xi < w && yi < h) veins[yi * w + xi] = 1;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 0, amp = 1;
        for (const o of oct) {
          const px = x / o.cell, py = y / o.cell, ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
          const a = o.g[iy * o.gw + ix], b = o.g[iy * o.gw + ix + 1], c = o.g[(iy + 1) * o.gw + ix], e = o.g[(iy + 1) * o.gw + ix + 1];
          const top = a + (b - a) * fx, bot = c + (e - c) * fx;
          v += (top + (bot - top) * fy) * amp;
          amp *= 0.5;
        }
        const i = (y * w + x) * 4;
        const dark = veins[y * w + x] ? 0.22 : 0;
        const lum = v > 0 ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = dark ? 0 : lum;
        d[i + 3] = Math.min(255, (Math.abs(v) * 0.6 + dark) * strength * 255);
      }
    }
  });
}

/** Fine noise (rubber, LCD backgrounds): grey around `base` with +-`amp`. */
export function grain(key: string, w: number, h: number, base: number, amp: number, seed: number): string {
  return make(`grain:${key}`, w, h, (d) => {
    const r = rng(seed);
    for (let i = 0; i < w * h; i++) {
      const v = base + (r() * 2 - 1) * amp;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }
  });
}
