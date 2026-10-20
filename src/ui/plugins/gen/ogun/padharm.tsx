// Ogun's "Create pad harmonics..." tool (FL: TMEHarmToolForm, 530 x 397, a modal form opened by the articulator editor's menu while a
// shaping map is edited). The 64 harmonic bins (level and width bars), the bin window shape (a mapping curve editor), the width knob and
// "Normalize loudness" make a spectrum that is written into the edited map as a dense curve (model: padharm.ts, bit-exact with FL's
// tool). Every change rebuilds the curve after 200 ms of calm and shows it in the map at once (no undo entry); Accept makes it one
// undo step, closing the dialog any other way gives the map back. The tool remembers its last state (FL keeps it while the plugin
// is loaded; here it also survives a reload through the browser's storage). Original drawing, FL's layout.

import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { setHint, clearHint } from '../../../hint';
import { openMenu } from '../../../widgets/ContextMenu';
import type { ControlProps } from '../../../widgets/control';
import { Display } from '../../kit';
import {
  PAD_WIDTH_DEFAULT, PAD_WIDTH_MAX, defaultWindow, humanizeBins, randomWidthValue, randomizeBins, resetBins, windowPreset, type PadRng,
} from '../../../../model/gen/plugins/ogun/padharm';
import type { OgEnv } from '../../../../model/gen/plugins/ogun/types';
import { OButton, OCheck, OWheel } from './widgets';
import type { FCtl } from './form';
import { EnvEditor, type EnvTools } from './EnvEditor';
import { flip } from './curve';
import { BIN_H, BIN_W, TAB_COLORS, TAB_NAMES, binHint, binIndexAt, drawBins, dragBins, newBinDrag, type BinDrag } from './padbins';
import { PadSession } from './padsession';

export interface PadRequest {
  slotId: string;
  target: number;
}

let request: PadRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Open the tool for a shaping map (13..16) of an instrument. */
export function openPad(slotId: string, target: number): void {
  request = { slotId, target };
  emit();
}

export function closePad(): void {
  request = null;
  emit();
}

export const subscribePad = (fn: () => void): (() => void) => { listeners.add(fn); return () => listeners.delete(fn); };
export const padRequest = (): PadRequest | null => request;

// ---------------------------------------------------------------------------------------------------------------- randomness

/** Random u32 values for the randomize buttons (the plugin's own twister is the model's business, FL's UI needs no fixed numbers). */
const uiRng: PadRng = () => {
  try { return crypto.getRandomValues(new Uint32Array(1))[0]; } catch { return Math.floor(Math.random() * 4294967296); }
};

// -------------------------------------------------------------------------------------------------------------------- layout

const W = 530, H = 397;
const ctl = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const WIDTH_CTL: FCtl = { n: 'WidthWheel', k: 'wheel', ...ctl(484, 236, 36, 36), fill: '#7d8591', rail: '#2e2329', cap: '#40474d', ptr: 's' };
const NORM_CTL: FCtl = { n: 'NormBox', k: 'check', ...ctl(397, 324, 125, 16), caption: 'Normalize loudness' };
const TOOL_BTN = (x: number): FCtl => ({ n: 'tool', k: 'button', ...ctl(x, 322, 20, 16) });
const ENV_BOX = ctl(9, 236, 329, 103);
const ENV_VIS = ctl(9, 236, 326, 85);

function Btn({ x, y, w, h, children, onClick, hint, className }: { x: number; y: number; w: number; h: number; children: ReactNode; onClick: () => void; hint?: string; className?: string }) {
  return (
    <div className={'og-tool-btn' + (className ? ' ' + className : '')} style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>{children}</div>
  );
}

