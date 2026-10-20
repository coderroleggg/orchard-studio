// MIDI Out editor (FL: MIDI Out, SynthEditorForm 558 x 389), shown in the
// channel settings window of a MIDI Out channel instead of the Sampler tabs.
// Top: Channel, Patch (General MIDI), Bank coarse / fine and Port. Page box:
// the page selector and its rename button, 9 controller knobs per page with
// their labels (orange = activated: click to activate / deactivate; the gear
// opens the Control settings of an unassigned knob) and values. Bottom:
// Reset, Deactivate all, Send pan / volume and pitch, Map note color to MIDI
// channel, the Options menu (transport flush) and Multi-touch. Right-click a
// knob for Reset, Configure... and the automation items. Positions are FL's
// form coordinates; colours come from the manual's FL 2026 screenshot.
//
// Notes played on this channel go out on its Port; effects whose MIDI input
// port matches receive them. Controller data (CC / RPN / NRPN / AFT) has no
// receiver in this clone (no external MIDI or VST); "Note" type knobs send
// notes like the channel's own.

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { store } from '../../store';
import * as A from '../../store/actions';
import type { Channel } from '../../model/types';
import {
  GM_PATCHES, MO_KNOBS, MO_PAGES, MO_TYPES, MO_TYPE_HINTS, MO_NOTE, defaultMidiOutControl, midiOutControlLabel, portText,
  type MidiOutControl, type MidiOutSettings,
} from '../../model/midiout';
import { automationMenuItems, useControl, type AutoSpec } from '../widgets/control';
import { openMenu, type MenuItem } from '../widgets/ContextMenu';
import { setHint, clearHint, flashHint } from '../hint';
import './midiout.css';

export const MO_W = 558;
export const MO_H = 389;

/** Knob columns / rows inside the page box (FL's VectorWheel1..9). */
const KX = [83, 235, 387];
const KY = [51, 135, 219];
const PAGE_Y = 46;

const GM_FAMILIES = [
  'Piano', 'Chromatic percussion', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass',
  'Reed', 'Pipe', 'Synth lead', 'Synth pad', 'Synth effects', 'Ethnic', 'Percussive', 'Sound effects',
];

let ctrlClipboard: MidiOutControl | null = null;

type Edit = (label: string, recipe: (s: MidiOutSettings) => void, mergeKey?: string) => void;

