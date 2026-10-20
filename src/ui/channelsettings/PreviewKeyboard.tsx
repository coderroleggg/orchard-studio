// Preview keyboard (MISC / INS bottom): the full C0..B10 range with a key-zone
// ruler on top. Left-click plays (the vertical click position sets the
// velocity), right-click sets the root note, drag on the ruler sets the zone.

import { useEffect, useRef, useState } from 'react';
import { store, host } from '../../store';
import type { Channel } from '../../model/types';
import { isBlackKey, keyName, KEY_MAX, KEY_MIN, DEFAULT_KEY } from '../../model/notes';
import { openMenu } from '../widgets/ContextMenu';
import { setHint, clearHint } from '../hint';
import { editSampler, useCanvas, uiFont } from './controls';

const RULER = 9;
const NUM_WHITE = Math.floor((KEY_MAX + 1) / 12) * 7; // 77 white keys for C0..B10
const WHITE_SEMIS = [0, 2, 4, 5, 7, 9, 11];
const WHITE_OF = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];

interface Geo {
  ww: number; // white key width
  bw: number; // black key width
  top: number; // keys top (below the ruler)
  h: number; // keys height
  bh: number; // black key height
}

function geo(w: number, h: number): Geo {
  const ww = w / NUM_WHITE;
  return { ww, bw: Math.max(2, ww * 0.62), top: RULER, h: h - RULER, bh: Math.round((h - RULER) * 0.6) };
}

const whiteIndex = (k: number) => Math.floor(k / 12) * 7 + WHITE_OF[k % 12];
const whiteKey = (wi: number) => Math.floor(wi / 7) * 12 + WHITE_SEMIS[wi % 7];

/** Left edge and width of a key. */
function keySpan(k: number, g: Geo): [number, number] {
  if (isBlackKey(k)) return [(whiteIndex(k) + 1) * g.ww - g.bw / 2, g.bw];
  return [whiteIndex(k) * g.ww, g.ww];
}

function keyAt(x: number, g: Geo, blackZone: boolean): number {
  const wi = Math.max(0, Math.min(NUM_WHITE - 1, Math.floor(x / g.ww)));
  const wk = whiteKey(wi);
  if (blackZone) {
    for (const k of [wk - 1, wk + 1]) {
      if (k < KEY_MIN || k > KEY_MAX || !isBlackKey(k)) continue;
      const [bx, bw] = keySpan(k, g);
      if (x >= bx && x < bx + bw) return k;
    }
  }
  return wk;
}

interface KbState {
  root: number;
  lo: number;
  hi: number;
  held: number | null;
}

function drawKeyboard(c: CanvasRenderingContext2D, w: number, h: number, st: KbState): void {
  const g = geo(w, h);
  // ruler with the key zone
  c.fillStyle = '#1a1e21';
  c.fillRect(0, 0, w, RULER);
  const [lx] = keySpan(st.lo, g);
  const [hx, hw] = keySpan(st.hi, g);
  c.fillStyle = 'rgba(95, 200, 255, 0.45)';
  c.fillRect(lx, 2, hx + hw - lx, RULER - 4);
  c.fillStyle = '#9fdcff';
  c.fillRect(lx, 1, 2, RULER - 2);
  c.fillRect(hx + hw - 2, 1, 2, RULER - 2);
  // root marker on the ruler
  const [rx, rw] = keySpan(st.root, g);
  c.fillStyle = '#e8eef2';
  c.beginPath();
  c.moveTo(rx + rw / 2 - 3, 1);
  c.lineTo(rx + rw / 2 + 3, 1);
  c.lineTo(rx + rw / 2, RULER - 1);
  c.closePath();
  c.fill();

  // white keys
  for (let wi = 0; wi < NUM_WHITE; wi++) {
    const k = whiteKey(wi);
    const x = wi * g.ww;
    const inZone = k >= st.lo && k <= st.hi;
    c.fillStyle = k === st.held ? '#ffb46b' : k === st.root ? '#5fc8ff' : inZone ? '#e2e8eb' : '#8a9399';
    c.fillRect(x, g.top, g.ww + 0.5, g.h);
    c.fillStyle = '#5f686e';
    c.fillRect(Math.round(x), g.top, 1, g.h);
  }
  // black keys
  for (let k = KEY_MIN; k <= KEY_MAX; k++) {
    if (!isBlackKey(k)) continue;
    const [x, bw] = keySpan(k, g);
    const inZone = k >= st.lo && k <= st.hi;
    c.fillStyle = k === st.held ? '#ff9f43' : k === st.root ? '#2f9fd8' : inZone ? '#1c2023' : '#454d53';
    c.fillRect(x, g.top, bw, g.bh);
  }
  // octave labels on the C keys
  if (g.ww >= 5) {
    c.font = `${g.ww >= 8 ? 8 : 7}px ${uiFont()}`;
    c.textBaseline = 'bottom';
    c.textAlign = 'left';
    for (let k = KEY_MIN; k <= KEY_MAX; k += 12) {
      const x = whiteIndex(k) * g.ww;
      c.fillStyle = k === st.root || k === st.held ? '#10161a' : '#59636a';
      c.fillText(g.ww >= 8 ? keyName(k) : String(k / 12), x + 1.5, g.top + g.h - 1);
    }
  }
  c.fillStyle = '#0f1214';
  c.fillRect(0, g.top, w, 1);
}

