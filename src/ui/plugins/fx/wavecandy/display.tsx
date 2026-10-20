// Wave Candy display window: FL shows the visualisation in its own window
// (a layered window over the desktop). Here it is a floating panel in the
// page, shown while the plugin editor is open and "Visible" is on: drag to
// move and drag the edges to resize (when "Solid"), right-click for FL's
// display menu, middle-click to hold. Everything is drawn from the 28 colour
// targets: frame (background, punches, border), bevel or reflection, glass,
// glowing lights, title, and the oscilloscope, spectrum, meter, vectorscope
// or mini view.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  T, WC_MODES, WC_SPEC_ROWS, rgba, wcColor, wcEffectiveMode, wcFracFreq, wcFreqFrac, wcGain, wcMeterAmp, wcMeterFrac,
  type WcRgba, type WcState,
} from '../../../../model/fx/plugins/wavecandy';
import { useFxMonitor } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import * as A from '../../../../store/actions';

interface Live {
  osc: Float32Array | null;
  vec: Float32Array | null;
  pending: Float32Array[]; // spectrum columns not drawn yet
  colDt: number;
  meter: { l: number; r: number; hl: number; hr: number; hlt: number; hrt: number; pl: number; pr: number };
  quiet: number;
  quietAt: number;
  sono: HTMLCanvasElement | null;
  sono2: HTMLCanvasElement | null;
  sonoKey: string;
  mouse: { x: number; y: number } | null;
  last: number;
}

function newLive(): Live {
  return {
    osc: null, vec: null, pending: [], colDt: 0.015, meter: { l: 0, r: 0, hl: 0, hr: 0, hlt: 0, hrt: 0, pl: 0, pr: 0 },
    quiet: 0, quietAt: 0, sono: null, sono2: null, sonoKey: '', mouse: null, last: 0,
  };
}

const MARGIN = 8;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

/** Corner radius for FL's Corners wheel (0..512, 256 = 16 px). */
export function cornerRadius(s: WcState, w: number, h: number): number {
  return Math.min(s.corners / 16, w / 2, h / 2);
}

function titleFont(s: WcState): string {
  return `${s.fontStyle & 1 ? 'italic ' : ''}${s.fontStyle & 2 ? 'bold ' : ''}${s.fontSize}px "${s.font}", "Trebuchet MS", Tahoma, sans-serif`;
}

/** Frame: background, punches, border, bevel, glass, glowing lights and glow. */
function drawFrame(g: CanvasRenderingContext2D, s: WcState, w: number, h: number, cols: WcRgba[]) {
  const r = cornerRadius(s, w, h);
  if (s.glow) {
    g.save();
    g.shadowColor = rgba(cols[T.glow], 0.9);
    g.shadowBlur = 10;
    roundRect(g, 0.5, 0.5, w - 1, h - 1, r);
    g.strokeStyle = rgba(cols[T.glow], 0.6);
    g.lineWidth = 1.5;
    g.stroke();
    g.restore();
  }
  roundRect(g, 0, 0, w, h, r);
  g.fillStyle = rgba(cols[T.background]);
  g.fill();
  if (s.punches !== 0) {
    g.save();
    roundRect(g, 0, 0, w, h, r);
    g.clip();
    const size = Math.abs(s.punches) / 3 + 0.8, pitch = size * 2.6 + 2;
    g.fillStyle = rgba(cols[T.punches]);
    for (let y = pitch / 2; y < h; y += pitch) {
      for (let x = pitch / 2 + ((Math.round(y / pitch) % 2) * pitch) / 2; x < w; x += pitch) {
        if (s.punches > 0) { g.beginPath(); g.arc(x, y, size / 2, 0, Math.PI * 2); g.fill(); } else g.fillRect(x - size / 2, y - size / 2, size, size);
      }
    }
    g.restore();
  }
}

