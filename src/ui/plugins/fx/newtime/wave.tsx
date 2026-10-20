// Newtime's warp view (below FL's 88 px toolbar): time ruler, the warped
// waveform on the beat grid, warp markers with their flags (warp orange,
// downbeat green, groove yellow, shift cyan) and FL's scroll-zoom bar.
// Mouse (manual): drag a marker to warp (Alt = no snap), Shift+click or
// double-click empty space adds a warp marker, double-click a marker
// removes it, right-click toggles downbeat, Alt+click toggles shift,
// Ctrl+Alt+click toggles groove, drag between markers moves the region,
// Ctrl+drag selects, Ctrl+right-click zooms to the selection (or out),
// wheel zooms, Shift+wheel scrolls, the ruler sets the play position.

import { useEffect, useLayoutEffect, useRef } from 'react';
import { markerPos, MK_DOWNBEAT, MK_GROOVE, MK_SHIFT, type NtmMarker, type TimeKnobs } from '../../../../engine/effects/plugins/newtools/timemodel';
import { MARKER_COLORS, MARKER_NAMES, moveMarker, moveMarkers, sortMarkers } from '../../../../engine/effects/plugins/newtools/timeops';
import type { TimeMap } from '../../../../engine/effects/plugins/newtools/psola';
import { clearHint, setHint } from '../../../hint';
import { localPos } from '../newtools/ui';

export const WW = 727, WH = 494, RUL = 17, ZB = 18;
const Y0 = RUL, Y1 = WH - ZB;

export interface WView { t0: number; pps: number }

export interface TimeView {
  sr: number;
  srcLen: number;
  /** Output seconds per output (unscaled) sample = ratio / sr. */
  ratio: number;
  markers: NtmMarker[];
  knobs: TimeKnobs;
  bpm: number;
  map: TimeMap;
  /** Source peak envelope: max |x| per `blk` samples. */
  env: Float32Array | null;
  blk: number;
  peak: number;
  /** Grid tempo (output) and origin (output seconds). */
  gridBpm: number;
  origin: number;
  dur: number;
}

export interface WaveApi {
  tv: TimeView;
  view: WView;
  setView: (v: WView) => void;
  sel: ReadonlySet<number>;
  setSel: (s: Set<number>) => void;
  timeSel: [number, number] | null;
  setTimeSel: (t: [number, number] | null) => void;
  snapDiv: number;
  play: { current: { sec: number; playing: boolean } };
  autoScroll: boolean;
  editMarkers: (label: string, ms: NtmMarker[]) => void;
  beginGesture: (label: string) => void;
  endGesture: () => void;
  onAdd: (outPos: number) => void;
  onRemove: (id: number) => void;
  onType: (id: number, type: number) => void;
  onSetPlay: (sec: number) => void;
  focus: () => void;
}

type Hit = { k: 'none' } | { k: 'ruler' } | { k: 'zoom'; part: 'l' | 'r' | 'thumb' | 'track' | 'btn' } | { k: 'marker'; m: NtmMarker } | { k: 'wave' };