export function PreviewKeyboard({ ch }: { ch: Channel }) {
  const s = ch.sampler;
  const chId = ch.id;
  const [held, setHeld] = useState<number | null>(null);
  const note = useRef<{ key: number; tag: number } | null>(null);
  const zone = useRef<{ mode: 'lo' | 'hi' | 'new'; anchor: number } | null>(null);
  const ref = useCanvas((g, w, h) => drawKeyboard(g, w, h, { root: s.rootKey, lo: s.keyLo, hi: s.keyHi, held }),
    [s.rootKey, s.keyLo, s.keyHi, held]);

  // release a held preview note if the window closes mid-press
  useEffect(() => () => {
    const n = note.current;
    if (n) host.noteOff(chId, n.key, n.tag);
    note.current = null;
  }, [chId]);

  const rootHint = (root: number, lo: number, hi: number) => `Root note: ${keyName(root)} / zone: ${keyName(lo)} to ${keyName(hi)}`;
  const zoneHint = (lo: number, hi: number) => `Key zone: ${keyName(lo)} to ${keyName(hi)} - drag to set, drag an end to resize, right-click to reset`;

  const locate = (e: React.PointerEvent | React.MouseEvent) => {
    // positions inside the canvas content box (the bitmap excludes the border)
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left - el.clientLeft, y = e.clientY - r.top - el.clientTop;
    const g = geo(el.clientWidth, el.clientHeight);
    const inRuler = y < RULER;
    const blackZone = inRuler || y < g.top + g.bh;
    const key = keyAt(x, g, blackZone);
    const vel = Math.round(40 + 88 * Math.max(0, Math.min(1, (y - g.top) / (blackZone ? g.bh : g.h))));
    return { x, g, inRuler, key, vel };
  };

  const play = (key: number, vel: number) => {
    const n = note.current;
    if (n) host.noteOff(chId, n.key, n.tag);
    note.current = { key, tag: host.noteOn(chId, key, vel) };
    setHeld(key);
  };

  const stop = () => {
    const n = note.current;
    if (n) host.noteOff(chId, n.key, n.tag);
    note.current = null;
    setHeld(null);
  };

  const setZone = (a: number, b: number) => {
    const lo = Math.max(KEY_MIN, Math.min(a, b)), hi = Math.min(KEY_MAX, Math.max(a, b));
    editSampler(chId, 'Key zone', (d) => { d.keyLo = lo; d.keyHi = hi; });
    setHint(zoneHint(lo, hi));
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || e.ctrlKey) return; // macOS ctrl+click is a right-click
    e.preventDefault();
    const L = locate(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (L.inRuler) {
      const [lx] = keySpan(s.keyLo, L.g);
      const [hx, hw] = keySpan(s.keyHi, L.g);
      const dLo = Math.abs(L.x - lx), dHi = Math.abs(L.x - (hx + hw));
      const mode = Math.min(dLo, dHi) <= 4 ? (dLo <= dHi ? 'lo' : 'hi') : 'new';
      zone.current = { mode, anchor: L.key };
      store.beginGesture('Key zone');
      if (mode === 'new') setZone(L.key, L.key);
      return;
    }
    play(L.key, L.vel);
    setHint(`${keyName(L.key)} - velocity ${L.vel}`);
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const L = locate(e);
    const z = zone.current;
    if (z) {
      if (z.mode === 'new') setZone(z.anchor, L.key);
      else if (z.mode === 'lo') setZone(Math.min(L.key, s.keyHi), s.keyHi);
      else setZone(s.keyLo, Math.max(L.key, s.keyLo));
      return;
    }
    if (note.current) {
      if ((e.buttons & 1) && !L.inRuler && L.key !== note.current.key) play(L.key, L.vel);
      setHint(`${keyName(note.current.key)} - velocity ${L.vel}`);
      return;
    }
    if (L.inRuler) setHint(zoneHint(s.keyLo, s.keyHi));
    else setHint(`${rootHint(s.rootKey, s.keyLo, s.keyHi)} - ${keyName(L.key)}: click to play, right-click to set as root`);
  };

  const onUp = () => {
    if (zone.current) {
      zone.current = null;
      store.endGesture();
    }
    if (note.current) stop();
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const L = locate(e);
    if (L.inRuler) {
      openMenu(e.clientX, e.clientY, [
        { header: true, label: 'Key zone' },
        { label: 'Reset zone', onClick: () => editSampler(chId, 'Key zone', (d) => { d.keyLo = KEY_MIN; d.keyHi = KEY_MAX; }) },
        {
          label: 'Reset root and zone',
          onClick: () => editSampler(chId, 'Reset keyboard', (d) => { d.rootKey = DEFAULT_KEY; d.keyLo = KEY_MIN; d.keyHi = KEY_MAX; }),
        },
      ]);
      return;
    }
    editSampler(chId, 'Root note', (d) => { d.rootKey = L.key; });
    setHint(rootHint(L.key, s.keyLo, s.keyHi));
  };

  return (
    <canvas ref={ref} className="cs-kb"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onLostPointerCapture={onUp}
      onContextMenu={onContextMenu}
      onPointerLeave={() => { if (!note.current && !zone.current) clearHint(); }} />
  );
}
