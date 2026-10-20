// Harmor's global section (bottom left, y 330..612) and the left strip
// buttons: options menu, part select A / B with the part switches, part mix,
// GUI link, legato / porta / strum, main volumes and pitch, velocity, main LFO
// amount, the X / Y / Z pad with its wheels and the info memo.

import { useEffect, useRef } from 'react';
import { setHint, clearHint } from '../../../hint';
import { openMenu } from '../../../widgets/ContextMenu';
import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { useNoScrollWheel, useParam } from '../../kit';
import { FORM } from './form';
import { HCtl } from './Ctl';
import { HButton, HCheckView } from './widgets';
import { editGlobal, editPart, setView, useHarmor } from './use';
import { harmorMenu } from './menus';

export const GLOBAL_CONTROLS = [
  'MainLFOLevelWheel', 'PartMixWheel', 'LegatoLimitWheel', 'LegatoBox', 'PortaBox', 'VelToPortaTimeBox',
  'StrumModeSelect', 'StrumTimeWheel', 'StrumTensWheel', 'VelToVolBox', 'MainVolWheel', 'PostVolWheel', 'MainPitchWheel',
  'ModXWheel', 'ModYWheel', 'ModZWheel',
] as const;

/** FL's PartSelect (PartSelectPaint): "A" | "B", the current part lit orange (#e1973f). */
function PartSelect() {
  const h = useHarmor();
  const c = FORM.PartSelect;
  const pick = (part: number) => { if (part !== h.part) setView(h.slotId, 'Current part', { part }); };
  return (
    <div className="hm-ctl hm-partsel" style={{ left: c.x, top: c.y, width: c.w, height: c.h }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        pick(e.clientX - r.left < r.width / 2 ? 0 : 1);
      }}
      onPointerEnter={() => setHint(`Current part: ${h.part ? 'B' : 'A'}`)} onPointerLeave={clearHint}>
      {['A', 'B'].map((s, i) => <div key={s} className={'hm-partsel-half' + (i === h.part ? ' on' : '')}>{s}</div>)}
    </div>
  );
}

/** Enable part A / B (HPart.on). */
function PartEnable({ part }: { part: 0 | 1 }) {
  const h = useHarmor();
  const c = part ? FORM.PartBEnabledBox : FORM.PartAEnabledBox;
  const hp = (part ? h.params.hB : h.params.hA) as { on?: number } | undefined;
  const on = !!hp?.on;
  const label = part ? 'Enable part B' : 'Enable part A';
  return <HCheckView ctl={c} on={on} hint={`${label}: ${on ? 'on' : 'off'}`}
    onToggle={() => editPart(h.slotId, part, label, (p) => { p.on = on ? 0 : 1; })} />;
}

/** GUI-link parts (HGlobal.linkParts). */
function LinkParts() {
  const h = useHarmor();
  const c = FORM.LinkPartsBox;
  const on = !!h.hg?.linkParts;
  return (
    <HButton ctl={c} hint={`GUI-link parts: ${on ? 'on' : 'off'}`} active={on}
      onClick={() => editGlobal(h.slotId, 'GUI-link parts', (g) => { g.linkParts = on ? 0 : 1; })}
      style={{ background: 'transparent' }}>
      <svg width={c.w} height={c.h} style={{ position: 'absolute', left: 0, top: 0 }}>
        <rect x={c.w / 2 - 13} y={3} width={26} height={c.h - 6} rx={(c.h - 6) / 2} fill={on ? '#e1973f' : 'rgba(0,0,0,0.35)'} stroke="rgba(0,0,0,0.5)" />
        <path d={`M${c.w / 2 - 7} ${c.h / 2} h14`} stroke={on ? '#2a1d1d' : 'rgba(255,255,255,0.55)'} strokeWidth={1.6} />
        <circle cx={c.w / 2 - 7} cy={c.h / 2} r={2.6} fill="none" stroke={on ? '#2a1d1d' : 'rgba(255,255,255,0.55)'} strokeWidth={1.3} />
        <circle cx={c.w / 2 + 7} cy={c.h / 2} r={2.6} fill="none" stroke={on ? '#2a1d1d' : 'rgba(255,255,255,0.55)'} strokeWidth={1.3} />
      </svg>
    </HButton>
  );
}

