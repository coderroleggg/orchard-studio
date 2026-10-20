// Gross Beat editor (FL: Gross Beat, 831 x 561 as FL opens it; the form's
// design size is 824 x 535, the bottom rows are anchored to the bottom and
// the right edge). Left: the time mix knob
// with its pill, the Options button, HOLD and the scratching clock, the 36
// time slots and 36 volume slots, the envelope visibility toggle, the ATT /
// REL / TNS volume knobs and the volume mix knob. Right: the mapping envelope
// toolbar (options menu, snap, step / slide / freeze, envelope type), the
// envelope editor and the bottom bar (slot name, link / key-held / one-shot,
// force hold, trigger and position sync).

import { useEffect, useState } from 'react';
import { FxPanel, useFxEditor, useFxMonitor, useParam } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, flashHint, setHint } from '../../../hint';
import * as Store from '../../../../store';
import { findFx } from '../../../../store/actions';
import {
  GB_DECLICK, GB_HOLD, GB_SNAP, GB_SNAP_LABELS, GB_SYNC, gbOffsetBeats, type GbSlot,
} from '../../../../model/fx/plugins/grossbeat';
import type { FxEditorModule } from '../../registry';
import {
  allSmooth, copySlot, decimate, edit, editSlot, flipVertical, hasClip, normalizeLevels, pasteInto, readView, resetSlot,
  setOpt, smoothAbrupt, type Bank, type GbView,
} from './edit';
import { EnvelopeEditor } from './envelope';
import { Combo, GREEN, HoldButton, IconToggle, MixKnob, ORANGE, ScratchClock, SmallKnob, TabBtn, TabSel } from './parts';
import { SlotGrid } from './slots';
import './grossbeat.css';

/** Left panel background: grey header and footer around the dark slot area (FL's paint boxes). */
function LeftBackground() {
  const dark = 'M0 61.3 L40 61.3 L60 53.3 L176 53.3 Q179 53.3 179 56.3 L179 87.7 Q179 90.7 182 90.7 L266 90.7 L266 506 L62 506 L40 498 L0 498 Z';
  return (
    <svg className="fxk-abs" width={266} height={561} viewBox="0 0 266 561" style={{ left: 0, top: 0 }}>
      <defs>
        <linearGradient id="gbTop" x1="0" y1="0" x2="0" y2="91" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#c8d2d7" />
          <stop offset="0.143" stopColor="#afb8be" />
          <stop offset="0.297" stopColor="#9199a0" />
          <stop offset="0.44" stopColor="#727b81" />
          <stop offset="0.55" stopColor="#5b646b" />
          <stop offset="0.66" stopColor="#444d54" />
          <stop offset="1" stopColor="#444d54" />
        </linearGradient>
        <linearGradient id="gbBottom" x1="0" y1="498" x2="0" y2="561" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#c5cfd4" />
          <stop offset="0.16" stopColor="#abb5bc" />
          <stop offset="0.4" stopColor="#868f95" />
          <stop offset="0.66" stopColor="#4a5459" />
          <stop offset="0.75" stopColor="#444d54" />
          <stop offset="1" stopColor="#444d54" />
        </linearGradient>
      </defs>
      <rect x={0} y={0} width={266} height={110} fill="url(#gbTop)" />
      <rect x={0} y={486} width={266} height={75} fill="url(#gbBottom)" />
      <path d={dark} fill="#222b30" stroke="#373836" strokeWidth={0.9} />
      <rect x={265} y={0} width={1} height={561} fill="#1c242a" />
    </svg>
  );
}

function OptionsButton({ x, y, view }: { x: number; y: number; view: GbView }) {
  const { slotId } = useFxEditor();
  return (
    <div className="fxk-abs gb-optbtn" style={{ left: x, top: y, width: 20, height: 20 }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenu(r.left, r.bottom, optionsMenu(slotId, view)); }}
      onPointerEnter={() => setHint('Options')} onPointerLeave={clearHint}>
      <svg width={12} height={12} viewBox="0 0 12 12"><path d="M3 2 L9.5 6 L3 10 Z" fill="#e3e9ec" /></svg>
    </div>
  );
}

