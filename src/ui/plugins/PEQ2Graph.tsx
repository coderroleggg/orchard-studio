// Parametric EQ 2 graph: rulers and grid, analyzer, response curve, band
// tokens, and the graph gestures (docs/research/peq2.md 6.1, 6.2, 6.6).
//
// Three stacked canvases: static background (redrawn on resize), analyzer
// (redrawn when spectrum data arrives) and foreground (curve + tokens,
// redrawn when params, hover or size change). One requestAnimationFrame loop
// per editor does the drawing; React effects only mark layers dirty.

import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { host, store } from '../../store';
import { findFx } from '../../store/actions';
import {
  activeBands, designModeOf, formatFreq, freqHz, typeHasLevel, PEQ2_BAND_COLORS,
  type DesignMode, type PEQ2Band, type PEQ2Params,
} from '../../model/peq2';
import { clamp, keyToHz } from '../../engine/dsp/math';
import { keyName } from '../../model/notes';
import { openMenu } from '../widgets/ContextMenu';
import { setHint, clearHint } from '../hint';
import { Analyzer, analyzerVisible, drawAnalyzer } from './peq2Analyzer';
import * as D from './peq2Draw';
import { bandHint, cents, fmtBw, fmtDb } from './peq2Format';
import { auditionParams, currentParams, edit, editOnce, resetBand, setParamsNoHistory } from './peq2Edit';
import { tokenMenu } from './peq2Menus';

type DragKind = 'move' | 'bw' | 'main' | 'solo';

interface Drag {
  kind: DragKind;
  band: number; // -1 for main level
  pointerId: number;
  x0: number;
  y0: number;
  lx: number;
  ly: number;
  moved: boolean;
  // accumulated values (clamped), so fine mode can kick in mid-drag
  freq: number;
  level: number;
  bw: number;
  main: number;
  /** Band solo audition: the stored params before it started, and their complete view. */
  orig: PEQ2Params | null;
  view: PEQ2Params | null;
}

interface BandCurve {
  b: PEQ2Band;
  geom: D.Geom;
  fs: number;
  mode: DesignMode;
  lin: boolean;
  ys: Float32Array;
}

interface GraphState {
  slotId: string;
  params: PEQ2Params;
  geom: D.Geom;
  onAudition: (p: PEQ2Params | null) => void;
  dpr: number;
  fs: number;
  hover: number;
  drag: Drag | null;
  audition: { k: number; band: PEQ2Band } | null;
  curve: D.Curve | null;
  band: BandCurve | null;
  dirty: { bg: boolean; an: boolean; fg: boolean; curve: boolean };
  analyzer: Analyzer;
  anVisible: boolean;
  lastFrame: number;
}

const THRESHOLD = 3; // px of travel before a press becomes a drag (a plain click changes nothing)
const BW_PX = 200; // px of travel for the full bandwidth range
const LABELS: Record<DragKind, string> = { move: 'Move band', bw: 'Band bandwidth', main: 'Main level', solo: 'Band solo' };
const round2 = (v: number) => Math.round(v * 100) / 100;

function hitToken(S: GraphState, x: number, y: number): number {
  return D.hitTest(D.tokenLayout(S.params.bands, S.params.showTokens, S.geom), S.geom, x, y);
}

function drawForeground(S: GraphState, canvas: HTMLCanvasElement): void {
  const g = S.geom, p = S.params, d = S.drag;
  const ctx = D.setupCanvas(canvas, g.w, g.h, S.dpr);
  if (!ctx) return;
  ctx.clearRect(0, 0, g.w, g.h);
  const mode = designModeOf(p);

  // the band whose own response is drawn: audition > drag > hovered token
  const hover = p.showTokens && S.hover >= 0 && p.bands[S.hover]?.type !== 'off' ? S.hover : -1;
  const hk = S.audition ? S.audition.k : d && d.band >= 0 ? d.band : hover;
  let bandYs: Float32Array | null = null;
  let bandActive = true;
  if (hk >= 0 && hk < p.bands.length) {
    const b = S.audition ? S.audition.band : p.bands[hk];
    if (b.type !== 'off') {
      let c = S.band;
      if (!c || c.b !== b || c.geom !== g || c.fs !== S.fs || c.mode !== mode || c.lin !== p.lin) {
        c = { b, geom: g, fs: S.fs, mode, lin: p.lin, ys: D.computeBandCurve(b, S.fs, mode, p.lin, g) };
        S.band = c;
      }
      bandYs = c.ys;
      bandActive = !!S.audition || activeBands(p).includes(p.bands[hk]);
    }
  }
  const color = hk >= 0 ? PEQ2_BAND_COLORS[hk] : '#ffffff';

  if (S.curve) D.drawCurveFill(ctx, g, S.curve.ys);
  if (bandYs) D.drawBandFill(ctx, g, bandYs, color);
  if (S.curve) D.drawCurveLine(ctx, g, S.curve.ys);
  if (bandYs) D.drawBandLine(ctx, g, bandYs, color, !bandActive);
  if (S.curve?.phase) D.drawPhase(ctx, g, S.curve.phase);

  const toks = D.tokenLayout(p.bands, p.showTokens, g);
  const top = S.audition ? S.audition.k : d && d.band >= 0 ? d.band : -1;
  D.drawTokens(ctx, g, p, toks, hover, top);

  if (d && (d.moved || d.kind === 'solo')) {
    const t = toks.find((tk) => tk.k === d.band);
    const bx = t ? t.x : d.lx, by = t ? t.y : d.ly;
    let text: string;
    if (d.kind === 'main') text = `Main ${fmtDb(p.mainLevel)}`;
    else if (d.kind === 'solo') text = `Solo BW ${fmtBw(d.bw)}`;
    else if (d.kind === 'bw') text = `BW ${fmtBw(p.bands[d.band].bw)}`;
    else {
      const b = p.bands[d.band];
      text = typeHasLevel(b.type) ? `${formatFreq(freqHz(b.freq))}   ${fmtDb(b.level)}` : formatFreq(freqHz(b.freq));
    }
    D.drawBubble(ctx, g, bx, by, text);
  }
}