/** The X / Y / Z pad (TQuickXYZ): drag sets X and Y, the wheel / right-drag sets Z. */
function XyzPad() {
  const c = FORM.ModVisual;
  const x = useParam('modX'), y = useParam('modY'), z = useParam('modZ');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const drag = useRef<{ z: boolean; y0: number; z0: number } | null>(null);
  useEffect(() => () => { if (drag.current) store.endGesture(); }, []);
  const tx = (x.value - x.def.min) / (x.def.max - x.def.min);
  const ty = (y.value - y.def.min) / (y.def.max - y.def.min);
  const tz = (z.value - z.def.min) / (z.def.max - z.def.min);
  const set = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    x.set(Math.round(x.def.min + fx * (x.def.max - x.def.min)));
    y.set(Math.round(y.def.min + (1 - fy) * (y.def.max - y.def.min)));
    setHint(`X ${Math.round(fx * 100)}% / Y ${Math.round((1 - fy) * 100)}%`);
  };
  const W = c.w, H = c.h;
  const cx = tx * (W - 8) + 4, cy = (1 - ty) * (H - 8) + 4;
  return (
    <div ref={ref} className="hm-ctl" style={{ left: c.x, top: c.y, width: W, height: H, touchAction: 'none' }}
      onPointerDown={(e) => {
        e.preventDefault(); e.stopPropagation();
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        store.beginGesture('X / Y / Z modulation');
        if (e.button === 2) { drag.current = { z: true, y0: e.clientY, z0: z.value }; return; }
        if (e.button !== 0) return;
        drag.current = { z: false, y0: 0, z0: 0 };
        set(e);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) { setHint('X / Y / Z modulation: drag to set X and Y, wheel or right-drag to set Z'); return; }
        if (d.z) {
          const v = Math.round(Math.min(z.def.max, Math.max(z.def.min, d.z0 + (d.y0 - e.clientY) * 2)));
          z.set(v);
          setHint(`Z ${Math.round(((v - z.def.min) / (z.def.max - z.def.min)) * 100)}%`);
        } else set(e);
      }}
      onPointerUp={() => { if (drag.current) { drag.current = null; store.endGesture(); } }}
      onPointerCancel={() => { if (drag.current) { drag.current = null; store.endGesture(); } }}
      onContextMenu={(e) => e.preventDefault()}
      onWheel={(e) => {
        e.stopPropagation();
        store.beginGesture('Modulation Z');
        z.set(Math.round(Math.min(z.def.max, Math.max(z.def.min, z.value + (e.deltaY < 0 ? 8 : -8)))));
        store.endGesture();
      }}
      onPointerLeave={clearHint}>
      <svg width={W} height={H} style={{ display: 'block' }}>
        <rect x={0.5} y={0.5} width={W - 1} height={H - 1} rx={3} fill="#38393e" fillOpacity={0.55} stroke="rgba(0,0,0,0.55)" />
        {[1, 2, 3].map((i) => (
          <g key={i} stroke="rgba(255,255,255,0.07)">
            <line x1={(W * i) / 4} y1={2} x2={(W * i) / 4} y2={H - 2} />
            <line x1={2} y1={(H * i) / 4} x2={W - 2} y2={(H * i) / 4} />
          </g>
        ))}
        <circle cx={cx} cy={cy} r={3 + tz * 9} fill="#b9bfc3" fillOpacity={0.14} stroke="#b9bfc3" strokeOpacity={0.6} />
        <line x1={cx - 5} y1={cy} x2={cx + 5} y2={cy} stroke="#b9bfc3" strokeWidth={1.2} />
        <line x1={cx} y1={cy - 5} x2={cx} y2={cy + 5} stroke="#b9bfc3" strokeWidth={1.2} />
      </svg>
    </div>
  );
}

/** The info / comments memo (HGlobal.info). */
function InfoMemo() {
  const h = useHarmor();
  const c = FORM.InfoEdit;
  const text = h.hg?.info ?? '';
  return (
    <textarea className="hm-ctl hm-memo" style={{ left: c.x, top: c.y, width: c.w, height: c.h }} value={text.replace(/\r/g, '\n')}
      spellCheck={false}
      onChange={(e) => {
        const v = e.target.value.slice(0, 4096);
        A.editFx(h.slotId, 'Info', (d) => { (d.hG as { info: string }).info = v; }, `hinfo:${h.slotId}`);
      }}
      onPointerEnter={() => setHint('Info / comments')} onPointerLeave={clearHint}
      onKeyDown={(e) => e.stopPropagation()} />
  );
}

export function GlobalSection() {
  const h = useHarmor();
  return (
    <>
      <HButton ctl={FORM.MainMenuBtn} glyph="menu" hint="Options"
        onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenu(r.left, r.bottom, harmorMenu(h.slotId)); }} />
      <HButton ctl={FORM.AboutBtn} glyph="about" hint="About Harmor" onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.right, r.top, [
          { header: true, label: 'Harmor' },
          { label: 'Additive / subtractive synthesizer by Image-Line', disabled: true },
        ]);
      }} />
      <HButton ctl={FORM.BrowseBtn} glyph="browse" hint="Browse envelopes / images (not available in this version)" onClick={() => undefined} />
      <HButton ctl={FORM.KbBtn} glyph="kb" hint="Show / hide keyboard" active={!!h.view.kb}
        onClick={() => setView(h.slotId, 'Keyboard', { kb: h.view.kb ? 0 : 1 })} />
      {GLOBAL_CONTROLS.map((n) => <HCtl key={n} n={n} />)}
      <PartSelect />
      <PartEnable part={0} />
      <PartEnable part={1} />
      <LinkParts />
      <XyzPad />
      <InfoMemo />
    </>
  );
}
