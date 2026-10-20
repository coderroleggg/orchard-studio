// Hardcore editor (FL: Hardcore Guitar Effects, 767 x 485). Top bar: preset
// selector with arrows, INPUT / OUTPUT knobs with level meters, the 8-band
// graphic EQ (power button + draggable bands) and the CABINET model selector.
// Board: five pedal slots (chrome stomp-boxes with knobs, LED and footswitch),
// each with a combo box below (pedal type, Move left / Move right).
// Positions are FL's skin coordinates measured on the manual's 100% screenshots.

import { useRef, useState, type CSSProperties } from 'react';
import * as A from '../../../../store/actions';
import { setHint, clearHint } from '../../../hint';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { useControl } from '../../../widgets/control';
import { AnimatedDisplay, FxPanel, useFxEditor, useFxMonitor, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { defaultFxParams } from '../../../../model/fx/registry';
import {
  HC_CABINETS, HC_EQ_BANDS, HC_KNOBS, HC_RAW, HC_SLOTS, HC_TYPES, def as hcDef, hcEqKey, hcKnobKey, hcKnobPhys, hcOnKey, hcPct, hcSwapSlots, hcTypeKey,
} from '../../../../model/fx/plugins/hardcore';
import { KNOB_POS, LED_POS, LOOKS, type PedalLook } from './looks';
import { brushed, grain, mottle } from './textures';
import './hardcore.css';

const W = 767, H = 485;
// slots: casing, face, footswitch, jacks and combo box relative to the slot's left edge
const SLOT_X0 = 21, SLOT_DX = 147;
const CASE_Y = 148, CASE_W = 137, CASE_H = 284;
const FACE_DX = 10, FACE_Y = 180, FACE_W = 117, FACE_H = 138;
const FOOT_DX = 5, FOOT_Y = 334, FOOT_W = 127, FOOT_H = 77;
const JACKS = [22.5, 93.5], JACK_Y = 77, JACK_H = 78;
const COMBO_DX = 4, COMBO_Y = 455, COMBO_W = 127, COMBO_H = 16;

const abs = (x: number, y: number, w: number, h: number, extra?: CSSProperties): CSSProperties => ({ left: x, top: y, width: w, height: h, ...extra });
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const PRESETS = hcDef.presets ?? [];

/** Load a factory preset the way the plugin window does (fresh state + preset values + name). */
function loadPreset(slotId: string, i: number): void {
  const pr = PRESETS[(i + PRESETS.length) % PRESETS.length];
  if (!pr) return;
  const fresh = { ...defaultFxParams('hardcore'), ...structuredClone(pr.params), __preset: pr.name };
  A.editFx(slotId, `Preset: ${pr.name}`, (p) => { for (const k of Object.keys(p)) delete p[k]; Object.assign(p, fresh); });
}

// ------------------------------------------------------------------ top bar

/** INPUT / OUTPUT knob: olive disc, yellow ring with four ticks and a pointer. */
function LcdKnob({ k, cx, cy }: { k: string; cx: number; cy: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 160, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  const ang = ((-135 + 270 * t) * Math.PI) / 180;
  const S = 30, c = S / 2;
  return (
    <div className="hc-abs hc-knob" style={abs(cx - c, cy - c, S, S)} {...h}>
      <svg width={S} height={S} style={{ display: 'block' }}>
        <circle cx={c} cy={c} r={13.5} fill="#6d6a10" />
        <circle cx={c} cy={c} r={11.5} fill="#5e5b0e" />
        {[0, 90, 180, 270].map((a) => {
          const r = (a * Math.PI) / 180;
          return <line key={a} x1={c + Math.sin(r) * 9} y1={c - Math.cos(r) * 9} x2={c + Math.sin(r) * 13} y2={c - Math.cos(r) * 13} stroke="#ffff00" strokeWidth={1.4} />;
        })}
        <circle cx={c} cy={c} r={9.3} fill="#37330c" stroke="#ffff00" strokeWidth={1.3} />
        <line x1={c} y1={c} x2={c + Math.sin(ang) * 8.6} y2={c - Math.cos(ang) * 8.6} stroke="#ffff00" strokeWidth={1.5} />
      </svg>
    </div>
  );
}

/** Level meter in the LCD box next to a knob (segmented, FL-yellow). */
function LevelMeter({ which, x, y, w, h }: { which: 'in' | 'out'; x: number; y: number; w: number; h: number }) {
  const { slotId } = useFxEditor();
  const st = useRef({ v: 0, hold: 0, ht: 0, last: 0 });
  useFxMonitor(slotId, (d) => { st.current.v = Math.max(st.current.v, Number(d[which]) || 0); });
  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h} frame={(g, W2, H2, t) => {
      const s = st.current;
      const dt = s.last ? Math.min(0.1, (t - s.last) / 1000) : 0;
      s.last = t;
      g.clearRect(0, 0, W2, H2);
      // LCD dot row (unlit segments)
      const seg = 3, n = Math.floor((W2 - 4) / seg);
      const db = s.v > 1e-5 ? 20 * Math.log10(s.v) : -100;
      const f = Math.max(0, Math.min(1, (db + 48) / 54)); // -48 .. +6 dB
      if (s.v >= s.hold) { s.hold = s.v; s.ht = t; } else if (t - s.ht > 1200) s.hold *= Math.pow(10, (-24 * dt) / 20);
      const hdb = s.hold > 1e-5 ? 20 * Math.log10(s.hold) : -100;
      const hf = Math.max(0, Math.min(1, (hdb + 48) / 54));
      for (let i = 0; i < n; i++) {
        const on = (i + 0.5) / n <= f;
        const clip = (i + 0.5) / n > 48 / 54;
        g.fillStyle = on ? (clip ? '#ff8a10' : '#f4ee10') : 'rgba(10, 8, 0, 0.55)';
        g.fillRect(2 + i * seg, on ? 3 : Math.round(H2 / 2) - 1, seg - 1, on ? H2 - 6 : 2);
      }
      if (hf > 0.01) { g.fillStyle = '#fffb80'; g.fillRect(2 + Math.min(n - 1, Math.floor(hf * n)) * seg, 3, seg - 1, H2 - 6); }
      s.v *= Math.pow(10, (-30 * dt) / 20);
    }} />
  );
}

