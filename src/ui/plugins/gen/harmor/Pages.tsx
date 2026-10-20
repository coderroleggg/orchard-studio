// Harmor's IMG, FX and ADV pages (FL's TimbrePanel, EffectsPanel and
// AdvancedPanel, moved to (392, 330) at run time), the page selector
// (MainPageSelect: ENV / IMG / FX / ADV in FL's page colours) and the unit
// order lists.

import { useState, useSyncExternalStore } from 'react';
import type { HImage } from '../../../../model/gen/plugins/harmor/types';
import { samplePlanes } from '../../../../model/gen/plugins/harmor/import';
import { getRaw, onSamplesChanged, samplesVersion } from '../../../../audio/samples';
import { IMG_SAMPLE_KEYS } from './flimport';
import { setHint, clearHint } from '../../../hint';
import { openMenu } from '../../../widgets/ContextMenu';
import { Display } from '../../kit';
import { FORM } from './form';
import { HCtl } from './Ctl';
import { HButton, HCombo } from './widgets';
import { editGlobal, editPart, setView, useHarmor } from './use';
import { chorusMenu, reverbMenu } from './menus';
import { paintPage } from './paint';
import type { ControlProps } from '../../../widgets/control';
import { store } from '../../../../store';

export const PAGE_ORIGIN = { x: 392, y: 330, w: 632, h: 272 };

/** FL's page names and colours (MainPageSelectPaintCell, ARGB table 0x8ec068). */
export const PAGES: [string, string, string][] = [
  ['ENV', '#e1973f', 'articulators'],
  ['IMG', '#598700', 'image'],
  ['FX', '#037191', 'effects'],
  ['ADV', '#8f27a4', 'advanced'],
];

export function PageSelect() {
  const h = useHarmor();
  const c = FORM.MainPageSelect;
  const cw = c.w / 4;
  const page = h.view.page;
  return (
    <div className="hm-ctl hm-pages" style={{ left: c.x, top: c.y, width: c.w, height: c.h }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const i = Math.min(3, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * 4)));
        if (i !== page) setView(h.slotId, 'Current page', { page: i });
      }}
      onWheel={(e) => { e.stopPropagation(); const i = Math.min(3, Math.max(0, page + (e.deltaY > 0 ? 1 : -1))); if (i !== page) setView(h.slotId, 'Current page', { page: i }); }}
      onPointerMove={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const i = Math.min(3, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * 4)));
        setHint(`Current page: ${PAGES[i][2]}`);
      }}
      onPointerLeave={clearHint}>
      {PAGES.map(([name, col], i) => (
        <div key={name} className={'hm-page' + (i === page ? ' on' : '')}
          style={{ left: i * cw, width: cw - 2, background: i === page ? `linear-gradient(180deg, ${lighten(col, 0.18)}, ${col})` : undefined }}>
          {name}
        </div>
      ))}
    </div>
  );
}

