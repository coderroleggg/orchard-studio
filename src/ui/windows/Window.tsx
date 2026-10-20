// Floating MDI window inside the workspace: title bar drag, edge resize,
// minimize / maximize / close, focus-to-front.

import { useRef, type ReactNode } from 'react';
import { useUi } from '../../store';
import { closeWindow, focusWindow, updateWindow } from '../../store/actions';
import { openMenu, type MenuItem } from '../widgets/ContextMenu';
import './window.css';

interface WindowProps {
  id: string;
  title: ReactNode;
  children: ReactNode;
  toolbar?: ReactNode; // extra content in the title bar (FL puts tools there)
  minW?: number;
  minH?: number;
  menu?: () => MenuItem[];
  resizable?: boolean;
  bodyClass?: string;
  onClose?: () => void;
}

export function Window({ id, title, children, toolbar, minW = 200, minH = 100, menu, resizable = true, bodyClass, onClose }: WindowProps) {
  const w = useUi((u) => u.windows[id]);
  const focused = useUi((u) => u.focused === id);
  const ref = useRef<HTMLDivElement>(null);
  if (!w || !w.open) return null;

  const startMove = (e: React.PointerEvent) => {
    if (e.button !== 0 || w.maximized) return;
    if ((e.target as HTMLElement).closest('.win-btn, .win-toolbar > *')) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = w.x, oy = w.y;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('moving');
    const parent = ref.current?.parentElement?.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      let nx = ox + ev.clientX - sx;
      let ny = oy + ev.clientY - sy;
      if (parent) {
        nx = Math.min(Math.max(nx, -w.w + 60), parent.width - 60);
        ny = Math.min(Math.max(ny, 0), parent.height - 20);
      }
      updateWindow(id, { x: nx, y: ny });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      document.body.classList.remove('moving');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const startResize = (edge: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const o = { x: w.x, y: w.y, w: w.w, h: w.h };
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      const p = { ...o };
      if (edge.includes('e')) p.w = Math.max(minW, o.w + dx);
      if (edge.includes('s')) p.h = Math.max(minH, o.h + dy);
      if (edge.includes('w')) { p.w = Math.max(minW, o.w - dx); p.x = o.x + (o.w - p.w); }
      if (edge.includes('n')) { p.h = Math.max(minH, o.h - dy); p.y = o.y + (o.h - p.h); }
      updateWindow(id, p);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const style: React.CSSProperties = w.maximized
    ? { left: 0, top: 0, right: 0, bottom: 0, zIndex: w.z }
    : { left: w.x, top: w.y, width: w.w, height: w.minimized ? undefined : w.h, zIndex: w.z };

  const close = () => { onClose?.(); closeWindow(id); };

  return (
    <div
      ref={ref}
      className={'win' + (focused ? ' focused' : '') + (w.maximized ? ' maximized' : '') + (w.minimized ? ' minimized' : '')}
      style={style}
      onPointerDownCapture={() => focusWindow(id)}
    >
      <div className="win-title" onPointerDown={startMove} onDoubleClick={() => updateWindow(id, { maximized: !w.maximized })}>
        <button
          className="win-btn win-menu"
          title="Options"
          onPointerDown={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const base: MenuItem[] = menu ? menu() : [];
            openMenu(r.left, r.bottom + 1, [
              ...base,
              ...(base.length ? [{ separator: true } as MenuItem] : []),
              { label: w.maximized ? 'Restore' : 'Maximize', onClick: () => updateWindow(id, { maximized: !w.maximized }) },
              { label: 'Close', onClick: close },
            ]);
          }}
        >
          <svg width="9" height="9" viewBox="0 0 9 9"><path d="M1 2.5 L4.5 6.5 L8 2.5 Z" fill="currentColor" /></svg>
        </button>
        <div className="win-caption">{title}</div>
        {toolbar && <div className="win-toolbar">{toolbar}</div>}
        <div className="win-buttons">
          <button className="win-btn" title="Minimize" onClick={() => updateWindow(id, { minimized: !w.minimized })}>
            <svg width="9" height="9" viewBox="0 0 9 9"><rect x="1" y="6" width="7" height="1.6" fill="currentColor" /></svg>
          </button>
          <button className="win-btn" title={w.maximized ? 'Restore' : 'Maximize'} onClick={() => updateWindow(id, { maximized: !w.maximized })}>
            <svg width="9" height="9" viewBox="0 0 9 9"><rect x="1" y="1" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
          </button>
          <button className="win-btn win-close" title="Close" onClick={close}>
            <svg width="9" height="9" viewBox="0 0 9 9"><path d="M1.5 1.5 L7.5 7.5 M7.5 1.5 L1.5 7.5" stroke="currentColor" strokeWidth="1.6" /></svg>
          </button>
        </div>
      </div>
      {!w.minimized && <div className={'win-body' + (bodyClass ? ' ' + bodyClass : '')}>{children}</div>}
      {resizable && !w.maximized && !w.minimized && (
        <>
          <div className="rz rz-e" onPointerDown={startResize('e')} />
          <div className="rz rz-s" onPointerDown={startResize('s')} />
          <div className="rz rz-w" onPointerDown={startResize('w')} />
          <div className="rz rz-n" onPointerDown={startResize('n')} />
          <div className="rz rz-se" onPointerDown={startResize('se')} />
          <div className="rz rz-sw" onPointerDown={startResize('sw')} />
          <div className="rz rz-ne" onPointerDown={startResize('ne')} />
          <div className="rz rz-nw" onPointerDown={startResize('nw')} />
        </>
      )}
    </div>
  );
}
