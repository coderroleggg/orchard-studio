// Formula Controller editor (FL: Fruity Formula Controller, 521 x 370): the
// a / b / c knobs (dimmed when the formula does not read them), the formula
// field with FL's colouring, compile status, syntax help (?), Compile, and the
// Comments / Monitor sheet (the output graph shows behind the comments).

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AnimatedDisplay, FxPanel, useFxEditor, useFxMonitor, useFxState, useParam } from '../kit';
import { editFx } from '../../../store/actions';
import { useControl } from '../../widgets/control';
import { openMenu, type MenuItem } from '../../widgets/ContextMenu';
import { setHint, clearHint } from '../../hint';
import { compileFormula, FORMULA_FUNCTIONS } from '../../../model/formula';
import { SoberPanel } from './controllers/kit';
import type { FxEditorModule } from '../registry';

const VAR_COLORS: Record<string, { ball: [string, string]; text: string; dot: string; value: string }> = {
  a: { ball: ['#9fbd75', '#76924f'], text: '#b5e061', dot: '#d9ff3f', value: '#8a9399' },
  b: { ball: ['#68a0bb', '#467b95'], text: '#5fc3f0', dot: '#5fd0ff', value: '#8a9399' },
  c: { ball: ['#bd7896', '#8f4f69'], text: '#f06a9b', dot: '#ff6a9a', value: '#8a9399' },
};

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** FL's big formula knob: coloured ball with its letter, dark bezel, 11 ticks, value dot. */
function BigKnob({ k, x, y, dim }: { k: 'a' | 'b' | 'c'; x: number; y: number; dim: boolean }) {
  const p = useParam(k);
  const h = useControl({ travel: 220, ...p.control }, 'vertical');
  const S = 70, c = S / 2;
  const t = (p.value - p.def.min) / (p.def.max - p.def.min);
  const ang = -150 + 300 * Math.min(1, Math.max(0, t));
  const col = VAR_COLORS[k];
  const [dx, dy] = polar(c, c, 22.2, ang);
  const id = `fk-${k}`;
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: S, height: S }} {...h}>
      <svg width={S} height={S} style={{ display: 'block', overflow: 'visible', opacity: dim ? 0.55 : 1 }}>
        <defs>
          <radialGradient id={`${id}h`} cx="50%" cy="55%" r="50%">
            <stop offset="0.6" stopColor="rgba(0,0,0,0.25)" />
            <stop offset="1" stopColor="rgba(0,0,0,0)" />
          </radialGradient>
          <linearGradient id={`${id}z`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4a5359" />
            <stop offset="0.45" stopColor="#1d2427" />
            <stop offset="1" stopColor="#0f1416" />
          </linearGradient>
          <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={dim ? '#7a6670' : col.ball[0]} />
            <stop offset="1" stopColor={dim ? '#5a4a52' : col.ball[1]} />
          </linearGradient>
        </defs>
        {Array.from({ length: 11 }, (_, i) => {
          const a = -150 + i * 30;
          const [x0, y0] = polar(c, c, 30.5, a);
          const [x1, y1] = polar(c, c, i === 5 ? 36.5 : 35, a);
          return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#2b3235" strokeWidth={1.1} />;
        })}
        <circle cx={c} cy={c + 1.5} r={31} fill={`url(#${id}h)`} />
        <circle cx={c} cy={c} r={26.5} fill={`url(#${id}z)`} stroke="#0b0f11" strokeWidth={0.8} />
        <circle cx={c} cy={c} r={24.6} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth={1} />
        <circle cx={c} cy={c} r={19.6} fill={`url(#${id}b)`} />
        <circle cx={dx} cy={dy} r={1.5} fill={dim ? '#a07888' : col.dot} />
        <text x={c} y={c + 5.5} textAnchor="middle" fontSize={16} fill="#1c2427" style={{ fontFamily: 'var(--font-ui)' }}>{k}</text>
      </svg>
    </div>
  );
}

/** Formula text coloured like FL's field: a / b / c in their knob colours, operators dimmer. */
function highlight(src: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)|(\d*\.?\d+(?:[eE][-+]?\d+)?)|(\s+)|([^\sA-Za-z0-9_])/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(src))) {
    const t = m[0];
    let color = '#f2f6f8';
    if (m[1]) {
      const w = t.toLowerCase();
      if (w === 'a' || w === 'b' || w === 'c') color = VAR_COLORS[w].text;
    } else if (m[4]) color = /[()]/.test(t) ? '#e6ecef' : '#b4bec4';
    out.push(<span key={i++} style={{ color }}>{t}</span>);
  }
  return out;
}

const PANEL = { bg: '#3b4146', tab: '#353c40', line: '#30373b' };

const FIELD: CSSProperties = { fontFamily: 'var(--font-ui)', fontSize: 12, letterSpacing: 0, padding: '0 6px', lineHeight: '24px' };