function lighten(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(v + (255 - v) * k);
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/** Page background with FL's captions. */
function PageBack({ page }: { page: string }) {
  return (
    <Display x={PAGE_ORIGIN.x} y={PAGE_ORIGIN.y} w={PAGE_ORIGIN.w} h={PAGE_ORIGIN.h} deps={[page]}
      draw={(g, w, h) => paintPage(g, page, PAGE_ORIGIN.x, PAGE_ORIGIN.y, w, h)} />
  );
}

// -------------------------------------------------------------------- IMG

export const IMG_CONTROLS = [
  'BMPSpeedMulWheel', 'BMPSpeedWheel', 'BMPTimeSmoothWheel', 'BMPTimeWheel', 'BMPPhasinessWheel',
  'BMPSmoothGainSelect', 'BMPGainScaleWheel', 'BMPGainMixWheel',
  'BMPSmoothSubFreqSelect', 'BMPSubFreqModeSelect', 'BMPSubFreqScaleWheel', 'BMPFormantShiftWheel', 'BMPFormantMixWheel',
  'BMPViewScaleSelect',
] as const;

/** Partial index (0-based) at each pixel row: octave (log) or linear scale over FL's 516 partials, partial 1 at the bottom. */
function partialRows(H: number, oct: boolean): Int32Array {
  const out = new Int32Array(H);
  for (let y = 0; y < H; y++) {
    const f = (H - y - 0.5) / H;
    out[y] = Math.min(516, Math.ceil(oct ? Math.pow(516, f) : f * 516)) - 1;
  }
  return out;
}

/**
 * The imported image planes (pool sample, import.ts imagePlanesSample): the
 * gain plane's levels (0..255) over time (rows, left to right) and partials
 * (columns, bottom to top). False when the sample is not loaded.
 */
function drawPlanes(g: CanvasRenderingContext2D, w: number, h: number, img: HImage, sampleId: string, oct: boolean): boolean {
  const data = getRaw(sampleId)?.channels[0];
  const planes = data && img.h > 0 && img.w > 0 ? samplePlanes(data, img.h, img.w) : null;
  if (!planes || typeof document === 'undefined') return false;
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
  const off = document.createElement('canvas');
  off.width = W;
  off.height = H;
  const og = off.getContext('2d');
  if (!og) return false;
  const pix = og.createImageData(W, H);
  const col = partialRows(H, oct), gain = planes[0];
  for (let x = 0; x < W; x++) {
    const t = Math.min(img.h - 1, Math.floor((x / W) * img.h));
    for (let y = 0; y < H; y++) {
      const c = col[y];
      if (c < 0 || c >= img.w) continue;
      const v = Math.max(0, Math.min(1, gain[t * img.w + c] / 255));
      if (!v) continue;
      const o = (y * W + x) * 4;
      pix.data[o] = 150 + 105 * v;
      pix.data[o + 1] = 190 + 50 * v;
      pix.data[o + 2] = 60 + 40 * v;
      pix.data[o + 3] = 255 * Math.sqrt(v);
    }
  }
  og.putImageData(pix, 0, 0);
  g.drawImage(off, 0, 0, w, h);
  return true;
}

/** The image display (ToneBMPVisual): FL's dark canvas with the partial scale and the image planes (FL content, imported). */
function ImageView({ img, oct, sampleId }: { img: HImage | undefined; oct: boolean; sampleId: string }) {
  const c = FORM.ToneBMPVisual;
  const ver = useSyncExternalStore(onSamplesChanged, samplesVersion, samplesVersion);
  return (
    <Display x={c.x} y={c.y} w={c.w} h={c.h} deps={[img?.w, img?.h, img?.missing, img?.mode, oct, sampleId, ver]}
      draw={(g, w, h) => {
        const bg = g.createLinearGradient(0, 0, 0, h);
        bg.addColorStop(0, '#120c13');
        bg.addColorStop(1, '#0b080d');
        g.fillStyle = bg;
        g.fillRect(0, 0, w, h);
        const drawn = !!img && !img.missing && img.mode === 0 && !!sampleId && drawPlanes(g, w, h, img, sampleId, oct);
        // partial scale: octave lines (oct) or linear partial lines (Hz), partial 1 at the bottom
        g.strokeStyle = 'rgba(255,255,255,0.06)';
        g.lineWidth = 1;
        for (let k = 1; k <= 512; k *= 2) {
          const y = oct ? h - (Math.log2(k) / Math.log2(516)) * h : h - (k / 516) * h;
          g.beginPath(); g.moveTo(0, Math.round(y) + 0.5); g.lineTo(w, Math.round(y) + 0.5); g.stroke();
        }
        if (drawn) return;
        g.fillStyle = 'rgba(220,230,240,0.45)';
        g.font = '11px Arial, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        if (img?.missing) g.fillText('Image data is FL content: use "Import FL content" in the plugin menu', w / 2, h / 2);
        else if (!img || !img.w || !img.h) g.fillText('No image', w / 2, h / 2);
        else g.fillText(img.mode === 1 ? 'Resynthesized image' : `Image ${img.w} x ${img.h}`, w / 2, h / 2);
      }} />
  );
}

export function ImgPage() {
  const h = useHarmor();
  const img = h.hp?.img;
  const [plane, setPlane] = useState(0);
  const loop: ControlProps = {
    value: Math.max(0, Math.min(2, img?.a58 ?? 1)), min: 0, max: 2, defaultValue: 0, step: 1, label: 'Looping mode',
    onBegin: () => store.beginGesture('Looping mode'), onEnd: () => store.endGesture(),
    onChange: (v) => editPart(h.slotId, h.part, 'Looping mode', (hp) => { hp.img.a58 = Math.round(v); }),
  };
  const planeCp: ControlProps = { value: plane, min: 0, max: 2, defaultValue: 0, step: 1, label: 'Plane(s) to work on', onChange: (v) => setPlane(Math.round(v)) };
  return (
    <>
      <PageBack page="img" />
      <ImageView img={img} oct={(h.hp?.view ?? 1) === 0} sampleId={typeof h.params[IMG_SAMPLE_KEYS[h.part]] === 'string' ? h.params[IMG_SAMPLE_KEYS[h.part]] as string : ''} />
      {IMG_CONTROLS.map((n) => <HCtl key={n} n={n} />)}
      <HCombo ctl={FORM.BMPLoopModeSelect} cp={loop} />
      <HCombo ctl={FORM.PlaneMaskSelect} cp={planeCp} />
      <HButton ctl={FORM.BMPMenuBtn} glyph="menu" hint="Image options" onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom, [
          { header: true, label: 'Tools' }, { label: 'Clear all', disabled: true }, { label: 'Prepare time envelope', disabled: true },
          { header: true, label: 'Audio' }, { label: 'Analyze audio file...', disabled: true },
          { header: true, label: 'Image' }, { label: 'Open image file...', disabled: true }, { label: 'Generate random cloud', disabled: true },
        ]);
      }} />
      <HButton ctl={FORM.CopyBtn} hint="Copy to image clipboard" onClick={() => undefined}><span className="hm-btn-text">COPY</span></HButton>
      <HButton ctl={FORM.PasteBtn} hint="Paste from / monitor image clipboard" onClick={() => undefined}><span className="hm-btn-text">PASTE</span></HButton>
      <TimeBar />
    </>
  );
}

