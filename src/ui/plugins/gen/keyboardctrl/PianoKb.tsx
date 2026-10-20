// FL's scrolled piano keyboard of the controller plugins (TQuickVectorMIDIKb in
// a "sober" panel): 11 octaves (132 keys, 13 px per white key = 1001 px) seen
// through a viewport, a note ruler on top that sets the key range by dragging
// (the in-range part is bright, the rest dimmed), the selected key in blue,
// octave names on the C keys and the range's end keys, and a scroll bar below
// (arrows and a thumb). Left-click on a key selects it (and plays it when the
// plugin wants key tests), dragging past the viewport's edge scrolls.
// Geometry and colours follow FL 2026's screenshots (Keyboard Controller and
// Envelope Controller manual pages). Original drawing, no FL assets.

import { useEffect, useRef } from 'react';
import { Display } from '../../kit';
import { setHint } from '../../../hint';
import { kbIsWhite, kbKeyName, KB_KEYS } from '../../../../model/gen/plugins/keyboardctrl';

export const KB_WW = 13;
export const KB_NUM_WHITE = 77;
export const KB_TOTAL_W = KB_WW * KB_NUM_WHITE;
export const KB_RULER_H = 18;
export const KB_KEYS_H = 48;
export const KB_BAR_H = 14;

const WHITE_SEMIS = [0, 2, 4, 5, 7, 9, 11];
const WHITE_OF = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const BW = 8;

const whiteIndex = (k: number) => Math.floor(k / 12) * 7 + WHITE_OF[k % 12];
const whiteKey = (wi: number) => Math.floor(wi / 7) * 12 + WHITE_SEMIS[wi % 7];

/** Left edge and width of a key inside the full keyboard. */
export function kbKeySpan(k: number): [number, number] {
  if (!kbIsWhite(k)) return [(whiteIndex(k) + 1) * KB_WW - BW / 2, BW];
  return [whiteIndex(k) * KB_WW, KB_WW];
}

/** The key at keyboard x (black keys only when `black`: the keys part, not the ruler). */
export function kbKeyAt(x: number, black: boolean): number {
  const wi = Math.max(0, Math.min(KB_NUM_WHITE - 1, Math.floor(x / KB_WW)));
  const wk = whiteKey(wi);
  if (black) {
    for (const k of [wk - 1, wk + 1]) {
      if (k < 0 || k >= KB_KEYS || kbIsWhite(k)) continue;
      const [bx, bw] = kbKeySpan(k);
      if (x >= bx && x < bx + bw) return k;
    }
  }
  return Math.min(KB_KEYS - 1, wk);
}

const COL = {
  rulerIn: '#d7dbe3', rulerOut: '#9da1a9', white: '#d7dbe3', whiteOut: '#9da1a9', sep: '#9aa0a9', sepOut: '#8a8f96',
  black: '#3c3e3f', blackOut: '#6d7176', blackEdge: '#55585b', sel: '#8cc4ff', selBlack: '#5aa4f0', bottomStrip: '#e6ecf2',
  text: '#2c3236', textOut: '#6f757c', bar: '#9da1a9', thumb: '#646567', arrow: '#3f454a', line: '#31383c',
  held: '#ff9a3a', heldBlack: '#f0801a',
};

export interface PianoKbProps {
  x: number;
  y: number;
  /** Viewport width (the panel's inner width). */
  w: number;
  /** Scroll offset in px (0..1001 - w). */
  scroll: number;
  onScroll: (px: number) => void;
  /** Key range (hi >= 132: open). */
  lo: number;
  hi: number;
  /** Dragging the ruler sets the range; omit to disable. */
  onRange?: (lo: number, hi: number) => void;
  /** The blue key. */
  selected?: number;
  /** A click on a key (`down`) and its release; `vel` (1..127) follows the click's height on the key (low = soft). */
  onKey?: (key: number, down: boolean, vel?: number) => void;
  /** Keys that sound now (drawn orange-ish). */
  held?: ReadonlySet<number>;
  /** Hint texts. */
  keyHint?: string;
  rangeHint?: string;
  /** Total height of ruler + keys (default 66). */
  keysH?: number;
}

type Drag =
  | { kind: 'range'; anchor: number }
  | { kind: 'key'; key: number }
  | { kind: 'thumb'; x0: number; s0: number };