function drawFrameTop(g: CanvasRenderingContext2D, s: WcState, w: number, h: number, cols: WcRgba[]) {
  const r = cornerRadius(s, w, h);
  g.save();
  roundRect(g, 0, 0, w, h, r);
  g.clip();
  // glass: glossy upper half
  const gl = cols[T.glass];
  const ga = gl.oa * gl.a;
  if (ga > 0) {
    const gr = g.createLinearGradient(0, 0, 0, h * 0.56);
    gr.addColorStop(0, rgba(gl, Math.min(0.9, ga * 1.6)));
    gr.addColorStop(1, rgba(gl, ga * 0.3));
    g.fillStyle = gr;
    g.beginPath();
    g.roundRect(0, 0, w, h * 0.56, [r, r, Math.min(r, 6), Math.min(r, 6)]);
    g.fill();
  }
  // glowing lights at the sides
  const lt = cols[T.glow];
  const la = Math.min(1, lt.oa * lt.a * 5);
  if (la > 0) {
    for (const x of [0, w]) {
      const rad = Math.max(6, Math.min(w, h) * 0.11);
      const gr = g.createRadialGradient(x, h * 0.42, 0, x, h * 0.42, rad);
      gr.addColorStop(0, rgba(lt, la));
      gr.addColorStop(1, rgba(lt, 0));
      g.fillStyle = gr;
      g.fillRect(x - rad, h * 0.42 - rad, rad * 2, rad * 2);
    }
  }
  // bevel (Reflect / bevel turned left)
  if (s.reflect < 0) {
    const bw = (-s.reflect / 256) * 10;
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, rgba(cols[T.bevelTop]));
    gr.addColorStop(1, rgba(cols[T.bevelBottom]));
    g.strokeStyle = gr;
    g.lineWidth = bw;
    roundRect(g, bw / 2, bw / 2, w - bw, h - bw, Math.max(0, r - bw / 2));
    g.stroke();
  }
  g.restore();
  roundRect(g, 0.75, 0.75, w - 1.5, h - 1.5, r);
  g.strokeStyle = rgba(cols[T.border]);
  g.lineWidth = 1.5;
  g.stroke();
}

function drawTitle(g: CanvasRenderingContext2D, s: WcState, w: number, cols: WcRgba[]) {
  if (!s.title) return;
  g.font = titleFont(s);
  g.fillStyle = rgba(cols[T.title]);
  g.textBaseline = 'top';
  g.textAlign = s.titleAlign === 2 ? 'right' : s.titleAlign === 1 ? 'center' : 'left';
  const x = s.titleAlign === 2 ? w - MARGIN - 2 : s.titleAlign === 1 ? w / 2 : MARGIN + 2;
  g.fillText(s.title, x, MARGIN - 2);
}

function labelPair(g: CanvasRenderingContext2D, num: string, unit: string, x: number, y: number, c: WcRgba, size = 10) {
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.font = `bold ${size}px Tahoma, Verdana, sans-serif`;
  const w1 = g.measureText(num).width;
  g.font = `${size}px Tahoma, Verdana, sans-serif`;
  const w2 = g.measureText(unit).width;
  const x0 = x - w1 - w2;
  g.font = `bold ${size}px Tahoma, Verdana, sans-serif`;
  g.fillStyle = rgba(c);
  g.fillText(num, x0, y);
  g.font = `${size}px Tahoma, Verdana, sans-serif`;
  g.fillStyle = rgba(c, c.a * c.oa * 0.55);
  g.fillText(unit, x0 + w1, y);
}

// ------------------------------------------------------------------ modes

function drawOsc(g: CanvasRenderingContext2D, s: WcState, live: Live, x: number, y: number, w: number, h: number, cols: WcRgba[]) {
  const ru = cols[T.oscRuler];
  const cy = y + h / 2;
  g.fillStyle = rgba(ru);
  g.fillRect(x, Math.round(cy), w, 1);
  g.fillStyle = rgba(ru, ru.a * ru.oa * 0.5);
  g.fillRect(Math.round(x + w / 2), y, 1, h);
  for (let k = 1; k < 8; k++) {
    const yy = Math.round(y + (h * k) / 8);
    const long = k === 2 || k === 6;
    g.fillRect(Math.round(x + w / 2 - (long ? 9 : 4)), yy, long ? 18 : 8, 1);
  }
  const d = live.osc;
  if (!d) return;
  const n = d.length / 2;
  if (n < 2) return;
  const gain = wcGain(s.gain);
  const amp = (h / 2) * 0.92 * gain;
  const lw = Math.max(1.5, Math.min(w, h) / 70);
  const wave = cols[T.waveform];
  g.strokeStyle = rgba(wave);
  g.lineWidth = lw;
  g.lineJoin = 'round';
  const sep = s.oscSep;
  const chans = sep < 0 ? [-1] : [0, 1];
  for (const ch of chans) {
    const off = ch < 0 ? 0 : (ch === 0 ? -1 : 1) * (sep / 1000) * (h / 4);
    const scale = ch < 0 ? amp : amp * (1 - (sep / 1000) * 0.5);
    g.beginPath();
    let px = 0, py = 0;
    for (let i = 0; i < n; i++) {
      let v = ch < 0 ? (d[i] + d[n + i]) * 0.5 : d[ch * n + i];
      if (s.oscPinch) {
        const t = i / (n - 1), e = Math.min(t, 1 - t) / 0.18;
        if (e < 1) v *= Math.sin((Math.PI / 2) * e);
      }
      const xx = x + (w * i) / (n - 1), yy = cy + off - Math.max(-1.6, Math.min(1.6, v)) * scale;
      if (i === 0) g.moveTo(xx, yy);
      else if (s.oscInterp && n < w) g.quadraticCurveTo(px, py, (px + xx) / 2, (py + yy) / 2);
      else g.lineTo(xx, yy);
      px = xx; py = yy;
    }
    if (s.oscInterp && n < w) g.lineTo(px, py);
    g.stroke();
  }
}