function Box({ x, y, w, h, className, style, children, ...rest }: { x: number; y: number; w: number; h: number; className?: string; style?: React.CSSProperties; children?: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={'mo-abs' + (className ? ' ' + className : '')} style={{ left: x, top: y, width: w, height: h, ...style }} {...rest}>{children}</div>;
}

function Cap({ x, y, w, h, children }: { x: number; y: number; w: number; h: number; children: ReactNode }) {
  return <Box x={x} y={y} w={w} h={h} className="mo-cap">{children}</Box>;
}

/** FL's red digit wheel (TVectorDigiWheel, "Cushion light" style): drag / wheel; right-click for the value menu. */
function Digi({ x, y, w, h, value, min, max, def, label, text, set, auto }: {
  x: number; y: number; w: number; h: number; value: number; min: number; max: number; def: number; label: string;
  text: (v: number) => string; set: (v: number) => void; auto?: AutoSpec;
}) {
  const hnd = useControl({
    value, min, max, defaultValue: def, step: 1, label, format: text, travel: Math.max(90, (max - min) * 2),
    onChange: (v) => set(Math.round(v)), onBegin: () => store.beginGesture(label), onEnd: () => store.endGesture(),
    parse: (v) => v, auto,
  }, 'vertical');
  return <Box x={x} y={y} w={w} h={h} className="mo-digi" {...hnd}>{text(value)}</Box>;
}

/** The knob drawing: dark ring with FL's tick marks, a bevelled grey body and the pointer dot (orange when activated). */
function KnobView({ size, t, on }: { size: number; t: number; on: boolean }) {
  const c = size / 2;
  const rRing = size * 0.355, rBody = size * 0.285;
  const ang = (-135 + 270 * Math.min(1, Math.max(0, t))) * (Math.PI / 180);
  const px = c + Math.sin(ang) * (rRing - size * 0.035), py = c - Math.cos(ang) * (rRing - size * 0.035);
  const ticks = [-135, -90, -45, 0, 45, 90, 135].map((a) => {
    const r = (a * Math.PI) / 180;
    return [c + Math.sin(r) * size * 0.4, c - Math.cos(r) * size * 0.4, c + Math.sin(r) * size * 0.47, c - Math.cos(r) * size * 0.47];
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id="moKnobBody" cx="50%" cy="35%" r="70%">
          <stop offset="0" stopColor="#646a6e" />
          <stop offset="1" stopColor="#4f5559" />
        </radialGradient>
        <linearGradient id="moKnobRim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#80878b" />
          <stop offset="1" stopColor="#2d3336" />
        </linearGradient>
      </defs>
      {ticks.map(([x0, y0, x1, y1], k) => <line key={k} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#2e3538" strokeWidth={1.4} />)}
      <circle cx={c} cy={c + size * 0.02} r={rRing + size * 0.03} fill="rgba(0,0,0,0.18)" />
      <circle cx={c} cy={c} r={rRing} fill="#1f2427" />
      <circle cx={c} cy={c} r={rBody + 1.2} fill="url(#moKnobRim)" />
      <circle cx={c} cy={c} r={rBody} fill="url(#moKnobBody)" />
      <circle cx={px} cy={py} r={size * 0.022} fill={on ? '#ffad3b' : '#d4dadd'} />
    </svg>
  );
}

function Knob({ ch, s, i, x, y, edit, configure }: { ch: Channel; s: MidiOutSettings; i: number; x: number; y: number; edit: Edit; configure: (i: number) => void }) {
  const ct = s.controls[i] ?? defaultMidiOutControl();
  const v = s.values[i] ?? 0;
  const pname = ct.name || ct.short || `Unnamed parameter ${i + 1}`;
  const label = `${ch.name} - ${pname}`;
  const hnd = useControl({
    value: v, min: 0, max: 127, defaultValue: 0, step: 1, label, travel: 200, format: (x) => String(Math.round(x)), parse: (x) => x,
    onChange: (x) => edit(pname, (d) => { d.values[i] = Math.round(x); }, `mo:${ch.id}:v${i}`),
    onBegin: () => store.beginGesture(pname), onEnd: () => store.endGesture(),
    auto: { scope: 'channel', id: ch.id, path: `midiOut.values.${i}`, label, min: 0, max: 127, step: 1 },
    extraMenu: [{ label: 'Configure...', onClick: () => configure(i) }, { separator: true }],
  }, 'vertical');
  const configured = ct.ctrl >= 0;
  return (
    <>
      <Box x={x} y={y} w={70} h={70} className="mo-knob" {...hnd}><KnobView size={70} t={v / 127} on={configured && ct.active} /></Box>
      {configured ? (
        <>
          <Box x={x + 71} y={y + 4} w={81} h={23} className={'mo-label' + (ct.active ? ' on' : '')} style={{ lineHeight: '23px' }}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); edit(ct.active ? 'Deactivate control' : 'Activate control', (d) => { d.controls[i].active = !d.controls[i].active; }); } }}
            onContextMenu={(e) => { e.preventDefault(); configure(i); }}
            onPointerEnter={() => setHint(`${ct.name || midiOutControlLabel(ct)} (${MO_TYPES[ct.type]} ${ct.ctrl}) - ${ct.active ? 'activated' : 'deactivated'}: click to ${ct.active ? 'deactivate' : 'activate'}, right-click to configure`)}
            onPointerLeave={clearHint}>
            {midiOutControlLabel(ct)}
          </Box>
          <Box x={x + 71} y={y + 27} w={48} h={17} className="mo-value">{v}</Box>
        </>
      ) : (
        <Box x={x + 71} y={y + 4} w={20} h={20} className="mo-gear"
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); configure(i); } }}
          onPointerEnter={() => setHint('Control settings: assign a controller to this knob')} onPointerLeave={clearHint}>
          <svg width={14} height={14} viewBox="0 0 16 16"><path fill="currentColor" d="M6.6 1h2.8l.4 2 1.4.6 1.7-1.2 2 2-1.2 1.7.6 1.4 2 .4v2.8l-2 .4-.6 1.4 1.2 1.7-2 2-1.7-1.2-1.4.6-.4 2H6.6l-.4-2-1.4-.6-1.7 1.2-2-2 1.2-1.7-.6-1.4-2-.4V6.6l2-.4.6-1.4L1.1 3.1l2-2 1.7 1.2 1.4-.6z M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 1 0 8 5.5z" fillRule="evenodd" /></svg>
        </Box>
      )}
    </>
  );
}

