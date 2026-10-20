// Sytrus testing keyboard (FL: KeyboardBevel 0,348,845x102 and MIDIKbPanel
// 4,355,752x95, widened to the panel as in FL; a TQuickVectorMIDIKb of 24 px white keys): a ruler with the
// octave names and the keys from A2; left-click plays the channel (the vertical
// position sets the velocity). Simplified: no scrolling, no key range display.

import { useEffect, useRef, useState } from 'react';
import { host } from '../../../../store';
import { setHint, clearHint } from '../../../hint';
import { useFxEditor } from '../../kit';
import { channelOfSlot } from '../../../../model/gen/ids';
import { keyName } from '../../../../model/notes';
import { C, FONT } from './theme';

const KW = 24, BW = 14, RULER = 12;
const FIRST = 33; // A2 (FL's C5 = 60)
const WHITE = [0, 2, 4, 5, 7, 9, 11];
const isBlack = (k: number) => [1, 3, 6, 8, 10].includes(k % 12);

export function Keyboard({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const { slotId } = useFxEditor();
  const ch = channelOfSlot(slotId);
  const [down, setDown] = useState<number | null>(null);
  const note = useRef<{ key: number; tag: number } | null>(null);
  useEffect(() => () => {
    const n = note.current;
    if (n && ch) host.noteOff(ch, n.key, n.tag);
    note.current = null;
  }, [ch]);
  // white keys from A2
  const whites: number[] = [];
  for (let k = FIRST; whites.length * KW < w; k++) if (WHITE.includes(k % 12)) whites.push(k);
  const keysH = h - RULER;
  const blackH = Math.round(keysH * 0.6);
  const blacks: { key: number; x: number }[] = [];
  whites.forEach((k, i) => { if (isBlack(k + 1) && i < whites.length) blacks.push({ key: k + 1, x: (i + 1) * KW - BW / 2 }); });
  const stop = () => {
    const n = note.current;
    if (n && ch) host.noteOff(ch, n.key, n.tag);
    note.current = null;
    setDown(null);
  };
  const play = (key: number, rel: number, e: React.PointerEvent) => {
    if (e.button !== 0 || !ch) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    stop();
    note.current = { key, tag: host.noteOn(ch, key, Math.round(30 + 97 * Math.min(1, Math.max(0, rel)))) };
    setDown(key);
  };
  const relY = (e: React.PointerEvent, kh: number) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return (e.clientY - r.top) / (r.height || kh);
  };
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, overflow: 'hidden', background: '#252525' }}
      onPointerLeave={clearHint}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: w, height: RULER, background: C.kbRuler }}>
        {whites.map((k, i) => (k % 12 === 0 ? (
          <span key={k} style={{ position: 'absolute', left: i * KW + 3, top: 0, fontSize: 8, lineHeight: `${RULER}px`, fontWeight: 700, color: C.label, fontFamily: FONT }}>{keyName(k)}</span>
        ) : null))}
      </div>
      {whites.map((k, i) => (
        <div key={k} style={{
          position: 'absolute', left: i * KW, top: RULER, width: KW - 1, height: keysH, borderRadius: '0 0 2px 2px',
          background: down === k ? C.kbPressed : k % 12 === 0 ? C.kbWhiteC : C.kbWhite, boxShadow: 'inset 0 -4px 0 rgba(0,0,0,0.12)',
        }}
          onPointerDown={(e) => play(k, relY(e, keysH), e)} onPointerUp={stop} onLostPointerCapture={() => { if (note.current?.key === k) stop(); }}
          onPointerEnter={() => setHint(keyName(k))} />
      ))}
      {blacks.map(({ key, x: bx }) => (
        <div key={key} style={{
          position: 'absolute', left: bx, top: RULER, width: BW, height: blackH, borderRadius: '0 0 2px 2px', zIndex: 1,
          background: down === key ? C.kbPressed : C.kbBlack, boxShadow: '0 2px 2px rgba(0,0,0,0.5), inset 0 -3px 0 rgba(255,255,255,0.06)',
        }}
          onPointerDown={(e) => play(key, relY(e, blackH), e)} onPointerUp={stop} onLostPointerCapture={() => { if (note.current?.key === key) stop(); }}
          onPointerEnter={() => setHint(keyName(key))} />
      ))}
    </div>
  );
}