/** FL's Options menu (the triangle button under the time knob). */
export function optionsMenu(slotId: string, v: GbView): MenuItem[] {
  return [
    { label: 'Trigger slots from MIDI notes', checked: v.opt.midi, hint: 'MIDI notes on the MIDI input port select slots: C5.. time slots, C2.. volume slots', onClick: () => setOpt(slotId, 'Trigger slots from MIDI notes', (o) => { o.midi = !v.opt.midi; }) },
    { separator: true },
    {
      label: 'Click reduction',
      submenu: GB_DECLICK.map((name, i) => ({ label: name, radio: true, checked: v.opt.declick === i, onClick: () => setOpt(slotId, 'Click reduction', (o) => { o.declick = i; }) } as MenuItem)),
    },
    { label: 'Smoothing attack compensation', checked: v.opt.comp, onClick: () => setOpt(slotId, 'Smoothing attack compensation', (o) => { o.comp = !v.opt.comp; }) },
    { label: 'Remove DC offset', checked: v.opt.dc, onClick: () => setOpt(slotId, 'Remove DC offset', (o) => { o.dc = !v.opt.dc; }) },
    { label: 'HQ resampling', checked: v.opt.hq, onClick: () => setOpt(slotId, 'HQ resampling', (o) => { o.hq = !v.opt.hq; }) },
    { separator: true },
    { label: 'View scratching clock', checked: v.opt.clock, onClick: () => setOpt(slotId, 'View scratching clock', (o) => { o.clock = !v.opt.clock; }) },
    { separator: true },
    { label: 'About', submenu: [{ label: 'Gross Beat: code and graphics by Didier Dambrin', disabled: true }] },
  ];
}

/** The mapping envelope options menu (toolbar down-arrow). */
function mappingMenu(slotId: string, bank: Bank, index: number, slot: GbSlot): MenuItem[] {
  const tool = (label: string, f: (s: GbSlot) => void) => ({ label, onClick: () => editSlot(slotId, bank, index, label, f) } as MenuItem);
  return [
    { label: 'Open state file...', disabled: true },
    { label: 'Save state file...', disabled: true },
    { separator: true },
    { label: 'Copy state', onClick: () => { copySlot(slot); flashHint('Envelope copied'); } },
    { label: 'Paste state', disabled: !hasClip(), onClick: () => editSlot(slotId, bank, index, 'Paste state', (s) => pasteInto(s)) },
    { separator: true },
    { label: 'Undo', onClick: () => { Store.store.undo(); } },
    { label: 'Last reset', onClick: () => editSlot(slotId, bank, index, 'Reset envelope', (s) => resetSlot(s)) },
    { separator: true },
    {
      label: 'Tools',
      submenu: [
        tool('Flip vertically', flipVertical),
        { label: 'Scale levels...', disabled: true },
        tool('Normalize levels', normalizeLevels),
        tool('Decimate points', decimate),
        tool('Smooth up abrupt changes', smoothAbrupt),
        tool('Turn all points smooth', allSmooth),
        { label: 'Create sequence...', disabled: true },
        { label: 'Analyze audio file...', disabled: true },
      ],
    },
  ];
}

/** FL's runtime size vs the form: bottom rows move down, the right edge moves right. */
const DX = 7, DY = 26;

interface Mon { playing: boolean; tPlay: number; vPlay: number; tPend: number; vPend: number }