const clampN = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function Wave({ api, y }: { api: WaveApi; y: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  const dirty = useRef(true);
  dirty.current = true;
  const last = useRef({ sec: -1, playing: false });
  const drag = useRef<{ kind: string; x0: number; orig: NtmMarker[]; m?: NtmMarker; ids?: Set<number>; view?: WView; t0?: number; moved: boolean; label?: string } | null>(null);

  const xOf = (sec: number, v = apiRef.current.view) => (sec - v.t0) * v.pps;
  const secOf = (x: number, v = apiRef.current.view) => v.t0 + x / v.pps;
  const posSec = (m: NtmMarker) => { const t = apiRef.current.tv; return (markerPos(m, t.knobs, t.bpm, t.sr) * t.ratio) / t.sr; };
  const outPos = (sec: number) => { const t = apiRef.current.tv; return (sec * t.sr) / t.ratio; };

  const zoomGeom = () => {
    const a = apiRef.current, v = a.view;
    const total = Math.max(a.tv.dur * 1.05, WW / v.pps, 0.1);
    const tw = WW - 34;
    const thW = Math.max(16, tw * Math.min(1, WW / v.pps / total));
    const thX = 34 + (tw - thW) * clampN(v.t0 / Math.max(1e-9, total - WW / v.pps), 0, 1);
    return { total, tw, thW, thX };
  };

  const hitTest = (x: number, yy: number): Hit => {
    const a = apiRef.current;
    if (yy < Y0) return { k: 'ruler' };
    if (yy >= Y1) {
      if (x < 34) return { k: 'zoom', part: 'btn' };
      const z = zoomGeom();
      if (Math.abs(x - z.thX) < 5) return { k: 'zoom', part: 'l' };
      if (Math.abs(x - (z.thX + z.thW)) < 5) return { k: 'zoom', part: 'r' };
      if (x > z.thX && x < z.thX + z.thW) return { k: 'zoom', part: 'thumb' };
      return { k: 'zoom', part: 'track' };
    }
    let best: NtmMarker | null = null, bd = 5;
    for (const m of a.tv.markers) {
      const mx = xOf(posSec(m));
      const flag = yy < Y0 + 12 && x >= mx - 1 && x <= mx + 11;
      const dd = flag ? 0 : Math.abs(x - mx);
      if (dd < bd) { bd = dd; best = m; }
    }
    if (best) return { k: 'marker', m: best };
    return { k: 'wave' };
  };

  const draw = (g: CanvasRenderingContext2D) => {
    const a = apiRef.current, t = a.tv, v = a.view;
    g.fillStyle = '#4c5f6b';
    g.fillRect(0, 0, WW, WH);
    // grid
    const beat = 60 / Math.max(20, t.gridBpm), bar = beat * 4, step = beat / 4;
    const tA = secOf(0), tB = secOf(WW);
    const lvl = step * v.pps >= 8 ? step : beat * v.pps >= 8 ? beat : bar;
    const first = Math.floor((tA - t.origin) / lvl) * lvl + t.origin;
    for (let s = first; s <= tB; s += lvl) {
      const xx = Math.round(xOf(s));
      const rel = (s - t.origin) / beat;
      const isBeat = Math.abs(rel - Math.round(rel)) < 1e-6;
      const isBar = isBeat && Math.round(rel) % 4 === 0;
      g.fillStyle = isBar ? '#2e4250' : isBeat ? '#344c54' : '#405460';
      g.fillRect(xx, Y0, 1, Y1 - Y0);
      g.fillStyle = isBar ? 'rgba(46,66,80,0.5)' : 'rgba(64,84,96,0.45)';
      g.fillRect(xx - 1, Y0, 1, Y1 - Y0);
      g.fillRect(xx + 1, Y0, 1, Y1 - Y0);
    }
    // selection
    if (a.timeSel) {
      const x0 = xOf(a.timeSel[0]), x1 = xOf(a.timeSel[1]);
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(x0, Y0, x1 - x0, Y1 - Y0);
    }
    // waveform (symmetric envelope through the warp)
    if (t.env && t.srcLen > 0) {
      const cy = (Y0 + 12 + Y1) / 2, half = (Y1 - Y0 - 16) / 2;
      const sc = (half * 0.97) / Math.max(1e-6, t.peak);
      g.fillStyle = '#e9fbff';
      g.beginPath();
      const xs0 = Math.max(0, Math.floor(xOf(0))), xs1 = Math.min(WW, Math.ceil(xOf(t.dur)));
      const tops: number[] = [];
      for (let xx = xs0; xx <= xs1; xx++) {
        const s0 = t.map.srcAt(outPos(secOf(xx))), s1 = t.map.srcAt(outPos(secOf(xx + 1)));
        const b0 = Math.max(0, Math.floor(Math.min(s0, s1) / t.blk)), b1 = Math.min(t.env.length - 1, Math.ceil(Math.max(s0, s1) / t.blk));
        let mx = 0;
        for (let b = b0; b <= b1; b++) if (t.env[b] > mx) mx = t.env[b];
        tops.push(Math.min(half, mx * sc));
      }
      g.moveTo(xs0, cy);
      for (let i = 0; i < tops.length; i++) g.lineTo(xs0 + i, cy - tops[i]);
      for (let i = tops.length - 1; i >= 0; i--) g.lineTo(xs0 + i, cy + tops[i]);
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(233,251,255,0.35)';
      g.fillRect(xs0, Math.round(cy), xs1 - xs0, 1);
      // end of the sample
      const xe = Math.round(xOf(t.dur));
      g.fillStyle = '#7a3c46';
      g.fillRect(xe, Y0, 1, Y1 - Y0);
    }
    // markers
    for (const m of sortMarkers(t.markers)) {
      const xx = Math.round(xOf(posSec(m)));
      if (xx < -12 || xx > WW + 2) continue;
      const col = MARKER_COLORS[m.type] ?? MARKER_COLORS[0];
      const selM = a.sel.has(m.id);
      g.fillStyle = col;
      g.fillRect(xx, Y0, selM ? 2 : 1, Y1 - Y0);
      if (m.type === MK_DOWNBEAT) {
        g.fillRect(xx, Y0, 13, 13);
      } else {
        g.beginPath();
        g.moveTo(xx, Y0); g.lineTo(xx + 11, Y0); g.lineTo(xx, Y0 + 11); g.closePath();
        g.fill();
      }
      if (selM) { g.strokeStyle = '#ffffff'; g.lineWidth = 1; g.strokeRect(xx - 1.5, Y0 + 0.5, 14, 13); }
    }
    // play position
    const ps = a.play.current.sec;
    if (ps >= 0 && t.srcLen > 0) {
      const xp = Math.round(xOf(ps));
      g.fillStyle = 'rgba(232,216,168,0.9)';
      g.fillRect(xp, Y0, 1, Y1 - Y0);
    }
    drawRuler(g);
    drawZoom(g);
  };

  const drawRuler = (g: CanvasRenderingContext2D) => {
    const a = apiRef.current, t = a.tv, v = a.view;
    g.fillStyle = '#29333a';
    g.fillRect(0, 0, WW, Y0);
    g.fillStyle = '#3a454c';
    g.fillRect(0, Y0 - 1, WW, 1);
    const bar = (60 / Math.max(20, t.gridBpm)) * 4;
    const every = bar * v.pps < 28 ? Math.ceil(28 / (bar * v.pps)) : 1;
    g.font = '10px sans-serif';
    g.textBaseline = 'middle';
    g.fillStyle = '#e8eef1';
    const tA = secOf(0), tB = secOf(WW);
    for (let b = Math.floor((tA - t.origin) / bar); t.origin + b * bar <= tB; b++) {
      if (b < 0 && t.origin + b * bar < 0) continue;
      const xx = Math.round(xOf(t.origin + b * bar));
      if (((b % every) + every) % every !== 0) continue;
      g.fillStyle = '#5b696b';
      g.fillRect(xx, Y0 - 6, 1, 5);
      g.fillStyle = '#e8eef1';
      g.fillText(String(b + 1), xx + 3, Y0 / 2);
    }
    if (a.timeSel) {
      const x0 = xOf(a.timeSel[0]), x1 = xOf(a.timeSel[1]);
      g.fillStyle = 'rgba(240,160,60,0.5)';
      g.fillRect(x0, Y0 - 4, x1 - x0, 3);
    }
    const ps = a.play.current.sec;
    if (ps >= 0 && t.srcLen > 0) {
      const xp = xOf(ps);
      g.fillStyle = '#f08a2c';
      g.beginPath(); g.moveTo(xp, 1); g.lineTo(xp + 9, 1); g.lineTo(xp, 10); g.closePath(); g.fill();
    }
  };

  const drawZoom = (g: CanvasRenderingContext2D) => {
    const z = zoomGeom();
    g.fillStyle = '#3c454c';
    g.fillRect(0, Y1, WW, ZB);
    g.fillStyle = '#4a565c';
    g.fillRect(0, Y1, 33, ZB);
    g.strokeStyle = '#c9d1d5';
    g.lineWidth = 1.3;
    g.beginPath(); g.moveTo(19, Y1 + 4); g.lineTo(14, Y1 + 9); g.lineTo(19, Y1 + 14); g.stroke();
    g.fillStyle = '#6c7a80';
    g.fillRect(z.thX, Y1 + 1, z.thW, ZB - 2);
    g.fillStyle = 'rgba(255,255,255,0.06)';
    for (let xx = Math.ceil(z.thX); xx < z.thX + z.thW; xx += 2) g.fillRect(xx, Y1 + 2, 1, ZB - 4);
    g.fillStyle = '#86959b';
    g.fillRect(z.thX, Y1 + 1, z.thW, 1);
  };

  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(3, (window.devicePixelRatio || 1) * 1.5);
    if (c.width !== Math.round(WW * dpr)) { c.width = Math.round(WW * dpr); c.height = Math.round(WH * dpr); }
  }, []);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const a = apiRef.current;
      const pl = a.play.current;
      if (pl.playing && a.autoScroll && !drag.current) {
        const xp = xOf(pl.sec);
        if (xp > WW - 4 || xp < 0) { a.setView({ ...a.view, t0: Math.max(0, pl.sec - (0.02 * WW) / a.view.pps) }); return; }
      }
      if (pl.sec !== last.current.sec || pl.playing !== last.current.playing) { dirty.current = true; last.current = { ...pl }; }
      if (!dirty.current) return;
      dirty.current = false;
      const c = ref.current;
      const g = c?.getContext('2d');
      if (!c || !g) return;
      const dpr = c.width / WW;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(g);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const snapSec = (sec: number, alt: boolean) => {
    const a = apiRef.current;
    if (alt || !a.snapDiv) return sec;
    const st = 60 / Math.max(20, a.tv.gridBpm) / a.snapDiv;
    return a.tv.origin + Math.round((sec - a.tv.origin) / st) * st;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const a = apiRef.current;
    a.focus();
    const c = e.currentTarget;
    const { x, y: yy } = localPos(e, c, WW, WH);
    const h = hitTest(x, yy);
    const ctrl = e.ctrlKey || e.metaKey;
    const t = a.tv;
    if (e.button === 1) {
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      drag.current = { kind: 'pan', x0: x, orig: t.markers, view: { ...a.view }, moved: false };
      return;
    }
    if (e.button === 2) {
      e.preventDefault();
      if (ctrl) {
        const s = a.timeSel;
        if (s && s[1] > s[0]) a.setView({ t0: s[0], pps: WW / (s[1] - s[0]) });
        else a.setView({ t0: 0, pps: WW / Math.max(0.2, t.dur * 1.02) });
        return;
      }
      if (h.k === 'marker') a.onType(h.m.id, MK_DOWNBEAT);
      return;
    }
    if (e.button !== 0) return;
    if (h.k === 'ruler') {
      c.setPointerCapture(e.pointerId);
      drag.current = { kind: 'ruler', x0: x, orig: t.markers, moved: false };
      a.onSetPlay(Math.max(0, secOf(x)));
      return;
    }
    if (h.k === 'zoom') {
      if (h.part === 'btn') { a.setView({ ...a.view, t0: Math.max(0, a.view.t0 - 80 / a.view.pps) }); return; }
      c.setPointerCapture(e.pointerId);
      const z = zoomGeom();
      if (h.part === 'track') {
        // page to the click
        const total = z.total;
        a.setView({ ...a.view, t0: clampN(((x - 34 - z.thW / 2) / Math.max(1, z.tw - z.thW)) * (total - WW / a.view.pps), 0, total) });
      }
      drag.current = { kind: 'zoom:' + h.part, x0: x, orig: t.markers, view: { ...a.view }, t0: z.total, moved: false };
      return;
    }
    if (h.k === 'marker') {
      const m = h.m;
      if (e.altKey && ctrl) { a.onType(m.id, MK_GROOVE); return; }
      if (e.altKey) { a.onType(m.id, MK_SHIFT); return; }
      if (ctrl) { const s = new Set(a.sel); if (s.has(m.id)) s.delete(m.id); else s.add(m.id); a.setSel(s); return; }
      c.setPointerCapture(e.pointerId);
      const ids = a.sel.has(m.id) && a.sel.size > 1 ? new Set(a.sel) : undefined;
      a.beginGesture('Move marker');
      drag.current = { kind: ids ? 'group' : 'marker', x0: x, orig: t.markers, m, ids, moved: false, label: 'Move marker' };
      return;
    }
    if (h.k === 'wave') {
      if (e.shiftKey) { a.onAdd(outPos(snapSec(secOf(x), e.altKey))); return; }
      c.setPointerCapture(e.pointerId);
      if (ctrl) { drag.current = { kind: 'tsel', x0: x, orig: t.markers, moved: false, t0: Math.max(0, secOf(x)) }; return; }
      // drag between markers: move the region (the markers on both sides)
      const sec = secOf(x);
      const ms = sortMarkers(t.markers);
      let left: NtmMarker | undefined, right: NtmMarker | undefined;
      for (const m of ms) { const p = posSec(m); if (p <= sec) left = m; else if (!right) right = m; }
      const ids = new Set<number>();
      if (left) ids.add(left.id);
      if (right) ids.add(right.id);
      drag.current = { kind: ids.size ? 'region' : 'tsel', x0: x, orig: t.markers, ids, moved: false, t0: Math.max(0, sec), label: 'Move region' };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const a = apiRef.current, t = a.tv;
    const c = e.currentTarget;
    const { x, y: yy } = localPos(e, c, WW, WH);
    const dr = drag.current;
    if (!dr) {
      const h = hitTest(x, yy);
      let cur = 'default', hint = '';
      if (h.k === 'marker') {
        cur = 'ew-resize';
        hint = `${MARKER_NAMES[h.m.type] ?? 'Marker'} - drag to warp (Alt = no snap), double-click removes, right-click: downbeat, Alt+click: shift`;
      } else if (h.k === 'wave') { cur = 'default'; hint = 'Shift+click or double-click adds a warp marker; drag moves the region; Ctrl+drag selects'; }
      else if (h.k === 'ruler') { cur = 'pointer'; hint = 'Click to set the playback position'; }
      else if (h.k === 'zoom') { cur = h.part === 'l' || h.part === 'r' ? 'ew-resize' : 'default'; hint = 'Drag to scroll, drag the ends to zoom'; }
      c.style.cursor = cur;
      if (hint) setHint(hint); else clearHint();
      return;
    }
    const dx = x - dr.x0;
    if (Math.abs(dx) > 2) dr.moved = true;
    switch (dr.kind) {
      case 'pan': a.setView({ ...dr.view!, t0: Math.max(0, dr.view!.t0 - dx / dr.view!.pps) }); break;
      case 'ruler': a.onSetPlay(Math.max(0, secOf(x))); break;
      case 'zoom:thumb':
      case 'zoom:track': {
        const v = dr.view!;
        const z = zoomGeom();
        a.setView({ ...v, t0: clampN(v.t0 + (dx / Math.max(1, z.tw - z.thW)) * (dr.t0! - WW / v.pps), 0, dr.t0!) });
        break;
      }
      case 'zoom:l':
      case 'zoom:r': {
        const v = dr.view!;
        const total = dr.t0!;
        const secPerPx = total / Math.max(1, WW - 34);
        const visSec = WW / v.pps;
        if (dr.kind === 'zoom:r') {
          const nv = clampN(visSec + dx * secPerPx, 0.02, total * 2);
          a.setView({ t0: v.t0, pps: WW / nv });
        } else {
          const nt0 = clampN(v.t0 + dx * secPerPx, 0, v.t0 + visSec - 0.02);
          a.setView({ t0: nt0, pps: WW / (v.t0 + visSec - nt0) });
        }
        break;
      }
      case 'tsel': {
        if (!dr.moved) break;
        const t1 = Math.max(0, secOf(x));
        const s: [number, number] = [Math.min(dr.t0!, t1), Math.max(dr.t0!, t1)];
        a.setTimeSel(s);
        a.setSel(new Set(t.markers.filter((m) => { const p = posSec(m); return p >= s[0] && p <= s[1]; }).map((m) => m.id)));
        break;
      }
      case 'marker': {
        if (!dr.moved) break;
        const m0 = dr.orig.find((q) => q.id === dr.m!.id)!;
        const target = snapSec(posSec(m0) + dx / a.view.pps, e.altKey);
        a.editMarkers(dr.label!, moveMarker(dr.orig, m0.id, outPos(target), t.knobs, t.srcLen, t.bpm, t.sr));
        break;
      }
      case 'region':
        if (!dr.moved) break;
        // the region drag becomes an edit once the mouse moves
        a.beginGesture('Move region');
        dr.kind = 'region*';
        dr.label = 'Move region';
        applyGroup(dr, dx, e.altKey);
        break;
      case 'group':
      case 'region*':
        if (dr.moved) applyGroup(dr, dx, e.altKey);
        break;
    }
  };

  const applyGroup = (dr: NonNullable<typeof drag.current>, dx: number, alt: boolean) => {
    const a = apiRef.current, t = a.tv;
    const ref0 = dr.orig.find((q) => dr.ids!.has(q.id));
    if (!ref0) return;
    const p0 = posSec(ref0);
    const target = snapSec(p0 + dx / a.view.pps, alt);
    a.editMarkers(dr.label ?? 'Move markers', moveMarkers(dr.orig, dr.ids!, outPos(target) - outPos(p0), t.knobs, t.srcLen, t.bpm, t.sr));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const a = apiRef.current;
    const dr = drag.current;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!dr) return;
    if ((dr.kind === 'tsel' || dr.kind === 'region') && !dr.moved) { a.setTimeSel(null); a.setSel(new Set()); }
    if (dr.kind === 'marker' || dr.kind === 'group' || dr.kind === 'region*') a.endGesture();
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const a = apiRef.current;
    const { x, y: yy } = localPos(e, e.currentTarget, WW, WH);
    const h = hitTest(x, yy);
    if (h.k === 'marker') a.onRemove(h.m.id);
    else if (h.k === 'wave') a.onAdd(outPos(snapSec(secOf(x), e.altKey)));
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const a = apiRef.current, v = a.view;
    const { x } = localPos(e, e.currentTarget, WW, WH);
    const dir = e.deltaY > 0 ? 1 : -1;
    if (e.shiftKey) { a.setView({ ...v, t0: Math.max(0, v.t0 + (dir * 80) / v.pps) }); return; }
    const k = dir > 0 ? 1 / 1.25 : 1.25;
    const at = secOf(x);
    const pps = clampN(v.pps * k, 2, 40000);
    a.setView({ pps, t0: Math.max(0, at - x / pps) });
  };

  return (
    <canvas ref={ref} style={{ position: 'absolute', left: 0, top: y, width: WW, height: WH, display: 'block', touchAction: 'none' }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onPointerLeave={clearHint} onDoubleClick={onDoubleClick} onWheel={onWheel} onContextMenu={(e) => e.preventDefault()} />
  );
}
