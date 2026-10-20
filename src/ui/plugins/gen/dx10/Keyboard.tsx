// Fruity DX10's keyboard panel (FL: TQuickVectorMIDIKb, hint "Current key &
// range"): four octaves of 19 px white keys under a ruler with the octave names,
// showing the channel's root key in blue, its key range (keys outside it
// dimmed, C keys shaded) and the keys that play. Left-click plays a note (the
// vertical position sets the velocity), right-click sets the root key, dragging
// on the ruler sets the key range, the mouse wheel scrolls by an octave. Drawn
// after FL 2026's keyboard (DX10 editor thumbnail, Keyboard Controller);
// original drawing.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNoScrollWheel } from '../../kit';
import { setHint, clearHint } from '../../../hint';
import { openMenu } from '../../../widgets/ContextMenu';
import { host } from '../../../../store';
import * as A from '../../../../store/actions';
import { keyName } from '../../../../model/notes';

export const KB_WHITE = 19;
const RULER = 15;
const NUM_WHITE = 77; // C0..B10 (132 keys)
const MAX_KEY = 131;
const BLACK_W = 11;
const WHITE_SEMIS = [0, 2, 4, 5, 7, 9, 11];
const WHITE_OF = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const isBlack = (k: number) => [1, 3, 6, 8, 10].includes(((k % 12) + 12) % 12);
const whiteIndex = (k: number) => Math.floor(k / 12) * 7 + WHITE_OF[k % 12];
const whiteKey = (wi: number) => Math.floor(wi / 7) * 12 + WHITE_SEMIS[wi % 7];

const C = {
  ruler: '#babec5', rulerOut: '#959aa2', rulerSel: '#537cb0',
  white: '#ccd0d7', whiteLo: '#d7dbe1', whiteC: '#b5bac1', whiteOut: '#9da2aa', sep: '#959ba3',
  black: '#2f3032', blackHi: '#505154', blackOut: '#5b5e62',
  sel: '#76a7e3', selBlack: '#4f86cc', held: '#ffb46b', heldBlack: '#e88f3c',
  text: '#3d4349', textSel: '#eef4fb', edge: '#2a3236',
};

/** Default first white key: two octaves below the root key's octave (C3 for C5, as FL centres C5). */
export function kbDefaultStart(root: number): number {
  return Math.max(0, Math.min(NUM_WHITE - 28, (Math.floor(root / 12) - 2) * 7));
}

