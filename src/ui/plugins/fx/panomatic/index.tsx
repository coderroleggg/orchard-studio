// PanOMatic editor (FL: Fruity PanOMatic, 300 x 160). Left: PAN / VOL wheels
// and the LFO panel (shape glyphs, AMT / SPD wheels, OFF / PAN / VOL target
// LEDs); right: FL's green pan/volume grid. Dragging in the grid sets pan (x)
// and volume (y); the white cross shows the wheels and, while the LFO runs,
// a second line follows the modulated pan or volume (FL's GridSelect paint
// routine, read from the binary: x = pan * (W-1) / 256, y = (H-1) - vol *
// (H-1) / 320).

import { useRef } from 'react';
import { panoVolFromGain } from '../../../../model/fx/plugins/panomatic';
import { AnimatedDisplay, FxPanel, Label, useFxEditor, useFxMonitor, useParam } from '../../kit';
import { store } from '../../../../store';
import { clearHint, setHint } from '../../../hint';
import type { FxEditorModule } from '../../registry';
import { COND_FONT, COND_SQUEEZE, GlyphSelect, LedRadio, MetalKnob, SoberPanel } from './widgets';

const GRID = { x: 145, y: 5, w: 150, h: 150 };
const LABEL = { font: COND_FONT, color: '#a3afb6' };

function CapLabel({ x, y, w, children }: { x: number; y: number; w: number; children: string }) {
  return (
    <Label x={x} y={y} w={w} h={15} size={11} color={LABEL.color}
      style={{ fontFamily: LABEL.font, fontStretch: 'condensed', letterSpacing: 0, overflow: 'visible', transform: `scaleX(${COND_SQUEEZE * 0.92})` }}>{children}</Label>
  );
}

function PanVolGrid() {
  const { slotId } = useFxEditor();
  const pan = useParam('pan');
  const vol = useParam('vol');
  const target = useParam('target');
  const live = useRef({ pan: 0, vol: 1, target: 0, at: 0 });
  const vals = useRef({ pan: pan.value, vol: vol.value, target: target.value });
  vals.current = { pan: pan.value, vol: vol.value, target: target.value };
  useFxMonitor(slotId, (d) => {
    const s = live.current;
    s.pan = Number(d.pan) || 0;
    s.vol = Number(d.vol) || 0;
    s.target = Number(d.target) || 0;
    s.at = performance.now();
  });
  const drag = useRef(false);
  const setFrom = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const kx = r.width / 160, ky = r.height / 160;
    const fx = ((e.clientX - r.left) / kx - (GRID.x - 140)) / (GRID.w - 1);
    const fy = ((e.clientY - r.top) / ky - GRID.y) / (GRID.h - 1);
    const pv = Math.round(Math.min(1, Math.max(0, fx)) * 256);
    const vv = Math.round((1 - Math.min(1, Math.max(0, fy))) * 320);
    if (pv !== pan.value) pan.set(pv);
    if (vv !== vol.value) vol.set(vv);
    setHint(`${pan.control.format?.(pv)} / ${vol.control.format?.(vv)}`);
  };
  return (
    <AnimatedDisplay x={140} y={0} w={160} h={160}
      onPointerDown={(e) => {
        if (e.button === 1 || (e.button === 0 && e.altKey)) {
          // reset both, like a wheel's Alt+click
          store.beginGesture('Panning / volume');
          pan.set(pan.def.def); vol.set(vol.def.def);
          store.endGesture();
          return;
        }
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = true;
        store.beginGesture('Panning / volume');
        setFrom(e);
      }}
      onPointerMove={(e) => {
        if (drag.current) setFrom(e);
        else setHint('Panning / volume');
      }}
      onPointerUp={() => { if (drag.current) { drag.current = false; store.endGesture(); } clearHint(); }}
      frame={(g, W, H) => {
        const v = vals.current, s = live.current;
        g.fillStyle = '#347443';
        g.fillRect(0, 0, W, H);
        const ox = GRID.x - 140, oy = GRID.y, gw = GRID.w, gh = GRID.h;
        const hair = 0.62;
        g.fillStyle = '#5b936a';
        for (let k = 0; k <= 6; k++) {
          const p = Math.min(k * 25, gw - hair);
          g.fillRect(ox + p, oy, hair, gh);
          g.fillRect(ox, oy + Math.min(k * 25, gh - hair), gw, hair);
        }
        const cx = ox + (v.pan * (gw - 1)) / 256;
        const cy = oy + (gh - 1) - (v.vol * (gh - 1)) / 320;
        g.fillStyle = '#ffffdf';
        g.fillRect(cx, oy, hair, gh);
        g.fillRect(ox, cy, gw, hair);
        // LFO-modulated line (FL draws it in a second colour while the LFO runs)
        const fresh = performance.now() - s.at < 500;
        if (fresh && v.target > 0 && s.target === v.target) {
          g.fillStyle = '#ffd0d0';
          if (v.target === 1) {
            const lx = ox + (Math.round(s.pan * 128 + 128) * (gw - 1)) / 256;
            g.fillRect(lx, oy, hair, gh);
          } else {
            const pos = Math.round(panoVolFromGain(s.vol));
            const ly = oy + (gh - 1) - (pos * (gh - 1)) / 320;
            g.fillRect(ox, ly, gw, hair);
          }
        }
        // plugin name, bottom right (FL: wide oblique sans, 131 px wide, cap height 12)
        g.font = 'italic 600 16.5px Arial, "Helvetica Neue", Helvetica, sans-serif';
        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
        g.fillStyle = '#5b9067';
        const tw = g.measureText('PanOMatic').width || 1;
        g.save();
        g.translate(ox + gw - 0.5 - 131.5, oy + gh - 4);
        g.scale(131.5 / tw, 1);
        g.fillText('PanOMatic', 0, 0);
        g.restore();
      }} />
  );
}

function PanOMaticEditor() {
  return (
    <FxPanel width={300} height={160} style={{ background: '#373c50' }}>
      <SoberPanel x={0} y={0} w={139} h={65}>
        <MetalKnob k="pan" x={7} y={8} size={40} dot={0.5} />
        <MetalKnob k="vol" x={50} y={8} size={40} />
        <CapLabel x={57} y={46} w={26}>VOL</CapLabel>
        <CapLabel x={11} y={46} w={32}>PAN</CapLabel>
      </SoberPanel>
      <SoberPanel x={0} y={66} w={139} h={94} title="LFO" tabW={35} tabH={18}>
        <MetalKnob k="amount" x={7} y={37} size={40} />
        <MetalKnob k="speed" x={50} y={37} size={40} control={{ step: 0 }} />
        <CapLabel x={11} y={76} w={32}>AMT</CapLabel>
        <CapLabel x={56} y={76} w={26}>SPD</CapLabel>
        <GlyphSelect k="shape" x={58} y={13} w={72} h={21} glyphs={['sine', 'triangle', 'square']} />
        <LedRadio k="target" x={97} y={38} w={40} h={51} />
      </SoberPanel>
      <PanVolGrid />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'panomatic', Editor: PanOMaticEditor };
