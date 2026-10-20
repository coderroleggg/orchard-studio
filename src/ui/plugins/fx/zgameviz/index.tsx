// ZGameEditor Visualizer editor (FL: ZGameEditor Visualizer main window):
// sheet tabs Main / Add content / Settings / Debug log. Main holds the layer
// columns (./layers.tsx; left-most layer is drawn first) and FL's right-hand
// panel: Wizard, Export Video, Hold visualization (snowflake), Window mode,
// Frame rate (Max / Current), Aspect ratio, Rotate and Zoom. The picture is
// rendered in the separate video window (./video.tsx).

import { useEffect, useRef, useState } from 'react';
import {
  LAYER_LETTERS, ZGE_ASPECTS, ZGE_EFFECTS, ZGE_FPS, ZGE_LAYERS, ZGE_MAX, ZGE_WINDOW_MODES, zgeReadLayer, zgeState, zk, type ZgeState,
} from '../../../../model/fx/plugins/zgameviz';
import { FxPanel, useAuxWindow, useFxEditor, useParam } from '../../kit';
import { store, useUi } from '../../../../store';
import { Window } from '../../../windows/Window';
import * as A from '../../../../store/actions';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { flashHint } from '../../../hint';
import type { FxEditorModule } from '../../registry';
import { COLLAPSED_W, COL_H, COL_W, LayerColumn, editLayers, layerMenu, layerOp, setCollapsed } from './layers';
import { ZgeVideo, zgeLive, zgeSaveStill, zgeVideoMenu } from './video';
import { Glyph, Z, ZButton, ZCombo, ZGroup, ZLed, ZTabs, ZText, ZVSlider, ZWheel, abs } from './widgets';

const W = 736;
const H = 584;
const SHEET = 35; // top of the sheets (FL: TopPanel sheets at 36, tab selector 3..33)
const RIGHT = W - 95; // right-hand panel controls (FL anchors them to the right edge)

const CSS = `
.zge-cols::-webkit-scrollbar{height:10px}
.zge-cols::-webkit-scrollbar-track{background:transparent}
.zge-cols::-webkit-scrollbar-thumb{background:#4a5459;border-radius:5px;border:2px solid #5e686d}
.zge-params::-webkit-scrollbar{width:7px}
.zge-params::-webkit-scrollbar-track{background:transparent}
.zge-params::-webkit-scrollbar-thumb{background:#3a4247;border-radius:3px}
.zge-memo{position:absolute;box-sizing:border-box;resize:none;outline:none;border:1px solid #31373b;border-radius:2px;background:#e7ecef;color:#1d2226;font:12px var(--font-ui);padding:4px 6px;margin:0}
.zge-memo[readonly]{background:#d7dde0}
`;

/** "Current" frame rate, measured by the video window (refreshed twice a second). */
function FpsText({ slotId }: { slotId: string }) {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFps(zgeLive(slotId).fps), 500);
    return () => clearInterval(id);
  }, [slotId]);
  return <ZText x={52} y={51} w={34} h={23} size={12} color={Z.text}>{fps.toFixed(1)}</ZText>;
}

function workspaceMenu(slotId: string, s: ZgeState): MenuItem[] {
  const all = (collapsed: boolean) => editLayers(slotId, collapsed ? 'Collapse all layers' : 'Expand all layers', (p) => { p.layers = s.layers.map((l) => ({ ...l, collapsed })); });
  const set = (label: string, recipe: (p: Record<string, unknown>) => void) => A.editFx(slotId, label, recipe);
  return [
    { label: 'Collapse all layers', onClick: () => all(true) },
    { label: 'Expand all layers', onClick: () => all(false) },
    { label: 'Auto-collapse layers', checked: s.autoCollapse, hint: 'Only expand one layer at a time', onClick: () => set('Auto-collapse layers', (p) => { p.autoCollapse = !s.autoCollapse; }) },
    { label: 'Layers arrangement editor', disabled: true },
    { label: 'Save still image', onClick: () => zgeSaveStill(slotId) },
    { label: 'Show background pattern in preview', checked: s.gamut, onClick: () => set('Show background pattern', (p) => { p.gamut = !s.gamut; }) },
  ];
}

