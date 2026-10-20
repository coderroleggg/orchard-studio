// BeepMap editor (FL: BeepMap, SynthPanel 380 x 170; the INS tab below it is the
// channel's). Every control sits at FL's form coordinates: the FREQ and LENGTH
// wheels (7,15 and 59,15; 40 x 40), the scale combo (117,22), the Use Blue /
// Grainy / Loop / Widen lamps (228,23 / 301,23 / 228,41 / 301,41), the labels
// under the wheels, the OPEN / preset list / COPY / PASTE strip (6,85), the
// title, the Max bitmap height wheel (336,89) and the bitmap panel (6,124;
// 368 x 40). Colours sampled from FL's plugin database thumbnail; original
// drawing. A picture dropped on the panel is loaded (FL: TDropFileTarget).

import { useId, useMemo, useState, type ReactNode } from 'react';
import { Display, useFxEdit, useFxEditor, useNoScrollWheel, useParam } from '../../kit';
import { useControl } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import type { FxEditorModule } from '../../registry';
import { bitmapOf, MAXH_DEFAULT, MAXH_MAX, MAXH_MIN, type Bitmap } from '../../../../model/gen/plugins/beepmap/image';
import { SCALES } from '../../../../model/gen/plugins/beepmap';
import { copyBitmap, dropFiles, hasBitmap, openBitmap, pasteBitmap, resetBitmap, runImport } from './load';
import './beepmap.css';

const ARC = '#33a8dc';

const SWEEP = 270;

function polar(c: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}

function arc(c: number, r: number, a0: number, a1: number): string {
  if (a1 - a0 < 0.05) return '';
  const [x0, y0] = polar(c, r, a0), [x1, y1] = polar(c, r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** FL's TVectorWheel as BeepMap shows it: a dark disc inside a thin ring with a blue arc up to the value. */
function WheelView({ size, t }: { size: number; t: number }) {
  const c = size / 2;
  const rRing = c - 2;
  const rBody = c - 5.5;
  const ang = -SWEEP / 2 + SWEEP * Math.min(1, Math.max(0, t));
  const [p0x, p0y] = polar(c, rBody * 0.5, ang);
  const [p1x, p1y] = polar(c, rBody * 0.92, ang);
  const id = 'bw' + useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4c5559" />
          <stop offset="0.55" stopColor="#363e42" />
          <stop offset="1" stopColor="#2b3236" />
        </linearGradient>
      </defs>
      <path d={arc(c, rRing, -SWEEP / 2, SWEEP / 2)} stroke="#1f2a31" strokeWidth={2.6} fill="none" />
      <path d={arc(c, rRing, -SWEEP / 2, ang)} stroke={ARC} strokeWidth={2.2} fill="none" />
      <circle cx={c} cy={c + 0.8} r={rBody + 1} fill="rgba(0,0,0,0.35)" />
      <circle cx={c} cy={c} r={rBody} fill={`url(#${id})`} stroke="#1b2226" strokeWidth={1} />
      <path d={arc(c, rBody - 1, -62, 62)} stroke="rgba(255,255,255,0.16)" strokeWidth={1} fill="none" />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke="#8fd3f2" strokeWidth={1.4} strokeLinecap="round" opacity={0.85} />
    </svg>
  );
}

/** A wheel bound to parameter `k` at FL's form position (40 x 40). */
function Knob({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  // a wheel notch moves 2 % of the range (the values stay whole numbers: the parameter rounds them)
  const h = useControl({ travel: 200, ...p.control, step: 0 }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div ref={ref} className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: 40, height: 40 }} {...h}>
      <WheelView size={40} t={t} />
    </div>
  );
}

function Lbl({ x, y, w, children, align = 'center' }: { x: number; y: number; w: number; children: string; align?: 'left' | 'center' }) {
  return <div className="bm-label" style={{ left: x, top: y, width: w, height: 9, textAlign: align }}>{children}</div>;
}