function Check({ x, y, w, h, on, caption, hint, toggle }: { x: number; y: number; w: number; h: number; on: boolean; caption: string; hint: string; toggle: () => void }) {
  return (
    <Box x={x} y={y} w={w} h={h} className="mo-check"
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); toggle(); } }}
      onPointerEnter={() => setHint(`${hint}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
      <span className={'mo-led' + (on ? ' on' : '')} />{caption}
    </Box>
  );
}

function Button({ x, y, w, h, children, hint, onClick, className }: { x: number; y: number; w: number; h: number; children: ReactNode; hint: string; onClick: (e: React.PointerEvent) => void; className?: string }) {
  return (
    <Box x={x} y={y} w={w} h={h} className={'mo-btn' + (className ? ' ' + className : '')}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>{children}</Box>
  );
}

/** FL's Control settings dialog (CtrlSetForm 238 x 286). */
function ControlSettings({ ch, i, s, edit, close }: { ch: Channel; i: number; s: MidiOutSettings; edit: Edit; close: () => void }) {
  const [c, setC] = useState<MidiOutControl>(() => ({ ...(s.controls[i] ?? defaultMidiOutControl()) }));
  const hi = c.type === 1 || c.type === 2 ? 16383 : 127;
  const num = (t: string, lo: number, top: number, d: number) => { const n = parseInt(t, 10); return Number.isFinite(n) ? Math.min(top, Math.max(lo, n)) : d; };
  const accept = () => {
    edit('Control settings', (d) => {
      const was = d.controls[i];
      d.controls[i] = { ...c, active: c.ctrl >= 0 && (was.active || was.ctrl < 0 ? true : c.active) };
    });
    close();
  };
  const field = (x: number, y: number, w: number, value: string, onChange: (t: string) => void, hint: string) => (
    <input style={{ left: x, top: y, width: w }} value={value} onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') accept(); if (e.key === 'Escape') close(); }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint} />
  );
  const B = 26; // body top
  return (
    <Box x={160} y={50} w={238} h={286} className="mo-dlg" onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <div className="mo-dlg-title">Control settings</div>
      <div className="mo-dlg-close" onPointerDown={(e) => { if (e.button === 0) close(); }} onPointerEnter={() => setHint('Close (Escape)')} onPointerLeave={clearHint}>
        <svg width={10} height={10} viewBox="0 0 10 10"><path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth={1.6} /></svg>
      </div>
      <Box x={1} y={B} w={236} h={213} className="mo-dlg-body">
        <Cap x={19} y={11} w={51} h={23}>Full name</Cap>
        {field(77, 13, 150, c.name, (t) => setC({ ...c, name: t.slice(0, 64) }), 'Full name (shown in the hint bar)')}
        <Cap x={9} y={43} w={61} h={23}>Short name</Cap>
        {field(77, 45, 150, c.short, (t) => setC({ ...c, short: t.slice(0, 64) }), 'Short name (shown next to the knob)')}
        <Cap x={17} y={83} w={53} h={23}>{c.type === MO_NOTE ? 'Velocity' : 'Controller'}</Cap>
        {field(77, 85, 50, c.ctrl < 0 ? '' : String(c.ctrl), (t) => setC({ ...c, ctrl: t.trim() === '' ? -1 : num(t, -1, hi, c.ctrl) }), c.type === MO_NOTE ? 'Note velocity (-1 deactivates the control)' : 'Controller number (-1 deactivates the control)')}
        <Box x={132} y={83} w={52} h={23} className="mo-combo"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.left, r.bottom, MO_TYPES.map((t, k) => ({ label: t, hint: MO_TYPE_HINTS[k], checked: c.type === k, radio: true, onClick: () => setC({ ...c, type: k, max: k === 1 || k === 2 ? Math.max(c.max, 127) : Math.min(c.max, 127), min: Math.min(c.min, k === 1 || k === 2 ? 16383 : 127) }) })));
          }}
          onPointerEnter={() => setHint(`Type of controller: ${MO_TYPE_HINTS[c.type]}`)} onPointerLeave={clearHint}>{MO_TYPES[c.type]}</Box>
        <Cap x={37} y={115} w={33} h={23}>Range</Cap>
        {field(77, 117, 50, String(c.min), (t) => setC({ ...c, min: num(t, 0, hi, c.min) }), 'Controller minimum value')}
        {field(133, 117, 50, String(c.max), (t) => setC({ ...c, max: num(t, 0, hi, c.max) }), 'Controller maximum value')}
        <Cap x={28} y={147} w={42} h={23}>Channel</Cap>
        <Digi x={75} y={146} w={32} h={25} value={c.chan} min={0} max={16} def={0} label="MIDI channel override number"
          text={(v) => (v <= 0 ? '⋯' : String(v))} set={(v) => setC({ ...c, chan: v })} />
        {c.type === MO_NOTE && (
          <>
            <Cap x={26} y={179} w={44} h={23}>Note off</Cap>
            {field(77, 181, 50, String(c.noteOff), (t) => setC({ ...c, noteOff: num(t, 0, 127, c.noteOff) }), 'Send note off when this value is set')}
          </>
        )}
      </Box>
      <Button x={8} y={257} w={50} h={29} hint="Reset the control settings" onClick={() => setC(defaultMidiOutControl())}>Reset</Button>
      <Button x={64} y={257} w={50} h={29} hint="Copy the control settings" onClick={() => { ctrlClipboard = { ...c }; flashHint('Control settings copied'); }}>Copy</Button>
      <Button x={117} y={257} w={50} h={29} hint="Paste control settings" onClick={() => { if (ctrlClipboard) setC({ ...ctrlClipboard }); }}>Paste</Button>
      <Button x={171} y={257} w={50} h={29} hint="Accept (Enter)" onClick={accept}>Accept</Button>
    </Box>
  );
}

/** The MIDI Out panel at FL's form size. */
export function MidiOutPanel({ ch }: { ch: Channel }) {
  const s = ch.midiOut;
  const [cfg, setCfg] = useState<number | null>(null);
  if (!s) return null;
  const edit: Edit = (label, recipe, mergeKey) => A.setMidiOut(ch.id, label, recipe as Parameters<typeof A.setMidiOut>[2], mergeKey);
  const page = s.page;
  const patchName = GM_PATCHES[s.patch + 1] ?? '(none)';
  const patchMenu = (x: number, y: number) => openMenu(x, y, [
    { label: '(none)', checked: s.patch < 0, radio: true, onClick: () => edit('General MIDI patch', (d) => { d.patch = -1; }) },
    ...GM_FAMILIES.map((f, fi): MenuItem => ({
      label: f, submenu: Array.from({ length: 8 }, (_, k): MenuItem => {
        const p = fi * 8 + k;
        return { label: `${p + 1}. ${GM_PATCHES[p + 1]}`, checked: s.patch === p, radio: true, onClick: () => edit('General MIDI patch', (d) => { d.patch = p; }) };
      }),
    })),
  ], { minWidth: 170 });
  const optionsMenu = (x: number, y: number) => {
    const fl = s.flush;
    const opt = (label: string, k: keyof MidiOutSettings['flush']): MenuItem => ({ label, checked: fl[k], onClick: () => edit(label, (d) => { d.flush[k] = !d.flush[k]; }) });
    openMenu(x, y, [
      { label: 'Send all control values now', onClick: () => flashHint('All control values sent') },
      { header: true, label: 'On reset' },
      opt('Send program change', 'programChange'),
      opt('Send pan', 'pan'),
      opt('Send volume', 'volume'),
      opt('Send pitch', 'pitch'),
      opt('Send pitch bend range', 'pitchBendRange'),
      opt('Cut playing notes', 'cutNotes'),
    ], { minWidth: 200 });
  };
  return (
    <div className="mo-panel" onPointerDown={() => { if (cfg !== null) setCfg(null); }}>
      {/* top row */}
      <Cap x={7} y={11} w={42} h={23}>Channel</Cap>
      <Digi x={54} y={10} w={32} h={25} value={s.channel} min={1} max={16} def={1} label="MIDI channel number" text={String}
        set={(v) => edit('MIDI channel', (d) => { d.channel = v; }, `mo:${ch.id}:chan`)} />
      <Cap x={111} y={11} w={28} h={23}>Patch</Cap>
      <Box x={144} y={10} w={181} h={25} className="mo-combo"
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); patchMenu(r.left, r.bottom); } }}
        onContextMenu={(e) => {
          // FL publishes the patch as an automatable parameter ("General MIDI patch")
          e.preventDefault();
          e.stopPropagation();
          openMenu(e.clientX, e.clientY, automationMenuItems({ scope: 'channel', id: ch.id, path: 'midiOut.patch', min: -1, max: 127, step: 1, label: `${ch.name} - General MIDI patch` }, e.clientX, e.clientY));
        }}
        onPointerEnter={() => setHint(`General MIDI patch: ${patchName}`)} onPointerLeave={clearHint}>{patchName}</Box>
      <Cap x={349} y={11} w={26} h={23}>Bank</Cap>
      <Digi x={380} y={10} w={40} h={25} value={s.bankMSB} min={-1} max={127} def={-1} label="Coarse bank number (CC #0)"
        text={(v) => (v < 0 ? '⋯' : String(v))} set={(v) => edit('Bank (coarse)', (d) => { d.bankMSB = v; }, `mo:${ch.id}:bmsb`)} />
      <Digi x={422} y={10} w={40} h={25} value={s.bankLSB} min={-1} max={127} def={-1} label="Fine bank number (CC #32)"
        text={(v) => (v < 0 ? '⋯' : String(v))} set={(v) => edit('Bank (fine)', (d) => { d.bankLSB = v; }, `mo:${ch.id}:blsb`)} />
      <Cap x={486} y={11} w={22} h={23}>Port</Cap>
      <Digi x={513} y={10} w={40} h={25} value={s.port} min={0} max={255} def={0} label="Output port number" text={(v) => portText(v)}
        set={(v) => edit('MIDI port', (d) => { d.port = v; }, `mo:${ch.id}:port`)} />

      {/* page of controllers */}
      <Box x={0} y={PAGE_Y} w={558} h={303} className="mo-page">
        <Cap x={23} y={11} w={26} h={26}>Page</Cap>
        <Box x={54} y={10} w={271} h={28} className="mo-combo big"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.left, r.bottom, s.pageNames.map((n, k) => ({ label: n, checked: k === page, radio: true, onClick: () => edit('Page', (d) => { d.page = k; }) })));
          }}
          onWheel={(e) => { e.stopPropagation(); const k = Math.min(MO_PAGES - 1, Math.max(0, page + (e.deltaY > 0 ? 1 : -1))); if (k !== page) edit('Page', (d) => { d.page = k; }); }}
          onPointerEnter={() => setHint(`Page of controllers: ${s.pageNames[page]}`)} onPointerLeave={clearHint}>{s.pageNames[page]}</Box>
        <Button x={325} y={10} w={27} h={28} className="round" hint="Rename current page"
          onClick={() => { const n = prompt('Page name', s.pageNames[page]); if (n !== null) edit('Rename page', (d) => { d.pageNames[page] = n.slice(0, 64); }); }}>
          <svg width={14} height={14} viewBox="0 0 16 16"><path d="M2 14 L2.6 10.8 L10.8 2.6 L13.4 5.2 L5.2 13.4 Z M9.6 3.8 L12.2 6.4" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" /></svg>
        </Button>
        {Array.from({ length: MO_KNOBS }, (_, k) => (
          <Knob key={k} ch={ch} s={s} i={page * MO_KNOBS + k} x={KX[k % 3]} y={KY[Math.floor(k / 3)]} edit={edit} configure={setCfg} />
        ))}
      </Box>

      {/* bottom bar */}
      <Button x={4} y={354} w={44} h={31} hint="Reset all controllers (CC #121) and everything" onClick={() => flashHint('Reset all controllers (CC #121)')}>Reset</Button>
      <Button x={52} y={354} w={83} h={31} hint="Deactivate all controls"
        onClick={() => edit('Deactivate all', (d) => { for (const c of d.controls) c.active = false; })}>Deactivate all</Button>
      <Check x={140} y={358} w={161} h={23} on={s.sendPanVolPitch} caption="Send pan, volume and pitch" hint="Send MIDI panning / volume / pitch CC's"
        toggle={() => edit('Send pan, volume and pitch', (d) => { d.sendPanVolPitch = !d.sendPanVolPitch; })} />
      <Check x={301} y={358} w={189} h={23} on={s.mapColorToChannel} caption="Map note color to MIDI channel" hint="Send note color as MIDI channel for note events"
        toggle={() => edit('Map note color to MIDI channel', (d) => { d.mapColorToChannel = !d.mapColorToChannel; })} />
      <Button x={491} y={354} w={25} h={31} hint="Options" onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); optionsMenu(r.left, r.bottom); }}>
        <svg width={9} height={6} viewBox="0 0 9 6"><path d="M0 0 H9 L4.5 6 Z" fill="currentColor" /></svg>
      </Button>
      <Button x={519} y={354} w={35} h={31} hint={`Multi-touch control: ${s.multiTouch ? 'on' : 'off'}`} className={s.multiTouch ? 'on' : undefined}
        onClick={() => edit('Multi-touch control', (d) => { d.multiTouch = !d.multiTouch; })}>
        <svg width={18} height={16} viewBox="0 0 18 16"><path d="M6 15 L3 9.5 Q2.4 8 4 8 L6 10 V2.5 Q6 1.2 7.2 1.2 Q8.4 1.2 8.4 2.5 V7 L13.5 8 Q15 8.4 14.6 10 L13.5 15 Z" fill={s.multiTouch ? '#ffcc3c' : 'currentColor'} /></svg>
      </Button>
      {cfg !== null && <ControlSettings key={cfg} ch={ch} i={cfg} s={s} edit={edit} close={() => setCfg(null)} />}
    </div>
  );
}

/** The MIDI Out panel scaled to fit the window body (FL's editor size). */
export function MidiOutScaled({ ch }: { ch: Channel }) {
  const ref = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const f = Math.min(el.clientWidth / MO_W, el.clientHeight / MO_H);
      setK(Number.isFinite(f) && f > 0 ? f : 1);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden', background: '#3f454a' }}>
      <div style={{ width: MO_W, height: MO_H, transform: `scale(${k})`, transformOrigin: '0 0' }}><MidiOutPanel ch={ch} /></div>
    </div>
  );
}