/** 256-entry RGBA (premultiplied semantics of FL's gradient stops) for the sonogram. */
function spectrumLut(cols: WcRgba[]): Uint8ClampedArray {
  const stops = [T.spec1, T.spec2, T.spec3, T.spec4, T.spec5].map((i) => cols[i]);
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * 4, k = Math.min(3, Math.floor(t)), f = t - k;
    const a = stops[k], b = stops[k + 1];
    const aa = a.oa * a.a, ba = b.oa * b.a;
    const al = aa + (ba - aa) * f;
    const pr = a.r * aa + (b.r * ba - a.r * aa) * f, pg = a.g * aa + (b.g * ba - a.g * aa) * f, pb = a.b * aa + (b.b * ba - a.b * aa) * f;
    lut[i * 4] = al > 0 ? pr / al : 0;
    lut[i * 4 + 1] = al > 0 ? pg / al : 0;
    lut[i * 4 + 2] = al > 0 ? pb / al : 0;
    lut[i * 4 + 3] = al * 255;
  }
  return lut;
}

function drawSpectrum(g: CanvasRenderingContext2D, s: WcState, live: Live, x: number, y: number, w: number, h: number, cols: WcRgba[], dpr: number) {
  const cw = Math.max(1, Math.round(w * dpr)), ch = Math.max(1, Math.round(h * dpr));
  const key = `${cw}x${ch}`;
  if (!live.sono || !live.sono2 || live.sonoKey !== key) {
    for (const k of ['sono', 'sono2'] as const) {
      const c = document.createElement('canvas');
      c.width = cw;
      c.height = ch;
      live[k] = c;
    }
    live.sonoKey = key;
  }
  const sg = live.sono2!.getContext('2d');
  if (sg && live.pending.length) {
    const lut = spectrumLut(cols);
    const gainDb = s.gain / 10;
    const range = s.specRange;
    // device pixels per column: 1 per "Update" period
    const per = Math.max(1, Math.round((live.colDt / (s.specUpdate / 100000)) * dpr));
    const k = Math.min(cw, live.pending.length * per);
    // scroll: copy the old image shifted left into the back buffer, then swap
    sg.clearRect(0, 0, cw, ch);
    sg.drawImage(live.sono!, -k, 0);
    const img = sg.createImageData(k, ch);
    const rowOf = new Float32Array(ch);
    for (let py = 0; py < ch; py++) {
      const f = wcFracFreq(1 - (py + 0.5) / ch, s.specScale);
      rowOf[py] = (Math.log(f / 20) / Math.log(1000)) * (WC_SPEC_ROWS - 1);
    }
    const cols0 = live.pending.slice(-Math.ceil(k / per));
    for (let c = 0; c < cols0.length; c++) {
      const col = cols0[c];
      for (let py = 0; py < ch; py++) {
        const rf = rowOf[py], r0 = Math.max(0, Math.min(WC_SPEC_ROWS - 2, Math.floor(rf))), fr = Math.max(0, Math.min(1, rf - r0));
        let db = col[r0] + (col[r0 + 1] - col[r0]) * fr + gainDb;
        if (s.specNatural) db += 10 * Math.log10(Math.max(20, wcFracFreq(1 - (py + 0.5) / ch, s.specScale)) / 1000);
        const t = Math.max(0, Math.min(255, Math.round(((db + range) / range) * 255)));
        for (let p = 0; p < per; p++) {
          const xx = c * per + p - (cols0.length * per - k);
          if (xx < 0 || xx >= k) continue;
          const o = (py * k + xx) * 4;
          img.data[o] = lut[t * 4]; img.data[o + 1] = lut[t * 4 + 1]; img.data[o + 2] = lut[t * 4 + 2]; img.data[o + 3] = lut[t * 4 + 3];
        }
      }
    }
    sg.putImageData(img, cw - k, 0);
    live.pending.length = 0;
    [live.sono, live.sono2] = [live.sono2, live.sono];
  }
  if (live.sono) g.drawImage(live.sono, x, y, w, h);
  // piano keyboard (Scale fully right) and frequency labels
  const lab = cols[T.labels];
  if (s.specScale >= 256) {
    for (let key = 24; key <= 132; key++) {
      const f0 = 440 * Math.pow(2, (key - 0.5 - 69) / 12), f1 = 440 * Math.pow(2, (key + 0.5 - 69) / 12);
      if (f1 < 20 || f0 > 20000) continue;
      const y0 = y + h * (1 - wcFreqFrac(f1, 256)), y1 = y + h * (1 - wcFreqFrac(f0, 256));
      const black = [1, 3, 6, 8, 10].includes(key % 12);
      g.fillStyle = black ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.42)';
      g.fillRect(x, y0, black ? 9 : 14, Math.max(0.5, y1 - y0 - 0.4));
      if (key % 12 === 0) labelPair(g, `C${Math.floor(key / 12)}`, '', x + 34, (y0 + y1) / 2, lab, 9);
    }
  }
  let lastY = 1e9;
  for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 20000]) {
    const yy = y + h * (1 - wcFreqFrac(f, s.specScale));
    if (yy < y + 6 || Math.abs(lastY - yy) < 13) continue;
    lastY = yy;
    const num = f >= 1000 ? `${f / 1000}k` : String(f);
    labelPair(g, num, 'Hz', x + (s.specScale >= 256 ? 64 : 44), yy, lab, 10);
  }
}