function GrossBeatEditor() {
  const { slotId, params } = useFxEditor();
  const v = readView(params);
  const [mon, setMon] = useState<Mon>({ playing: false, tPlay: -1, vPlay: -1, tPend: -1, vPend: -1 });
  useFxMonitor(slotId, (d) => {
    const m: Mon = {
      playing: !!d.playing, tPlay: Number(d.tPlay), vPlay: Number(d.vPlay), tPend: Number(d.tPend), vPend: Number(d.vPend),
    };
    if (m.playing !== mon.playing || m.tPlay !== mon.tPlay || m.vPlay !== mon.vPlay || m.tPend !== mon.tPend || m.vPend !== mon.vPend) setMon(m);
  });
  const offset = useParam('offset');
  const [clockOff, setClockOff] = useState(gbOffsetBeats(offset.value));
  // the clock follows the scratch offset with a short glide
  useEffect(() => {
    const target = gbOffsetBeats(offset.value);
    let raf = 0;
    const step = () => {
      setClockOff((c) => {
        const n = c + (target - c) * 0.35;
        if (Math.abs(target - n) > 1e-4) raf = requestAnimationFrame(step);
        return Math.abs(target - n) > 1e-4 ? n : target;
      });
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [offset.value]);

  const time = v.map === 0;
  const bank: Bank = time ? 'tslots' : 'vslots';
  const index = time ? v.tslot : v.vslot;
  const slot = (time ? v.tslots : v.vslots)[index];
  const setMap = (m: number) => { if (m !== v.map) edit(slotId, 'Envelope', (p) => { p.map = m; }); };
  const toggle = (key: 'step' | 'slide' | 'freeze' | 'zoom', label: string) => edit(slotId, label, (p) => { p[key] = !v[key]; });
  const slotEdit = (label: string, f: (s: GbSlot) => void) => editSlot(slotId, bank, index, label, f);
  const playing = mon.playing;

  return (
    <FxPanel width={831} height={561} className="gb-panel">
      <div className="gb-left">
        <LeftBackground />
        <MixKnob k="tmix" x={7} y={5} color={GREEN} label="time" icon="clock" />
        <OptionsButton x={7} y={66} view={v} />
        <HoldButton x={109} y={60} w={63} h={30} />
        {v.opt.clock && <ScratchClock x={187} y={12} w={72} h={71} off={clockOff} />}
        <SlotGrid x={10} y={102} w={248} h={162} bank="tslots" slots={v.tslots} zoom={v.zoom}
          playing={playing ? mon.tPlay : -1} pending={playing ? mon.tPend : -1}
          onSelect={() => setMap(0)} linkOther={(i) => !!v.tslots[i]?.link} />
        <SlotGrid x={10} y={275} w={248} h={162} bank="vslots" slots={v.vslots} zoom={v.zoom}
          playing={playing ? mon.vPlay : -1} pending={playing ? mon.vPend : -1}
          onSelect={() => setMap(1)} linkOther={(i) => !!v.vslots[i]?.link} />
        <IconToggle x={8} y={447 + DY} w={24} h={19} icon="zoom" active={v.zoom} hint="Toggle Envelope Visibility" onClick={() => toggle('zoom', 'Toggle envelope visibility')} />
        <SmallKnob k="att" x={56} y={422 + DY} size={42} />
        <SmallKnob k="rel" x={106} y={422 + DY} size={42} />
        <SmallKnob k="tns" x={159} y={418 + DY} size={48} />
        <div className="fxk-abs gb-knoblabel" style={{ left: 59, top: 459 + DY, width: 36, height: 12, lineHeight: '12px', textAlign: 'center' }}>ATT</div>
        <div className="fxk-abs gb-knoblabel" style={{ left: 111, top: 459 + DY, width: 32, height: 15, lineHeight: '13px', textAlign: 'center' }}>REL</div>
        <div className="fxk-abs gb-knoblabel" style={{ left: 166, top: 459 + DY, width: 34, height: 15, lineHeight: '13px', textAlign: 'center' }}>TNS</div>
        <MixKnob k="vmix" x={7} y={480 + DY} color={ORANGE} label="volume" icon="ramp" />
      </div>

      {/* mapping toolbar */}
      <TabBtn x={270} y={4} w={23} h={27} icon="menu" hint="Options"
        onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenu(r.right, r.top, mappingMenu(slotId, bank, index, slot)); }} />
      <TabSel x={270} y={40} w={23} h={189} n={GB_SNAP.length} value={v.snap}
        onPick={(i) => edit(slotId, 'Snap', (p) => { p.snap = i; })}
        render={(i) => ({ text: GB_SNAP_LABELS[i] })} hint={(i) => `Snap: ${GB_SNAP[i]}`} />
      <TabBtn x={270} y={275} w={23} h={27} icon="step" active={v.step} hint="Step editing (hold shift for pulse mode)" onClick={() => toggle('step', 'Step editing')} />
      <TabBtn x={270} y={301} w={23} h={27} icon="slide" active={v.slide} hint="Slide remaining points" onClick={() => toggle('slide', 'Slide remaining points')} />
      <TabBtn x={270} y={327} w={23} h={27} icon="freeze" active={v.freeze} hint="Freeze editing" onClick={() => toggle('freeze', 'Freeze editing')} />
      <TabSel x={270} y={470} w={23} h={52} n={2} value={v.map} onPick={setMap}
        render={(i, on) => ({ icon: i === 0 ? 'clock' : 'ramp', color: on ? (i === 0 ? GREEN : ORANGE) : '#26333c' })}
        hint={(i) => `Envelope: ${i === 0 ? 'time travel' : 'volume'}`} />

      {slot && <EnvelopeEditor x={298} y={5} bank={bank} index={index} slot={slot} snap={v.snap} step={v.step} slide={v.slide} freeze={v.freeze} />}

      {/* bottom bar */}
      <div className="fxk-abs gb-name" style={{ left: 298, top: 510 + DY, width: 157, height: 22, color: time ? GREEN : ORANGE }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const name = prompt('Slot name', slot?.name ?? '');
          if (name !== null) slotEdit('Rename slot', (s) => { s.name = name.slice(0, 63); });
        }}
        onPointerEnter={() => setHint('Click to rename the selected slot')} onPointerLeave={clearHint}>
        {time ? 'Time' : 'Volume'}: {slot?.name ?? ''}
      </div>
      <BottomToggle x={457 + DX} icon="link" on={!!slot?.link} hint={time ? 'Link volume slot' : 'Link time slot'} onClick={() => slotEdit('Link slots', (s) => { s.link = !s.link; })} />
      <BottomToggle x={480 + DX} icon="keys" on={!!slot?.key} hint="Key-held  (back to previous slot on key release)" onClick={() => slotEdit('Key-held', (s) => { s.key = !s.key; })} />
      <BottomToggle x={503 + DX} icon="one" on={!!slot?.one} hint="One-shot (back to first slot once done)" onClick={() => slotEdit('One-shot', (s) => { s.one = !s.one; })} />
      <Combo x={530 + DX} y={512 + DY} w={76} h={19} caption="HOLD:" options={GB_HOLD} value={slot?.hold ?? 0} hint="Force hold delay (bar repeat)"
        onPick={(i) => slotEdit('Force hold', (s) => { s.hold = i; })} />
      <Combo x={610 + DX} y={512 + DY} w={104} h={19} caption="TRIG SYNC:" options={GB_SYNC} value={slot?.trig ?? 5} hint="Slot trigger synchronization"
        onPick={(i) => slotEdit('Trigger sync', (s) => { s.trig = i; })} />
      <Combo x={718 + DX} y={512 + DY} w={106} h={19} caption="POS SYNC:" options={GB_SYNC} value={slot?.pos ?? 5} hint="Slot position synchronization"
        onPick={(i) => slotEdit('Position sync', (s) => { s.pos = i; })} />
    </FxPanel>
  );
}

