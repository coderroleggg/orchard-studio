// ZGameEditor Visualizer layer columns (FL: AppSetFrame, 191 px wide): the
// header (enable switch, layer name, previous / next effect, color selector,
// move-layer handle, layer menu), the effect selector, author line, AUDIO SRC,
// IMAGE SRC, MESH, TO BUFFER (+ render quality) and the effect's parameters
// (FL ParameterFrame rows: slider, check box or list). Left-most = bottom.

import { useRef } from 'react';
import {
  LAYER_LETTERS, ZGE_CATEGORIES, ZGE_EFFECTS, ZGE_LAYERS, ZGE_MAX, ZGE_RQ, emptyLayerState, zListIndex, zgeLayerOp, zgeReadLayer,
  zgeSetEffect, zgeWriteLayer, zk, type ZgeLayerData, type ZgeLayerOp, type ZgeParamDef, type ZgeState,
} from '../../../../model/fx/plugins/zgameviz';
import { useFxEditor, useParam } from '../../kit';
import type { MenuItem } from '../../../widgets/ContextMenu';
import { openMenu } from '../../../widgets/ContextMenu';
import { clearHint, flashHint, setHint } from '../../../hint';
import * as A from '../../../../store/actions';
import { Glyph, Z, ZCombo, ZLed, ZSlider, ZText, abs } from './widgets';

export const COL_W = 191;
export const COLLAPSED_W = 24;
export const COL_H = 516;
const PARAMS_TOP = 166;

/** Layer clipboard (Copy layer / Paste layer). */
let clip: ZgeLayerData | null = null;

const layerTitle = (s: ZgeState, n: number) => s.layers[n].name || LAYER_LETTERS[n];

export function editLayers(slotId: string, label: string, fn: (p: Record<string, unknown>) => void, merge?: string) {
  A.editFx(slotId, label, fn, merge);
}

/** Run a layer menu operation; returns nothing, selection follows through onSelect. */
export function layerOp(slotId: string, op: ZgeLayerOp, n: number, onSelect: (i: number) => void, data?: ZgeLayerData, merge?: string) {
  const labels: Record<ZgeLayerOp, string> = { insert: 'Insert layer', clone: 'Clone layer', delete: 'Delete layer', left: 'Move layer left', right: 'Move layer right' };
  let sel = n;
  editLayers(slotId, labels[op], (p) => { sel = zgeLayerOp(p, op, n, data); }, merge);
  onSelect(sel);
}

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Layer menu (FL LayerPopupMenu). */
export function layerMenu(slotId: string, s: ZgeState, params: Record<string, unknown>, n: number, onSelect: (i: number) => void): MenuItem[] {
  const count = s.layerCount;
  const on = (i: number) => (typeof params[zk.on(i)] === 'number' ? (params[zk.on(i)] as number) : ZGE_MAX) >= ZGE_MAX / 2;
  const solo = on(n) && Array.from({ length: count }, (_, i) => i).every((i) => i === n || !on(i));
  return [
    { label: 'Insert layer', disabled: count >= ZGE_LAYERS, onClick: () => layerOp(slotId, 'insert', n, onSelect) },
    { label: 'Clone layer', disabled: count >= ZGE_LAYERS, onClick: () => layerOp(slotId, 'clone', n, onSelect) },
    { label: 'Move layer left', disabled: n === 0, onClick: () => layerOp(slotId, 'left', n, onSelect) },
    { label: 'Move layer right', disabled: n >= count - 1, onClick: () => layerOp(slotId, 'right', n, onSelect) },
    { label: 'Delete layer', onClick: () => layerOp(slotId, 'delete', n, onSelect) },
    {
      label: 'Rename layer', onClick: () => {
        const name = prompt('Layer name', s.layers[n].name);
        if (name === null) return;
        editLayers(slotId, 'Rename layer', (p) => { const d = zgeReadLayer(p, n); d.state.name = name.trim().slice(0, 40); zgeWriteLayer(p, n, d); });
      },
    },
    { label: 'Collapse layer', checked: s.layers[n].collapsed, onClick: () => setCollapsed(slotId, s, n, !s.layers[n].collapsed) },
    {
      label: 'Solo layer', checked: solo, onClick: () => editLayers(slotId, 'Solo layer', (p) => {
        for (let i = 0; i < count; i++) p[zk.on(i)] = solo || i === n ? ZGE_MAX : 0;
      }),
    },
    { separator: true },
    { label: 'Copy layer', onClick: () => { clip = zgeReadLayer(params, n); flashHint(`Copied layer ${layerTitle(s, n)}`); } },
    {
      label: 'Paste layer', disabled: !clip, onClick: () => {
        const c = clip;
        if (c) editLayers(slotId, 'Paste layer', (p) => zgeWriteLayer(p, n, { ...c, vals: [...c.vals], state: { ...c.state, imgSrc: c.state.imgSrc < n ? c.state.imgSrc : -1 } }));
      },
    },
    { separator: true },
    { label: 'Save layer to file', onClick: () => saveLayer(params, s, n) },
    { label: 'Load layer from file', onClick: () => loadLayer(slotId, n) },
  ];
}