const METER_LABELS = [6, 3, 1, 0, -1, -2, -3, -4, -6, -8, -10, -13, -17, -24, -30, -36, -48, -60];

function meterGradient(g: CanvasRenderingContext2D, s: WcState, y: number, h: number, cols: WcRgba[]): CanvasGradient {
  const gr = g.createLinearGradient(0, y + h, 0, y);
  const at = (db: number) => Math.max(0, Math.min(1, wcMeterFrac(Math.pow(10, db / 20), s.meterScale)));
  gr.addColorStop(0, rgba(cols[T.meterInf], 1));
  gr.addColorStop(at(-6), rgba(cols[T.meter6], 1));
  gr.addColorStop(Math.max(at(-6), at(-0.05)), rgba(cols[T.meter0], 1));
  gr.addColorStop(Math.min(1, at(0.05)), rgba(cols[T.meterP0], 1));
  gr.addColorStop(Math.max(at(0.05), at(6)), rgba(cols[T.meterP6], 1));
  return gr;
}

function drawMeter(g: CanvasRenderingContext2D, s: WcState, live: Live, x: number, y: number, w: number, h: number, cols: WcRgba[], t: number, mini: boolean) {
  const m = live.meter;
  const dt = live.last ? Math.min(0.1, (t - live.last) / 1000) : 0;
  const gain = wcGain(s.gain);
  const fall = dt / Math.max(0.001, s.meterSpeed / 1000);
  const step = (cur: number, target: number) => (target >= cur ? target : Math.max(target, cur - fall));
  const tl = wcMeterFrac(m.pl * gain, s.meterScale), tr = wcMeterFrac(m.pr * gain, s.meterScale);
  m.l = step(m.l, tl); m.r = step(m.r, tr);
  m.pl = m.pr = 0;
  const hold = (v: number, hv: number, ht: number): [number, number] => {
    if (s.meterHold <= 0) return [0, t];
    if (v >= hv) return [v, t];
    if (s.meterHold >= 5001 || t - ht < s.meterHold) return [hv, ht];
    return [Math.max(v, hv - fall), ht];
  };
  [m.hl, m.hlt] = hold(m.l, m.hl, m.hlt);
  [m.hr, m.hrt] = hold(m.r, m.hr, m.hrt);
  const labW = mini ? 0 : Math.min(w * 0.42, 66);
  const bx = x + labW + (mini ? 0 : 6), bw = w - labW - (mini ? 0 : 6);
  const gap = Math.max(2, bw * 0.06), barW = (bw - gap) / 2;
  const grad = meterGradient(g, s, y, h, cols);
  for (let c = 0; c < 2; c++) {
    const xx = bx + c * (barW + gap);
    g.fillStyle = rgba(cols[T.meterBg]);
    g.fillRect(xx, y, barW, h);
    const v = c === 0 ? m.l : m.r, hv = c === 0 ? m.hl : m.hr;
    if (v > 0) { g.fillStyle = grad; g.fillRect(xx, y + h * (1 - v), barW, h * v); }
    if (hv > 0 && s.meterHold > 0) {
      const hy = Math.round(y + h * (1 - hv)) - 1;
      g.fillStyle = grad;
      g.fillRect(xx, hy, barW, 2);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(xx, hy, barW, 2);
    }
  }
  if (mini) return;
  const lab = cols[T.labels];
  const rx = x + labW - 2;
  g.fillStyle = rgba(lab, lab.a * lab.oa * 0.5);
  g.fillRect(rx + 4, y, 1, h);
  let lastY = -1e9;
  for (const db of METER_LABELS) {
    const f = wcMeterFrac(Math.pow(10, db / 20), s.meterScale);
    if (f > 0.985 || f <= 0.01) continue;
    const yy = y + h * (1 - f);
    if (yy - lastY < 11) continue;
    lastY = yy;
    labelPair(g, db > 0 ? `+${db}` : String(db), ' dB', rx, yy, lab, 10);
    g.fillStyle = rgba(lab, lab.a * lab.oa * 0.5);
    g.fillRect(rx + 1, Math.round(yy), 4, 1);
  }
}