// ------------------------------------------------------------------ Main sheet

function MainSheet({ s, params, sel, setSel }: { s: ZgeState; params: Record<string, unknown>; sel: number; setSel: (i: number) => void }) {
  const { slotId, trackName } = useFxEditor();
  const zoom = useParam('zoom', { label: 'Camera zoom', format: (v) => `${Math.round((v / ZGE_MAX) * 100)}%` });
  const angle = useParam('angle', { label: 'Camera angle', format: (v) => `${Math.round((v / ZGE_MAX) * 360)}°` });
  const set = (label: string, recipe: (p: Record<string, unknown>) => void) => A.editFx(slotId, label, recipe);
  const xs: number[] = [];
  let cx = 0;
  for (let n = 0; n < s.layerCount; n++) { xs.push(cx); cx += (s.layers[n].collapsed ? COLLAPSED_W : COL_W) + 1; }
  const colsRef = useRef<HTMLDivElement>(null);
  const plusX = cx;

  return (
    <>
      <div style={abs(0, 33, W, H - 33, { background: Z.sheet, borderTop: `1px solid ${Z.frame}` })} />
      <div style={abs(W - 103, 34, 1, H - 34, { background: '#485156' })} />
      <div ref={colsRef} className="zge-cols"
        style={abs(1, 34, W - 104, H - 36, { overflowX: 'auto', overflowY: 'hidden' })}
        onWheel={(e) => {
          const el = colsRef.current;
          if (!el || (e.target as HTMLElement).closest('.zge-params')) return;
          el.scrollLeft += e.deltaY + e.deltaX;
        }}
        onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, workspaceMenu(slotId, s)); }}>
        <div style={{ position: 'relative', width: plusX + 44, height: COL_H }}>
          {Array.from({ length: s.layerCount }, (_, n) => (
            <div key={n}>
              <LayerColumn n={n} s={s} params={params} x={xs[n]} selected={sel === n} onSelect={setSel} trackName={trackName} />
              <div style={abs(xs[n] + (s.layers[n].collapsed ? COLLAPSED_W : COL_W), 0, 1, COL_H, { background: Z.sep })} />
            </div>
          ))}
          {s.layerCount < ZGE_LAYERS && (
            <svg width={48} height={23} style={{ position: 'absolute', left: plusX, top: 0, cursor: 'default' }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                layerOp(slotId, 'insert', s.layerCount, setSel);
              }}
              onPointerEnter={() => flashHint('Add new layer')}>
              <path d="M0 0 H46 L37 23 H0 Z" fill={Z.colTab} />
              <path d="M18 11.5 H28 M23 6.5 V16.5" stroke="#eef1f3" strokeWidth={2.2} />
            </svg>
          )}
        </div>
      </div>

      {/* right-hand panel */}
      <ZButton x={RIGHT} y={SHEET + 5} w={90} h={30} disabled hint="Video wizard: not available in this version">Wizard</ZButton>
      <ZButton x={RIGHT} y={SHEET + 39} w={90} h={30} disabled hint="Export Video: not available in this version">Export Video</ZButton>
      <ZButton x={RIGHT + 1} y={SHEET + 73} w={88} h={36} round active={s.freeze} hint="Hold visualization"
        onClick={() => set('Hold visualization', (p) => { p.freeze = !s.freeze; })}>
        <Glyph kind="snow" color={s.freeze ? '#8fd6ff' : '#f2f5f7'} />
      </ZButton>
      <ZText x={RIGHT} y={SHEET + 112} w={92} h={23} size={13} bold color={Z.text}>Window mode</ZText>
      <ZCombo x={RIGHT} y={SHEET + 133} w={90} h={23} items={ZGE_WINDOW_MODES} value={s.windowMode} hint="Video window mode"
        onPick={(i) => set(`Window mode: ${ZGE_WINDOW_MODES[i]}`, (p) => { p.windowMode = i; p.visible = true; })} />
      <ZGroup x={RIGHT + 1} y={SHEET + 165} w={88} h={79} title="Frame rate">
        <ZText x={6} y={24} w={30} h={23} size={12.5} color={Z.text}>Max</ZText>
        <ZCombo x={48} y={24} w={36} h={23} size={12} items={ZGE_FPS.map(String)} value={s.fps} hint="Select frame rate"
          onPick={(i) => set('Frame rate', (p) => { p.fps = i; })} />
        <ZText x={6} y={51} w={44} h={23} size={12} color={Z.text}>Current</ZText>
        <FpsText slotId={slotId} />
      </ZGroup>
      <ZText x={RIGHT + 2} y={SHEET + 247} w={90} h={23} size={13} bold color={Z.text}>Aspect ratio</ZText>
      <ZCombo x={RIGHT + 2} y={SHEET + 268} w={88} h={23} items={ZGE_ASPECTS} value={s.aspect} hint="Aspect ratio"
        onPick={(i) => set('Aspect ratio', (p) => { p.aspect = i; })} />
      <ZText x={RIGHT + 15} y={SHEET + 307} w={60} h={15} size={13} bold align="center" color={Z.text}>Rotate</ZText>
      <ZWheel x={RIGHT + 20} y={SHEET + 322} control={angle.control} />
      <ZVSlider x={RIGHT + 28} y={SHEET + 375} control={zoom.control} />
      <ZText x={RIGHT + 15} y={SHEET + 469} w={60} h={15} size={13} bold align="center" color={Z.text}>Zoom</ZText>
    </>
  );
}

