// FL's Set time dialog (TSetTimeForm, 259 x 164): opened by right-clicking the
// start, end or current time. Four digit wheels (Hours, Minutes, Seconds and
// Milliseconds, or the frame number in the SMPTE displays) and Accept / Cancel.
// FL shows it in the screen's centre; here it is a modal dialog in the page's
// centre. Positions are the form's.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DigiWheelControl } from '../../kit';
import type { ControlProps } from '../../../widgets/control';
import { fieldsToTime, lastFieldMax, timeFields } from '../../../../model/gen/plugins/videoplayer';

const BG = '#3c454b';

export interface TimeDialogProps {
  /** FL's caption: "Start time (H:M:S:MS)". */
  title: string;
  /** Time display mode (VP_TIME_MODES tag) and the clip's frame rate. */
  mode: number;
  clipFps: number;
  /** The time to edit (seconds). */
  value: number;
  onAccept: (seconds: number) => void;
  onCancel: () => void;
}

function Cap({ x, y, w, children }: { x: number; y: number; w: number; children: string }) {
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, height: 15, textAlign: 'center', fontSize: 12, lineHeight: '15px', color: '#c9d2d7', pointerEvents: 'none' }}>{children}</div>
  );
}

function Btn({ x, y, children, onClick }: { x: number; y: number; children: string; onClick: () => void }) {
  return (
    <div className="vp-dlg-btn" style={{ left: x, top: y, width: 68, height: 33 }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}>{children}</div>
  );
}

export function SetTimeDialog({ title, mode, clipFps, value, onAccept, onCancel }: TimeDialogProps) {
  const f0 = timeFields(value, mode, clipFps);
  const [h, setH] = useState(f0[0]);
  const [m, setM] = useState(f0[1]);
  const [s, setS] = useState(f0[2]);
  const [x, setX] = useState(f0[3]);
  const lastMax = lastFieldMax(mode, clipFps);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.focus(); }, []);

  const ctl = (label: string, v: number, set: (n: number) => void, max: number): ControlProps => ({
    value: v, min: 0, max, defaultValue: 0, step: 1, label, onChange: set, travel: Math.max(60, max * 4),
  });
  const accept = () => onAccept(fieldsToTime(h, m, s, Math.min(x, lastMax), mode, clipFps));

  return createPortal(
    <div className="vp-dlg-back" onPointerDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div ref={root} className="vp-dlg" tabIndex={-1} style={{ width: 259, height: 164, background: BG }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); accept(); }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}>
        {/* caption bar (CS_Sober) with FL's close button */}
        <div className="vp-dlg-title" style={{ height: 26 }}>
          <span style={{ position: 'absolute', left: 4, top: 0, lineHeight: '26px', maxWidth: 210, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{title}</span>
          <div className="vp-dlg-close" style={{ left: 237, top: 2, width: 21, height: 21 }}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onCancel(); } }}>
            <svg width={9} height={9} viewBox="0 0 9 9"><path d="M1.5 1.5 L7.5 7.5 M7.5 1.5 L1.5 7.5" stroke="#3a2412" strokeWidth={1.7} /></svg>
          </div>
        </div>
        <Cap x={19} y={38} w={30}>Hours</Cap>
        <Cap x={78} y={38} w={40}>Minutes</Cap>
        <Cap x={139} y={39} w={41}>Seconds</Cap>
        <Cap x={mode === 0 ? 215 : 203} y={39} w={mode === 0 ? 16 : 40}>{mode === 0 ? 'MS' : 'Frame'}</Cap>
        <DigiWheelControl x={14} y={59} w={40} h={29} control={ctl('Hours', h, setH, 99)} />
        <DigiWheelControl x={78} y={59} w={40} h={29} control={ctl('Minutes', m, setM, 59)} />
        <DigiWheelControl x={140} y={60} w={40} h={29} control={ctl('Seconds', s, setS, 59)} />
        <DigiWheelControl x={203} y={60} w={40} h={29} control={ctl(mode === 0 ? 'Milliseconds' : 'Frame', Math.min(x, lastMax), setX, lastMax)} />
        <Btn x={19} y={123} onClick={accept}>Accept</Btn>
        <Btn x={175} y={123} onClick={onCancel}>Cancel</Btn>
      </div>
    </div>,
    document.body,
  );
}