/** FL's FS_SoberCombo bound to the frequency scale parameter. */
function ScaleCombo() {
  const p = useParam('scale');
  const h = useControl({ ...p.control, format: (v) => SCALES[Math.round(v)] ?? '' }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const idx = Math.round(p.value);
  const pick = (i: number) => { p.control.onBegin?.(); p.set(i); p.control.onEnd?.(); };
  return (
    <div ref={ref} className="bm-combo" style={{ left: 117, top: 22, width: 98, height: 28 }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom, SCALES.map((s, i) => ({ label: s, radio: true, checked: i === idx, onClick: () => pick(i) } as MenuItem)), { minWidth: r.width });
      }}
      onWheel={h.onWheel} onContextMenu={h.onContextMenu}
      onPointerEnter={() => setHint(`${p.def.name}: ${SCALES[idx] ?? ''}`)} onPointerLeave={clearHint}>
      {SCALES[idx] ?? ''}
    </div>
  );
}

/** FL's TVectorCheckBox bound to a 0 / 1 parameter: the lamp is orange when on. */
function Lamp({ k, x, y, w, caption }: { k: string; x: number; y: number; w: number; caption: string }) {
  const p = useParam(k);
  const h = useControl(p.control, 'vertical');
  const on = p.value > p.def.min;
  return (
    <div className="bm-sw" style={{ left: x, top: y, width: w, height: 12 }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(on ? p.def.min : p.def.max); p.control.onEnd?.(); } }}
      onContextMenu={h.onContextMenu}
      onPointerEnter={() => setHint(`${p.def.name}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
      <span className={'bm-lamp' + (on ? ' on' : '')} />
      <span>{caption}</span>
    </div>
  );
}

/** FL's TSysBtn (FS_Sober). */
function Btn({ x, y, w, h = 31, cls, hint, onClick, children }: { x: number; y: number; w: number; h?: number; cls?: string; hint: string; onClick: (e: React.PointerEvent) => void; children: ReactNode }) {
  return (
    <div className={'bm-btn' + (cls ? ' ' + cls : '')} style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      {children}
    </div>
  );
}

/** The bitmap menu shared by the preset list button and the plugin window's menu. */
export function bitmapMenu(slotId: string, hasBitmap: boolean): MenuItem[] {
  return [
    { label: 'Open bitmap...', onClick: () => { void openBitmap(slotId); } },
    { label: 'Copy bitmap', onClick: () => { void copyBitmap(slotId); } },
    { label: 'Paste bitmap', onClick: () => { void pasteBitmap(slotId); } },
    { separator: true },
    { label: 'Stand-in bitmap', radio: true, checked: !hasBitmap, onClick: () => resetBitmap(slotId) },
    { separator: true },
    { label: 'Import FL content (files)...', onClick: () => { void runImport(slotId, 'files'); } },
    { label: 'Import FL content (folder)...', onClick: () => { void runImport(slotId, 'folder'); } },
  ];
}

/** FL's HeightSelect (TVectorDigiWheel, no parameter): the tallest bitmap a load keeps = the sines per voice. */
function HeightWheel() {
  const { params } = useFxEditor();
  const edit = useFxEdit();
  const raw = Number(params.maxH);
  const value = Number.isFinite(raw) ? Math.max(MAXH_MIN, Math.min(MAXH_MAX, Math.round(raw))) : MAXH_DEFAULT;
  const set = (v: number) => edit('Max bitmap height', (p) => { p.maxH = Math.max(MAXH_MIN, Math.min(MAXH_MAX, Math.round(v))); }, 'maxH');
  const h = useControl({ value, min: MAXH_MIN, max: MAXH_MAX, defaultValue: MAXH_DEFAULT, step: 1, travel: 700, label: 'Max bitmap height', format: (v) => String(Math.round(v)), onChange: set }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const bump = (d: number) => set(value + d);
  return (
    <div ref={ref} className="bm-height" style={{ left: 336, top: 89, width: 37, height: 25 }}
      onPointerEnter={() => setHint(`Max bitmap height: ${value}`)} onPointerLeave={clearHint}>
      <div className="bm-height-val" {...h}>{value}</div>
      <div className="bm-height-arrows">
        <div onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0) bump(1); }} />
        <div onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0) bump(-1); }} />
      </div>
    </div>
  );
}

const drawn = new WeakMap<Bitmap, HTMLCanvasElement>();

/** The bitmap as a canvas of its own size (cached per bitmap). */
function canvasOf(bitmap: Bitmap): HTMLCanvasElement {
  let cv = drawn.get(bitmap);
  if (!cv) {
    cv = document.createElement('canvas');
    cv.width = bitmap.w;
    cv.height = bitmap.h;
    const g = cv.getContext('2d');
    if (g) {
      const img = g.createImageData(bitmap.w, bitmap.h);
      for (let i = 0; i < bitmap.px.length; i++) {
        const c = bitmap.px[i];
        img.data[4 * i] = (c >>> 16) & 255; img.data[4 * i + 1] = (c >>> 8) & 255; img.data[4 * i + 2] = c & 255; img.data[4 * i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    }
    drawn.set(bitmap, cv);
  }
  return cv;
}

/** The bitmap panel: the picture stretched over it (FL's BmpDisplay). */
function BitmapPanel({ bitmap }: { bitmap: Bitmap }) {
  return (
    <Display x={7} y={125} w={366} h={38}
      draw={(g, w, h) => {
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.fillStyle = '#000';
        g.fillRect(0, 0, w, h);
        g.drawImage(canvasOf(bitmap), 0, 0, w, h);
      }}
      deps={[bitmap]} />
  );
}

function BeepMapEditor() {
  const { slotId, params } = useFxEditor();
  const bmp = typeof params.bmp === 'string' ? params.bmp : '';
  const bitmap = useMemo(() => bitmapOf(bmp), [bmp]);
  const [drop, setDrop] = useState(false);
  const id = 'bm' + useId().replace(/:/g, '');
  const loaded = bmp !== '';
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files');
  return (
    <div id={id} className="fxk-panel bm-panel" style={{ width: 380, height: 170, background: 'radial-gradient(70% 115% at 50% -8%, #354b5a 0%, #2c3f4b 38%, #243540 66%, #1d2930 100%)' }}
      onDragOver={(e) => { if (hasFiles(e)) { e.preventDefault(); setDrop(true); } }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => { setDrop(false); if (hasFiles(e)) { e.preventDefault(); void dropFiles(slotId, e.dataTransfer.files); } }}>
      <Knob k="freq" x={7} y={15} />
      <Knob k="length" x={59} y={15} />
      <Lbl x={8} y={63} w={38}>FREQ</Lbl>
      <Lbl x={58} y={63} w={42}>LENGTH</Lbl>
      <Lbl x={118} y={63} w={35} align="left">SCALE</Lbl>
      <ScaleCombo />
      <Lamp k="blue" x={228} y={23} w={67} caption="Use Blue" />
      <Lamp k="grainy" x={301} y={23} w={72} caption="Grainy" />
      <Lamp k="loop" x={228} y={41} w={56} caption="Loop" />
      <Lamp k="widen" x={301} y={41} w={64} caption="Widen" />
      <Btn x={6} y={85} w={50} cls="first" hint="Load a bitmap..." onClick={() => { void openBitmap(slotId); }}>Open</Btn>
      <Btn x={55} y={85} w={20} cls="mid" hint="Show bitmap preset list"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(r.left, r.bottom, bitmapMenu(slotId, loaded));
        }}>
        <svg width="10" height="9" viewBox="0 0 10 9"><path d="M1 1.5H9M1 4.5H9M1 7.5H9" stroke="currentColor" strokeWidth="1.3" /></svg>
      </Btn>
      <Btn x={78} y={85} w={50} cls="mid" hint="Copy bitmap to clipboard" onClick={() => { void copyBitmap(slotId); }}>Copy</Btn>
      <Btn x={127} y={85} w={50} cls="last" hint="Paste bitmap from clipboard" onClick={() => { void pasteBitmap(slotId); }}>Paste</Btn>
      <div className="bm-title" style={{ left: 200, top: 85, width: 129, height: 31 }}>BEEP · MAP</div>
      <HeightWheel />
      <div className={'bm-bmp' + (drop ? ' drop' : '')} style={{ left: 6, top: 124, width: 368, height: 40 }} />
      <BitmapPanel bitmap={bitmap} />
    </div>
  );
}

export const editor: FxEditorModule = {
  id: 'beepmap',
  Editor: BeepMapEditor,
  menu: (slotId) => bitmapMenu(slotId, hasBitmap(slotId)),
};