// ------------------------------------------------------------------ Add content sheet

const CONTENT_TABS = ['Images', 'HTML', 'Text', 'Meshes', 'Video cue points'];
const NA = 'Not available in this version';

function ContentSheet({ s, sub, setSub }: { s: ZgeState; sub: number; setSub: (i: number) => void }) {
  const { slotId } = useFxEditor();
  const top = SHEET + 33, extra = W - 689;
  const btn = (x: number, y: number, w: number, caption: string) => <ZButton key={caption} x={x} y={top + y} w={w} h={27} size={12} disabled hint={NA}>{caption}</ZButton>;
  return (
    <>
      <div style={abs(0, 33, W, H - 33, { background: Z.sheet, borderTop: `1px solid ${Z.frame}` })} />
      <ZTabs x={3} y={SHEET + 6} h={26} size={13.5} items={CONTENT_TABS} widths={[72, 62, 54, 76, 142]} value={sub} onPick={setSub} />
      {sub === 0 && <>
        {btn(6, 6, 85, 'Add pictures')}{btn(98, 6, 77, 'Add videos')}{btn(182, 6, 105, 'Add WebCam')}{btn(295, 6, 91, 'Add Window')}
        {btn(6, 35, 85, 'Add preset')}{btn(98, 35, 78, 'Add URL')}{btn(184, 35, 105, 'Find media online')}{btn(295, 35, 91, 'Add NDI')}
        <ZText x={410} y={top + 35} w={60} h={23} size={13} bold color={Z.text}>Filtering</ZText>
        <ZCombo x={480} y={top + 35} w={79} h={23} items={['Mipmap', 'Linear', 'Nearest']} value={0} disabled hint={NA} />
        <ZGroup x={9} y={top + 68} w={202} h={65} title="Video preloading">
          <ZLed x={5} y={23} w={157} on={false} onToggle={() => {}} caption="Enable video preloading" hint={NA} />
          <ZLed x={5} y={43} w={100} on={false} onToggle={() => {}} caption="Compress" hint={NA} />
          <ZLed x={109} y={43} w={90} on={false} onToggle={() => {}} caption="With audio" hint={NA} />
        </ZGroup>
        <ZLed x={215} y={top + 69} w={189} on onToggle={() => {}} caption="Sync video with song position" hint={NA} />
        <div style={abs(8, top + 136, 674 + extra, 323, { background: '#e7ecef', border: '1px solid #31373b', color: '#5b656b', font: '12px var(--font-ui)', padding: 8 })}>
          Images, videos, webcams and windows can't be added in this version: effects draw their own content.
        </div>
        {btn(3, 464, 59, 'Select all')}{btn(65, 464, 75, 'Remove')}{btn(143, 464, 59, 'Reload all')}{btn(205, 464, 59, 'Replace')}{btn(267, 464, 102, 'Remove unused')}
      </>}
      {sub === 1 && <>
        <ZText x={4} y={top + 6} w={500} h={27} size={13} color={Z.text}>The text typed here is displayed in the &quot;TextTrueType&quot; effect.</ZText>
        <textarea className="zge-memo" readOnly style={{ left: 8, top: top + 36, width: 390, height: 453 }} value={'<p align="center">[textline]</p>'} />
        <div style={abs(404, top + 36, 280 + extra, 453, { background: '#d7dde0', border: '1px solid #31373b', color: '#4a545a', font: '12px var(--font-ui)', padding: 8 })}>
          The TextTrueType effect isn&apos;t part of this version; use TextDraw with the lines of the Text tab.
        </div>
      </>}
      {sub === 2 && <>
        <ZText x={8} y={top + 5} w={560} h={32} size={12.5} color={Z.text} style={{ whiteSpace: 'pre', lineHeight: '15px' }}>
          {'The text typed here is displayed in text effects such as "TextDraw".\nMacros [author], [title], [comment] can be used in the text.'}
        </ZText>
        <textarea className="zge-memo" spellCheck={false} style={{ left: 8, top: top + 39, width: 674 + extra, height: 453 }}
          value={s.text.join('\n')}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            const lines = e.target.value.split('\n').slice(0, 64).map((l) => l.slice(0, 200));
            A.editFx(slotId, 'Edit text', (p) => { p.text = lines; }, `zge:${slotId}:text`);
          }} />
      </>}
      {sub === 3 && <>
        {btn(8, 8, 82, 'Add meshes')}{btn(92, 8, 99, 'Remove meshes')}
        <ZLed x={197} y={top + 13} w={83} on={false} onToggle={() => {}} caption="With colors" hint={NA} />
        <ZLed x={280} y={top + 13} w={94} on onToggle={() => {}} caption="Auto scale" hint={NA} />
        <div style={abs(8, top + 44, 674 + extra, 418, { background: '#e7ecef', border: '1px solid #31373b', color: '#5b656b', font: '12px var(--font-ui)', padding: 8 })}>
          3D meshes can't be loaded in this version.
        </div>
        {btn(3, 464, 59, 'Select all')}
      </>}
      {sub === 4 && <>
        <textarea className="zge-memo" readOnly style={{ left: 8, top: top + 6, width: 88, height: 483 }} value="" />
        <ZText x={102} y={top + 6} w={570} h={60} size={13} color={Z.text} style={{ whiteSpace: 'normal', lineHeight: '17px' }}>
          Video cue points (seconds) trigger video playback positions from MIDI notes. Videos aren&apos;t available in this version.
        </ZText>
        {btn(102, 463, 153, 'Import cue points from wav')}
      </>}
    </>
  );
}