export function DxKeyboard({ x, y, w, h, chId, root, lo, hi, held, start, onStart }: {
  x: number; y: number; w: number; h: number; chId: string | null;
  root: number; lo: number; hi: number; held: ReadonlySet<number>;
  /** First visible white key. */
  start: number;
  onStart: (wi: number) => void;
}) {
  const [pressed, setPressed] = useState<number | null>(null);
  const note = useRef<{ key: number; tag: number } | null>(null);
  const range = useRef<number | null>(null);
  const wheelRef = useNoScrollWheel<HTMLDivElement>();
  const visible = Math.ceil(w / KB_WHITE);
  const first = Math.max(0, Math.min(NUM_WHITE - visible, Math.round(start)));
  const keysH = h - RULER;
  const blackH = Math.round(keysH * 0.6);

  useEffect(() => () => {
    const n = note.current;
    if (n && chId) host.noteOff(chId, n.key, n.tag);
    note.current = null;
  }, [chId]);

  const keySpan = (k: number): [number, number] => {
    if (isBlack(k)) return [(whiteIndex(k) + 1 - first) * KB_WHITE - BLACK_W / 2, BLACK_W];
    return [(whiteIndex(k) - first) * KB_WHITE, KB_WHITE];
  };
  const keyAt = (px: number, py: number): number => {
    const wi = Math.max(0, Math.min(NUM_WHITE - 1, first + Math.floor(px / KB_WHITE)));
    const wk = whiteKey(wi);
    if (py < RULER + blackH) {
      for (const k of [wk - 1, wk + 1]) {
        if (k < 0 || k > MAX_KEY || !isBlack(k)) continue;
        const [bx, bw] = keySpan(k);
        if (px >= bx && px < bx + bw) return k;
      }
    }
    return Math.min(MAX_KEY, wk);
  };

  // ---- drawing
  const inR = (k: number) => k >= lo && k <= hi;
  const els: ReactNode[] = [];
  const [lx] = keySpan(lo);
  const [hx, hw] = keySpan(hi);
  els.push(<rect key="r0" x={0} y={0} width={w} height={h} fill={C.rulerOut} />);
  const r0 = Math.max(0, lx), r1 = Math.min(w, hx + hw);
  if (r1 > r0) els.push(<rect key="r1" x={r0} y={0} width={r1 - r0} height={RULER} fill={C.ruler} />);
  const [rx, rw] = keySpan(root);
  if (rx + rw > 0 && rx < w) els.push(<rect key="r2" x={rx} y={0} width={rw} height={RULER} fill={C.rulerSel} />);
  const last = Math.min(NUM_WHITE, first + visible + 1);
  for (let wi = first; wi < last; wi++) {
    const k = whiteKey(wi);
    const kx = (wi - first) * KB_WHITE;
    const on = held.has(k) || k === pressed, sel = k === root;
    const col = on ? C.held : sel ? C.sel : !inR(k) ? C.whiteOut : k % 12 === 0 ? C.whiteC : C.white;
    const plain = !on && !sel && inR(k) && k % 12 !== 0;
    els.push(<rect key={`w${k}`} x={kx} y={RULER} width={KB_WHITE} height={keysH} fill={plain ? 'url(#dxkbw)' : col} />);
    els.push(<rect key={`s${k}`} x={kx} y={RULER} width={1} height={keysH} fill={C.sep} />);
  }
  for (let wi = first; wi < last; wi++) {
    const k = whiteKey(wi) + 1;
    if (k > MAX_KEY || !isBlack(k)) continue;
    const [bx, bw] = keySpan(k);
    const on = held.has(k) || k === pressed, sel = k === root;
    const fill = on ? C.heldBlack : sel ? C.selBlack : !inR(k) ? C.blackOut : 'url(#dxkbb)';
    els.push(<rect key={`b${k}`} x={bx} y={RULER} width={bw} height={blackH} fill={fill} />);
  }
  for (let k = 0; k <= MAX_KEY; k += 12) {
    const [kx] = keySpan(k);
    if (kx < -24 || kx > w) continue;
    els.push(<text key={`t${k}`} x={kx + 2} y={RULER / 2 + 3.2} fontSize={9} fontWeight={600} fontFamily="Arial, Helvetica, sans-serif"
      fill={k === root ? C.textSel : C.text}>{keyName(k)}</text>);
  }
  els.push(<rect key="edge" x={0} y={RULER - 1} width={w} height={1} fill={C.edge} />);

  // ---- mouse
  const locate = (e: React.PointerEvent | React.MouseEvent) => {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    const px = ((e.clientX - r.left) * w) / r.width, py = ((e.clientY - r.top) * h) / r.height;
    const key = keyAt(px, py);
    const vel = Math.round(Math.max(1, Math.min(127, 40 + 88 * Math.max(0, Math.min(1, (py - RULER) / (isBlack(key) ? blackH : keysH))))));
    return { key, vel, inRuler: py < RULER };
  };
  const setRange = (a: number, b: number) => {
    if (!chId) return;
    const l = Math.max(0, Math.min(a, b)), u = Math.min(MAX_KEY, Math.max(a, b));
    A.setSampler(chId, 'Key range', (s) => { s.keyLo = l; s.keyHi = u; });
    setHint(`Key range: ${keyName(l)} to ${keyName(u)}`);
  };
  const play = (key: number, vel: number) => {
    if (!chId) return;
    const n = note.current;
    if (n) host.noteOff(chId, n.key, n.tag);
    note.current = { key, tag: host.noteOn(chId, key, vel) };
    setPressed(key);
  };
  const stop = () => {
    const n = note.current;
    if (n && chId) host.noteOff(chId, n.key, n.tag);
    note.current = null;
    setPressed(null);
  };
  const up = () => { range.current = null; if (note.current) stop(); };

  return (
    <div ref={wheelRef} className="fxk-abs" style={{ left: x, top: y, width: w, height: h }}
      onPointerLeave={() => { if (!note.current && range.current === null) clearHint(); }}
      onWheel={(e) => onStart(first + (e.deltaY + e.deltaX > 0 ? 7 : -7))}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', touchAction: 'none' }}
        onPointerDown={(e) => {
          if (e.button !== 0 || e.ctrlKey) return;
          e.preventDefault();
          const L = locate(e);
          e.currentTarget.setPointerCapture(e.pointerId);
          if (L.inRuler) { range.current = L.key; setRange(L.key, L.key); return; }
          play(L.key, L.vel);
          setHint(`${keyName(L.key)} - velocity ${L.vel}`);
        }}
        onPointerMove={(e) => {
          const L = locate(e);
          if (range.current !== null) { setRange(range.current, L.key); return; }
          if (note.current) {
            if ((e.buttons & 1) && !L.inRuler && L.key !== note.current.key) play(L.key, L.vel);
            return;
          }
          setHint(L.inRuler ? `Key range: ${keyName(lo)} to ${keyName(hi)} - drag to set`
            : `Current key & range - root ${keyName(root)}; ${keyName(L.key)}: click to play, right-click to set as root`);
        }}
        onPointerUp={up}
        onPointerCancel={up}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!chId) return;
          const L = locate(e);
          if (L.inRuler) {
            openMenu(e.clientX, e.clientY, [
              { header: true, label: 'Key range' },
              { label: 'Reset range', onClick: () => A.setSampler(chId, 'Key range', (s) => { s.keyLo = 0; s.keyHi = MAX_KEY; }) },
            ]);
            return;
          }
          A.setSampler(chId, 'Root note', (s) => { s.rootKey = L.key; });
          setHint(`Root note: ${keyName(L.key)}`);
        }}>
        <defs>
          <linearGradient id="dxkbw" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={C.white} />
            <stop offset="1" stopColor={C.whiteLo} />
          </linearGradient>
          <linearGradient id="dxkbb" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={C.black} />
            <stop offset="0.82" stopColor={C.black} />
            <stop offset="1" stopColor={C.blackHi} />
          </linearGradient>
        </defs>
        {els}
      </svg>
    </div>
  );
}