export function setCollapsed(slotId: string, s: ZgeState, n: number, collapsed: boolean) {
  editLayers(slotId, collapsed ? 'Collapse layer' : 'Expand layer', (p) => {
    const layers = s.layers.map((l, i) => ({ ...l, collapsed: i === n ? collapsed : s.autoCollapse && !collapsed ? true : l.collapsed }));
    p.layers = layers;
  });
}

function saveLayer(params: Record<string, unknown>, s: ZgeState, n: number) {
  const d = zgeReadLayer(params, n);
  const json = JSON.stringify({ format: 'zgameviz-layer', effect: ZGE_EFFECTS[d.fx].name, enabled: d.on, values: d.vals, name: d.state.name }, null, 1);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = `${layerTitle(s, n)} - ${ZGE_EFFECTS[d.fx].name}.zgelayer.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function loadLayer(slotId: string, n: number) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.onchange = () => {
    const f = inp.files?.[0];
    if (!f) return;
    void f.text().then((txt) => {
      try {
        const j = JSON.parse(txt) as { format?: string; effect?: string; enabled?: number; values?: number[]; name?: string };
        const fx = ZGE_EFFECTS.findIndex((e) => e.name === j.effect);
        if (j.format !== 'zgameviz-layer' || fx < 0) throw new Error('not a layer file');
        const vals = Array.from({ length: 16 }, (_, k) => Math.max(0, Math.min(ZGE_MAX, Math.round(Number(j.values?.[k]) || 0))));
        editLayers(slotId, 'Load layer', (p) => zgeWriteLayer(p, n, { fx, on: Number(j.enabled) >= ZGE_MAX / 2 ? ZGE_MAX : 0, vals, state: { ...emptyLayerState(), name: String(j.name ?? '').slice(0, 40) } }));
      } catch { flashHint('Not a ZGameEditor Visualizer layer file'); }
    });
  };
  inp.click();
}

/** Effect selector menu: (none) and the effect categories. */
function effectMenu(fx: number, pick: (i: number) => void): MenuItem[] {
  return [
    { label: '(none)', radio: true, checked: fx === 0, onClick: () => pick(0) },
    ...ZGE_CATEGORIES.map((c): MenuItem => ({
      label: c,
      checked: ZGE_EFFECTS[fx]?.category === c,
      submenu: ZGE_EFFECTS.map((e, i) => ({ e, i })).filter(({ e }) => e.category === c).map(({ e, i }) => ({ label: e.name, radio: true, checked: i === fx, onClick: () => pick(i) })),
    })),
  ];
}

// ------------------------------------------------------------------ parameter rows

function ParamRow({ n, k, def, top }: { n: number; k: number; def: ZgeParamDef; top: number }) {
  const key = zk.p(n, k);
  const pct = (v: number) => `${Math.round((v / ZGE_MAX) * 100)}%`;
  const fmt = def.kind === 'checkbox' ? (v: number) => (v >= ZGE_MAX / 2 ? 'On' : 'Off') : def.kind === 'list' && def.items ? (v: number) => def.items![zListIndex(v / ZGE_MAX, def.items!.length)] : pct;
  const bp = useParam(key, { label: def.name, format: fmt, step: def.kind === 'list' && def.items ? ZGE_MAX / (def.items.length - 1) : 1 });
  const set = (v: number) => { bp.control.onBegin?.(); bp.set(v); bp.control.onEnd?.(); };
  return (
    <>
      <ZText x={3} y={top + 8} w={78} h={23} align="right" size={def.name.length > 12 ? 10.5 : 12} clip>{def.name}</ZText>
      {def.kind === 'checkbox' ? (
        <ZLed x={86} y={top + 11} w={20} h={17} on={bp.value >= ZGE_MAX / 2} hint={`${def.name}: ${fmt(bp.value)}`} onToggle={() => set(bp.value >= ZGE_MAX / 2 ? 0 : ZGE_MAX)} />
      ) : def.kind === 'list' && def.items ? (
        <ZCombo x={86} y={top + 9} w={89} h={20} size={12} items={def.items} value={zListIndex(bp.value / ZGE_MAX, def.items.length)} hint={def.name}
          onPick={(i) => set(Math.round((i / (def.items!.length - 1)) * ZGE_MAX))} color={Z.comboText} />
      ) : (
        <ZSlider x={86} y={top + 9} control={bp.control} />
      )}
    </>
  );
}

// ------------------------------------------------------------------ column

export function LayerColumn({ n, s, params, x, selected, onSelect, trackName }: {
  n: number; s: ZgeState; params: Record<string, unknown>; x: number; selected: boolean; onSelect: (i: number) => void; trackName: string;
}) {
  const { slotId } = useFxEditor();
  const L = zgeReadLayer(params, n);
  const ls = s.layers[n];
  const eff = ZGE_EFFECTS[L.fx] ?? ZGE_EFFECTS[0];
  const enabled = L.on >= ZGE_MAX / 2;
  const onP = useParam(zk.on(n));
  const dragRef = useRef<{ x: number; n: number } | null>(null);
  const title = layerTitle(s, n);
  const toggleOn = () => { onP.control.onBegin?.(); onP.set(enabled ? 0 : ZGE_MAX); onP.control.onEnd?.(); };
  const pickEffect = (i: number) => editLayers(slotId, `Layer ${title}: ${ZGE_EFFECTS[i].name}`, (p) => zgeSetEffect(p, n, i));
  const step = (d: number) => {
    const N = ZGE_EFFECTS.length - 1;
    const cur = L.fx === 0 ? (d > 0 ? 0 : 1) : L.fx;
    pickEffect(((cur - 1 + d + N) % N) + 1);
  };

  if (ls.collapsed) {
    return (
      <div style={abs(x, 0, COLLAPSED_W, COL_H, { background: Z.col, cursor: 'default' })}
        onPointerDown={(e) => { if (e.button === 0) { onSelect(n); setCollapsed(slotId, s, n, false); } }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onSelect(n); openMenu(e.clientX, e.clientY, layerMenu(slotId, s, params, n, onSelect)); }}
        onPointerEnter={() => setHint(`Layer ${title} (collapsed): click to expand`)} onPointerLeave={() => clearHint()}>
        <div style={abs(0, 0, COLLAPSED_W, 23, { background: selected ? '#56616a' : Z.colTab })} />
        <ZLed x={5} y={4} w={14} h={15} on={enabled} tone="grey" onToggle={toggleOn} hint="Enable/disable layer" />
        <div style={{ position: 'absolute', left: 5, top: 30, writingMode: 'vertical-rl', font: '12.5px var(--font-ui)', color: Z.text, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
          {title}{L.fx ? ` - ${eff.name}` : ''}
        </div>
      </div>
    );
  }

  const imgItems: MenuItem[] = [
    { label: '(none)', radio: true, checked: ls.imgSrc < 0, onClick: () => editLayers(slotId, 'Image source', (p) => { const d = zgeReadLayer(p, n); d.state.imgSrc = -1; zgeWriteLayer(p, n, d); }) },
    ...Array.from({ length: n }, (_, i) => i).filter((i) => s.layers[i].toBuffer).map((i): MenuItem => ({
      label: `Buffer ${layerTitle(s, i)}`, radio: true, checked: ls.imgSrc === i,
      onClick: () => editLayers(slotId, 'Image source', (p) => { const d = zgeReadLayer(p, n); d.state.imgSrc = i; zgeWriteLayer(p, n, d); }),
    })),
  ];
  const srcText = ls.imgSrc >= 0 && ls.imgSrc < n && s.layers[ls.imgSrc].toBuffer ? `Buffer ${layerTitle(s, ls.imgSrc)}` : '(none)';
  const hasColor = eff.params.some((q) => q.name === 'Hue');
  const pickColor = () => {
    const iH = eff.params.findIndex((q) => q.name === 'Hue'), iS = eff.params.findIndex((q) => q.name === 'Saturation'), iL = eff.params.findIndex((q) => q.name === 'Lightness');
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = hslToHex(L.vals[iH] / ZGE_MAX, iS >= 0 ? L.vals[iS] / ZGE_MAX : 1, iL >= 0 ? L.vals[iL] / ZGE_MAX : 0.5);
    inp.oninput = () => {
      const [h, sa, l] = hexToHsl(inp.value);
      editLayers(slotId, 'Select color', (p) => {
        p[zk.p(n, iH)] = Math.round(h * ZGE_MAX);
        if (iS >= 0) p[zk.p(n, iS)] = Math.round(sa * ZGE_MAX);
        if (iL >= 0) p[zk.p(n, iL)] = Math.round(l * ZGE_MAX);
      }, `zge:${slotId}:color${n}`);
    };
    inp.click();
  };
  const tabW = Math.min(110, Math.max(40, 26 + title.length * 7.5));
  const rows = eff.params.length;
  const icon = (ix: number, kind: Parameters<typeof Glyph>[0]['kind'], hint: string, onDown: (e: React.PointerEvent) => void, disabled = false) => (
    <div style={abs(ix, 2, 14, 19, { display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default', opacity: disabled ? 0.35 : 1 })}
      onPointerEnter={() => setHint(hint)} onPointerLeave={() => clearHint()}
      onPointerDown={(e) => { if (e.button !== 0 || disabled) return; e.stopPropagation(); onSelect(n); onDown(e); }}>
      <Glyph kind={kind} />
    </div>
  );

  return (
    <div style={abs(x, 0, COL_W, COL_H, { background: Z.col })}
      onPointerDown={() => onSelect(n)}>
      {/* header */}
      <svg width={tabW + 12} height={23} style={{ position: 'absolute', left: 0, top: 0 }}>
        <path d={`M0 0 H${tabW + 11} L${tabW} 23 H0 Z`} fill={selected ? '#56616a' : Z.colTab} />
      </svg>
      <ZLed x={4} y={3} w={14} h={17} on={enabled} tone="grey" onToggle={toggleOn} hint="Enable/disable layer" />
      <ZText x={21} y={4} w={tabW - 18} h={15} size={13} clip color={enabled ? Z.text : Z.dim}>{title}</ZText>
      {icon(112, 'prev', 'Previous effect', () => step(-1))}
      {icon(126, 'next', 'Next effect', () => step(1))}
      {icon(140, 'brush', 'Select color (set Hue, Saturation and Lightness parameters)', pickColor, !hasColor)}
      {icon(156, 'drag', 'Click and drag to move layer', (e) => {
        dragRef.current = { x: e.clientX, n };
        const move = (ev: PointerEvent) => {
          const d = dragRef.current;
          if (!d) return;
          const dx = ev.clientX - d.x;
          if (Math.abs(dx) > COL_W / 2) {
            const op = dx > 0 ? 'right' : 'left';
            if ((op === 'left' && d.n > 0) || (op === 'right' && d.n < s.layerCount - 1)) {
              layerOp(slotId, op, d.n, (i) => { d.n = i; onSelect(i); }, undefined, `zge:${slotId}:drag`);
            }
            d.x = ev.clientX;
          }
        };
        const up = () => { dragRef.current = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      })}
      {icon(173, 'menu', 'Layer menu', (e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom, layerMenu(slotId, s, params, n, onSelect));
      })}

      {/* effect and sources */}
      <ZCombo x={3} y={23} w={184} h={24} size={14} text={eff.name} hint="Effect selector" menu={() => effectMenu(L.fx, pickEffect)}
        items={ZGE_EFFECTS.map((e) => e.name)} value={L.fx} onPick={pickEffect} />
      <ZText x={6} y={47} w={180} h={21} align="right" size={11} clip color={Z.dim}>{L.fx ? `Built-in: ${eff.category}` : ''}</ZText>
      <ZText x={6} y={68} w={54} h={21} size={8.5} bold color="#aab2b7">AUDIO SRC</ZText>
      <ZCombo x={59} y={68} w={128} h={21} size={12} text={trackName} hint="Audio source: the mixer track hosting the plugin"
        menu={() => [{ label: trackName, radio: true, checked: true }, { label: 'Other tracks are not available here', disabled: true }]} />
      <ZText x={6} y={91} w={54} h={21} size={8.5} bold color="#aab2b7">IMAGE SRC</ZText>
      <ZCombo x={59} y={91} w={128} h={21} size={12} text={srcText} hint="Image source: the buffer of a TO BUFFER layer on the left" menu={() => imgItems} />
      <ZText x={6} y={114} w={54} h={21} size={8.5} bold color="#aab2b7">MESH</ZText>
      <ZCombo x={59} y={114} w={128} h={21} size={12} text="(none)" disabled hint="Meshes are not available in this version" />
      <ZLed x={56} y={143} w={86} h={14} size={11} tone="grey" bold fontSize={10} captionColor="#aab2b7" caption="TO BUFFER" on={ls.toBuffer}
        hint="Redirect this layer to a buffer that can be used as image source in other layers"
        onToggle={() => editLayers(slotId, 'To buffer', (p) => { const d = zgeReadLayer(p, n); d.state.toBuffer = !ls.toBuffer; zgeWriteLayer(p, n, d); })} />
      {ls.toBuffer && (
        <ZCombo x={148} y={140} w={38} h={21} size={10} bold={false} items={ZGE_RQ} value={ls.rq} hint="Render to buffer quality (100% means full resolution)"
          onPick={(i) => editLayers(slotId, 'Render to buffer quality', (p) => { const d = zgeReadLayer(p, n); d.state.rq = i; zgeWriteLayer(p, n, d); })} />
      )}
      <div style={abs(0, PARAMS_TOP - 1, COL_W, 1, { background: Z.sep })} />
      <div style={abs(0, PARAMS_TOP, COL_W, 1, { background: '#58626a' })} />

      {/* parameters */}
      <div className="zge-params" style={abs(0, PARAMS_TOP + 1, COL_W, COL_H - PARAMS_TOP - 1, { overflowY: 'auto', overflowX: 'hidden' })}>
        <div style={{ position: 'relative', height: rows * 24 + 12 }}>
          {eff.params.map((d, k) => <ParamRow key={`${L.fx}:${k}`} n={n} k={k} def={d} top={24 * k - 1} />)}
        </div>
      </div>
    </div>
  );
}
