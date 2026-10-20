// Reeverb 2 editor (FL: Fruity Reeverb 2, 530 x 160): the room visual on the
// left (a glowing wireframe room sized by Room size, brightening with the
// reverb output), then FL's four control sections at the form's coordinates:
// MID/SIDE + input cuts, predelay / size / diffusion / modulation, bass /
// decay / crossover / damping, and the dry / ER / wet faders with separation.

import { useRef } from 'react';
import * as A from '../../../../store/actions';
import { predelayTempoText } from '../../../../model/fx/plugins/reeverb2';
import { AnimatedDisplay, FxPanel, useFxEditor, useFxMonitor, useFxState, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { MidSideSwitch, RoundLed, RvFader, RvKnob } from './widgets';
import './reeverb2.css';

const ML = 160; // MainPanel left

function Cap({ x, y, w = 50, children }: { x: number; y: number; w?: number; children: string }) {
  return <div className="rv2-cap" style={{ left: x - w / 2, top: y, width: w, height: 13, lineHeight: '13px' }}>{children}</div>;
}

/** Knob + caption, positioned by the knob's form Left/Top (MainPanel coordinates). */
function K({ k, l, t, cap, bipolar }: { k: string; l: number; t: number; cap: string; bipolar?: boolean }) {
  return (
    <>
      <RvKnob k={k} x={ML + l} y={t} bipolar={bipolar} />
      <Cap x={ML + l + 18} y={t + 37}>{cap}</Cap>
    </>
  );
}

interface VisState { level: number; room: number; roomShown: number; spin: number; last: number; drag: number | null }

/**
 * The room: a glowing wireframe frustum (FL's geometry at room size 50: top
 * ellipse 43 x 18.7 px at y 53, bottom 33.7 x 18 px at y 107). Room size
 * scales it; the reverb output brightens the glow. Dragging turns it.
 */
function RoomVisual() {
  const { slotId } = useFxEditor();
  const room = useParam('room').value;
  const st = useRef<VisState>({ level: 0, room, roomShown: room, spin: 0, last: 0, drag: null });
  st.current.room = room;
  useFxMonitor(slotId, (d) => {
    const s = st.current;
    s.level = Math.max(s.level, Number(d.peak) || 0);
  });
  return (
    <AnimatedDisplay x={0} y={0} w={160} h={160}
      onPointerDown={(e) => { if (e.button === 0) { st.current.drag = e.clientX; (e.currentTarget as Element).setPointerCapture(e.pointerId); } }}
      onPointerMove={(e) => { const s = st.current; if (s.drag !== null) { s.spin += (e.clientX - s.drag) * 0.01; s.drag = e.clientX; } }}
      onPointerUp={() => { st.current.drag = null; }}
      frame={(g, W, H, t) => {
        const s = st.current;
        const dt = s.last ? Math.min(0.1, (t - s.last) / 1000) : 0;
        s.last = t;
        s.roomShown += (s.room - s.roomShown) * Math.min(1, dt * 12);
        s.level *= Math.pow(0.05, dt); // about -26 dB/s fall
        const lv = Math.min(1, Math.sqrt(s.level));
        const k = 0.35 + 0.65 * Math.sqrt(s.roomShown / 50); // 1 at room 50
        const cx = 80, cy = 80;
        const tY = cy + (53.3 - cy) * k, bY = cy + (106.7 - cy) * k;
        const tRx = 43 * k, tRy = 18.7 * k, bRx = 33.7 * k, bRy = 18 * k;
        g.fillStyle = '#6f6565';
        g.fillRect(0, 0, W, H);
        const halo = g.createRadialGradient(cx, cy, 6 * k, cx, cy, 76 * k);
        halo.addColorStop(0, `rgba(150,142,142,${0.7 + 0.3 * lv})`);
        halo.addColorStop(0.55, `rgba(134,125,125,${0.45 + 0.3 * lv})`);
        halo.addColorStop(1, 'rgba(111,101,101,0)');
        g.fillStyle = halo;
        g.fillRect(0, 0, W, H);
        const N = 22;
        const path = () => {
          g.beginPath();
          g.ellipse(cx, tY, tRx, tRy, 0, 0, Math.PI * 2);
          g.moveTo(cx + bRx, bY);
          g.ellipse(cx, bY, bRx, bRy, 0, 0, Math.PI * 2);
          for (let i = 0; i < N; i++) {
            const a = s.spin + (i / N) * Math.PI * 2;
            const c = Math.cos(a), sn = Math.sin(a);
            g.moveTo(cx + tRx * c, tY + tRy * sn);
            g.lineTo(cx + bRx * c, bY + bRy * sn);
          }
        };
        g.save();
        g.strokeStyle = '#ffffff';
        g.shadowColor = '#ffffff';
        g.globalAlpha = 0.16 + 0.3 * lv;
        g.lineWidth = 4;
        g.shadowBlur = 16;
        path(); g.stroke();
        g.globalAlpha = 0.22 + 0.2 * lv;
        g.lineWidth = 2.4;
        g.shadowBlur = 7;
        path(); g.stroke();
        g.globalAlpha = 0.55;
        g.lineWidth = 1.3;
        g.shadowBlur = 3;
        path(); g.stroke();
        g.globalAlpha = 1;
        g.shadowBlur = 0;
        g.lineWidth = 1.05;
        path(); g.stroke();
        g.restore();
      }} />
  );
}

function Reeverb2Editor() {
  const { slotId } = useFxEditor();
  const side = useFxState('side', false);
  const tempo = useFxState('tempo', false);
  const pdText = tempo ? { format: predelayTempoText } : undefined;
  return (
    <FxPanel width={530} height={160} className="rv2-panel">
      <RoomVisual />
      <div className="rv2-main" />
      <div className="rv2-sep" style={{ left: 159 }} />
      <div className="rv2-sep" style={{ left: 218 }} />
      <div className="rv2-sep" style={{ left: 321 }} />
      <div className="rv2-sep" style={{ left: 423 }} />
      <div className="fxk-abs" style={{ left: 0, top: 0, width: 530, height: 160, boxShadow: 'inset 0 0 0 1px #23292e', pointerEvents: 'none' }} />

      {/* input section */}
      <MidSideSwitch x={ML + 9} y={18} side={side} onChange={(v) => A.editFx(slotId, v ? 'Side input' : 'Mid input', (p) => { p.side = v; })} />
      <K k="highCut" l={12} t={57} cap="H.CUT" />
      <K k="lowCut" l={12} t={108} cap="L.CUT" />

      {/* space section */}
      <div className="rv2-wire" style={{ left: ML + 107, top: 18, width: 28, height: 1 }} />
      <div className="rv2-wire" style={{ left: ML + 134, top: 18, width: 1, height: 9 }} />
      <div className="rv2-wire" style={{ left: ML + 150, top: 71, width: 5, height: 1 }} />
      <div className="rv2-wire" style={{ left: ML + 154, top: 71, width: 1, height: 62 }} />
      <div className="rv2-wire" style={{ left: ML + 150, top: 133, width: 5, height: 1 }} />
      <RvKnob k="predelay" x={ML + 71} y={5} control={pdText} />
      <Cap x={ML + 89} y={42}>DELAY</Cap>
      <RoundLed x={ML + 127} y={27} on={tempo} hint="Tempo-based predelay"
        onToggle={() => A.editFx(slotId, 'Tempo-based predelay', (p) => { p.tempo = !p.tempo; })} />
      <div className="rv2-cap" style={{ left: ML + 109, top: 42, width: 50, height: 13, lineHeight: '13px', color: '#98a6ae', fontWeight: 400 }}>TEMPO</div>
      <K k="room" l={71} t={57} cap="SIZE" />
      <K k="modDepth" l={115} t={57} cap="MOD" />
      <K k="diffusion" l={71} t={108} cap="DIFF" />
      <K k="modSpeed" l={115} t={108} cap="SPEED" />

      {/* decay section */}
      <K k="bass" l={174} t={5} cap="BASS" />
      <K k="decay" l={218} t={5} cap="DEC" />
      <K k="cross" l={174} t={57} cap="CROSS" />
      <K k="damping" l={217} t={57} cap="DAMP" />
      <div className="rv2-logo" style={{ left: ML + 170, top: 127, fontSize: 31, lineHeight: '34px', transform: 'scaleX(0.74)', transformOrigin: '0 0' }}>
        REEVERB<span style={{ fontWeight: 600, fontSize: 36, marginLeft: 7 }}>2</span>
      </div>

      {/* levels */}
      <RvFader k="dry" x={ML + 274} y={1} w={24} h={90} />
      <RvFader k="er" x={ML + 306} y={1} w={24} h={90} />
      <RvFader k="wet" x={ML + 337} y={1} w={24} h={90} />
      <Cap x={ML + 286} y={93}>DRY</Cap>
      <Cap x={ML + 318} y={93}>ER</Cap>
      <Cap x={ML + 349} y={93}>WET</Cap>
      <div className="fxk-abs" style={{ left: ML + 316.5, top: 104, width: 3, height: 3, borderRadius: 2, background: '#9c8889' }} />
      <RvKnob k="sep" x={ML + 300} y={108} bipolar />
      <div className="rv2-arrow" style={{ left: ML + 298, top: 147, borderLeft: '5px solid #aab4b8' }} />
      <div className="rv2-arrow" style={{ left: ML + 334, top: 147, borderRight: '5px solid #aab4b8' }} />
      <Cap x={ML + 318} y={145} w={30}>SEP</Cap>
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'reeverb2', Editor: Reeverb2Editor };