function FormulaField({ x, y, w, h, value, onChange, onEnter }: { x: number; y: number; w: number; h: number; value: string; onChange: (v: string) => void; onEnter: () => void }) {
  const [scroll, setScroll] = useState(0);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: '#2c3337', border: '1px solid #21282c', borderRadius: 2, overflow: 'hidden' }}
      onPointerEnter={() => setHint('Input to output mapping formula')} onPointerLeave={clearHint}>
      <div style={{ ...FIELD, position: 'absolute', inset: 0, whiteSpace: 'pre', pointerEvents: 'none', transform: `translateX(${-scroll}px)` }}>{highlight(value)}</div>
      <input value={value} spellCheck={false}
        style={{ ...FIELD, position: 'absolute', inset: 0, width: '100%', height: '100%', boxSizing: 'border-box', background: 'transparent', border: 'none', outline: 'none', color: 'transparent', caretColor: '#f2f6f8' }}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => setScroll((e.target as HTMLInputElement).scrollLeft)}
        onKeyUp={(e) => setScroll((e.target as HTMLInputElement).scrollLeft)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') onEnter(); }} />
    </div>
  );
}

function Graph({ x, y, w, h, monitor }: { x: number; y: number; w: number; h: number; monitor: boolean }) {
  const { slotId } = useFxEditor();
  const st = useRef({ v: new Float32Array(760), bt: new Float32Array(760), w: 0, n: 0, out: 0 });
  useFxMonitor(slotId, (d) => {
    const s = st.current;
    const v = d.v as number[] | undefined, bt = d.bt as number[] | undefined;
    if (!v || !bt) return;
    for (let i = 0; i < v.length; i++) { s.v[s.w] = v[i]; s.bt[s.w] = bt[i]; s.w = (s.w + 1) % 760; s.n = Math.min(760, s.n + 1); }
    s.out = Number(d.out) || 0;
  });
  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h} style={{ pointerEvents: monitor ? 'auto' : 'none' }} frame={(g, W, H) => {
      const s = st.current;
      const per = 760 / W;
      const at = (k: number) => (s.w - s.n + k + 1520) % 760;
      if (monitor) {
        g.fillStyle = '#4d5a5d';
        g.fillRect(0, 0, W, H);
        g.fillStyle = '#525f61';
        for (let px = 0; px < W; px++) {
          const k = Math.floor((px - (W - s.n / per)) * per);
          if (k >= 0 && k < s.n && Math.floor(s.bt[at(k)]) % 2 === 1) g.fillRect(px, 0, 1, H);
        }
        g.fillStyle = '#495557';
        for (let i = 1; i < 4; i++) g.fillRect(0, Math.round((H * i) / 4), W, 1);
      } else {
        g.fillStyle = '#2c3337';
        g.fillRect(0, 0, W, H);
      }
      g.strokeStyle = monitor ? '#e8f6f8' : '#59636a';
      g.lineWidth = monitor ? 1.4 : 1.1;
      g.beginPath();
      let started = false;
      for (let px = 0; px < W; px++) {
        const k = Math.floor((px - (W - s.n / per)) * per);
        if (k < 0 || k >= s.n) continue;
        const v = Math.min(1.05, Math.max(-0.05, s.v[at(k)]));
        const yy = 2 + (1 - v) * (H - 4);
        if (started) g.lineTo(px + 0.5, yy); else { g.moveTo(px + 0.5, yy); started = true; }
      }
      g.stroke();
      if (monitor) {
        g.font = '300 26px "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
        g.textAlign = 'right';
        g.fillStyle = 'rgba(30, 37, 40, 0.72)';
        g.fillText(s.out.toFixed(3), W - 8, H - 8);
      }
    }} />
  );
}

/** FL's sheet tabs (TQuickTabSelector): slanted tabs, the selected one dark with yellow text. */
function SheetTabs({ x, y, value, onChange }: { x: number; y: number; value: number; onChange: (i: number) => void }) {
  const tabs = ['Comments', 'Monitor'];
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 150, height: 29 }}>
      {tabs.map((t, i) => (
        <div key={t} className="fxk-abs" style={{
          left: i * 74, top: 0, width: 84, height: 29, lineHeight: '29px', paddingLeft: i ? 13 : 9, boxSizing: 'border-box', fontSize: 11,
          color: i === value ? '#f5c242' : '#c9d2d7', background: i === value ? '#242a2e' : '#3b4146',
          clipPath: i ? 'polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%)' : 'polygon(0 0, 100% 0, calc(100% - 10px) 100%, 0 100%)',
          cursor: 'default', zIndex: i === value ? 1 : 0,
        }} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onChange(i); } }}>{t}</div>
      ))}
    </div>
  );
}

