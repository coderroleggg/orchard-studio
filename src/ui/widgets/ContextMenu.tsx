// Popup menus (context menus, menu bar drop-downs, combo lists).

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import './menu.css';

export interface MenuItem {
  label?: string;
  shortcut?: string;
  checked?: boolean;
  radio?: boolean;
  disabled?: boolean;
  separator?: boolean;
  header?: boolean;
  submenu?: MenuItem[];
  onClick?: () => void;
  hint?: string;
}

interface OpenMenu {
  id: number;
  x: number;
  y: number;
  items: MenuItem[];
  minWidth?: number;
  onClose?: () => void;
}

let current: OpenMenu | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openMenu(x: number, y: number, items: MenuItem[], opts: { minWidth?: number; onClose?: () => void } = {}): void {
  current?.onClose?.();
  current = { id: nextId++, x, y, items, minWidth: opts.minWidth, onClose: opts.onClose };
  emit();
}

export function closeMenu(): void {
  if (!current) return;
  const c = current;
  current = null;
  emit();
  c.onClose?.();
}

export function isMenuOpen(): boolean {
  return current !== null;
}

export function MenuHost() {
  const menu = useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => current,
  );
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest('.ctx-menu')) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // the key only closes the menu (not the window behind it, see App's key handler)
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeMenu);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', closeMenu);
    };
  }, [menu]);
  if (!menu) return null;
  return <MenuPanel key={menu.id} x={menu.x} y={menu.y} items={menu.items} minWidth={menu.minWidth} />;
}

function MenuPanel({ x, y, items, minWidth, level = 0 }: { x: number; y: number; items: MenuItem[]; minWidth?: number; level?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null);
  const timer = useRef<number>(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x, ny = y;
    if (nx + r.width > window.innerWidth - 2) nx = level > 0 ? x - r.width - (minWidth ?? 0) : window.innerWidth - r.width - 2;
    if (ny + r.height > window.innerHeight - 2) ny = Math.max(2, window.innerHeight - r.height - 2);
    if (nx < 2) nx = 2;
    setPos({ x: nx, y: ny });
  }, [x, y, level, minWidth]);

  const openSub = (i: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setSub({ index: i, x: r.right - 2, y: r.top - 3 });
  };

  return (
    <>
      <div
        ref={ref}
        className="ctx-menu"
        style={{ left: pos.x, top: pos.y, minWidth: level === 0 ? minWidth : undefined }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((it, i) => {
          if (it.separator) return <div key={i} className="ctx-sep" />;
          if (it.header) return <div key={i} className="ctx-header">{it.label}</div>;
          return (
            <div
              key={i}
              className={'ctx-item' + (it.disabled ? ' disabled' : '') + (sub?.index === i ? ' open' : '')}
              onPointerEnter={(e) => {
                window.clearTimeout(timer.current);
                const el = e.currentTarget;
                if (it.submenu) timer.current = window.setTimeout(() => openSub(i, el), 120);
                else timer.current = window.setTimeout(() => setSub(null), 150);
              }}
              onPointerUp={(e) => {
                if (e.button !== 0 && e.button !== 2) return;
                if (it.disabled) return;
                if (it.submenu) { openSub(i, e.currentTarget); return; }
                closeMenu();
                it.onClick?.();
              }}
            >
              <span className="ctx-check">{it.checked ? (it.radio ? '•' : '✓') : ''}</span>
              <span className="ctx-label">{it.label}</span>
              <span className="ctx-shortcut">{it.shortcut ?? ''}</span>
              <span className="ctx-arrow">{it.submenu ? '▸' : ''}</span>
            </div>
          );
        })}
      </div>
      {sub && items[sub.index]?.submenu && (
        <MenuPanel x={sub.x} y={sub.y} items={items[sub.index].submenu!} level={level + 1} minWidth={ref.current?.offsetWidth} />
      )}
    </>
  );
}
