// VFX Level Scaler editor (FL: 566 x 481). Property tabs (TargetSelect 8,8
// 343x30) over the control sheet (ctrlPanel 8,38 550x378): Center / Multiply /
// Offset sliders, Tension and Humanize knobs, humanize Mode combo and RESET,
// and the live display (input -> output graph with the identity diagonal,
// the curve and the humanize band). Title band with the "Event persistence"
// knob (display fade time; editor setting, not a parameter).

import { useState } from 'react';
import { Display, FxPanel, Label, Wheel, WheelControl, useFxEdit, useFxEditor, useFxState, useFxView, useParam } from '../kit';
import type { FxEditorModule } from '../registry';
import { useControl } from '../../widgets/control';
import { store } from '../../../store';
import { clearHint, setHint } from '../../hint';
import {
  HUMANIZE_MODES, LS_TARGETS, lsBand, lsChannel, lsCurve, lsKey, type LsField,
} from '../../../model/fx/plugins/vfxlevelscaler';
import { CANVAS_FONT, ParamCombo, SheetTabs, VfxTitle } from './vfx/common';

const CYAN = '#4fd8ff';
const PANEL = '#4a5055';

/** FL 2026 vertical slider: tick ladder, silver cap, cyan value line from the zero position. */
function FancySlider({ k, x, y, w, h }: { k: string; x: number; y: number; w: number; h: number }) {
  const p = useParam(k);
  const capH = 34, capW = 22;
  const travel = h - capH;
  const hnd = useControl({ ...p.control, travel }, 'vertical');
  const min = p.def.min, max = p.def.max;
  const t = (p.value - min) / (max - min || 1);
  const zero = min < 0 ? -min / (max - min) : 0;
  const capY = (1 - t) * travel;
  const zeroY = capH / 2 + (1 - zero) * travel;
  const valY = capY + capH / 2;
  const ticks = 10;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, touchAction: 'none' }} {...hnd}>
      <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const ty = capH / 2 + (i / ticks) * travel;
          return (
            <g key={i}>
              <rect x={w / 2 - 15} y={ty - 0.5} width={9} height={1} fill="#3b4145" />
              <rect x={w / 2 + 6} y={ty - 0.5} width={9} height={1} fill="#3b4145" />
            </g>
          );
        })}
        <rect x={w / 2 - 14} y={capH / 2} width={8} height={travel} fill="rgba(0,0,0,0.08)" />
        <rect x={w / 2 + 6} y={capH / 2} width={8} height={travel} fill="rgba(0,0,0,0.08)" />
        <rect x={w / 2 - 1.5} y={capH / 2 - 8} width={3} height={travel + 16} rx={1.5} fill="#24292c" />
        <rect x={w / 2 - 0.75} y={Math.min(zeroY, valY)} width={1.5} height={Math.abs(zeroY - valY)} fill={CYAN} />
        <rect x={0} y={valY - 0.5} width={w} height={1} fill={CYAN} />
        <defs>
          <linearGradient id={`lscap-${k}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f4f6f7" />
            <stop offset="0.3" stopColor="#c9ced2" />
            <stop offset="0.5" stopColor="#9aa1a7" />
            <stop offset="0.53" stopColor="#6f777d" />
            <stop offset="1" stopColor="#8d959b" />
          </linearGradient>
        </defs>
        <rect x={w / 2 - capW / 2 + 0.5} y={capY + 1.5} width={capW} height={capH} rx={4} fill="rgba(0,0,0,0.35)" />
        <rect x={w / 2 - capW / 2} y={capY} width={capW} height={capH} rx={4} fill={`url(#lscap-${k})`} stroke="#4c5358" strokeWidth={0.8} />
        <rect x={w / 2 - capW / 2 + 3} y={valY - 0.6} width={capW - 6} height={1.2} fill="#2a2f33" />
      </svg>
    </div>
  );
}