// ------------------------------------------------------------------ Settings sheet

function SettingsSheet({ s }: { s: ZgeState }) {
  const { slotId } = useFxEditor();
  const top = SHEET;
  const set = (label: string, recipe: (p: Record<string, unknown>) => void) => A.editFx(slotId, label, recipe);
  return (
    <>
      <div style={abs(0, 33, W, H - 33, { background: Z.sheet, borderTop: `1px solid ${Z.frame}` })} />
      <ZText x={5} y={top + 11} w={130} h={21} size={12} bold color={Z.text}>MIDI port <span style={{ fontWeight: 400, fontSize: 10.5, color: Z.dim }}>(channels 1..x)</span></ZText>
      <div style={abs(137, top + 9, 40, 25, { background: '#9a3a3e', border: '1px solid #31373b', borderRadius: 3, color: '#ffd9d9', font: '600 14px var(--font-ui)', textAlign: 'center', lineHeight: '23px', opacity: 0.6 })} title="">{'⋯'}</div>
      <ZLed x={3} y={top + 43} w={77} on={s.antialias} caption="Antialias" hint="Smoother graphics (full resolution rendering)"
        onToggle={() => set('Antialias', (p) => { p.antialias = !s.antialias; })} />
      <ZLed x={86} y={top + 43} w={150} on onToggle={() => {}} caption="also for rendertargets" hint={NA} />
      <ZText x={4} y={top + 66} w={70} h={23} size={11} bold color={Z.text}>Stereoscopic</ZText>
      <ZCombo x={78} y={top + 66} w={163} h={23} text="Off" disabled hint={NA} />
      <ZLed x={371} y={top + 35} w={157} on={false} onToggle={() => {}} caption="Enable NDI output" hint={NA} />
      <ZButton x={W - 151} y={top + 4} w={147} h={33} hint="About ZGameEditor Visualizer"
        onClick={(e) => openMenu(e.clientX, e.clientY, [
          { header: true, label: 'ZGameEditor Visualizer' },
          { label: 'Reduced version: Canvas 2D renderer', disabled: true },
          { label: `${ZGE_EFFECTS.length - 1} built-in effects, ${ZGE_LAYERS} layers`, disabled: true },
          { label: 'ZGameEditor: zgameeditor.org', disabled: true },
        ])}>About</ZButton>
      <ZButton x={W - 151} y={top + 41} w={147} h={33} hint="Reset to default settings"
        onClick={() => set('Reset to defaults', (p) => { p.antialias = true; p.gamut = false; p.autoCollapse = false; p.fps = 1; p.aspect = 1; p.windowMode = 1; p.visible = true; p.freeze = false; })}>
        Reset to defaults
      </ZButton>
    </>
  );
}