function lissajouStyle(s: WcState, cols: WcRgba[]): { core: string; glow: string; dot: string } {
  const tint = cols[T.lissajou];
  const ta = tint.a;
  const mix = (r: number, gg: number, b: number) => `rgba(${Math.round(r + (tint.r - r) * ta)},${Math.round(gg + (tint.g - gg) * ta)},${Math.round(b + (tint.b - b) * ta)},`;
  switch (s.vecMode) {
    case 0: return { core: `${mix(235, 245, 255)}0.9)`, glow: `${mix(235, 245, 255)}0.2)`, dot: '' };
    case 1: return { core: `${mix(255, 168, 32)}0.85)`, glow: `${mix(255, 120, 10)}0.25)`, dot: `${mix(255, 214, 60)}0.9)` };
    case 2: return { core: `${mix(255, 236, 160)}0.95)`, glow: `${mix(255, 120, 20)}0.55)`, dot: '' };
    default: return { core: `${mix(200, 245, 255)}0.95)`, glow: `${mix(40, 150, 255)}0.28)`, dot: '' };
  }
}

function drawVector(g: CanvasRenderingContext2D, s: WcState, live: Live, x: number, y: number, w: number, h: number, cols: WcRgba[]) {
  const cx = x + w / 2, cy = y + h / 2, rad = Math.min(w, h) / 2;
  const ru = cols[T.vecRuler];
  g.fillStyle = rgba(ru);
  for (const [deg, a] of [[45, 1], [-45, 1], [22.5, 0.5], [-22.5, 0.5], [0, 0.35]] as const) {
    const dx = Math.sin((deg * Math.PI) / 180), dy = -Math.cos((deg * Math.PI) / 180);
    g.globalAlpha = a;
    for (let r = 6; r < rad * 1.05; r += 7) {
      g.fillRect(cx + dx * r - 0.75, cy + dy * r - 0.75, 1.5, 1.5);
      g.fillRect(cx - dx * r - 0.75, cy - dy * r - 0.75, 1.5, 1.5);
    }
  }
  g.globalAlpha = 1;
  const lab = cols[T.labels];
  g.font = '10px Tahoma, sans-serif';
  g.fillStyle = rgba(lab);
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.fillText('+ L', x + 4, y + 12);
  g.fillText('- R', x + 4, y + h - 10);
  g.textAlign = 'right';
  g.fillText('+ R', x + w - 4, y + 12);
  g.fillText('- L', x + w - 4, y + h - 10);
  const d = live.vec;
  if (!d) return;
  const n = d.length / 2;
  const k = (rad / 2) * 0.95 * wcGain(s.gain);
  const st = lissajouStyle(s, cols);
  const thick = s.vecThickness / 100;
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  if (s.vecAdd) g.globalCompositeOperation = 'lighter';
  const P = (i: number): [number, number] => [cx + (d[n + i] - d[i]) * k, cy - (d[i] + d[n + i]) * k];
  if (s.vecMode === 1) {
    for (let i = 0; i < n; i++) {
      const [px, py] = P(i);
      g.fillStyle = i % 3 ? st.core : st.dot;
      g.fillRect(px - thick / 2, py - thick / 2, thick, thick);
    }
  } else {
    const line = (width: number, color: string) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.beginPath();
      for (let i = 0; i < n; i++) { const [px, py] = P(i); if (i) g.lineTo(px, py); else g.moveTo(px, py); }
      g.stroke();
    };
    if (s.vecMode === 0) line(Math.max(1, thick * 0.4), st.core);
    else if (s.vecMode === 2) { line(thick * 1.6, st.glow); line(Math.max(1, thick * 0.55), st.core); }
    else { line(thick * 3, st.glow); line(thick * 1.4, st.glow); line(Math.max(1, thick * 0.4), st.core); }
  }
  g.restore();
}

