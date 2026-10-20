// ZGameEditor Visualizer video window and renderer. FL renders the layers
// with OpenGL into its own window: Attached (docked to the plugin window),
// Detached (free floating) or Wallpaper (behind FL's windows). Here the layers
// are composited with Canvas 2D, A (left-most) first, at the selected aspect
// ratio and frame-rate cap; "To buffer" layers redirect everything composited
// so far into a buffer that later layers can take as IMAGE SRC; the camera
// zoom / angle transform the final image. Audio comes from the plugin's
// analysis (64 bands, waveform, peak, RMS).

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  LAYER_LETTERS, ZGE_ASPECT_VALUES, ZGE_EFFECTS, ZGE_FPS, ZGE_LAYERS, ZGE_MAX, ZGE_WINDOW_MODES, zgeReadLayer, zgeState, type ZgeState,
} from '../../../../model/fx/plugins/zgameviz';
import { useFxMonitor } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { RENDERERS, type ZgeAudio, type ZgeFrame } from './effects';

// ------------------------------------------------------------------ shared live state

/** Per-slot data shared between the video window and the editor (measured frame rate, debug log). */
export interface ZgeLive { fps: number; frames: number; since: number; log: string[]; size: string; renderer: ZgeRenderer | null; fullscreen: (() => void) | null }
const lives = new Map<string, ZgeLive>();

export function zgeLive(slotId: string): ZgeLive {
  let l = lives.get(slotId);
  if (!l) { l = { fps: 0, frames: 0, since: 0, log: [], size: '', renderer: null, fullscreen: null }; lives.set(slotId, l); }
  return l;
}

export function zgeLog(slotId: string, line: string): void {
  const l = zgeLive(slotId);
  const d = new Date();
  const ts = [d.getHours(), d.getMinutes(), d.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':');
  l.log.push(`${ts}  ${line}`);
  if (l.log.length > 300) l.log.splice(0, l.log.length - 300);
}

// ------------------------------------------------------------------ renderer

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function fit(c: HTMLCanvasElement, w: number, h: number) { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } }
function resetCtx(g: CanvasRenderingContext2D) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
  g.shadowBlur = 0;
  g.shadowColor = 'rgba(0,0,0,0)';
}