function TimeBar() {
  const c = FORM.ToneBMPTimeScroller;
  return (
    <div className="hm-ctl" style={{ left: c.x, top: c.y, width: c.w, height: c.h }}>
      <svg width={c.w} height={c.h} style={{ display: 'block' }}>
        <rect x={0} y={0} width={c.w} height={c.h} fill={c.color ?? '#414359'} />
        <rect x={10} y={3} width={c.w - 20} height={c.h - 6} rx={3} fill="#5d607c" />
      </svg>
    </div>
  );
}

// --------------------------------------------------------------------- FX

export const FX_CONTROLS = [
  'ChOrderSelect', 'ChDepthWheel', 'ChSpeedWheel', 'ChDelayWheel', 'ChSpreadWheel', 'ChCrossWheel', 'ChWetWheel',
  'RevEnableBtn', 'RevVolWheel', 'RevHDWheel', 'RevDecWheel', 'RevDiffWheel', 'RevRoomWheel', 'RevDelWheel', 'RevHCWheel', 'RevLCWheel', 'RevColWheel',
  'DelModeSelect', 'DelEnableBtn', 'DelFBWheel', 'DelTimeWheel', 'DelTimeOfsWheel', 'DelVolWheel', 'DelHCWheel', 'DelLCWheel', 'DelFBFilterBtn', 'DelPanWheel',
  'DistInWheel', 'DistAsymWheel', 'DistOutWheel', 'DistMixWheel', 'DistFCutWheel', 'DistModeSelect',
  'CompVolWheel', 'CompLWheel', 'CompMWheel', 'CompHWheel', 'CompTypeSelect',
] as const;

export function FxPage() {
  const h = useHarmor();
  const menuAt = (e: React.PointerEvent, items: ReturnType<typeof chorusMenu>) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.left, r.bottom, items);
  };
  return (
    <>
      <PageBack page="fx" />
      {FX_CONTROLS.map((n) => <HCtl key={n} n={n} />)}
      <HButton ctl={FORM.ChMenuBtn} glyph="menu" hint="Chorus presets" onClick={(e) => menuAt(e, chorusMenu(h.slotId))} />
      <HButton ctl={FORM.RevMenuBtn} glyph="menu" hint="Reverb presets" onClick={(e) => menuAt(e, reverbMenu(h.slotId))} />
    </>
  );
}

// -------------------------------------------------------------------- ADV

export const ADV_CONTROLS = [
  'PredelayWheel', 'PolyRelMulWheel', 'DeclickWheel', 'RampWheel', 'AutoGainModeSelect', 'BMPResynthModeSelect', 'MidSideBtn', 'BMPDenoiseWheel',
  'InvArpBox', 'ModSmoothBox', 'MonoSelect', 'VoiceRandSelect', 'VoiceSameMapRandBox',
  'QThreadedBox', 'QHQRenderBox', 'QLocalMaxNumTonesWheel', 'QSafetyWheel', 'QGrainWheel', 'QPrecisionSelect',
] as const;