function BottomToggle({ x, icon, on, hint, onClick }: { x: number; icon: 'link' | 'keys' | 'one'; on: boolean; hint: string; onClick: () => void }) {
  return (
    <TabLikeButton x={x} y={512 + DY} w={22} h={22} icon={icon} on={on} hint={hint} onClick={onClick} />
  );
}

function TabLikeButton({ x, y, w, h, icon, on, hint, onClick }: { x: number; y: number; w: number; h: number; icon: 'link' | 'keys' | 'one'; on: boolean; hint: string; onClick: () => void }) {
  const col = on ? '#ffffff' : '#1f2b33';
  return (
    <div className={'fxk-abs gb-bbtn' + (on ? ' on' : '')} style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onPointerEnter={() => setHint(`${hint}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
      <svg width={16} height={16} viewBox="0 0 16 16">
        {icon === 'link' && <path d="M6.6 9.4 L9.4 6.6 M5.6 7.6 L4.4 8.8 A2 2 0 0 0 7.2 11.6 L8.4 10.4 M7.6 5.6 L8.8 4.4 A2 2 0 0 1 11.6 7.2 L10.4 8.4" stroke={col} strokeWidth="1.4" fill="none" />}
        {icon === 'keys' && <path d="M3.5 3.5 H12.5 V12.5 H3.5 Z M6.5 9 V12.5 M9.5 9 V12.5 M5.5 3.5 V9 H7.5 V3.5 M8.5 3.5 V9 H10.5 V3.5" stroke={col} strokeWidth="1.1" fill="none" />}
        {icon === 'one' && <text x="8" y="12.5" fontSize="11.5" textAnchor="middle" fill={col} fontFamily="sans-serif" fontStyle="italic">1</text>}
      </svg>
    </div>
  );
}

export const editor: FxEditorModule = {
  id: 'grossbeat',
  Editor: GrossBeatEditor,
  menu: (slotId) => {
    const loc = findFx(Store.store.project, slotId);
    const v = readView((loc?.fx.params ?? {}) as Record<string, unknown>);
    return [{ label: 'Options', submenu: optionsMenu(slotId, v) }];
  },
};
