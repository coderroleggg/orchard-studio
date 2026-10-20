// Controls of the Dance editor in FL's flat dark style (the form family of the
// Keyboard Controller: SynthPanel colour 3880753, rings for check boxes,
// vertical sliders with a metal cap and an orange value line, dark combos and
// buttons). Original drawings; positions are FL's form coordinates.

import { useId, type ReactNode } from 'react';
import { useControl, autoTargetOf, automationMenuItems, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { useNoScrollWheel } from '../../kit';

export const TXT = '#dfe5e8';

/** A caption in FL's condensed face (squeezed horizontally, never clipped). */
export function Txt({ x, y, w, h, align = 'left', size = 12.5, bold, color = TXT, children }: {
  x: number; y: number; w: number; h: number; align?: 'left' | 'center' | 'right'; size?: number; bold?: boolean; color?: string; children: ReactNode;
}) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, display: 'flex', alignItems: 'center', pointerEvents: 'none', fontSize: size, color, fontWeight: bold ? 600 : undefined,
      justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start',
    }}>
      <span style={{ whiteSpace: 'nowrap', transform: 'scaleX(0.84)', transformOrigin: align === 'right' ? 'right center' : align === 'center' ? 'center' : 'left center' }}>{children}</span>
    </div>
  );
}

/** FL's check box (TVectorCheckBox): a ring with a glowing orange disc when on, and its caption. */
export function Tick({ x, y, w, h, caption, on, onToggle, hint, menu }: {
  x: number; y: number; w: number; h: number; caption: string; on: boolean; onToggle: () => void; hint: string;
  /** Right-click menu items (automation of a parameter's check box). */
  menu?: (x: number, y: number) => MenuItem[];
}) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, display: 'flex', alignItems: 'center', gap: 6, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (menu) openMenu(e.clientX, e.clientY, menu(e.clientX, e.clientY)); }}
      onPointerEnter={() => setHint(`${hint}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
      <span style={{
        width: 12, height: 12, borderRadius: '50%', flex: 'none', boxSizing: 'border-box', marginLeft: 4, border: '1.5px solid #8a9094',
        background: on ? 'radial-gradient(circle at 45% 40%, #ffd8cc 0%, #ff6a4d 55%, #b03b24 100%)' : 'radial-gradient(circle at 45% 40%, #50565a 0%, #2d3234 70%, #121515 100%)',
        boxShadow: on ? '0 0 5px #ff6a4d' : 'inset 0 0 0 1px #121515',
      }} />
      <span style={{ fontSize: 12.5, color: TXT, whiteSpace: 'nowrap', display: 'inline-block', transform: 'scaleX(0.84)', transformOrigin: 'left center', marginLeft: -2 }}>{caption}</span>
    </div>
  );
}

/** The automation / remote control section of a control's right-click menu. */
export function autoMenu(control: ControlProps): (x: number, y: number) => MenuItem[] {
  return (x, y) => automationMenuItems(autoTargetOf(control), x, y);
}

/** FL's combo (TQuickCombo, Sober style): a dark rounded box with the current item and a drop arrow; click opens the list, the wheel steps. */
export function Combo({ x, y, w, h, items, value, onPick, hint, menu }: {
  x: number; y: number; w: number; h: number; items: string[]; value: number; onPick: (i: number) => void; hint: string;
  menu?: (x: number, y: number) => MenuItem[];
}) {
  const ref = useNoScrollWheel<HTMLDivElement>();
  const cur = Math.min(items.length - 1, Math.max(0, value));
  return (
    <div ref={ref} className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, background: '#262b2f', borderRadius: '6px 6px 3px 3px', display: 'flex', alignItems: 'center',
      paddingLeft: 10, boxSizing: 'border-box', cursor: 'default', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.25)',
    }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom, items.map((it, i): MenuItem => ({ label: it, checked: i === cur, radio: true, onClick: () => onPick(i) })), { minWidth: r.width });
      }}
      onWheel={(e) => {
        e.stopPropagation();
        const n = Math.min(items.length - 1, Math.max(0, cur + (e.deltaY < 0 ? -1 : 1)));
        if (n !== cur) onPick(n);
      }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (menu) openMenu(e.clientX, e.clientY, menu(e.clientX, e.clientY)); }}
      onPointerEnter={() => setHint(`${hint}: ${items[cur] ?? ''}`)} onPointerLeave={clearHint}>
      <span style={{ fontSize: 14.5, fontWeight: 700, color: '#eef2f4', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, transform: 'scaleX(0.9)', transformOrigin: 'left center' }}>{items[cur] ?? ''}</span>
      <svg width="12" height="8" viewBox="0 0 12 8" style={{ marginRight: 9, flex: 'none' }}><path d="M1 1.5 L6 6.5 L11 1.5 Z" fill="#9aa5ab" /></svg>
    </div>
  );
}

/** A flat dark icon button (TQuickBtn with a glyph). */
export function GlyphButton({ x, y, w, h, hint, onClick, children }: { x: number; y: number; w: number; h: number; hint: string; onClick: (e: React.PointerEvent) => void; children: ReactNode }) {
  return (
    <div className="fxk-abs dance-btn" style={{
      left: x, top: y, width: w, height: h, background: '#2d3236', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#c9d2d7', cursor: 'default', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.25)',
    }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      {children}
    </div>
  );
}

export function FolderGlyph() {
  return <svg width="18" height="18" viewBox="0 0 16 16"><path d="M2 4 H6.5 L8 5.5 H14 V13 H2 Z" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>;
}

/**
 * FL's vertical slider (TVectorSlider): a dark column with grid lines, a big
 * metal cap and an orange line from the bottom (or, for a bipolar control,
 * from the middle) to the cap.
 */
export function VSlider({ x, y, w, h, control, bipolar }: { x: number; y: number; w: number; h: number; control: ControlProps; bipolar?: boolean }) {
  const capH = 26, capW = 42;
  const travel = h - capH - 4;
  const hnd = useControl({ ...control, travel }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = Math.min(1, Math.max(0, (control.value - min) / (max - min || 1)));
  const cy = 2 + capH / 2 + (1 - t) * travel;
  const mid = 2 + capH / 2 + travel / 2;
  const id = 'dv' + useId().replace(/:/g, '');
  const cx = w / 2;
  const y0 = bipolar ? Math.min(cy, mid) : cy;
  const y1 = bipolar ? Math.max(cy, mid) : h - 2;
  return (
    <div ref={ref} className="fxk-abs" style={{ left: x, top: y, width: w, height: h, touchAction: 'none' }} {...hnd}>
      <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#d5d9de" />
            <stop offset="0.45" stopColor="#a4abb2" />
            <stop offset="0.5" stopColor="#7e868e" />
            <stop offset="1" stopColor="#c3c8ce" />
          </linearGradient>
        </defs>
        <rect x={cx - 21} y={0} width={42} height={h} fill="#2f353a" />
        {Array.from({ length: 6 }, (_, i) => <rect key={i} x={cx - 21} y={Math.round((i * h) / 6)} width={42} height={1} fill="#262b2f" />)}
        <rect x={cx - 0.5} y={0} width={1} height={h} fill="#1f2427" />
        {bipolar && <rect x={cx - 21} y={Math.round(mid)} width={42} height={1} fill="#4a5258" />}
        <rect x={cx - 1} y={y0} width={2} height={Math.max(0, y1 - y0)} fill="#ffa830" />
        <rect x={cx - capW / 2 + 1} y={cy - capH / 2 + 2} width={capW} height={capH} rx={4} fill="rgba(0,0,0,0.4)" />
        <rect x={cx - capW / 2} y={cy - capH / 2} width={capW} height={capH} rx={4} fill={`url(#${id})`} stroke="#222a2f" strokeWidth={1} />
        <rect x={cx - 10} y={cy - 2.5} width={20} height={2} rx={1} fill="#3a4147" />
        <rect x={cx - 10} y={cy + 1.5} width={20} height={1.5} rx={0.75} fill="#e9edf1" opacity={0.8} />
      </svg>
    </div>
  );
}