function Panel({ y, h, title }: { y: number; h: number; title: string }) {
  return (
    <div className="og-tool-panel" style={{ left: 1, top: y, width: 528, height: h }}>
      <div className="og-tool-ptitle">{title}</div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------------------------- dialog

export function PadHarmonics({ slotId, target }: { slotId: string; target: number }) {
  const [rev, redraw] = useReducer((n: number) => n + 1, 0);
  const root = useRef<HTMLDivElement>(null);
  const session = useMemo(() => new PadSession(slotId, target), [slotId, target]);
  const S = session.state;
  const drag = useRef<BinDrag | null>(null);
  const [pos, setPos] = useState<[number, number]>([15, 90]);
  const [tools, setTools] = useState<EnvTools>({ snap: false, slide: true, freeze: false });
  // FL's tool puts one point per harmonic `unit` apart: on the natural (octave) scale that unit is an octave, so only the first
  // octaves of the map are filled; the linear scale is the one the tool is made for
  const natural = session.natural;
  const steep = target !== 14;

  useEffect(() => {
    if (!session.orig) { closePad(); return; }
    session.open();
    root.current?.focus();
    return () => session.close();
  }, [session]);

  /** A change of the settings: the dialog follows now, the map when the user pauses (or at once). */
  const changed = (now = false) => {
    redraw();
    if (now) session.preview(); else session.schedule();
  };
  const accept = () => { session.accept(); closePad(); };
  const cancel = () => { session.close(); closePad(); };

  // ------------------------------------------------------------------------------------------------ the bins
  const tab = S.tab;
  const pointer = (e: React.PointerEvent | React.WheelEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: ((e.clientX - r.left) * BIN_W) / r.width, y: ((e.clientY - r.top) * BIN_H) / r.height };
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button > 2) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = newBinDrag();
    onMove(e);
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = pointer(e);
    const d = drag.current;
    if (!d) { setHint(binHint(binIndexAt(p.x))); return; }
    const left = (e.buttons & 1) !== 0;
    if (dragBins(S.bins, tab, d, { x: p.x, y: p.y, left, shift: e.shiftKey, alt: e.altKey })) changed();
    setHint(binHint(binIndexAt(p.x)));
  };
  const onUp = () => { drag.current = null; };

  const setTab = (t: 0 | 1) => { S.tab = t; redraw(); };
  const resetTab = () => { resetBins(S.bins, 1 << tab); changed(true); };
  const randomTab = () => { randomizeBins(S.bins, 1 << tab, uiRng, { steep }); changed(true); };
  const humanizeTab = () => { humanizeBins(S.bins, tab, uiRng); changed(true); };
  const fullReset = () => {
    resetBins(S.bins, 3);
    S.width = PAD_WIDTH_DEFAULT;
    S.normalize = true;
    S.window = defaultWindow();
    changed(true);
  };
  const fullRandom = () => {
    S.width = randomWidthValue(uiRng);
    randomizeBins(S.bins, 3, uiRng, { steep });
    changed(true);
  };

  // ------------------------------------------------------------------------------------------------ the window shape
  const editWindow = (next: OgEnv) => { S.window = next; changed(); };
  const shapeMenu = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.left, r.bottom, [
      { header: true, label: 'Bin window shape' },
      { label: 'Default (raised cosine)', onClick: () => editWindow(windowPreset('default')) },
      { label: 'Hat (flat top)', onClick: () => editWindow(windowPreset('hat')) },
      { label: 'Tent (pointed)', onClick: () => editWindow(windowPreset('tent')) },
      { separator: true },
      { label: 'Flip vertically', onClick: () => editWindow(flip(S.window)) },
    ]);
  };
  const widthCp: ControlProps = {
    value: S.width, min: 0, max: PAD_WIDTH_MAX, defaultValue: PAD_WIDTH_DEFAULT, step: 1, label: 'Bin window width',
    format: (v) => `${Math.round(v / 10)}%`,
    onChange: (v) => { S.width = Math.round(v); changed(); },
  };

  const key = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') cancel();
    else if (e.key === 'Enter') accept();
  };
  const hostStyle: CSSProperties = { left: pos[0], top: pos[1], width: W, height: H };

  return (
    <div className="og-pad-back" tabIndex={-1} ref={root}
      onPointerDown={(e) => e.stopPropagation()} onKeyDown={key}
      onWheel={(e) => { e.stopPropagation(); if (e.deltaY) setTab(e.deltaY > 0 ? 1 : 0); }}>
      <div className="og-tool-dialog" style={hostStyle}>
        <div className="og-tool-title"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            const sx = e.clientX, sy = e.clientY, p0 = pos;
            const mv = (ev: PointerEvent) => setPos([p0[0] + ev.clientX - sx, p0[1] + ev.clientY - sy]);
            const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
            window.addEventListener('pointermove', mv);
            window.addEventListener('pointerup', up);
          }}>Create pad harmonics</div>
        <div className="og-tool-close" onPointerDown={(e) => { e.stopPropagation(); cancel(); }} onPointerEnter={() => setHint('Close without applying')} onPointerLeave={clearHint}>x</div>

        <Panel y={26} h={172} title="Harmonic bins" />
        {natural && <div className="og-tool-note" style={{ left: 120, top: 28, width: 396, height: 15 }} title="Options menu > Natural EQ mapping scale">
          Natural EQ mapping scale is on: the harmonics fill only its first octaves</div>}
        <Display x={9} y={54} w={BIN_W} h={BIN_H} deps={[rev, tab]} draw={(g) => drawBins(g, S.bins, tab)}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
          onContextMenu={(e) => e.preventDefault()} style={{ cursor: 'pointer' }} />
        <div className="og-tool-tabs" style={{ left: 9, top: 159, width: 120, height: 27 }}>
          {TAB_NAMES.map((n, i) => (
            <div key={n} className={'og-tool-tab' + (tab === i ? ' on' : '')} style={{ ['--tab' as string]: TAB_COLORS[i] }}
              onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setTab(i as 0 | 1); } }}>{n}</div>
          ))}
        </div>
        <Btn x={340} y={159} w={49} h={27} onClick={resetTab} hint={`Reset the ${TAB_NAMES[tab].toLowerCase()} bars`}>Reset</Btn>
        <Btn x={389} y={159} w={69} h={27} onClick={randomTab} hint={`Randomize the ${TAB_NAMES[tab].toLowerCase()} bars`}>Randomize</Btn>
        <Btn x={458} y={159} w={63} h={27} onClick={humanizeTab} hint={`Add a little randomness to the ${TAB_NAMES[tab].toLowerCase()} bars`}>Humanize</Btn>

        <Panel y={206} h={142} title="Bin window shape" />
        <div className="og-envframe" style={{ left: ENV_BOX.x, top: ENV_BOX.y, width: ENV_BOX.w, height: ENV_BOX.h, background: '#2a2c42' }} />
        <EnvEditor {...ENV_VIS} curve={S.window} kind="map" grid="plain" tempo={false} view={[0, 1]} setView={() => undefined} tools={tools}
          title="Bin window shape" edit={(next) => editWindow(next)} local />
        <div className="og-lbl" style={{ left: 449, top: 245, width: 31, height: 15, color: '#9fa8ad', fontSize: 9 }}>Width</div>
        <OWheel ctl={WIDTH_CTL} cp={widthCp} />
        <OCheck ctl={NORM_CTL} on={S.normalize} hint="Normalize loudness" onToggle={() => { S.normalize = !S.normalize; changed(); }} />
        <OButton ctl={TOOL_BTN(9)} g="arrow" hint="Bin window shape presets" onClick={shapeMenu} className="og-tool" />
        <OButton ctl={TOOL_BTN(33)} g="freeze" on={tools.freeze} hint="Freeze editing / hide points" onClick={() => setTools((t) => ({ ...t, freeze: !t.freeze }))} className="og-tool" />
        <OButton ctl={TOOL_BTN(57)} g="snap" on={tools.snap} hint="Snap to grid" onClick={() => setTools((t) => ({ ...t, snap: !t.snap }))} className="og-tool" />
        <OButton ctl={TOOL_BTN(81)} g="slide" on={tools.slide} hint="Slide succeeding points" onClick={() => setTools((t) => ({ ...t, slide: !t.slide }))} className="og-tool" />

        <Btn x={8} y={358} w={60} h={29} onClick={fullReset} hint="Reset everything">Reset</Btn>
        <Btn x={82} y={358} w={79} h={29} onClick={fullRandom} hint="Randomize the bins and the width">Randomize</Btn>
        <Btn x={469} y={359} w={60} h={29} onClick={accept} hint="Write the harmonics into the map" className="accept">Accept</Btn>
      </div>
    </div>
  );
}