export function PianoKb(p: PianoKbProps) {
  const { x, y, w } = p;
  const keysH = p.keysH ?? KB_KEYS_H;
  const H = KB_RULER_H + keysH;
  const maxScroll = Math.max(0, KB_TOTAL_W - w);
  const scroll = Math.max(0, Math.min(maxScroll, p.scroll));
  const drag = useRef<Drag | null>(null);
  const pr = useRef(p);
  pr.current = p;

  const draw = (g: CanvasRenderingContext2D, W: number) => {
    g.fillStyle = COL.rulerOut;
    g.fillRect(0, 0, W, H + KB_BAR_H);
    const inR = (k: number) => k >= p.lo && k <= Math.min(KB_KEYS - 1, p.hi);
    g.save();
    g.beginPath();
    g.rect(0, 0, W, H);
    g.clip();
    g.translate(-scroll, 0);
    // ruler
    const lx = p.lo >= KB_KEYS ? KB_TOTAL_W : kbKeySpan(Math.max(0, p.lo))[0];
    const hiK = Math.min(KB_KEYS - 1, p.hi);
    const [hx, hw] = kbKeySpan(hiK);
    // white keys edge-to-edge: the range spans whole keys (to the end of a white key; black keys at the white key edge)
    const rx0 = lx;
    const rx1 = hx + hw;
    g.fillStyle = COL.rulerIn;
    g.fillRect(Math.max(0, rx0), 0, Math.max(0, rx1 - Math.max(0, rx0)), KB_RULER_H);
    // white keys
    for (let wi = 0; wi < KB_NUM_WHITE; wi++) {
      const k = whiteKey(wi);
      const kx = wi * KB_WW;
      if (kx + KB_WW < scroll || kx > scroll + W) continue;
      const on = inR(k);
      g.fillStyle = k === p.selected ? COL.sel : on ? COL.white : COL.whiteOut;
      g.fillRect(kx, KB_RULER_H, KB_WW, keysH);
      if (k !== p.selected && on) { g.fillStyle = COL.bottomStrip; g.fillRect(kx + 1, KB_RULER_H + keysH - 3, KB_WW - 1, 3); }
      g.fillStyle = on ? COL.sep : COL.sepOut;
      g.fillRect(kx, KB_RULER_H, 1, keysH);
      if (p.held?.has(k)) { g.fillStyle = COL.held; g.fillRect(kx + 1, KB_RULER_H, KB_WW - 1, keysH); }
    }
    // black keys
    const bh = Math.round(keysH * 0.96);
    for (let k = 0; k < KB_KEYS; k++) {
      if (kbIsWhite(k)) continue;
      const [bx, bw] = kbKeySpan(k);
      if (bx + bw < scroll || bx > scroll + W) continue;
      g.fillStyle = k === p.selected ? COL.selBlack : inR(k) ? COL.black : COL.blackOut;
      g.fillRect(bx, KB_RULER_H, bw, bh);
      g.fillStyle = COL.blackEdge;
      g.fillRect(bx + 1, KB_RULER_H, 1, bh - 1);
      if (p.held?.has(k)) { g.fillStyle = COL.heldBlack; g.fillRect(bx, KB_RULER_H, bw, bh); }
    }
    // octave names on the C keys, the range's end keys in the ruler
    g.font = '600 10px ' + (getComputedStyle(document.body).fontFamily || 'sans-serif');
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    for (let k = 0; k < KB_KEYS; k += 12) {
      const kx = whiteIndex(k) * KB_WW;
      g.fillStyle = inR(k) ? COL.text : COL.textOut;
      g.fillText(kbKeyName(k), kx + 2, KB_RULER_H / 2 + 0.5);
    }
    if (p.lo < KB_KEYS && p.lo % 12 !== 0) { g.fillStyle = COL.text; g.fillText(kbKeyName(p.lo), kbKeySpan(p.lo)[0] + 2, KB_RULER_H / 2 + 0.5); }
    if (hiK % 12 !== 0 && p.hi < KB_KEYS) { g.fillStyle = COL.text; g.textAlign = 'right'; g.fillText(kbKeyName(hiK), kbKeySpan(hiK)[0] + kbKeySpan(hiK)[1] - 1, KB_RULER_H / 2 + 0.5); }
    g.restore();
    g.fillStyle = COL.line;
    g.fillRect(0, KB_RULER_H, W, 1);
    // scroll bar: arrows and the thumb
    g.fillStyle = COL.bar;
    g.fillRect(0, H, W, KB_BAR_H);
    g.strokeStyle = COL.arrow;
    g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(8, H + 4); g.lineTo(4, H + 7.5); g.lineTo(8, H + 11); g.stroke();
    g.beginPath(); g.moveTo(W - 8, H + 4); g.lineTo(W - 4, H + 7.5); g.lineTo(W - 8, H + 11); g.stroke();
    const trackW = W - 24;
    const thumbW = Math.max(16, (W / KB_TOTAL_W) * trackW);
    const tx = 12 + (maxScroll > 0 ? (scroll / maxScroll) * (trackW - thumbW) : 0);
    g.fillStyle = COL.thumb;
    g.fillRect(tx, H + 6, thumbW, 3);
  };

  const local = (e: React.PointerEvent | React.WheelEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const k = r.width / w || 1;
    return { px: (e.clientX - r.left) / k, py: (e.clientY - r.top) / k };
  };

  // dragging past the edge scrolls (a timer keeps scrolling while the pointer rests there)
  const edge = useRef(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!edge.current || !drag.current || drag.current.kind !== 'range') return;
      const q = pr.current;
      q.onScroll(Math.max(0, Math.min(Math.max(0, KB_TOTAL_W - q.w), q.scroll + edge.current)));
    }, 40);
    return () => window.clearInterval(id);
  }, []);

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const { px, py } = local(e);
    const kx = px + scroll;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (py >= H) {
      if (px < 12) p.onScroll(Math.max(0, scroll - KB_WW * 4));
      else if (px > w - 12) p.onScroll(Math.min(maxScroll, scroll + KB_WW * 4));
      else {
        const trackW = w - 24, thumbW = Math.max(16, (w / KB_TOTAL_W) * trackW);
        const tx = 12 + (maxScroll > 0 ? (scroll / maxScroll) * (trackW - thumbW) : 0);
        if (px >= tx && px <= tx + thumbW) drag.current = { kind: 'thumb', x0: px, s0: scroll };
        else p.onScroll(Math.max(0, Math.min(maxScroll, scroll + (px < tx ? -w * 0.8 : w * 0.8))));
      }
      return;
    }
    if (py < KB_RULER_H) {
      if (!p.onRange) return;
      const k = kbKeyAt(kx, true);
      drag.current = { kind: 'range', anchor: k };
      p.onRange(k, k);
      return;
    }
    const k = kbKeyAt(kx, py < KB_RULER_H + keysH * 0.96);
    drag.current = { kind: 'key', key: k };
    p.onKey?.(k, true, velAt(py));
  };

  /** FL's keyboard: the velocity follows the height of the click on the key. */
  const velAt = (py: number) => Math.round(Math.max(1, Math.min(127, 40 + 88 * Math.max(0, Math.min(1, (py - KB_RULER_H) / keysH)))));

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { px, py } = local(e);
    const d = drag.current;
    if (!d) {
      if (py < KB_RULER_H) setHint(p.rangeHint ?? 'Drag to set the key range');
      else if (py < H) setHint(`${p.keyHint ?? 'Key'}: ${kbKeyName(kbKeyAt(px + scroll, py < KB_RULER_H + keysH * 0.96))}`);
      return;
    }
    if (d.kind === 'thumb') {
      const trackW = w - 24, thumbW = Math.max(16, (w / KB_TOTAL_W) * trackW);
      p.onScroll(Math.max(0, Math.min(maxScroll, d.s0 + ((px - d.x0) / Math.max(1, trackW - thumbW)) * maxScroll)));
    } else if (d.kind === 'range') {
      edge.current = px < 6 ? -KB_WW : px > w - 6 ? KB_WW : 0;
      const k = kbKeyAt(Math.max(0, Math.min(KB_TOTAL_W - 1, px + scroll)), true);
      p.onRange?.(Math.min(d.anchor, k), Math.max(d.anchor, k));
    } else if (d.kind === 'key') {
      const k = kbKeyAt(px + scroll, py < KB_RULER_H + keysH * 0.96);
      if (k !== d.key) { p.onKey?.(d.key, false); d.key = k; p.onKey?.(k, true, velAt(py)); }
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    edge.current = 0;
    if (d?.kind === 'key') p.onKey?.(d.key, false);
  };

  return (
    <Display x={x} y={y} w={w} h={H + KB_BAR_H} draw={(g, W) => draw(g, W)}
      deps={[scroll, p.lo, p.hi, p.selected, p.held, p.keysH]}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
      onWheel={(e) => { e.stopPropagation(); p.onScroll(Math.max(0, Math.min(maxScroll, scroll + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY)))); }}
      style={{ cursor: 'default' }}
    />
  );
}