function FormulaCtrlEditor() {
  const { slotId } = useFxEditor();
  const formula = useFxState<string>('formula', '');
  const comments = useFxState<string>('comments', '');
  const sheet = useFxState<number>('sheet', 0);
  const [draft, setDraft] = useState(formula);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  // a preset or undo replaces the formula: show it
  useEffect(() => { setDraft(formula); setStatus(null); }, [formula]);
  const compiled = compileFormula(formula);
  const uses = compiled.ok ? compiled.uses : new Set<string>();
  const compile = () => {
    const r = compileFormula(draft);
    if (r.ok) {
      setStatus({ ok: true, text: 'Compiled ok' });
      if (draft !== formula) editFx(slotId, 'Formula', (p) => { p.formula = draft; });
    } else setStatus({ ok: false, text: `Error: ${r.error}` });
  };
  const shown = status ?? (formula.trim() === '' ? { ok: true, text: '' } : compiled.ok ? { ok: true, text: 'Compiled ok' } : { ok: false, text: `Error: ${compiled.error}` });
  const help = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const ins = (s: string) => () => setDraft((d) => d + s);
    const items: MenuItem[] = [
      { header: true, label: 'Operators' },
      { label: '+ - * / ^ ( )', onClick: ins('+') },
      { label: '= <> < > <= >= in', onClick: ins('=') },
      { label: 'and or xor not', onClick: ins(' and ') },
      { label: 'div mod fmod shl shr', onClick: ins(' mod ') },
      { label: '% (percent)  ! (factorial)', onClick: ins('%') },
      { header: true, label: 'Variables' },
      ...['Input', 'a', 'b', 'c', 'SongTime', 'Time', 'GetTempo', 'Pi', 'Rand', 'MouseX', 'MouseY'].map((v) => ({ label: v, onClick: ins(v) })),
      { header: true, label: 'Functions' },
      { label: 'Functions', submenu: FORMULA_FUNCTIONS.map((f) => ({ label: f, onClick: ins(`${f}(`) })) },
    ];
    openMenu(r.left, r.bottom, items);
  };
  return (
    <FxPanel width={521} height={370} style={{ background: '#353c40' }}>
      <SoberPanel x={7} y={7} w={507} h={84} title="Input" tabW={44} colors={PANEL}>
        {(['a', 'b', 'c'] as const).map((k, i) => (
          <div key={k}>
            <BigKnob k={k} x={180 + i * 112} y={7} dim={!uses.has(k)} />
            <ValueText k={k} x={243 + i * 112} y={63} dim={!uses.has(k)} />
          </div>
        ))}
      </SoberPanel>
      <SoberPanel x={7} y={99} w={507} h={95} title="Formula" tabW={58} colors={PANEL}>
        <FormulaField x={7} y={27} w={493} h={26} value={draft} onChange={(v) => { setDraft(v); setStatus(null); }} onEnter={compile} />
        <div className="fxk-abs" style={{ left: 11, top: 60, width: 397, height: 29, lineHeight: '29px', fontSize: 11, fontWeight: 600, color: shown.ok ? '#f5c242' : '#ff7a5f', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{shown.text}</div>
        <div className="fxk-abs" style={{ left: 414, top: 60, width: 26, height: 29, background: '#2c3337', clipPath: 'polygon(8px 0, 100% 0, 100% 100%, 8px 100%, 0 50%)', display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 5, boxSizing: 'border-box', color: '#e8eef1', fontWeight: 700, fontSize: 15, cursor: 'default' }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); help(e); } }}
          onPointerEnter={() => setHint('Allowed syntax')} onPointerLeave={clearHint}>?</div>
        <div className="fxk-abs" style={{ left: 442, top: 60, width: 59, height: 29, background: '#2c3337', border: '1px solid #21282c', borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#d5dde2', fontSize: 10.5, cursor: 'default' }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); compile(); } }}
          onPointerEnter={() => setHint('Accept / compile formula')} onPointerLeave={clearHint}>Compile</div>
      </SoberPanel>
      <SoberPanel x={7} y={202} w={507} h={133} colors={PANEL}>
        <div className="fxk-abs" style={{ left: 7, top: 7, width: 493, height: 119, border: '1px solid #21282c', overflow: 'hidden' }}>
          <Graph x={0} y={0} w={491} h={117} monitor={sheet === 1} />
          {sheet === 0 && (
            <textarea value={comments} spellCheck={false}
              onChange={(e) => editFx(slotId, 'Comments', (p) => { p.comments = e.target.value; }, `ffc-comments:${slotId}`)}
              onKeyDown={(e) => e.stopPropagation()}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', boxSizing: 'border-box', resize: 'none', background: 'transparent', border: 'none', outline: 'none', color: '#f2f6f8', font: '10.5px var(--font-ui)', lineHeight: '14px', padding: '4px 6px' }} />
          )}
        </div>
      </SoberPanel>
      <SheetTabs x={6} y={335} value={sheet} onChange={(i) => editFx(slotId, 'Sheet', (p) => { p.sheet = i; })} />
    </FxPanel>
  );
}

function ValueText({ k, x, y, dim }: { k: 'a' | 'b' | 'c'; x: number; y: number; dim: boolean }) {
  const p = useParam(k);
  return (
    <div className="fxk-abs" style={{ left: x - 8, top: y - 3, width: 50, height: 21, textAlign: 'right', fontSize: 16, fontWeight: 300, fontFamily: '"Arial Narrow", "Helvetica Neue", Arial, sans-serif', color: VAR_COLORS[k].value, opacity: dim ? 0.5 : 1, pointerEvents: 'none', lineHeight: '21px' }}>
      {(p.value / 65536).toFixed(3)}
    </div>
  );
}

export const editor: FxEditorModule = { id: 'formulactrl', Editor: FormulaCtrlEditor };