/** One graphic EQ band: drag vertically; the lit bar runs from the centre to the value. */
function EqBand({ band, x, y, w, h, on }: { band: number; x: number; y: number; w: number; h: number; on: boolean }) {
  const p = useParam(hcEqKey(band));
  const hnd = useControl({ travel: 120, ...p.control }, 'vertical');
  const t = Math.min(1, Math.max(0, p.value / HC_RAW));
  const inner = h - 4;
  const yc = 2 + inner * 0.5, yv = 2 + inner * (1 - t);
  let top = Math.min(yc, yv), bot = Math.max(yc, yv);
  if (bot - top < 3) { const m = (top + bot) / 2; top = m - 1.5; bot = m + 1.5; }
  const lines: number[] = [];
  for (let yy = Math.floor(top); yy < bot; yy += 2) lines.push(yy);
  return (
    <div className="hc-abs hc-eqcol" style={abs(x, y, w, h)} {...hnd}>
      {lines.map((yy) => (
        <div key={yy} style={{ position: 'absolute', left: 2, right: 2, top: yy - 1, height: 1.4, background: on ? '#ffff06' : '#c8c20c', boxShadow: on ? '0 0 2px rgba(255,255,0,0.5)' : undefined }} />
      ))}
    </div>
  );
}

function TopBar() {
  const { slotId, params } = useFxEditor();
  const eqOn = num(params.eqOn, 0) > 0;
  const cab = Math.round(num(params.cab, 0));
  const preset = typeof params.__preset === 'string' ? params.__preset : '';
  const cur = PRESETS.findIndex((p) => p.name === preset);
  const step = (dir: number) => loadPreset(slotId, cur < 0 ? (dir > 0 ? 0 : PRESETS.length - 1) : cur + dir);
  const metal = brushed('hc-top', 765, 65, 214, 12, 6, 60, 11);
  return (
    <>
      <div className="hc-abs hc-top" style={metal ? { backgroundImage: `url(${metal})` } : undefined} />
      {/* preset / input / output */}
      <div className="hc-abs hc-lcd" style={abs(15, 10, 338, 49)} />
      <div className="hc-abs hc-arrow l" style={abs(25, 18, 8, 35)}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); step(-1); } }}
        onPointerEnter={() => setHint('Previous preset')} onPointerLeave={clearHint} />
      <div className="hc-abs hc-arrow r" style={abs(155, 18, 8, 35)}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); step(1); } }}
        onPointerEnter={() => setHint('Next preset')} onPointerLeave={clearHint} />
      <div className="hc-txt arial" style={{ left: 38, top: 18, width: 112, fontSize: 19.5 }}>PRESET</div>
      <div className="hc-txt dim hc-preset-name" style={{ left: 36, top: 40, width: 116, height: 12, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis' }}
        onPointerEnter={() => setHint(`Preset: ${preset || 'none'} (click for the list)`)} onPointerLeave={clearHint}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          openMenu(e.clientX, e.clientY, PRESETS.map((p, i) => ({ label: p.name, radio: true, checked: i === cur, onClick: () => loadPreset(slotId, i) })), { minWidth: 180 });
        }}>{preset || '<noname>'}</div>
      <div className="hc-abs hc-sep" style={abs(165, 16, 2, 38)} />
      <LcdKnob k="in" cx={183.5} cy={33.5} />
      <div className="hc-txt arial" style={{ left: 202, top: 22, fontSize: 8, letterSpacing: '0.06em' }}>INPUT</div>
      <div className="hc-abs hc-meterbox" style={abs(201, 33, 50, 14)} />
      <LevelMeter which="in" x={202} y={34} w={48} h={12} />
      <div className="hc-abs hc-sep" style={abs(255, 16, 2, 38)} />
      <LcdKnob k="out" cx={272.5} cy={33.5} />
      <div className="hc-txt arial" style={{ left: 291, top: 22, fontSize: 8, letterSpacing: '0.06em' }}>OUTPUT</div>
      <div className="hc-abs hc-meterbox" style={abs(290, 33, 50, 14)} />
      <LevelMeter which="out" x={291} y={34} w={48} h={12} />

      {/* EQ / cabinet */}
      <div className="hc-abs hc-lcd" style={abs(362, 10, 261, 49)} />
      <div className="hc-abs hc-groove" style={abs(627, 9, 3, 51)} />
      <div className="hc-txt" style={{ left: 377, top: 20, width: 22, fontSize: 10.5, fontWeight: 700 }}>EQ</div>
      <div className="hc-abs hc-power" style={abs(380, 37, 16, 16)}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); A.editFx(slotId, eqOn ? 'EQ off' : 'EQ on', (d) => { d.eqOn = eqOn ? 0 : HC_RAW; }); } }}
        onPointerEnter={() => setHint(`EQ: ${eqOn ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
        <svg width={16} height={16} style={{ display: 'block' }}>
          <circle cx={8} cy={8} r={7.5} fill={eqOn ? '#6b6610' : '#4a4612'} />
          <path d="M5.2 4.6 A4.3 4.3 0 1 0 10.8 4.6" fill="none" stroke={eqOn ? '#ffff06' : '#7f7a14'} strokeWidth={1.8} strokeLinecap="round" />
          <line x1={8} y1={2.6} x2={8} y2={7.6} stroke={eqOn ? '#ffff06' : '#7f7a14'} strokeWidth={1.8} strokeLinecap="round" />
        </svg>
      </div>
      {HC_EQ_BANDS.map((b, i) => (
        <div key={b} className="hc-txt" style={{ left: 410 + 16 * i - 3, top: 15.5, width: 20, fontSize: 7.5, letterSpacing: '-0.02em' }}>{b}</div>
      ))}
      {HC_EQ_BANDS.map((b, i) => <EqBand key={b} band={i} x={410 + 16 * i} y={25} w={14} h={29} on={eqOn} />)}
      <div className="hc-abs hc-cab" style={abs(541, 16, 72, 38)}
        onPointerEnter={() => setHint(`Cabinet: ${HC_CABINETS[cab] ?? 'Off'} (click to select)`)} onPointerLeave={clearHint}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          openMenu(e.clientX, e.clientY, HC_CABINETS.map((n, i) => ({ label: n, radio: true, checked: i === cab, onClick: () => A.editFx(slotId, `Cabinet: ${n}`, (d) => { d.cab = i; }) })));
        }}
        onWheel={(e) => {
          e.stopPropagation();
          const next = Math.max(0, Math.min(HC_CABINETS.length - 1, cab + (e.deltaY < 0 ? -1 : 1)));
          if (next !== cab) A.editFx(slotId, `Cabinet: ${HC_CABINETS[next]}`, (d) => { d.cab = next; }, 'hc-cab');
        }}>
        <div className="hc-txt" style={{ left: 0, top: 5, width: 69, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.12em' }}>CABINET</div>
        <div className="hc-txt dim" style={{ left: 0, top: 21, width: 69, fontSize: 12 }}>{HC_CABINETS[cab] ?? 'Off'}</div>
      </div>
      <div className="hc-abs hc-emblem" style={{ left: 648, top: 23 }}>HARDCORE</div>
    </>
  );
}

// ------------------------------------------------------------------ pedals

/** Stomp-box knob: soft shadow, black skirt, coloured cap and black pointer, three dots. */
function PedalKnob({ slot, k, type, cx, cy, look }: { slot: number; k: number; type: number; cx: number; cy: number; look: PedalLook }) {
  const caption = HC_KNOBS[type][k];
  const p = useParam(hcKnobKey(slot, k), {
    label: `${HC_TYPES[type]} - ${caption}`,
    format: (v) => { const phys = hcKnobPhys(type, k, v / HC_RAW); return hcPct(v).trim() + (phys ? ` (${phys})` : ''); },
  });
  const h = useControl({ travel: 160, ...p.control }, 'vertical');
  const ang = ((-135 + 270 * Math.min(1, Math.max(0, p.value / HC_RAW))) * Math.PI) / 180;
  const S = 40, c = S / 2;
  const id = `hck${slot}${k}`;
  return (
    <>
      {[[0, -16.5], [-16, 16], [16, 16]].map(([dx, dy], i) => (
        <div key={i} className="hc-abs" style={{ left: cx + dx - 1, top: cy + dy - 1, width: 2, height: 2, background: look.dot, pointerEvents: 'none' }} />
      ))}
      <div className="hc-abs hc-knob" style={abs(cx - c, cy - c, S, S)} {...h}>
        <svg width={S} height={S} style={{ display: 'block', overflow: 'visible' }}>
          <defs>
            <radialGradient id={`${id}s`} cx="50%" cy="54%" r="50%">
              <stop offset="0.62" stopColor="rgba(0,0,0,0.6)" />
              <stop offset="1" stopColor="rgba(0,0,0,0)" />
            </radialGradient>
            <radialGradient id={`${id}c`} cx="42%" cy="36%" r="70%">
              <stop offset="0" stopColor="#ffffff" stopOpacity={0.45} />
              <stop offset="0.45" stopColor="#ffffff" stopOpacity={0} />
              <stop offset="1" stopColor="#000000" stopOpacity={0.16} />
            </radialGradient>
          </defs>
          <circle cx={c} cy={c + 1} r={19.5} fill={`url(#${id}s)`} />
          <circle cx={c} cy={c} r={14.6} fill="#121212" />
          <circle cx={c} cy={c} r={11.6} fill={look.knob} />
          <circle cx={c} cy={c} r={11.6} fill={`url(#${id}c)`} />
          <line x1={c + Math.sin(ang) * 4.5} y1={c - Math.cos(ang) * 4.5} x2={c + Math.sin(ang) * 10.8} y2={c - Math.cos(ang) * 10.8} stroke="#0a0a0a" strokeWidth={2.6} />
        </svg>
      </div>
      <div className="hc-cap" style={{ left: cx - 30, top: cy + 28 - look.capSize * 0.5, width: 60, color: look.label, fontSize: look.capSize, fontWeight: look.capWeight }}>{caption}</div>
    </>
  );
}

function Jack({ x }: { x: number }) {
  return (
    <div className="hc-abs hc-jack" style={abs(x, JACK_Y, 15, JACK_H)}>
      <div className="hc-jack-barrel" />
      {[13, 20, 27].map((y) => <div key={y} className="hc-jack-ring" style={{ top: y }} />)}
      <div className="hc-jack-nut" />
    </div>
  );
}

function Pedal({ slot, type }: { slot: number; type: number }) {
  const look = LOOKS[type];
  const on = useParam(hcOnKey(slot));
  const [down, setDown] = useState(false);
  const x = SLOT_X0 + SLOT_DX * slot;
  const isOn = on.value > 0;
  const chrome = brushed('hc-case2', CASE_W, CASE_H, 150, 34, 16, 26, 5);
  const tex = mottle(`face${type}`, FACE_W, FACE_H, 100 + type, look.mottle);
  const rubber = grain('hc-rubber', FOOT_W, FOOT_H, 128, 60, 9);
  const layout = String(look.layout);
  const [lx, ly] = LED_POS[layout];
  const toggle = () => { on.control.onBegin?.(); on.set(isOn ? 0 : HC_RAW); on.control.onEnd?.(); };
  return (
    <>
      {JACKS.map((j) => <Jack key={j} x={x + j} />)}
      <div className="hc-abs hc-case-shadow" style={abs(x, CASE_Y, CASE_W, CASE_H)} />
      <div className="hc-abs hc-case" style={abs(x, CASE_Y, CASE_W, CASE_H, chrome ? { backgroundImage: `url(${chrome})` } : undefined)}>
        <div className="hc-case-shade" />
        <div className="hc-abs hc-case-top" style={abs(0, 0, CASE_W, 12)} />
        <div className="hc-abs hc-case-bevel" style={abs(0, 12, CASE_W, 15)} />
        <div className="hc-abs hc-well" style={abs(FACE_DX - 3, 26, FACE_W + 6, FACE_H + 8)} />
        <div className="hc-abs hc-ridge" style={abs(0, 172, CASE_W, 14)} />
        <div className="hc-abs hc-case-base" style={abs(0, 263, CASE_W, 21)} />
        <div className="hc-abs hc-rim-l" style={abs(0, 0, 9, CASE_H)} />
        <div className="hc-abs hc-rim-r" style={abs(CASE_W - 9, 0, 9, CASE_H)} />
      </div>
      <div className="hc-abs hc-face" style={abs(x + FACE_DX, FACE_Y, FACE_W, FACE_H, { background: look.face })}>
        {tex && <div className="hc-face-tex" style={{ backgroundImage: `url(${tex})` }} />}
        <svg className="hc-abs" width={FACE_W} height={FACE_H} style={{ left: 0, top: 0, pointerEvents: 'none' }}>
          <text x={FACE_W / 2} y={131} textAnchor="middle" textLength={look.titleWidth} lengthAdjust="spacingAndGlyphs"
            fontFamily={look.titleFont} fontWeight={look.titleWeight} fontSize={look.titleSize} fill={look.titleColor}
            stroke={look.titleStroke} strokeWidth={look.titleStroke ? 0.7 : 0} paintOrder="stroke">{look.title}</text>
        </svg>
      </div>
      <div className="hc-abs hc-led" style={abs(x + FACE_DX + lx - 3.5, FACE_Y + ly - 3.5, 7, 7, {
        background: isOn ? 'radial-gradient(circle at 40% 35%, #ffb0a0 0%, #ff2a1a 40%, #c00000 100%)' : 'radial-gradient(circle at 40% 35%, #8a4038, #4a0e0a 70%)',
        boxShadow: isOn ? '0 0 4px 1px rgba(255, 30, 20, 0.75)' : 'inset 0 0 1px rgba(0,0,0,0.6)',
      })} />
      {KNOB_POS[layout].map(([cx, cy], k) => (
        <PedalKnob key={k} slot={slot} k={k} type={type} cx={x + FACE_DX + cx} cy={FACE_Y + cy} look={look} />
      ))}
      <div className={'hc-abs hc-foot' + (down ? ' down' : '')} style={abs(x + FOOT_DX, FOOT_Y, FOOT_W, FOOT_H)}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setDown(true); toggle(); } }}
        onPointerUp={() => setDown(false)} onPointerLeave={() => { setDown(false); clearHint(); }}
        onPointerEnter={() => setHint(`${HC_TYPES[type]}: ${isOn ? 'on' : 'off'} (click to switch)`)}>
        {rubber && <div className="hc-foot-tex" style={{ backgroundImage: `url(${rubber})` }} />}
      </div>
    </>
  );
}