function drawHint(g: CanvasRenderingContext2D, s: WcState, mode: number, live: Live, x: number, y: number, w: number, h: number, cols: WcRgba[]): string {
  const m = live.mouse;
  if (!m || m.x < x || m.x > x + w || m.y < y || m.y > y + h) return '';
  const hl = cols[T.hintLoc];
  g.fillStyle = rgba(hl);
  let text = '';
  if (mode === 1 || mode === 2) {
    g.fillRect(x, Math.round(m.y), w, 1);
    const fy = 1 - (m.y - y) / h;
    if (mode === 1) {
      const f = wcFracFreq(fy, s.specScale);
      const key = Math.round(69 + 12 * Math.log2(f / 440));
      text = `${f >= 1000 ? (f / 1000).toFixed(2) + ' kHz' : Math.round(f) + ' Hz'}  ${NOTE_NAMES[((key % 12) + 12) % 12]}${Math.floor(key / 12)}`;
    } else {
      const amp = wcMeterAmp(fy, s.meterScale) / wcGain(s.gain);
      text = amp > 1e-6 ? `${(20 * Math.log10(amp)).toFixed(1)} dB` : '-INF dB';
    }
  } else if (mode === 0) {
    g.fillRect(Math.round(m.x), y, 1, h);
    text = `${(((m.x - x) / w) * (s.oscWindow / 100)).toFixed(2)} ms`;
  }
  if (text) {
    const hc = cols[T.hint];
    g.font = 'bold 10px Tahoma, sans-serif';
    g.fillStyle = rgba(hc);
    g.textBaseline = 'bottom';
    g.textAlign = m.x > x + w / 2 ? 'right' : 'left';
    g.fillText(text, m.x + (m.x > x + w / 2 ? -5 : 5), Math.max(y + 12, m.y - 3));
  }
  return text;
}

/** Draw the whole display (frame + content) into `g` (size w x h). Exported for the gallery/tests. */
export function drawDisplay(g: CanvasRenderingContext2D, s: WcState, live: Live, w: number, h: number, t: number, dpr: number): string {
  const cols = s.colors.map((c) => wcColor(c));
  const mode = wcEffectiveMode(s);
  let fade = 1;
  if (!s.background && s.fade < 5001 && live.quiet * 1000 > s.fade) fade = Math.max(0, 1 - (live.quiet * 1000 - s.fade) / 400);
  g.save();
  g.globalAlpha = fade;
  if (s.background) drawFrame(g, s, w, h, cols);
  const pad = s.mini ? 4 : MARGIN;
  const top = s.mini ? 4 : MARGIN + (mode === 2 || mode === 1 ? 4 : 0);
  const x = pad, y = top, cw = w - 2 * pad, ch = h - top - pad;
  g.save();
  if (s.background) { roundRect(g, 0, 0, w, h, cornerRadius(s, w, h)); g.clip(); }
  if (mode === 0) drawOsc(g, s, live, x, y, cw, ch, cols);
  else if (mode === 1) drawSpectrum(g, s, live, x, y, cw, ch, cols, dpr);
  else if (mode === 2) drawMeter(g, s, live, s.mini ? x : x, y, cw, ch, cols, t, s.mini);
  else drawVector(g, s, live, x, y, cw, ch, cols);
  const hint = s.mini ? '' : drawHint(g, s, mode, live, x, y, cw, ch, cols);
  g.restore();
  if (s.background) drawFrameTop(g, s, w, h, cols);
  if (!s.mini) drawTitle(g, s, w, cols);
  g.restore();
  live.last = t;
  return hint;
}

// ------------------------------------------------------------------ gallery demo

/** Synthetic input for the editor gallery (no audio there): a few partials and a slow level wobble. */
function demoFeed(L: Live, t: number) {
  const sec = t / 1000;
  const n = 960, osc = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    const x = i / 48000;
    const v = 0.45 * Math.sin(2 * Math.PI * 110 * x) + 0.2 * Math.sin(2 * Math.PI * 330 * x + 0.7) + 0.12 * Math.sin(2 * Math.PI * 770 * x + sec);
    osc[i] = v;
    osc[n + i] = v * 0.8 + 0.1 * Math.sin(2 * Math.PI * 550 * x);
  }
  L.osc = osc;
  L.vec = osc;
  const lvl = 0.55 + 0.25 * Math.sin(sec * 1.7);
  L.meter.pl = Math.max(L.meter.pl, lvl);
  L.meter.pr = Math.max(L.meter.pr, lvl * 0.92);
  const count = L.last ? Math.max(1, Math.min(8, Math.round((t - L.last) / 15))) : 240;
  for (let c = count - 1; c >= 0; c--) {
    const ts = sec - c * 0.015;
    const col = new Float32Array(WC_SPEC_ROWS);
    const root = [110, 98, 131, 147][Math.floor(ts / 0.9) & 3];
    for (let r = 0; r < WC_SPEC_ROWS; r++) {
      const f = 20 * Math.pow(1000, r / (WC_SPEC_ROWS - 1));
      let db = -72 - 12 * Math.log10(f / 100) + 8 * Math.sin(ts * 9 + r * 0.31);
      for (let k = 1; k <= 9; k++) db = Math.max(db, -4 - 5 * Math.log2(k) - Math.abs(12 * Math.log2(f / (root * k))) * 26);
      col[r] = db;
    }
    L.pending.push(col);
  }
}