function Graph({ tab }: { tab: number }) {
  const { params } = useFxEditor();
  const c = lsChannel(params, tab);
  const W = 384, H = 365;
  return (
    <Display x={168} y={44} w={W} h={H} deps={[c.center, c.mul, c.ofs, c.tension, c.hum, c.mode, tab]} draw={(g, w, h) => {
      g.fillStyle = '#4e585d';
      g.fillRect(0, 0, w, h);
      const px = 1, py = 1, gw = w - 2, gh = h - 2;
      const X = (v: number) => px + v * gw, Y = (v: number) => py + (1 - v) * gh;
      // grid (10 x 10)
      g.strokeStyle = '#4c5d67';
      g.lineWidth = 1;
      for (let i = 1; i < 10; i++) {
        const xx = Math.round(X(i / 10)) + 0.5, yy = Math.round(Y(i / 10)) + 0.5;
        g.beginPath(); g.moveTo(xx, py); g.lineTo(xx, py + gh); g.stroke();
        g.beginPath(); g.moveTo(px, yy); g.lineTo(px + gw, yy); g.stroke();
      }
      // property watermark
      g.font = `italic 700 21px ${CANVAS_FONT}`;
      g.fillStyle = 'rgba(160,172,180,0.32)';
      g.textBaseline = 'top';
      g.fillText(LS_TARGETS[tab].tab, 10, 8);
      // identity diagonal
      g.strokeStyle = 'rgba(205,214,219,0.45)';
      g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(1), Y(1)); g.stroke();
      const N = 200;
      // humanize band
      if (c.hum > 0) {
        g.beginPath();
        for (let i = 0; i <= N; i++) { const x = i / N; const [, hi] = lsBand(x, c); if (i === 0) g.moveTo(X(x), Y(hi)); else g.lineTo(X(x), Y(hi)); }
        for (let i = N; i >= 0; i--) { const x = i / N; const [lo] = lsBand(x, c); g.lineTo(X(x), Y(lo)); }
        g.closePath();
        g.fillStyle = 'rgba(79,216,255,0.13)';
        g.fill();
        g.strokeStyle = 'rgba(79,200,240,0.42)';
        for (const side of [0, 1] as const) {
          g.beginPath();
          for (let i = 0; i <= N; i++) { const x = i / N; const b = lsBand(x, c)[side]; if (i === 0) g.moveTo(X(x), Y(b)); else g.lineTo(X(x), Y(b)); }
          g.stroke();
        }
      }
      // the curve
      g.strokeStyle = '#63ebff';
      g.lineWidth = 2;
      g.beginPath();
      for (let i = 0; i <= N; i++) { const x = i / N; const yv = lsCurve(x, c); if (i === 0) g.moveTo(X(x), Y(yv)); else g.lineTo(X(x), Y(yv)); }
      g.stroke();
      g.lineWidth = 1;
      g.strokeStyle = '#3a4449';
      g.strokeRect(0.5, 0.5, w - 1, h - 1);
    }} />
  );
}

