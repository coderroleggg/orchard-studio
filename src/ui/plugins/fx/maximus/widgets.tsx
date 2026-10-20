// Maximus editor widgets drawn after FL's vector skin: the LOW / MID / HIGH /
// MASTER band tabs, the vertical switches (band mode, PEAK / RMS, slopes),
// caption badges, round icon buttons and the curve spinners.

import type { CSSProperties, ReactNode } from 'react';
import * as A from '../../../../store/actions';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { useControl } from '../../../widgets/control';
import { useFxEditor, useParam } from '../../kit';

type Box = { x: number; y: number; w: number; h: number };

export const C = {
  panelTop: '#64767d',
  panelBot: '#56666d',
  dark: '#27393c',
  strip: '#2f3c42',
  text: '#d6e0e3',
  textDim: '#9fb0b6',
  label: '#dfe7ea',
  badge: '#5e6e71',
  tabOff: '#849394',
  tabOffText: '#5b6b70',
  bandColors: ['#ff7269', '#fdb668', '#ddf05d', '#62ec5b'],
};

export const abs = (b: Box, extra?: CSSProperties): CSSProperties => ({ position: 'absolute', left: b.x, top: b.y, width: b.w, height: b.h, boxSizing: 'border-box', ...extra });

/** A view-state edit of the slot (no undo entry), like FL's band selector. */
export function setView(slotId: string, label: string, recipe: (p: Record<string, unknown>) => void): void {
  A.setFxStateNoHistory(slotId, label, (p) => recipe(p as Record<string, unknown>));
}

/** Caption text (FL's condensed uppercase labels). */
export function Cap({ x, y, w, h = 15, children, size = 10.5, color = C.label, align = 'center', style }: Omit<Box, 'h'> & { h?: number; children: ReactNode; size?: number; color?: string; align?: 'left' | 'center' | 'right'; style?: CSSProperties }) {
  return (
    <div style={abs({ x, y, w, h }, { fontSize: size, lineHeight: `${h}px`, color, textAlign: align, whiteSpace: 'nowrap', pointerEvents: 'none', fontStretch: 'condensed', letterSpacing: '-0.01em', ...style })}>{children}</div>
  );
}

/** Dark rounded badge with a caption (GAIN, SAT, ENV, FREQ). */
export function Badge({ x, y, w, h, children }: Box & { children: ReactNode }) {
  return (
    <div style={abs({ x, y, w, h }, { background: C.badge, borderRadius: 3, color: '#e3eaec', fontSize: 10.5, lineHeight: `${h}px`, textAlign: 'center', pointerEvents: 'none', fontStretch: 'condensed' })}>{children}</div>
  );
}

/** Small white triangle (FL's arrow glyphs that point from a knob to its curve spinner). */
export function Tri({ x, y, w, h, up }: Box & { up?: boolean }) {
  const cx = w / 2, cy = h / 2;
  return (
    <svg style={abs({ x, y, w, h }, { pointerEvents: 'none' })} viewBox={`0 0 ${w} ${h}`}>
      <path d={up ? `M${cx - 4} ${cy + 2} L${cx + 4} ${cy + 2} L${cx} ${cy - 3} Z` : `M${cx - 4} ${cy - 2} L${cx + 4} ${cy - 2} L${cx} ${cy + 3} Z`} fill="#eef3f4" />
    </svg>
  );
}