export interface GraphProps {
  slotId: string;
  params: PEQ2Params;
  width: number;
  height: number;
  s: number;
  /** Band solo audition started (the untouched params to display) or ended (null). */
  onAudition: (p: PEQ2Params | null) => void;
}

export const PEQ2Graph = memo(function PEQ2Graph({ slotId, params, width, height, s, onAudition }: GraphProps) {
  const bgRef = useRef<HTMLCanvasElement>(null);
  const anRef = useRef<HTMLCanvasElement>(null);
  const fgRef = useRef<HTMLCanvasElement>(null);
  const geom = useMemo(() => D.makeGeom(width, height, s), [width, height, s]);
  const stateRef = useRef<GraphState | null>(null);
  if (stateRef.current === null) {
    stateRef.current = {
      slotId, params, geom, onAudition, dpr: 0, fs: 0, hover: -1, drag: null, audition: null, curve: null, band: null,
      dirty: { bg: true, an: true, fg: true, curve: true }, analyzer: new Analyzer(), anVisible: analyzerVisible(params), lastFrame: 0,
    };
  }
  const S = stateRef.current;

  useLayoutEffect(() => {
    S.params = params;
    const vis = analyzerVisible(params);
    if (vis !== S.anVisible) {
      S.anVisible = vis;
      S.analyzer.reset();
    }
    S.dirty.curve = S.dirty.fg = S.dirty.an = true;
  }, [S, params]);

  useLayoutEffect(() => {
    S.geom = geom;
    S.band = null;
    S.dirty.bg = S.dirty.an = S.dirty.fg = S.dirty.curve = true;
  }, [S, geom]);

  useLayoutEffect(() => {
    S.slotId = slotId;
    S.onAudition = onAudition;
  }, [S, slotId, onAudition]);

  // spectrum data from the engine
  useEffect(() => {
    const cb = (data: Float32Array, sr: number) => {
      if (!analyzerVisible(S.params)) return;
      S.analyzer.push(data, sr, S.params.opts, Math.max(1, Math.round(S.geom.pw)), performance.now());
      S.dirty.an = true;
    };
    host.spectrumListeners.set(slotId, cb);
    return () => {
      if (host.spectrumListeners.get(slotId) === cb) host.spectrumListeners.delete(slotId);
    };
  }, [S, slotId]);

  // render loop
  useEffect(() => {
    let raf = 0;
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const dt = S.lastFrame ? Math.min(0.1, Math.max(0, (t - S.lastFrame) / 1000)) : 0;
      S.lastFrame = t;
      const dpr = window.devicePixelRatio || 1;
      if (dpr !== S.dpr) {
        S.dpr = dpr;
        S.dirty.bg = S.dirty.an = S.dirty.fg = true;
      }
      const fs = host.sampleRate;
      if (fs !== S.fs) {
        S.fs = fs;
        S.band = null;
        S.dirty.curve = S.dirty.fg = true;
      }
      const g = S.geom, p = S.params;
      if (S.dirty.bg && bgRef.current) {
        S.dirty.bg = false;
        const ctx = D.setupCanvas(bgRef.current, g.w, g.h, dpr);
        if (ctx) D.drawBackground(ctx, g);
      }
      if (S.anVisible && S.analyzer.hasData && dt > 0 && performance.now() - S.analyzer.lastTime > 200) {
        if (S.analyzer.decay(dt, p.opts)) S.dirty.an = true;
      }
      if (S.dirty.an && anRef.current) {
        S.dirty.an = false;
        const ctx = D.setupCanvas(anRef.current, g.w, g.h, dpr);
        if (ctx) drawAnalyzer(ctx, g, S.analyzer, p.opts, S.anVisible);
      }
      if (S.dirty.curve) {
        S.dirty.curve = false;
        S.curve = D.computeCurve(p, S.fs, designModeOf(p), p.lin, g, p.opts.phaseRotation);
      }
      if (S.dirty.fg && fgRef.current) {
        S.dirty.fg = false;
        drawForeground(S, fgRef.current);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [S]);

  // never leave a gesture or an audition behind
  useEffect(() => () => {
    const d = S.drag;
    S.drag = null;
    if (!d) return;
    if (d.kind === 'solo') {
      if (d.orig) setParamsNoHistory(S.slotId, d.orig);
    } else if (d.moved) store.endGesture();
  }, [S]);

  // mouse wheel over a token = bandwidth (wheel up = wider); native listener so it can preventDefault
  useEffect(() => {
    const el = fgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (S.drag) return;
      const r = el.getBoundingClientRect();
      const k = hitToken(S, e.clientX - r.left, e.clientY - r.top);
      if (k < 0) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 3 : 1 / 100;
      const notches = clamp(-e.deltaY * unit, -4, 4);
      if (!notches) return;
      const cur = currentParams(S.slotId)?.bands[k];
      if (!cur) return;
      const fine = e.ctrlKey || e.metaKey ? 0.1 : 1;
      const bw = clamp(cur.bw + notches * 0.025 * fine, 0, 1);
      if (bw === cur.bw) return;
      edit(S.slotId, 'Band bandwidth', (p) => { p.bands[k].bw = bw; });
      setHint(bandHint({ ...cur, bw }, k));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [S]);

  // ---------------------------------------------------------------- gestures
  const local = (e: { clientX: number; clientY: number }) => {
    const r = fgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const setHover = (k: number) => {
    if (S.hover !== k) {
      S.hover = k;
      S.dirty.fg = true;
    }
    const el = fgRef.current;
    const cursor = k >= 0 ? 'pointer' : 'crosshair';
    if (el && el.style.cursor !== cursor) el.style.cursor = cursor;
  };

  const hoverHint = (x: number, y: number, k: number) => {
    if (k >= 0) {
      setHint(bandHint(S.params.bands[k], k));
      return;
    }
    const g = S.geom;
    const hz = freqHz(clamp(D.normOfX(g, x), 0, 1));
    const f = formatFreq(hz);
    if (y >= g.py && y <= g.py + g.ph) setHint(`${f} / ${fmtDb(D.dbOfY(g, y))}`);
    else if (y < g.rowH) {
      // octave row: nearest note (FL naming, A5 = 440 Hz)
      const key = Math.round(69 + 12 * Math.log2(hz / 440));
      const c = Math.round(cents(hz, keyToHz(key)));
      setHint(`${f} (${keyName(key)} ${c < 0 ? '-' : '+'}${Math.abs(c)} cents)`);
    } else if (y < g.rulerTop) setHint(`${f} (${D.rangeAt(hz) ?? ''})`);
    else setHint(f);
  };

  const dragHint = (d: Drag) => {
    if (d.kind === 'main') setHint(`Main level: ${fmtDb(d.main)}`);
    else if (d.kind === 'solo') setHint(`Band ${d.band + 1} solo: BW ${fmtBw(d.bw)}`);
    else {
      const b = S.params.bands[d.band];
      setHint(bandHint({ ...b, freq: d.freq, level: typeHasLevel(b.type) ? d.level : b.level, bw: d.bw }, d.band));
    }
  };

  const applyAudition = (d: Drag) => {
    if (!d.view) return;
    const temp = auditionParams(d.view, d.band, d.bw);
    S.audition = { k: d.band, band: temp.bands[d.band] };
    setParamsNoHistory(S.slotId, temp);
    S.dirty.fg = true;
  };

  const startAudition = (d: Drag) => {
    const loc = findFx(store.project, S.slotId);
    if (!loc) return;
    d.orig = loc.fx.params as unknown as PEQ2Params;
    d.view = S.params;
    S.onAudition(d.view); // keep showing the real settings while the audition plays
    applyAudition(d);
  };

  const endAudition = (d: Drag) => {
    S.audition = null;
    if (d.orig) setParamsNoHistory(S.slotId, d.orig);
    if (d.moved && d.view?.opts.inheritBw) {
      const k = d.band, bw = d.bw;
      editOnce(S.slotId, 'Band bandwidth', (p) => { p.bands[k].bw = bw; });
    }
    S.onAudition(null);
  };

  const begin = (e: React.PointerEvent<HTMLCanvasElement>, kind: DragKind, k: number, x: number, y: number) => {
    const p = S.params;
    const b = k >= 0 ? p.bands[k] : null;
    const d: Drag = {
      kind, band: k, pointerId: e.pointerId, x0: x, y0: y, lx: x, ly: y, moved: false,
      freq: b?.freq ?? 0, level: b?.level ?? 0, bw: b?.bw ?? 0, main: p.mainLevel, orig: null, view: null,
    };
    S.drag = d;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (kind === 'solo') startAudition(d);
    dragHint(d);
    S.dirty.fg = true;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (S.drag) {
      if (e.pointerId !== S.drag.pointerId) return; // another pointer while dragging
      finish(e); // the release of the previous press was missed
    }
    const { x, y } = local(e);
    const k = hitToken(S, x, y);
    if (e.button === 1) {
      // middle-button drag on a token = bandwidth
      e.preventDefault();
      if (k >= 0) begin(e, 'bw', k, x, y);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    if (k < 0) {
      begin(e, 'main', -1, x, y); // empty area: main level
      return;
    }
    if (e.altKey) {
      resetBand(S.slotId, k);
      const b = currentParams(S.slotId)?.bands[k];
      if (b) setHint(bandHint(b, k));
      return;
    }
    if (e.shiftKey) begin(e, S.params.opts.soloOnShift ? 'solo' : 'bw', k, x, y);
    else begin(e, 'move', k, x, y);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = local(e);
    const d = S.drag;
    if (!d) {
      const k = hitToken(S, x, y);
      setHover(k);
      hoverHint(x, y, k);
      return;
    }
    if (e.pointerId !== d.pointerId) return;
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      finish(e); // button released outside the browser
      return;
    }
    let dx = x - d.lx, dy = y - d.ly;
    d.lx = x;
    d.ly = y;
    if (!d.moved) {
      if (Math.hypot(x - d.x0, y - d.y0) < THRESHOLD) return;
      d.moved = true;
      dx = x - d.x0;
      dy = y - d.y0;
      if (d.kind !== 'solo') store.beginGesture(LABELS[d.kind]);
    }
    const fine = e.ctrlKey || e.metaKey ? 0.1 : 1;
    const g = S.geom, k = d.band;
    switch (d.kind) {
      case 'move': {
        const lv = typeHasLevel(S.params.bands[k].type);
        d.freq = clamp(d.freq + (dx / g.pw) * fine, 0, 1);
        if (lv) d.level = clamp(d.level - (dy / D.pxPerDb(g)) * fine, -18, 18);
        const f = d.freq, l = round2(d.level);
        edit(S.slotId, LABELS.move, (p) => {
          p.bands[k].freq = f;
          if (lv) p.bands[k].level = l;
        });
        break;
      }
      case 'bw': {
        d.bw = clamp(d.bw + (dx / (BW_PX * g.s)) * fine, 0, 1);
        const v = d.bw;
        edit(S.slotId, LABELS.bw, (p) => { p.bands[k].bw = v; });
        break;
      }
      case 'main': {
        d.main = clamp(d.main - (dy / D.pxPerDb(g)) * fine, -18, 18);
        const v = round2(d.main);
        edit(S.slotId, LABELS.main, (p) => { p.mainLevel = v; });
        break;
      }
      case 'solo': {
        // vertical movement changes the audition bandwidth (up = wider)
        d.bw = clamp(d.bw - (dy / (BW_PX * g.s)) * fine, 0, 1);
        applyAudition(d);
        break;
      }
    }
    dragHint(d);
    S.dirty.fg = true;
  };

  const finish = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = S.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    S.drag = null;
    if (d.kind === 'solo') endAudition(d);
    else if (d.moved) store.endGesture();
    S.dirty.fg = true;
    const { x, y } = local(e);
    const k = hitToken(S, x, y);
    setHover(k);
    hoverHint(x, y, k);
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (S.drag) return; // Ctrl+click on macOS also fires contextmenu
    const { x, y } = local(e);
    const k = hitToken(S, x, y);
    if (k >= 0) openMenu(e.clientX, e.clientY, tokenMenu(S.slotId, S.params.bands[k], k));
  };

  const onPointerLeave = () => {
    if (S.drag) return;
    setHover(-1);
    clearHint();
  };

  return (
    <div className="peq2-graph" style={{ width, height }}>
      <canvas ref={bgRef} style={{ width, height }} />
      <canvas ref={anRef} style={{ width, height }} />
      <canvas
        ref={fgRef}
        className="peq2-fg"
        style={{ width, height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
        onPointerLeave={onPointerLeave}
        onContextMenu={onContextMenu}
        onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); /* no middle-click autoscroll */ }}
      />
    </div>
  );
});