function LevelScalerEditor() {
  const edit = useFxEdit();
  const view = useFxView();
  const [tab, setTab] = useState(0);
  const fade = useFxState<number>('fade', 12288);
  const key = (f: LsField) => lsKey(tab, f);
  const reset = () => {
    edit(`Reset ${LS_TARGETS[tab].name}`, (p) => {
      p[key('Center')] = LS_TARGETS[tab].center; p[key('Mul')] = 8192; p[key('Ofs')] = 0;
      p[key('Tension')] = 0; p[key('Hum')] = 0; p[key('HumMode')] = 1;
    });
  };
  return (
    <FxPanel width={566} height={481} style={{ background: '#394349' }}>
      <div className="fxk-abs" style={{ left: 8, top: 38, width: 550, height: 378, background: PANEL, borderRadius: '0 3px 3px 3px', boxShadow: 'inset 0 0 0 1px #343c41' }} />
      <SheetTabs x={8} y={9} h={29} value={tab} onChange={setTab}
        look={{ on: PANEL, off: '#424c52', onText: '#4fd4ff', offText: '#d5dbde', font: '15px var(--font-ui)', slant: 12, line: '#353e43' }}
        tabs={[{ label: 'Velocity', w: 74 }, { label: 'Release', w: 68 }, { label: 'Pitch', w: 48 }, { label: 'Pan', w: 40 }, { label: 'Mod X', w: 54 }, { label: 'Mod Y', w: 54 }]} />
      <Label x={8 + 11} y={38 + 8} w={42} h={14} size={11} color="#dde3e6" style={{ textTransform: 'none' }}>Center</Label>
      <Label x={8 + 56} y={38 + 8} w={47} h={14} size={11} color="#dde3e6" style={{ textTransform: 'none' }}>Multiply</Label>
      <Label x={8 + 106} y={38 + 8} w={42} h={14} size={11} color="#dde3e6" style={{ textTransform: 'none' }}>Offset</Label>
      <FancySlider key={`c${tab}`} k={key('Center')} x={8 + 12} y={38 + 26} w={40} h={210} />
      <FancySlider key={`m${tab}`} k={key('Mul')} x={8 + 59} y={38 + 26} w={40} h={271} />
      <FancySlider key={`o${tab}`} k={key('Ofs')} x={8 + 107} y={38 + 26} w={40} h={271} />
      <Wheel key={`t${tab}`} k={key('Tension')} x={8 + 14} y={38 + 240} size={36} look="flat" color={CYAN} track="#2b3236" />
      <Label x={8 + 9} y={38 + 282} w={46} h={19} size={11} color="#dde3e6" style={{ textTransform: 'none' }}>Tension</Label>
      <Wheel key={`h${tab}`} k={key('Hum')} x={8 + 14} y={38 + 309} size={36} look="flat" color={CYAN} track="#2b3236" />
      <Label x={8 + 5} y={38 + 351} w={54} h={19} size={11} color="#dde3e6" style={{ textTransform: 'none' }}>Humanize</Label>
      <ParamCombo key={`hm${tab}`} k={key('HumMode')} x={8 + 67} y={38 + 322} w={79} h={22} options={HUMANIZE_MODES}
        text={(v) => HUMANIZE_MODES[Math.round(v)] ?? ''}
        look={{ bg: '#2f363a', fg: '#e3e8ea', arrow: '#8d979c', radius: 2 }} style={{ boxShadow: 'inset 0 0 0 1px #262c30', fontSize: 12 }} />
      <Label x={8 + 70} y={38 + 351} w={42} h={19} size={11} color="#dde3e6" style={{ textTransform: 'none' }}>Mode</Label>
      <div className="fxk-abs" style={{ left: 8 + 112, top: 38 + 354, width: 35, height: 13, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.08em', color: '#e9eef0', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); reset(); } }}
        onPointerEnter={() => setHint('Reset all controls for this property')} onPointerLeave={clearHint}>RESET</div>
      <Graph tab={tab} />
      <VfxTitle y={425} w={566} h={56} name="Level Scaler" />
      <Label x={412} y={443} w={112} h={19} size={12} color="#b9c3c8" align="right" style={{ textTransform: 'none' }}>Event persistence</Label>
      <WheelControl x={530} y={441} size={28} look="flat" color={CYAN} track="#2b3236"
        control={{
          value: fade, min: 1, max: 16384, defaultValue: 12288, step: 1, label: 'Fade out speed of displayed events',
          format: (v) => `${Math.round((v / 16384) * 100)}%`,
          onChange: (v) => view('Event persistence', (p) => { p.fade = Math.round(v); }),
          onBegin: () => store.beginGesture('Event persistence'), onEnd: () => store.endGesture(),
        }} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'vfxlevelscaler', Editor: LevelScalerEditor };