/** FL's unit names (part units by id, then the effects units). */
export const PART_UNITS = ['LOCAL EQ', 'PRISM', 'HARM RAND', 'HARMONIZER', 'FILTER 1', 'FILTER 2', 'PHASER', 'PLUCK', 'BLUR', 'HARM PROT', 'HARM CLIP', 'VOLUME ART'];
export const FX_UNITS = ['DISTORTION', 'CHORUS', 'DELAY', 'REVERB', 'DRY MIX', 'COMPRESSION'];

/** An order list (UnitOrderSelect / FXUnitOrderSelect): 17 px rows; drag a row to move it. */
function OrderList({ n, names, order, set, title }: { n: string; names: string[]; order: number[]; set: (o: number[]) => void; title: string }) {
  const c = FORM[n];
  const rowH = 17;
  const [drag, setDrag] = useState<number | null>(null);
  return (
    <div className="hm-ctl hm-order" style={{ left: c.x, top: c.y, width: c.w, height: c.h }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const i = Math.floor((e.clientY - r.top) / rowH);
        if (i < 0 || i >= order.length) return;
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        store.beginGesture(title);
        setDrag(i);
      }}
      onPointerMove={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const j = Math.min(order.length - 1, Math.max(0, Math.floor((e.clientY - r.top) / rowH)));
        if (drag === null) { setHint(`${title}: drag to reorder`); return; }
        if (j !== drag) {
          const o = order.slice();
          const [u] = o.splice(drag, 1);
          o.splice(j, 0, u);
          set(o);
          setDrag(j);
        }
      }}
      onPointerUp={() => { if (drag !== null) { setDrag(null); store.endGesture(); } }}
      onPointerCancel={() => { if (drag !== null) { setDrag(null); store.endGesture(); } }}
      onPointerLeave={clearHint}>
      {order.map((u, i) => (
        <div key={i} className={'hm-order-row' + (drag === i ? ' drag' : '')} style={{ top: i * rowH, height: rowH - 1 }}>
          <span className="hm-order-n">{i + 1}</span>{names[u] ?? '?'}
        </div>
      ))}
    </div>
  );
}

export function AdvPage() {
  const h = useHarmor();
  const order = h.hp?.order ?? PART_UNITS.map((_, i) => i);
  const fx = h.hg?.fxOrder ?? FX_UNITS.map((_, i) => i);
  return (
    <>
      <PageBack page="adv" />
      {ADV_CONTROLS.map((n) => <HCtl key={n} n={n} format={advFormat(n)} />)}
      <OrderList n="UnitOrderSelect" names={PART_UNITS} order={order} title="Units processing order for current part"
        set={(o) => editPart(h.slotId, h.part, 'Unit order', (hp) => { hp.order = o; }, h.linked)} />
      <OrderList n="FXUnitOrderSelect" names={FX_UNITS} order={fx} title="Effects processing order"
        set={(o) => editGlobal(h.slotId, 'FX order', (g) => { g.fxOrder = o; })} />
      <div className="hm-cap-abs" style={{ left: FORM.UnitOrderSelect.x, top: FORM.UnitOrderSelect.y - 16 }}>UNIT ORDER</div>
      <div className="hm-cap-abs" style={{ left: FORM.FXUnitOrderSelect.x, top: FORM.FXUnitOrderSelect.y - 16 }}>FX ORDER</div>
      <div className="hm-cap-abs" style={{ left: FORM.QLocalMaxNumTonesWheel.x - 6, top: FORM.QLocalMaxNumTonesWheel.y + 33 }}>partial</div>
    </>
  );
}

/** Value texts of the ADV settings (FL shows them in the hint bar). */
function advFormat(n: string): ((v: number) => string) | undefined {
  switch (n) {
    case 'DeclickWheel': return (v) => (v === 0 ? 'Off (rely on ramping)' : `${Math.round(v / 10)}%`);
    case 'RampWheel': return (v) => `${Math.round(v / 20)}%`;
    case 'BMPDenoiseWheel': return (v) => `${Math.round(v / 10)}%`;
    case 'QLocalMaxNumTonesWheel': return (v) => `${Math.round(v)} partials`;
    case 'QSafetyWheel': return (v) => `${Math.round(v)}`;
    case 'QGrainWheel': return (v) => `${Math.round(v)}`;
    default: return undefined;
  }
}