/** Buffer size for FL's "Render to buffer quality" (100%, 50%, 25%, 128..1024 px on the long side). */
export function rqSize(rq: number, w: number, h: number): [number, number] {
  let k = 1;
  if (rq === 1) k = 0.5; else if (rq === 2) k = 0.25; else if (rq >= 3) k = [128, 256, 512, 1024][rq - 3] / Math.max(w, h);
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

/** Text lines for the text effects with FL's macros ([title]; [author] / [comment] have no source here). */
export function zgeText(lines: string[]): string[] {
  const title = store.project?.title ?? '';
  return lines.map((l) => l.replace(/\[title\]/gi, title).replace(/\[(author|comment|url)\]/gi, ''));
}

export class ZgeRenderer {
  readonly comp = makeCanvas(16, 9);
  private readonly tmpA = makeCanvas(16, 9);
  private readonly tmpB = makeCanvas(16, 9);
  private readonly layerC = makeCanvas(16, 9);
  private readonly buffers: (HTMLCanvasElement | null)[] = new Array(ZGE_LAYERS).fill(null);
  private readonly mem = Array.from({ length: ZGE_LAYERS }, () => ({ fx: -1, m: {} as Record<string, unknown> }));
  private readonly failed = new Set<string>();

  constructor(private readonly slotId: string) {}

  render(params: Record<string, unknown>, s: ZgeState, audio: ZgeAudio, text: string[], t: number, dt: number, w: number, h: number): void {
    for (const c of [this.comp, this.tmpA, this.tmpB, this.layerC]) fit(c, w, h);
    const g = this.comp.getContext('2d')!;
    resetCtx(g);
    g.clearRect(0, 0, w, h);
    const frame: ZgeFrame = { g, w, h, t, dt, u: h / 360, audio, text, tmp: () => this.tmpA, tmp2: () => this.tmpB };
    for (let n = 0; n < s.layerCount; n++) {
      const L = zgeReadLayer(params, n), ls = s.layers[n], slot = this.mem[n];
      if (slot.fx !== L.fx) {
        slot.fx = L.fx;
        slot.m = {};
        if (L.fx) zgeLog(this.slotId, `Layer ${LAYER_LETTERS[n]}: loaded effect ${ZGE_EFFECTS[L.fx].category}/${ZGE_EFFECTS[L.fx].name}`);
      }
      const eff = ZGE_EFFECTS[L.fx];
      if (L.fx > 0 && L.on >= ZGE_MAX / 2) {
        const run = RENDERERS[eff.id];
        const pv = L.vals.map((v) => Math.max(0, Math.min(1, v / ZGE_MAX)));
        const srcOk = ls.imgSrc >= 0 && ls.imgSrc < n && s.layers[ls.imgSrc].toBuffer;
        const src = srcOk ? this.buffers[ls.imgSrc] : null;
        try {
          if (src && (eff.category === 'Postprocess' || eff.category === 'Feedback')) {
            // process the buffer, then put the result over the composition
            const lg = this.layerC.getContext('2d')!;
            resetCtx(lg);
            lg.clearRect(0, 0, w, h);
            lg.drawImage(src, 0, 0, w, h);
            run({ ...frame, g: lg }, pv, slot.m);
            resetCtx(lg);
            g.drawImage(this.layerC, 0, 0);
          } else {
            g.save();
            run(frame, pv, slot.m);
            g.restore();
          }
        } catch (e) {
          const key = `${n}:${eff.id}`;
          if (!this.failed.has(key)) { this.failed.add(key); zgeLog(this.slotId, `Layer ${LAYER_LETTERS[n]}: ${eff.name} failed: ${String(e)}`); }
        }
        resetCtx(g);
      }
      if (ls.toBuffer) {
        const [bw, bh] = rqSize(ls.rq, w, h);
        const b = this.buffers[n] ?? (this.buffers[n] = makeCanvas(bw, bh));
        fit(b, bw, bh);
        const bg = b.getContext('2d')!;
        bg.globalCompositeOperation = 'copy';
        bg.drawImage(this.comp, 0, 0, bw, bh);
        bg.globalCompositeOperation = 'source-over';
        g.clearRect(0, 0, w, h); // the next layer starts from a clean slate
      }
    }
  }
}

// ------------------------------------------------------------------ audio

interface AudioIn { bands: Float32Array; wave: Float32Array; peak: number; rms: number }

function newAudio(): ZgeAudio {
  return { bands: new Float32Array(64), wave: new Float32Array(1024), peak: 0, rms: 0, bass: 0, mid: 0, high: 0 };
}

/** Smooth the analysis toward the latest values (fast attack, slower release). */
function smooth(a: ZgeAudio, tgt: AudioIn, dt: number) {
  const rel = Math.exp(-dt * 7), fall = Math.exp(-dt * 14);
  for (let i = 0; i < 64; i++) {
    const v = tgt.bands[i];
    a.bands[i] = v > a.bands[i] ? a.bands[i] + (v - a.bands[i]) * Math.min(1, dt * 40) : Math.max(v, a.bands[i] * rel);
    tgt.bands[i] *= fall;
  }
  a.wave.set(tgt.wave);
  a.peak = Math.max(tgt.peak, a.peak * rel);
  a.rms = Math.max(tgt.rms, a.rms * rel);
  tgt.peak *= fall; tgt.rms *= fall;
  let b = 0, m = 0, hi = 0;
  for (let i = 0; i < 64; i++) { if (i < 10) b += a.bands[i]; else if (i < 36) m += a.bands[i]; else hi += a.bands[i]; }
  a.bass = b / 10; a.mid = m / 26; a.high = hi / 28;
}

/** Gallery input (no audio there): a beat, a chord and a slow sweep. */
function demoFeed(tgt: AudioIn, t: number) {
  const beat = Math.pow(1 - ((t * 2) % 1), 3);
  for (let i = 0; i < 64; i++) {
    const f = i / 63;
    const v = 0.75 - f * 0.45 + 0.25 * Math.sin(t * 3 + i * 0.4) * (0.5 + f) + (i < 8 ? beat * 0.5 : 0) - Math.abs(f - (0.5 + 0.4 * Math.sin(t * 0.7))) * 0.3;
    tgt.bands[i] = Math.max(tgt.bands[i], Math.max(0, Math.min(1, v)));
  }
  for (let i = 0; i < 512; i++) {
    const x = i / 48000;
    const v = 0.5 * Math.sin(2 * Math.PI * 110 * x + t * 3) + 0.25 * Math.sin(2 * Math.PI * 330 * x + t) + 0.15 * beat * Math.sin(2 * Math.PI * 55 * x);
    tgt.wave[i] = v;
    tgt.wave[512 + i] = 0.8 * v + 0.2 * Math.sin(2 * Math.PI * 550 * x + t * 2);
  }
  tgt.peak = Math.max(tgt.peak, 0.55 + 0.4 * beat);
  tgt.rms = Math.max(tgt.rms, 0.25 + 0.2 * beat);
}

// ------------------------------------------------------------------ output

function drawChecker(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  g.fillStyle = '#9a9a9a';
  g.fillRect(x, y, w, h);
  g.fillStyle = '#6a6a6a';
  const c = 12;
  for (let yy = 0; yy < h; yy += c) for (let xx = ((yy / c) & 1) * c; xx < w; xx += 2 * c) g.fillRect(x + xx, y + yy, c, c);
}

/** Letterboxed (or, for the wallpaper, cropped) output rectangle in a cw x ch area. */
function outRect(s: ZgeState, cw: number, ch: number, cover: boolean) {
  const asp = ZGE_ASPECT_VALUES[s.aspect] ?? 16 / 9;
  let w = cw, h = cw / asp;
  if (cover ? h < ch : h > ch) { h = ch; w = ch * asp; }
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

// ------------------------------------------------------------------ window

const TITLE_H = 22;
type Rect = { x: number; y: number; w: number; h: number };

/**
 * The video output. variant "floating": the editor's docked (Attached) window,
 * or in the gallery any mode as a viewport overlay; "window": the canvas inside
 * the app Window of the Detached mode; "wallpaper": behind the workspace windows.
 */
export function ZgeVideo({ slotId, params, anchor, demo = false, variant = 'floating' }: {
  slotId: string; params: Record<string, unknown>; anchor?: React.RefObject<HTMLDivElement | null>; demo?: boolean; variant?: 'floating' | 'window' | 'wallpaper';
}) {
  const s = zgeState(params);
  const vRef = useRef(variant);
  vRef.current = variant;
  const pRef = useRef(params);
  pRef.current = params;
  const sRef = useRef(s);
  sRef.current = s;
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const rend = useRef<ZgeRenderer | null>(null);
  if (!rend.current) rend.current = new ZgeRenderer(slotId);
  const audio = useRef(newAudio());
  const target = useRef<AudioIn>({ bands: new Float32Array(64), wave: new Float32Array(1024), peak: 0, rms: 0 });
  const [drag, setDrag] = useState<Rect | null>(null);
  const dragRef = useRef<{ mode: string; sx: number; sy: number; r: number[] } | null>(null);
  const [fs, setFs] = useState(false);

  useFxMonitor(slotId, (d) => {
    const tg = target.current;
    if (d.bands instanceof Float32Array) for (let i = 0; i < 64; i++) tg.bands[i] = Math.max(tg.bands[i], d.bands[i] || 0);
    if (d.wave instanceof Float32Array && d.wave.length === 1024) tg.wave.set(d.wave);
    tg.peak = Math.max(tg.peak, Number(d.peak) || 0);
    tg.rms = Math.max(tg.rms, Number(d.rms) || 0);
  });

  useEffect(() => {
    const live = zgeLive(slotId);
    live.renderer = rend.current;
    zgeLog(slotId, 'Video window opened (Canvas 2D renderer)');
    let raf = 0, last = 0, lastRender = 0, t = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const c = canvas.current, b = box.current;
      if (!c || !b) return;
      const st = sRef.current;
      // attached: dock above the plugin window (below it when there is no room)
      if (vRef.current === 'floating' && st.windowMode === 0 && anchor?.current && !document.fullscreenElement) {
        const win = (anchor.current.closest('.win') as HTMLElement | null) ?? anchor.current;
        const r = win.getBoundingClientRect();
        const w = Math.round(r.width), h = Math.round(w / (ZGE_ASPECT_VALUES[st.aspect] ?? 16 / 9)) + TITLE_H;
        const y = r.top - h >= 0 ? r.top - h : r.bottom;
        b.style.left = `${Math.round(r.left)}px`; b.style.top = `${Math.round(y)}px`; b.style.width = `${w}px`; b.style.height = `${h}px`;
      }
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
      last = now;
      const cw = c.clientWidth, ch = c.clientHeight;
      if (cw < 2 || ch < 2) return;
      const maxFps = ZGE_FPS[st.fps] ?? 30;
      const due = now - lastRender >= 1000 / maxFps - 2;
      if (live.since === 0) live.since = now;
      if (now - live.since >= 500) { live.fps = (live.frames * 1000) / (now - live.since); live.frames = 0; live.since = now; }
      if (!due) return;
      const rdt = lastRender ? Math.min(0.1, (now - lastRender) / 1000) : dt;
      lastRender = now;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
      const cover = vRef.current === 'wallpaper' || (vRef.current === 'floating' && st.windowMode === 2);
      const o = outRect(st, cw, ch, cover);
      const rend0 = rend.current!;
      if (!st.freeze) {
        t += rdt;
        if (demo) demoFeed(target.current, t);
        smooth(audio.current, target.current, rdt);
        const q = st.antialias ? dpr : dpr * 0.5;
        let iw = Math.max(32, Math.round(o.w * q)), ih = Math.max(18, Math.round(o.h * q));
        const k = Math.min(1, 1920 / iw, 1080 / ih);
        iw = Math.round(iw * k); ih = Math.round(ih * k);
        rend0.render(pRef.current, st, audio.current, zgeText(st.text), t, rdt, iw, ih);
        live.frames++;
        const size = `${iw} x ${ih}`;
        if (size !== live.size) { live.size = size; zgeLog(slotId, `Output resolution ${size}`); }
      }
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#000';
      g.fillRect(0, 0, cw, ch);
      g.save();
      g.beginPath();
      g.rect(o.x, o.y, o.w, o.h);
      g.clip();
      if (st.gamut) drawChecker(g, o.x, o.y, o.w, o.h);
      const p = pRef.current;
      const zoom = Math.pow(2, 2 * (Number(p.zoom) || 0) / ZGE_MAX), ang = ((Number(p.angle) || 0) / ZGE_MAX) * Math.PI * 2;
      g.translate(o.x + o.w / 2, o.y + o.h / 2);
      g.rotate(ang);
      g.scale(zoom, zoom);
      g.imageSmoothingEnabled = st.antialias;
      g.drawImage(rend0.comp, -o.w / 2, -o.h / 2, o.w, o.h);
      g.restore();
    };
    raf = requestAnimationFrame(loop);
    live.fullscreen = () => { if (box.current && !document.fullscreenElement) void box.current.requestFullscreen?.().catch(() => {}); };
    const onFs = () => setFs(document.fullscreenElement === box.current && !!box.current);
    const onKey = () => { if (document.fullscreenElement && document.fullscreenElement === box.current) void document.exitFullscreen(); };
    document.addEventListener('fullscreenchange', onFs);
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('fullscreenchange', onFs);
      window.removeEventListener('keydown', onKey);
      live.renderer = null;
      live.fullscreen = null;
      live.fps = 0;
    };
  }, [slotId]);

  const set = (label: string, recipe: (p: Record<string, unknown>) => void) => A.editFx(slotId, label, recipe);
  const fullscreen = () => { if (box.current && !document.fullscreenElement) void box.current.requestFullscreen?.().catch(() => {}); };
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, zgeVideoMenu(slotId, sRef.current));
  };

  const bare = fs || variant !== 'floating' || s.windowMode === 2;
  const content = <canvas ref={canvas} style={{ position: 'absolute', left: 0, top: bare ? 0 : TITLE_H, width: '100%', height: bare ? '100%' : `calc(100% - ${TITLE_H}px)`, display: 'block', imageRendering: s.antialias ? 'auto' : 'pixelated' }} />;

  if (variant === 'window') {
    // Detached: inside the app Window (title bar, move, resize and close come from it)
    return (
      <div ref={box} style={{ position: 'absolute', inset: 0, background: '#000', cursor: 'default' }} onContextMenu={menu}
        onDoubleClick={fullscreen} onPointerEnter={() => setHint('ZGameEditor Visualizer: double-click for fullscreen, right-click for options')} onPointerLeave={() => clearHint()}>
        {content}
      </div>
    );
  }
  if (variant === 'wallpaper' || s.windowMode === 2) {
    // wallpaper: behind the windows of the workspace
    const host = document.getElementById('workspace');
    return createPortal(
      <div ref={box} style={{ position: host ? 'absolute' : 'fixed', inset: 0, zIndex: host ? 0 : -1, pointerEvents: 'none', background: '#000' }}>{content}</div>,
      host ?? document.body,
    );
  }
  if (!s.visible) return null;

  const rect: Rect = drag ?? (() => {
    const r = s.rect, vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.max(120, Math.min(vw, r[2])), h = Math.max(90, Math.min(vh, r[3]));
    return { x: Math.max(0, Math.min(vw - w, r[0])), y: Math.max(0, Math.min(vh - h, r[1])), w, h };
  })();
  const attached = s.windowMode === 0;
  const writeRect = (r: Rect) => A.setFxStateNoHistory(slotId, 'Move video window', (p) => { p.rect = [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]; });

  return createPortal(
    <div
      ref={box}
      style={{
        position: 'fixed', zIndex: 400, background: '#000', border: fs ? 'none' : '1px solid #1d2125', boxShadow: '0 6px 22px rgba(0,0,0,0.45)',
        boxSizing: 'border-box', touchAction: 'none', cursor: 'default',
        ...(attached ? {} : { left: rect.x, top: rect.y, width: rect.w, height: rect.h }),
      }}
      onContextMenu={menu}
      onPointerDown={(e) => {
        if (e.button !== 0 || attached || fs) return;
        const bx = e.currentTarget.getBoundingClientRect();
        const lx = e.clientX - bx.left, ly = e.clientY - bx.top, edge = 6;
        const m = `${ly < edge ? 'n' : ly > rect.h - edge ? 's' : ''}${lx < edge ? 'w' : lx > rect.w - edge ? 'e' : ''}` || (ly < TITLE_H ? 'move' : '');
        if (!m) return;
        dragRef.current = { mode: m, sx: e.clientX, sy: e.clientY, r: [rect.x, rect.y, rect.w, rect.h] };
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        e.stopPropagation();
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d) return;
        const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
        let [x, y, w, h] = d.r;
        if (d.mode === 'move') { x += dx; y += dy; } else {
          if (d.mode.includes('e')) w = Math.max(160, w + dx);
          if (d.mode.includes('s')) h = Math.max(110, h + dy);
          if (d.mode.includes('w')) { const nw = Math.max(160, w - dx); x += w - nw; w = nw; }
          if (d.mode.includes('n')) { const nh = Math.max(110, h - dy); y += h - nh; h = nh; }
        }
        setDrag({ x, y, w, h });
      }}
      onPointerUp={() => {
        const d = dragRef.current;
        dragRef.current = null;
        if (d && drag) writeRect(drag);
        setDrag(null);
      }}
      onDoubleClick={(e) => { const bx = e.currentTarget.getBoundingClientRect(); if (e.clientY - bx.top > TITLE_H) fullscreen(); }}
      onPointerEnter={() => setHint('ZGameEditor Visualizer: double-click for fullscreen, right-click for options')}
      onPointerLeave={() => clearHint()}
    >
      {!fs && (
        <div style={{ position: 'absolute', left: 0, top: 0, right: 0, height: TITLE_H, background: '#2f363c', borderBottom: '1px solid #1d2125', display: 'flex', alignItems: 'center', padding: '0 4px 0 7px', boxSizing: 'border-box', gap: 4 }}>
          <span style={{ flex: 1, font: '12px var(--font-ui)', color: '#c4ced5', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>ZGameEditor Visualizer</span>
          <TitleBtn hint="Fullscreen (press any key to restore)" onClick={fullscreen}>
            <svg width={10} height={10}><path d="M0.5 3.5 V0.5 H3.5 M6.5 0.5 H9.5 V3.5 M9.5 6.5 V9.5 H6.5 M3.5 9.5 H0.5 V6.5" stroke="#aeb9c1" fill="none" /></svg>
          </TitleBtn>
          <TitleBtn hint="Hide video window" onClick={() => set('Hide video window', (q) => { q.visible = false; })}>
            <svg width={10} height={10}><path d="M1 1 L9 9 M9 1 L1 9" stroke="#aeb9c1" strokeWidth={1.3} /></svg>
          </TitleBtn>
        </div>
      )}
      {content}
    </div>,
    document.body,
  );
}