/** FL's LOW / MID / HIGH / MASTER target tabs: italic captions, coloured edge, the selected tab blends into the panel. */
export function BandTabs({ x, y, w, h, band, onPick }: Box & { band: number; onPick: (b: number) => void }) {
  const labels = ['LOW', 'MID', 'HIGH', 'MASTER'];
  const th = h / 4;
  return (
    <div style={abs({ x, y, w, h })} onPointerEnter={() => setHint('Target')} onPointerLeave={clearHint}>
      {labels.map((t, i) => {
        const on = i === band;
        return (
          <div key={t} style={abs({ x: 0, y: i * th, w, h: th - (i < 3 ? 1 : 0) }, {
            background: on ? 'transparent' : C.tabOff,
            borderBottom: i < 3 && !on ? '1px solid rgba(0,0,0,0.12)' : undefined,
            cursor: 'default',
          })}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onPick(i); } }}>
            <div style={abs({ x: 0, y: 0, w: 5, h: th }, { background: C.bandColors[i] })} />
            <div style={abs({ x: 6, y: 0, w: w - 14, h: th }, {
              fontStyle: 'italic', fontSize: 15, lineHeight: `${th}px`, textAlign: on ? 'left' : 'right',
              paddingLeft: on ? 6 : 0, color: on ? '#ffffff' : C.tabOffText, letterSpacing: '0.01em',
            })}>{t}</div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * FL's vertical switch: a dark rounded slot with a light round thumb and the
 * option captions beside it (band mode, PEAK / RMS, 12dB / 24dB).
 */
export function VSwitchView({ x, y, w, h, trackW, labels, labelX, value, onPick, hint, menu, labelSize = 10.5, labelColor = C.label, rowH }: Box & {
  trackW: number; labels: string[]; labelX: number; value: number; onPick: (i: number) => void; hint?: string; menu?: MenuItem[];
  labelSize?: number; labelColor?: string; rowH?: number;
}) {
  const n = labels.length;
  const th = trackW - 4;
  const tH = h;
  const stepY = n > 1 ? (tH - th - 4) / (n - 1) : 0;
  const rh = rowH ?? h / n;
  return (
    <div style={abs({ x, y, w, h })}
      onPointerEnter={() => hint && setHint(`${hint}: ${labels[value] ?? ''}`)} onPointerLeave={clearHint}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, [
          ...labels.map((o, i) => ({ label: o, checked: i === value, radio: true, onClick: () => onPick(i) } as MenuItem)),
          ...(menu?.length ? [{ separator: true } as MenuItem, ...menu] : []),
        ]);
      }}>
      <div style={abs({ x: 0, y: 0, w: trackW, h: tH }, { background: '#24292b', borderRadius: trackW / 2, boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.6)' })}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const f = (e.clientY - r.top) / r.height;
          onPick(Math.max(0, Math.min(n - 1, Math.floor(f * n))));
        }}>
        <div style={abs({ x: 2, y: 2 + value * stepY, w: th, h: th }, {
          borderRadius: '50%', background: 'radial-gradient(circle at 45% 40%, #e6ebec, #c3cbce 65%, #9aa5a9)',
          boxShadow: '0 1px 2px rgba(0,0,0,0.5)',
        })} />
      </div>
      {labels.map((t, i) => (
        <div key={i} style={abs({ x: labelX, y: i * rh, w: w - labelX, h: rh }, {
          fontSize: labelSize, lineHeight: `${rh}px`, color: labelColor, whiteSpace: 'nowrap', cursor: 'default', fontStretch: 'condensed',
        })} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onPick(i); } }}>{t}</div>
      ))}
    </div>
  );
}

/** A vertical switch bound to an option parameter. */
export function VSwitch({ k, labels, ...rest }: Box & { k: string; trackW: number; labels: string[]; labelX: number; labelSize?: number; rowH?: number }) {
  const p = useParam(k);
  return (
    <VSwitchView {...rest} labels={labels} value={Math.round(p.value - p.def.min)} hint={p.def.name}
      onPick={(i) => { p.control.onBegin?.(); p.set(p.def.min + i); p.control.onEnd?.(); }} />
  );
}

/** FL's round light-grey icon buttons (LIN, A/B compare). */
export function RoundBtn({ x, y, w, h, children, onClick, active, hint }: Box & { children: ReactNode; onClick: () => void; active?: boolean; hint?: string }) {
  return (
    <div style={abs({ x, y, w, h }, {
      borderRadius: '50%', background: active ? '#a9c4cf' : '#849394', color: active ? '#1d2a2e' : '#e4ebed',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, cursor: 'default',
      boxShadow: active ? '0 0 4px rgba(150,220,255,0.6)' : 'inset 0 1px 0 rgba(255,255,255,0.15)',
    })}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>{children}</div>
  );
}

