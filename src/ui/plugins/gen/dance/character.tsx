// The Dance character's own window (FL's "OSD form"): a frameless transparent
// window that can be dragged anywhere on the screen. In the browser it is a
// fixed-position overlay mounted by the plugin's Persistent part for as long as
// the channel exists, editor open or not. "Solid" off makes it
// pointer-events: none, so it never blocks the app; "Keep in front" puts it
// above every app window (otherwise it is stacked with them and comes to the
// front when clicked); the right-click menu has FL's Visible and View settings.
// Holding the mouse on the character shows the sheet's Held row, and
// dragging moves it (the X / Y coordinate parameters follow).

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { currentTick, live } from '../../../../audio/live';
import { clearHint, setHint } from '../../../hint';
import { openMenu } from '../../../widgets/ContextMenu';
import { useFxEditor } from '../../kit';
import {
  danceBox, danceCoordsOf, danceHeldRow, danceMovesOf, danceState, danceWindowPos,
} from '../../../../model/gen/plugins/dance';
import { DanceAnimator } from './anim';
import { CharacterRenderer } from './render';
import { openSettings, setVisible } from './actions';
import { importSheet, useSheet } from './sheets';

/** Above every app window (Wave Candy's "keep in front" layer), below menus. */
const FRONT_Z = 9000;
/**
 * A move change noticed this soon after a dance cycle began still counts for that cycle: the engine's
 * note reaches the page about this much late (state reports are batched every 33 ms), FL's plugin gets the
 * note slightly ahead of the audible position.
 */
const GRACE_S = 0.12;
/** Backward steps of the page's song position estimate below this are noise (it is re-anchored by the engine's reports), not seeks. */
const JITTER_S = 0.1;

function useViewport(): { w: number; h: number } {
  const [v, setV] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setV({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return v;
}

/** The next position in the app's window stack (the character comes to the front like a window). */
function bumpZ(): number {
  let z = 0;
  A.setUi((u) => { u.zTop += 1; z = u.zTop; });
  return z;
}

/**
 * FL's character greets with "Hi !" when its window first appears (measured: a small label window
 * over the top of the character, fully opaque for about half a second, then fading out over
 * 0.7 s while it drifts up 7 px; not repeated when the window is hidden and shown again).
 */
function Greeting({ onDone }: { onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.animate !== 'function') { onDone(); return; }
    const a = el.animate(
      [{ opacity: 1, transform: 'translate(-50%, 0)' }, { opacity: 1, transform: 'translate(-50%, 0)', offset: 0.4 }, { opacity: 0, transform: 'translate(-50%, -7px)' }],
      { duration: 1200, easing: 'linear', fill: 'forwards' },
    );
    a.onfinish = onDone;
    return () => a.cancel();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={ref} style={{
      position: 'absolute', left: '50%', top: -5, transform: 'translate(-50%, 0)', pointerEvents: 'none', whiteSpace: 'nowrap',
      font: 'bold 14px/20px Arial, Helvetica, sans-serif', color: '#fff',
      textShadow: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 1px 1px rgba(0,0,0,0.6)',
    }}>Hi !</div>
  );
}

export function CharacterWindow() {
  const { slotId, params } = useFxEditor();
  const s = danceState(params);
  const { sheet } = useSheet(s);
  const box = danceBox(sheet.cellW, sheet.cellH, s.reflect);
  const vp = useViewport();
  const [drag, setDrag] = useState<{ left: number; top: number } | null>(null);
  const [held, setHeld] = useState(false);
  // the greeting is shown once, when the window first appears
  const [greet, setGreet] = useState(true);
  const heldRef = useRef(false);
  const dragRef = useRef<{ sx: number; sy: number; left: number; top: number } | null>(null);
  // stacking with the app's windows (Keep in front off): the character comes to the front when it appears and when clicked
  const [z, setZ] = useState(1);
  useEffect(() => { setZ(bumpZ()); }, []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cur = useRef({ s, sheet, box });
  cur.current = { s, sheet, box };

  // the animation: every frame asks the animator which cells the song position shows
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!s.visible || !canvas) return;
    const rend = new CharacterRenderer(canvas);
    const anim = new DanceAnimator();
    let raf = 0;
    let last = '';
    let sheetKey = '';
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const { s: st, sheet: sh, box: bx } = cur.current;
      if (sh.key !== sheetKey) { sheetKey = sh.key; anim.reset(); }
      const beat = currentTick() / (store.project.ppq || 96);
      const f = anim.frame(beat, live.playing, heldRef.current, {
        move: st.move, mirror: st.mirror, blend: st.blend, speed: st.speed, sync: st.sync,
        moves: danceMovesOf(sh.names).length, heldRow: danceHeldRow(sh.names),
      }, (GRACE_S * (store.project.tempo || 120)) / 60, (JITTER_S * (store.project.tempo || 120)) / 60);
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const key = `${f.row}.${f.col}.${+f.mirror}|${f.row2}.${f.col2}.${+f.mirror2}|${Math.round(f.t * 96)}|${sh.key}|${bx.w}x${bx.h}+${bx.refl}|${st.reflect}|${dpr}`;
      if (key === last) return;
      last = key;
      rend.draw(sh, f, bx, st.reflect, dpr);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [s.visible]);

  if (!s.visible) return null;
  const pos = drag ?? danceWindowPos(s.x, s.y, box, vp.w, vp.h);
  const total = box.h + box.refl;

  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    heldRef.current = false;
    setHeld(false);
    setDrag(null);
    store.endGesture();
  };

  const el = (
    <div
      style={{
        position: 'fixed', left: pos.left, top: pos.top, width: box.w, height: total, zIndex: s.front ? FRONT_Z : z,
        pointerEvents: s.solid ? 'auto' : 'none', cursor: held ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none',
      }}
      title=""
      onPointerEnter={() => setHint('Dance: drag the character to move it, right-click for options')}
      onPointerLeave={() => { if (!dragRef.current) clearHint(); }}
      onPointerDown={(e) => {
        setZ(bumpZ());
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        dragRef.current = { sx: e.clientX, sy: e.clientY, left: pos.left, top: pos.top };
        heldRef.current = true;
        setHeld(true);
        store.beginGesture('Move character');
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d) return;
        const c = danceCoordsOf(d.left + e.clientX - d.sx, d.top + e.clientY - d.sy, box);
        const cl = danceWindowPos(c.x, c.y, box, vp.w, vp.h);
        setDrag(cl);
        const at = danceCoordsOf(cl.left, cl.top, box);
        A.setFxParam(slotId, 'x', Math.max(-8192, Math.min(8192, at.x)), 'X coordinate');
        A.setFxParam(slotId, 'y', Math.max(-8192, Math.min(8192, at.y)), 'Y coordinate');
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, [
          { label: 'Visible', checked: true, onClick: () => setVisible(slotId, false) },
          { separator: true },
          { label: 'View settings', onClick: () => openSettings(slotId) },
        ]);
      }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        void importSheet(slotId, [...e.dataTransfer.files]);
      }}
    >
      <canvas ref={canvasRef} style={{ width: box.w, height: total, display: 'block', pointerEvents: 'none' }} />
      {greet && <Greeting onDone={() => setGreet(false)} />}
    </div>
  );
  return createPortal(el, document.body);
}