// ------------------------------------------------------------------ window

const REFLECT_H = 0.42;

/**
 * The display window. `host` "workspace": a frameless window inside the
 * workspace, stacked with the app's windows (z from the window store entry
 * `fxaux:<slotId>`, raised on click); "fixed": a viewport overlay (gallery).
 */
export function WaveCandyDisplay({ slotId, s, hold, onSettings, demo = false, host = 'fixed', z = 400, onFocus }: {
  slotId: string; s: WcState; hold: boolean; onSettings: () => void; demo?: boolean; host?: 'workspace' | 'fixed'; z?: number; onFocus?: () => void;
}) {
  const live = useRef<Live>(newLive());
  const canvas = useRef<HTMLCanvasElement>(null);
  const sRef = useRef(s);
  sRef.current = s;
  const [drag, setDrag] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragRef = useRef<{ mode: string; sx: number; sy: number; r: number[] } | null>(null);
  useFxMonitor(slotId, (d) => {
    const L = live.current;
    L.quiet = Number(d.quiet) || 0;
    if (d.osc instanceof Float32Array) L.osc = d.osc;
    if (d.vec instanceof Float32Array) L.vec = d.vec;
    if (d.spec instanceof Float32Array) {
      const n = Number(d.cols) || 0;
      for (let c = 0; c < n; c++) L.pending.push(d.spec.subarray(c * WC_SPEC_ROWS, (c + 1) * WC_SPEC_ROWS));
      if (L.pending.length > 400) L.pending.splice(0, L.pending.length - 400);
      L.colDt = Number(d.dt) || L.colDt;
    }
    if (d.mode === 2) {
      L.meter.pl = Math.max(L.meter.pl, Number(d.l) || 0);
      L.meter.pr = Math.max(L.meter.pr, Number(d.r) || 0);
    }
  });

  const rect = drag ?? (() => {
    const r = s.mini ? s.miniRect : s.rect;
    const ws = host === 'workspace' ? document.getElementById('workspace') : null;
    const vw = ws ? ws.clientWidth : window.innerWidth, vh = ws ? ws.clientHeight : window.innerHeight;
    const w = Math.max(24, Math.min(vw, r[2])), h = Math.max(24, Math.min(vh, r[3]));
    return { x: Math.max(0, Math.min(vw - w, r[0])), y: Math.max(0, Math.min(vh - h, r[1])), w, h };
  })();
  const reflectH = s.background && s.reflect > 0 && !s.mini ? Math.round(rect.h * REFLECT_H) : 0;

  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const c = canvas.current;
      if (!c) return;
      const st = sRef.current;
      const W = c.clientWidth, Hh = c.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(Hh * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(Hh * dpr); }
      const g = c.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, Hh);
      const rh = st.background && st.reflect > 0 && !st.mini ? Math.round(Hh / (1 + REFLECT_H) * REFLECT_H) : 0;
      const wh = Hh - rh;
      if (demo) demoFeed(live.current, t);
      const hint = drawDisplay(g, st, live.current, W, wh, t, dpr);
      if (live.current.mouse) setHint(hint || `Wave Candy: ${WC_MODES[wcEffectiveMode(st)]}`);
      if (rh > 0) {
        // reflection: the window mirrored below, fading out
        g.save();
        g.globalAlpha = Math.min(1, st.reflect / 256);
        g.translate(0, wh * 2 + 2);
        g.scale(1, -1);
        g.drawImage(c, 0, 0, W * dpr, wh * dpr, 0, 0, W, wh);
        g.restore();
        // tint with the Reflection top / bottom colours (only where the mirror has pixels)
        const cols = st.colors.map((cc) => wcColor(cc));
        g.save();
        g.globalCompositeOperation = 'source-atop';
        const tg = g.createLinearGradient(0, wh + 2, 0, Hh);
        tg.addColorStop(0, rgba(cols[T.reflTop]));
        tg.addColorStop(1, rgba(cols[T.reflBottom]));
        g.fillStyle = tg;
        g.fillRect(0, wh + 1, W, Hh - wh);
        g.restore();
        g.save();
        g.globalCompositeOperation = 'destination-out';
        const gr = g.createLinearGradient(0, wh + 2, 0, Hh);
        gr.addColorStop(0, 'rgba(0,0,0,0.35)');
        gr.addColorStop(1, 'rgba(0,0,0,1)');
        g.fillStyle = gr;
        g.fillRect(0, wh + 1, W, Hh - wh);
        g.restore();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const writeRect = (r: { x: number; y: number; w: number; h: number }) => {
    const key = sRef.current.mini ? 'miniRect' : 'rect';
    A.setFxStateNoHistory(slotId, 'Move Wave Candy display', (p) => { p[key] = [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]; });
  };

  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    const st = sRef.current;
    const set = (label: string, recipe: (p: Record<string, unknown>) => void) => A.editFx(slotId, label, recipe);
    const items: MenuItem[] = [
      { header: true, label: 'Window' },
      { label: 'Visible', checked: st.visible, onClick: () => set('Visible', (p) => { p.visible = !st.visible; }) },
      { label: 'Mini view', checked: st.mini, onClick: () => set('Mini view', (p) => { p.mini = !st.mini; }) },
      { label: 'Background', checked: st.background, onClick: () => set('Background', (p) => { p.background = !st.background; }) },
      { header: true, label: 'Mode' },
      { label: 'Auto', checked: st.auto, onClick: () => set('Auto visual mode', (p) => { p.auto = !st.auto; }) },
      { separator: true },
      ...WC_MODES.map((m, i): MenuItem => ({ label: m, radio: true, checked: !st.auto && st.mode === i, onClick: () => set(`Mode: ${m}`, (p) => { p.mode = i; p.auto = false; }) })),
      { separator: true },
      { label: 'View settings', onClick: onSettings },
    ];
    openMenu(e.clientX, e.clientY, items);
  };

  if (!s.visible) return null;
  const el = (
    <div
      style={{
        position: host === 'workspace' ? 'absolute' : 'fixed', left: rect.x, top: rect.y, width: rect.w, height: rect.h + reflectH, zIndex: s.stayOnTop ? 9000 : z,
        pointerEvents: s.solid ? 'auto' : 'none', cursor: 'default', touchAction: 'none',
      }}
      title=""
      onContextMenu={menu}
      onPointerDownCapture={() => onFocus?.()}
      onPointerDown={(e) => {
        if (e.button === 1) { e.preventDefault(); A.setFxParam(slotId, 'hold', hold ? 0 : 1); return; }
        if (e.button !== 0) return;
        const bx = e.currentTarget.getBoundingClientRect();
        const lx = e.clientX - bx.left, ly = e.clientY - bx.top;
        if (ly > rect.h) return;
        const edge = 6;
        const m = `${ly < edge ? 'n' : ly > rect.h - edge ? 's' : ''}${lx < edge ? 'w' : lx > rect.w - edge ? 'e' : ''}` || 'move';
        dragRef.current = { mode: m, sx: e.clientX, sy: e.clientY, r: [rect.x, rect.y, rect.w, rect.h] };
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        e.stopPropagation();
      }}
      onPointerMove={(e) => {
        const bx = e.currentTarget.getBoundingClientRect();
        live.current.mouse = { x: e.clientX - bx.left, y: e.clientY - bx.top };
        const d = dragRef.current;
        if (!d) return;
        const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
        let [x, y, w, h] = d.r;
        if (d.mode === 'move') { x += dx; y += dy; } else {
          if (d.mode.includes('e')) w = Math.max(24, w + dx);
          if (d.mode.includes('s')) h = Math.max(24, h + dy);
          if (d.mode.includes('w')) { const nw = Math.max(24, w - dx); x += w - nw; w = nw; }
          if (d.mode.includes('n')) { const nh = Math.max(24, h - dy); y += h - nh; h = nh; }
        }
        setDrag({ x, y, w, h });
      }}
      onPointerUp={() => {
        const d = dragRef.current;
        dragRef.current = null;
        if (d && drag) writeRect(drag);
        setDrag(null);
      }}
      onPointerLeave={() => { live.current.mouse = null; clearHint(); }}
      onDoubleClick={onSettings}
    >
      <canvas ref={canvas} style={{ width: '100%', height: '100%', display: 'block' }} />
      {hold && <div style={{ position: 'absolute', left: 6, bottom: reflectH + 4, font: 'bold 9px Tahoma, sans-serif', color: 'rgba(255,255,255,0.6)', pointerEvents: 'none' }}>HOLD</div>}
    </div>
  );
  return host === 'workspace' ? el : createPortal(el, document.body);
}
