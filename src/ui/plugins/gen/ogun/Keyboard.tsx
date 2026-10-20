// Ogun's testing keyboard (FL's TQuickVectorMIDIKb "MIDIKb", 560 x 85 at (0, 554): keys 36..83, white keys 20 px, black keys
// 13 px; FL's colours: white #cfd3da, black #2f3031, pressed #fe8025, C5 marker #7ff0aa; code from Harmor's Keyboard.tsx). Click /
// drag plays notes (the vertical position sets the velocity); the keys the
// engine reports as playing light up. Original drawing.

import { useEffect, useRef, useState } from 'react';
import { host } from '../../../../store';
import { channelOfSlot } from '../../../../model/gen/ids';
import { keyName } from '../../../../model/notes';
import { setHint, clearHint } from '../../../hint';
import { useFxEditor, useFxMonitor } from '../../kit';
import { FORM } from './form';

const WHITE_OF = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const isBlack = (k: number) => [1, 3, 6, 8, 10].includes(((k % 12) + 12) % 12);

export function OKeyboard() {
  const c = FORM.MIDIKb;
  const { slotId } = useFxEditor();
  const chId = channelOfSlot(slotId);
  const lo = c.minKey ?? 36, hi = c.maxKey ?? 83;
  const ww = c.whiteWidth ?? 20, bw = c.blackWidth ?? 13;
  const W = c.w, H = c.h;
  const blackH = Math.round(H * 0.62);
  const [held, setHeld] = useState<ReadonlySet<number>>(new Set());
  const [pressed, setPressed] = useState<number | null>(null);
  const note = useRef<{ key: number; tag: number } | null>(null);
  useFxMonitor(slotId, (d) => {
    const keys = Array.isArray((d as Record<string, unknown>).keys) ? ((d as Record<string, unknown>).keys as number[]) : [];
    const k = keys.join(',');
    setHeld((s) => ([...s].join(',') === k ? s : new Set(keys)));
  });
  useEffect(() => () => {
    const n = note.current;
    if (n && chId) host.noteOff(chId, n.key, n.tag);
    note.current = null;
  }, [chId]);

  const whiteIdx = (k: number) => Math.floor(k / 12) * 7 + WHITE_OF[k % 12] - (Math.floor(lo / 12) * 7 + WHITE_OF[lo % 12]);
  const span = (k: number): [number, number] => (isBlack(k) ? [(whiteIdx(k) + 1) * ww - bw / 2, bw] : [whiteIdx(k) * ww, ww]);
  const keyAt = (x: number, y: number): number => {
    if (y < blackH) {
      for (let k = lo; k <= hi; k++) {
        if (!isBlack(k)) continue;
        const [bx, w] = span(k);
        if (x >= bx && x < bx + w) return k;
      }
    }
    for (let k = lo; k <= hi; k++) {
      if (isBlack(k)) continue;
      const [kx, w] = span(k);
      if (x >= kx && x < kx + w) return k;
    }
    return x < 0 ? lo : hi;
  };
  const locate = (e: React.PointerEvent) => {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    const x = ((e.clientX - r.left) * W) / r.width, y = ((e.clientY - r.top) * H) / r.height;
    const key = keyAt(x, y);
    const vel = Math.round(Math.max(1, Math.min(127, 30 + 98 * Math.min(1, Math.max(0, y / (isBlack(key) ? blackH : H))))));
    return { key, vel };
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

  const whites: React.ReactNode[] = [], blacks: React.ReactNode[] = [];
  for (let k = lo; k <= hi; k++) {
    const [x, w] = span(k);
    const on = held.has(k) || k === pressed;
    if (isBlack(k)) {
      blacks.push(
        <g key={k}>
          <rect x={x} y={0} width={w} height={blackH} rx={1.5} fill={on ? (c.pressedColor ?? '#fe8025') : (c.blackColor ?? '#2f3031')} />
          {!on && <rect x={x + 1.5} y={1} width={w - 3} height={blackH - 5} rx={1} fill="#424446" />}
        </g>,
      );
    } else {
      whites.push(
        <g key={k}>
          <rect x={x + 0.5} y={0} width={w - 1} height={H - 0.5} rx={1.5} fill={on ? (c.pressedColor ?? '#fe8025') : (c.whiteColor ?? '#cfd3da')} />
          {!on && <rect x={x + 0.5} y={H - 6} width={w - 1} height={5.5} rx={1.5} fill="#b7bbc4" />}
          {k === 60 && <rect x={x + w / 2 - 3} y={H - 13} width={6} height={4} rx={1} fill={c.middleColor ?? '#7ff0aa'} />}
        </g>,
      );
    }
  }
  return (
    <div className="og-ctl og-kb" style={{ left: c.x, top: c.y, width: W, height: H }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', touchAction: 'none' }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          const L = locate(e);
          play(L.key, L.vel);
          setHint(`${keyName(L.key)} - velocity ${L.vel}`);
        }}
        onPointerMove={(e) => {
          const L = locate(e);
          if (note.current && (e.buttons & 1)) { if (L.key !== note.current.key) play(L.key, L.vel); return; }
          setHint(`${keyName(L.key)}: click to play`);
        }}
        onPointerUp={stop}
        onPointerCancel={stop}
        onPointerLeave={() => { if (!note.current) clearHint(); }}
        onContextMenu={(e) => e.preventDefault()}>
        <rect x={0} y={0} width={W} height={H} fill="#1b1c1f" />
        {whites}
        {blacks}
      </svg>
    </div>
  );
}