// ------------------------------------------------------------------ Debug log sheet

function LogSheet({ slotId }: { slotId: string }) {
  const [on, setOn] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((v) => v + 1), 500); return () => clearInterval(id); }, []);
  const lines = on ? zgeLive(slotId).log : [];
  return (
    <>
      <div style={abs(0, 33, W, H - 33, { background: Z.sheet, borderTop: `1px solid ${Z.frame}` })} />
      <ZLed x={3} y={SHEET + 3} w={121} on={on} onToggle={() => setOn(!on)} caption="Enable debug log" />
      <ZLed x={130} y={SHEET + 3} w={176} on={false} onToggle={() => {}} caption="Display normals on meshes" hint={NA} />
      <textarea className="zge-memo" readOnly style={{ left: 3, top: SHEET + 25, width: W - 6, height: H - SHEET - 28, font: '11px var(--font-mono)' }} value={lines.join('\n')} />
    </>
  );
}

// ------------------------------------------------------------------ editor

function ZgeEditor() {
  const { slotId, params } = useFxEditor();
  const s = zgeState(params);
  // gallery: ?zgetab=<sheet>[<content sub-sheet>] opens a sheet
  const [tab, setTab] = useState(() => Number(/[?&]zgetab=(\d)/.exec(location.search)?.[1] ?? 0));
  const [sub, setSub] = useState(() => Number(/[?&]zgetab=\d(\d)/.exec(location.search)?.[1] ?? 2));
  const [sel, setSel0] = useState(0);
  const anchor = useRef<HTMLDivElement>(null);
  const exists = !!A.findFx(store.project, slotId);
  const sl = Math.min(sel, s.layerCount - 1);
  const setSel = (i: number) => {
    setSel0(i);
    if (s.autoCollapse && s.layers[i]?.collapsed) setCollapsed(slotId, s, i, false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (tab !== 0 || (e.target as HTMLElement).closest('textarea, input')) return;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    const menu = layerMenu(slotId, s, params, sl, setSel);
    const run = (label: string) => menu.find((m) => m.label === label)?.onClick?.();
    let handled = true;
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const d = k === 'ArrowLeft' ? -1 : 1;
      if (e.shiftKey) { if ((d < 0 && sl > 0) || (d > 0 && sl < s.layerCount - 1)) layerOp(slotId, d < 0 ? 'left' : 'right', sl, setSel); } else setSel(Math.max(0, Math.min(s.layerCount - 1, sl + d)));
    } else if (mod && k.toLowerCase() === 'c') run('Copy layer');
    else if (mod && k.toLowerCase() === 'v') run('Paste layer');
    else if (mod) handled = false;
    else if (k.toLowerCase() === 'c') setCollapsed(slotId, s, sl, !s.layers[sl].collapsed);
    else if (k.toLowerCase() === 's') run('Solo layer');
    else if (k === 'Delete' || k.toLowerCase() === 'd') layerOp(slotId, 'delete', sl, setSel);
    else if (k === 'Insert' || k.toLowerCase() === 'i') { if (s.layerCount < ZGE_LAYERS) layerOp(slotId, 'insert', sl, setSel); }
    else if (k.toLowerCase() === 'x') flashHint('Export Video: not available in this version');
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  return (
    <FxPanel width={W} height={H} style={{ background: Z.bar, overflow: 'hidden' }}>
      <style>{CSS}</style>
      <div ref={anchor} tabIndex={0} onKeyDown={onKey} style={abs(0, 0, W, H, { outline: 'none' })}>
        <ZTabs x={3} y={3} h={30} items={['Main', 'Add content', 'Settings', 'Debug log']} widths={[66, 112, 88, 94]} value={tab} onPick={setTab} />
        <ZText x={W - 180} y={21} w={176} h={13} align="right" size={10} color={Z.dim}>Canvas 2D</ZText>
        {tab === 0 && <MainSheet s={s} params={params} sel={sl} setSel={setSel} />}
        {tab === 1 && <ContentSheet s={s} sub={sub} setSub={setSub} />}
        {tab === 2 && <SettingsSheet s={s} />}
        {tab === 3 && <LogSheet slotId={slotId} />}
      </div>
      {/* Attached: docked to this window while it's open; Detached / Wallpaper live in the Persistent part. Gallery: any mode. */}
      {((exists && s.windowMode === 0) || (!exists && /[?&]zgedisplay/.test(location.search))) && (
        <ZgeVideo slotId={slotId} params={params} anchor={anchor} demo={!exists && /[?&]zgedemo/.test(location.search)} />
      )}
    </FxPanel>
  );
}

// ------------------------------------------------------------------ persistent video window


/** FL's [Detached] window rect, kept inside the workspace. */
function detachedRect(s: ZgeState) {
  const ws = document.getElementById('workspace');
  const vw = ws?.clientWidth ?? window.innerWidth, vh = ws?.clientHeight ?? window.innerHeight;
  const w = Math.max(200, Math.min(vw, s.rect[2])), h = Math.max(140, Math.min(vh, s.rect[3]));
  return { x: Math.max(0, Math.min(vw - w, s.rect[0])), y: Math.max(0, Math.min(vh - h, s.rect[1])), w, h };
}

/**
 * The video output while the slot exists, editor open or not: the Detached
 * window (an app Window, opened when the plugin is inserted, like FL) or the
 * Wallpaper behind the workspace windows.
 */
function ZgePersistent() {
  const { slotId, params } = useFxEditor();
  const s = zgeState(params);
  const id = `fxaux:${slotId}`;
  const detached = s.visible && s.windowMode === 1;
  const open = useAuxWindow(slotId, 'zgameviz', detached, () => ({ title: 'ZGameEditor Visualizer', ...detachedRect(s) }), () => {
    A.setFxStateNoHistory(slotId, 'Hide video window', (p) => { p.visible = false; });
  });
  const win = useUi((u) => u.windows[id]);
  // FL saves the detached window's rect with the plugin state
  useEffect(() => {
    if (!win?.open) return;
    const t = setTimeout(() => {
      const r = [win.x, win.y, win.w, win.h].map((v) => Math.round(v));
      const cur = zgeState(A.findFx(store.project, slotId)?.fx.params ?? {}).rect;
      if (r.some((v, i) => v !== cur[i])) A.setFxStateNoHistory(slotId, 'Move video window', (p) => { p.rect = r; });
    }, 400);
    return () => clearTimeout(t);
  }, [win?.open, win?.x, win?.y, win?.w, win?.h]);

  if (s.visible && s.windowMode === 2) return <ZgeVideo slotId={slotId} params={params} variant="wallpaper" />;
  if (!open || !detached) return null;
  return (
    <Window id={id} title="ZGameEditor Visualizer" minW={160} minH={110}
      menu={() => zgeVideoMenu(slotId, zgeState(A.findFx(store.project, slotId)?.fx.params ?? {}))}
      toolbar={
        <button className="win-btn" title="Fullscreen (press any key to restore)" onPointerDown={(e) => { e.stopPropagation(); zgeLive(slotId).fullscreen?.(); }}>
          <svg width="9" height="9" viewBox="0 0 10 10"><path d="M0.5 3.5 V0.5 H3.5 M6.5 0.5 H9.5 V3.5 M9.5 6.5 V9.5 H6.5 M3.5 9.5 H0.5 V6.5" stroke="currentColor" fill="none" strokeWidth="1.2" /></svg>
        </button>
      }
      onClose={() => A.editFx(slotId, 'Hide video window', (p) => { p.visible = false; })}>
      <ZgeVideo slotId={slotId} params={params} variant="window" />
    </Window>
  );
}

export const editor: FxEditorModule = {
  id: 'zgameviz',
  Editor: ZgeEditor,
  Persistent: ZgePersistent,
  menu: (slotId) => {
    const p = (A.findFx(store.project, slotId)?.fx.params ?? {}) as Record<string, unknown>;
    const s = zgeState(p);
    const set = (label: string, recipe: (q: Record<string, unknown>) => void) => A.editFx(slotId, label, recipe);
    const layers = Array.from({ length: s.layerCount }, (_, n) => zgeReadLayer(p, n));
    return [
      { label: 'Show video window', checked: s.visible || s.windowMode === 2, onClick: () => set('Show video window', (q) => { q.visible = !s.visible; }) },
      { label: 'Window mode', submenu: ZGE_WINDOW_MODES.map((m, i) => ({ label: m, radio: true, checked: s.windowMode === i, onClick: () => set(`Window mode: ${m}`, (q) => { q.windowMode = i; q.visible = true; }) })) },
      { label: 'Hold visualization', checked: s.freeze, onClick: () => set('Hold visualization', (q) => { q.freeze = !s.freeze; }) },
      { label: 'Save still image', onClick: () => zgeSaveStill(slotId) },
      { label: 'Layers', submenu: layers.map((l, n) => ({ label: `${s.layers[n].name || LAYER_LETTERS[n]}: ${ZGE_EFFECTS[l.fx].name}`, checked: l.on >= ZGE_MAX / 2, onClick: () => set('Enable layer', (q) => { q[zk.on(n)] = l.on >= ZGE_MAX / 2 ? 0 : ZGE_MAX; }) })) },
    ];
  },
};