/** FL's curve spinner (TVectorDigiWheel): a number in a dark inset box with up / down arrows. */
export function CurveSpin({ k, x, y, w, h }: Box & { k: string }) {
  const p = useParam(k);
  const hnd = useControl({ travel: 80, ...p.control }, 'vertical');
  const bump = (d: number) => {
    const v = Math.min(p.def.max, Math.max(p.def.min, p.value + d));
    p.control.onBegin?.(); p.set(v); p.control.onEnd?.();
  };
  return (
    <div style={abs({ x, y, w, h }, { background: '#2d373b', borderRadius: 3, boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.55)', display: 'flex' })}>
      <div {...hnd} style={{ flex: 1, color: '#eef3f4', fontSize: 15, lineHeight: `${h}px`, textAlign: 'center', cursor: 'ns-resize', touchAction: 'none' }}>{Math.round(p.value)}</div>
      <div style={{ width: 9, display: 'flex', flexDirection: 'column' }}>
        {[1, -1].map((d) => (
          <div key={d} style={{ flex: 1, position: 'relative', cursor: 'default' }} onPointerDown={(e) => { e.stopPropagation(); if (e.button === 0) bump(d); }}>
            <svg width={9} height={h / 2} style={{ position: 'absolute', left: 0, top: 0 }}>
              <path d={d > 0 ? `M1.5 ${h / 2 - 2} L4.5 ${h / 2 - 6} L7.5 ${h / 2 - 2} Z` : 'M1.5 2 L4.5 6 L7.5 2 Z'} fill="#9fb0b6" />
            </svg>
          </div>
        ))}
      </div>
    </div>
  );
}

/** FL's LED check box (SOLO). */
export function Led({ x, y, w, h, on, caption, onToggle, hint }: Box & { on: boolean; caption: string; onToggle: () => void; hint?: string }) {
  return (
    <div style={abs({ x, y, w, h }, { display: 'flex', alignItems: 'center', gap: 6, cursor: 'default' })}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint}>
      <div style={{
        width: 12, height: 12, borderRadius: '50%', flex: 'none',
        background: on ? 'radial-gradient(circle at 45% 40%, #d9ff9a, #8ad336 70%, #4f8f16)' : 'radial-gradient(circle at 45% 40%, #4b5458, #2a3134 70%)',
        boxShadow: on ? '0 0 5px rgba(170,255,90,0.8), inset 0 0 0 1px #2b3c18' : 'inset 0 0 0 1.5px #8a979b, 0 0 0 1px #1e2426',
      }} />
      <span style={{ color: '#d3dcdf', fontSize: 10.5, fontStretch: 'condensed' }}>{caption}</span>
    </div>
  );
}

/** Read the edited slot's view state with a fallback. */
export function useView<T>(key: string, fallback: T): T {
  const { params } = useFxEditor();
  const v = params[key];
  return (v === undefined ? fallback : v) as T;
}

/** FL's small horizontal slider (monitor SPEED): dark groove, white capsule thumb. */
export function SpeedSlider({ x, y, w, h, value, onChange }: Box & { value: number; onChange: (v: number) => void }) {
  const thumbW = 13;
  const hnd = useControl({ value, min: 0, max: 100, defaultValue: 50, step: 1, label: 'Monitor scrolling speed', travel: w - thumbW, format: (v) => `${Math.round(v)}%`, onChange }, 'horizontal');
  const t = Math.min(1, Math.max(0, value / 100));
  return (
    <div {...hnd} style={abs({ x, y, w, h }, { cursor: 'default', touchAction: 'none' })}>
      <div style={abs({ x: 0, y: h / 2 - 2, w, h: 4 }, { background: '#1f292c', borderRadius: 2, boxShadow: '0 1px 0 rgba(255,255,255,0.06)' })} />
      <div style={abs({ x: t * (w - thumbW), y: h / 2 - 3.5, w: thumbW, h: 7 }, {
        background: 'linear-gradient(180deg, #ffffff, #dfe9ec 55%, #b9c6cb)', borderRadius: 3, boxShadow: '0 1px 2px rgba(0,0,0,0.55)',
      })}>
        <div style={abs({ x: thumbW / 2 - 0.5, y: 1, w: 1, h: 5 }, { background: '#3a4448' })} />
      </div>
    </div>
  );
}