/** The video window's menu (right-click on the picture, the Detached window's options menu). */
export function zgeVideoMenu(slotId: string, st: ZgeState): MenuItem[] {
  const set = (label: string, recipe: (p: Record<string, unknown>) => void) => A.editFx(slotId, label, recipe);
  return [
    { header: true, label: 'Window mode' },
    ...ZGE_WINDOW_MODES.map((m, i): MenuItem => ({ label: m, radio: true, checked: st.windowMode === i, onClick: () => set(`Window mode: ${m}`, (q) => { q.windowMode = i; q.visible = true; }) })),
    { separator: true },
    { label: 'Fullscreen', onClick: () => zgeLive(slotId).fullscreen?.(), disabled: st.windowMode === 2 },
    { label: 'Save still image', onClick: () => zgeSaveStill(slotId) },
    { label: 'Show background pattern in preview', checked: st.gamut, onClick: () => set('Show background pattern', (q) => { q.gamut = !st.gamut; }) },
    { label: 'Hold visualization', checked: st.freeze, onClick: () => set('Hold visualization', (q) => { q.freeze = !st.freeze; }) },
    { separator: true },
    { label: 'Hide video window', onClick: () => set('Hide video window', (q) => { q.visible = false; }) },
  ];
}

function TitleBtn({ children, onClick, hint }: { children: React.ReactNode; onClick: () => void; hint: string }) {
  return (
    <div
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onPointerEnter={() => setHint(hint)}
      style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 2, cursor: 'default' }}
    >{children}</div>
  );
}

/** "Save still image": the current output as a PNG download. */
export function zgeSaveStill(slotId: string): void {
  const r = zgeLive(slotId).renderer;
  if (!r) return;
  r.comp.toBlob((b) => {
    if (!b) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = 'ZGameEditor Visualizer.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
}
