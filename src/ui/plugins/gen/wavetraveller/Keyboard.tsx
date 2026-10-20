// Wave Traveller's patch selector (NoteSelectorPanel 252 x 62: a two-octave keyboard scrolled by octave): a key
// is a patch; pressing it selects the patch and plays it (the key's note on the channel). Original drawing.

import { useRef } from 'react';
import { AnimatedDisplay } from '../../kit';
import { setHint } from '../../../hint';
import { WT_KEYS } from '../../../../model/gen/plugins/wavetraveller/state';
import { keyNote } from './ops';

const W = 252;
const H = 62;
/** White key width: 14 white keys over the panel. */
const KW = 18;
const BLACK_W = 11;
const BLACK_H = 38;
/** Visible keys: two octaves. */
export const VISIBLE_KEYS = 24;

const WHITE = [0, 2, 4, 5, 7, 9, 11];
/** Left edge (in white-key units) of a black key by semitone; null = no black key. */
const BLACK_AT: Record<number, number> = { 1: 1, 3: 2, 6: 4, 8: 5, 10: 6 };

const COL = { white: '#c8ccd3', whiteDown: '#e8e0cc', black: '#3d3e3f', sel: '#d79b32', line: '#8e939c', text: '#3a3e45', used: '#6a8f6a' };

/** Key under a panel position. */
function keyAt(px: number, py: number, first: number): number {
  // black keys first (they sit on top)
  const oct = Math.floor(px / (KW * 7));
  const inOct = px - oct * KW * 7;
  if (py < BLACK_H) {
    for (const [semi, wk] of Object.entries(BLACK_AT)) {
      const left = wk * KW - BLACK_W / 2;
      if (inOct >= left && inOct < left + BLACK_W) return first + oct * 12 + Number(semi);
    }
  }
  const wi = Math.min(6, Math.floor(inOct / KW));
  return first + oct * 12 + WHITE[wi];
}

export interface KeyboardProps {
  x: number;
  y: number;
  /** First visible octave (key = 12 x octave). */
  octave: number;
  /** The selected key and the keys whose patch is not the default. */
  selected: number;
  used: ReadonlySet<number>;
  onSelect: (key: number) => void;
  onNoteOn: (key: number) => number;
  onNoteOff: (key: number, tag: number) => void;
  onMenu: (e: React.MouseEvent<HTMLCanvasElement>) => void;
}

export function Keyboard({ x, y, octave, selected, used, onSelect, onNoteOn, onNoteOff, onMenu }: KeyboardProps) {
  const first = Math.max(0, Math.min(WT_KEYS - VISIBLE_KEYS, octave * 12));
  const held = useRef<{ key: number; tag: number } | null>(null);
  const frame = (g: CanvasRenderingContext2D, w: number, h: number) => {
    g.fillStyle = COL.white;
    g.fillRect(0, 0, w, h);
    // white keys
    for (let o = 0; o < 2; o++) {
      for (let wi = 0; wi < 7; wi++) {
        const key = first + o * 12 + WHITE[wi];
        const kx = (o * 7 + wi) * KW;
        if (key >= WT_KEYS) continue;
        if (key === selected) { g.fillStyle = COL.sel; g.fillRect(kx, 0, KW, h); }
        else if (held.current?.key === key) { g.fillStyle = COL.whiteDown; g.fillRect(kx, 0, KW, h); }
        g.fillStyle = COL.line;
        g.fillRect(kx, 0, 1, h);
        if (used.has(key) && key !== selected) { g.fillStyle = COL.used; g.fillRect(kx + KW / 2 - 2, h - 8, 4, 4); }
        if (WHITE[wi] === 0) {
          g.fillStyle = COL.text; g.font = '9px Arial, sans-serif'; g.textAlign = 'left';
          g.fillText(keyNote(key), kx + 3, h - 5);
        }
      }
    }
    // black keys
    for (let o = 0; o < 2; o++) {
      for (const [semi, wk] of Object.entries(BLACK_AT)) {
        const key = first + o * 12 + Number(semi);
        if (key >= WT_KEYS) continue;
        const kx = (o * 7 + wk) * KW - BLACK_W / 2;
        g.fillStyle = key === selected ? COL.sel : held.current?.key === key ? '#6b6c6f' : COL.black;
        g.fillRect(kx, 0, BLACK_W, BLACK_H);
        if (used.has(key) && key !== selected) { g.fillStyle = COL.used; g.fillRect(kx + BLACK_W / 2 - 2, BLACK_H - 7, 4, 4); }
      }
    }
  };
  const pos = (e: React.PointerEvent<HTMLCanvasElement>): number => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = Math.max(0, Math.min(W - 1, ((e.clientX - r.left) / r.width) * W));
    const py = Math.max(0, Math.min(H - 1, ((e.clientY - r.top) / r.height) * H));
    return Math.min(WT_KEYS - 1, keyAt(px, py, first));
  };
  const press = (key: number) => {
    const h = held.current;
    if (h && h.key === key) return;
    if (h) onNoteOff(h.key, h.tag);
    onSelect(key);
    held.current = { key, tag: onNoteOn(key) };
  };
  const release = () => {
    const h = held.current;
    if (h) onNoteOff(h.key, h.tag);
    held.current = null;
  };
  return (
    <AnimatedDisplay x={x} y={y} w={W} h={H} frame={frame}
      onPointerDown={(e) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); press(pos(e)); }}
      onPointerMove={(e) => {
        if (held.current) press(pos(e));
        else setHint(`Patch selector / Preview: ${keyNote(pos(e))}`);
      }}
      onPointerUp={(e) => { release(); try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* released */ } }}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e); }} />
  );
}