function Combo({ slot, type }: { slot: number; type: number }) {
  const { slotId, params } = useFxEditor();
  const x = SLOT_X0 + SLOT_DX * slot + COMBO_DX;
  const setType = (t: number) => A.editFx(slotId, `Pedal ${slot + 1}: ${HC_TYPES[t]}`, (d) => { d[hcTypeKey(slot)] = t; });
  const move = (dir: number) => {
    const patch = hcSwapSlots(params, slot, slot + dir);
    A.editFx(slotId, dir < 0 ? 'Move pedal left' : 'Move pedal right', (d) => { Object.assign(d, patch); });
  };
  return (
    <div className="hc-abs hc-combo" style={abs(x, COMBO_Y, COMBO_W, COMBO_H)}
      onPointerEnter={() => setHint(`Pedal ${slot + 1}: ${HC_TYPES[type]}`)} onPointerLeave={clearHint}
      onPointerDown={(e) => {
        if (e.button !== 0 && e.button !== 2) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const items: MenuItem[] = [
          ...HC_TYPES.map((n, i) => ({ label: n, radio: true, checked: i === type, onClick: () => setType(i) })),
          { separator: true },
          { label: 'Move left', disabled: slot === 0, onClick: () => move(-1) },
          { label: 'Move right', disabled: slot === HC_SLOTS - 1, onClick: () => move(1) },
        ];
        openMenu(r.left, r.bottom, items, { minWidth: r.width });
      }}
      onContextMenu={(e) => e.preventDefault()}>
      {HC_TYPES[type]}
    </div>
  );
}

function HardcoreEditor() {
  const { params } = useFxEditor();
  const board = brushed('hc-board', 745, 374, 118, 26, 14, 34, 3);
  const types = Array.from({ length: HC_SLOTS }, (_, s) => {
    const t = Math.trunc(num(params[hcTypeKey(s)], 0));
    return t > 0 && t < HC_TYPES.length ? t : 0;
  });
  return (
    <FxPanel width={W} height={H} className="hc">
      <TopBar />
      <div className="hc-abs hc-board" style={board ? { backgroundImage: `url(${board})` } : undefined} />
      {types.map((t, s) => (t > 0 ? <Pedal key={`${s}:${t}`} slot={s} type={t} /> : null))}
      {types.map((t, s) => <Combo key={s} slot={s} type={t} />)}
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'hardcore', Editor: HardcoreEditor };
