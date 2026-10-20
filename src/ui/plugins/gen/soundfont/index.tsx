// SoundFont Player editor (FL: Soundfont Player, SynthPanel 370 x 385), at FL's form coordinates: the open button,
// the soundfont's name and the edit button on top, the patch combo, the REVERB / CHORUS groups (SEND TO track,
// the "use level" check, the LEVEL wheel, BUILT-IN), the ENVELOPE 2 sliders (A D S R), the LFO 2 wheels (DEL AMT SPD),
// the MISC wheels (CUT, MOD), the logo and the options button. Colours from the form (#535c62 panel, #5e6a6f
// name / combo, #576066 buttons, #3a5051 send display) and FL's editor thumbnail; original drawing.
// A soundfont comes from the open button, a drop of .sf2 files or the window menu (also "Import FL content...");
// its sample data lives in the project's sample pool, its tables in the state (see ops.ts and
// docs/research/gen/soundfont.md).

import { useMemo } from 'react';
import { CheckView, DigiWheelControl, FxPanel, Label, Slider, Wheel, useFxEditor, useNoScrollWheel, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import type { ControlProps } from '../../../widgets/control';
import { setHint, clearHint, flashHint } from '../../../hint';
import { pickFiles } from '../bassdrum/flimport';
import {
  currentPreset, fontHydra, patchOf, presetList, sfState, type SfPresetEntry, type SfState,
} from '../../../../model/gen/plugins/soundfont/state';
import { current, loadSoundFonts, selectFont, setPatch, setState } from './ops';

const W = 370;
const H = 385;
const COL = {
  bg: '#535c62', group: '#4c555b', title: '#b4bec3', line: '#454e53', label: '#d5dbde', dim: '#929da2',
  face: '#5e6a6f', btn: '#576066', btnHi: '#667178', digi: '#3a5051', check: '#5e656c', sub: '#464f55',
  logo: '#434c51', logo2: '#79858b', wheel: '#e6ebee', track: '#2d363a',
};

const MSG_OPEN = 'Open SoundFont...';
const MSG_FL = 'Pick your own FL Studio soundfonts: Data/Patches/Soundfonts/STR_Ensemble.sf2 or Plugins/Fruity/Generators/Soundfont Player/Data/Default.sf2';

/** FL's resampling menu (SetResampling modes), program modes and the other options. */
const RESAMPLING: [number, string][] = [[1, 'Crunchy'], [4, 'Standard'], [6, 'HQ'], [8, 'Extreme HQ']];
const PROGRAM_MODES = ['Automatic', 'Instrument', 'Drum'];

function isSf2(f: File): boolean {
  return /\.sf2$/i.test(f.name);
}

/** Open the file picker and load the chosen soundfonts. */
function openFiles(slotId: string): void {
  void pickFiles('.sf2,.SF2').then((fs) => {
    const sf = fs.filter(isSf2);
    if (fs.length && !sf.length) { flashHint('Not a SoundFont (.sf2) file.'); return; }
    if (sf.length) void loadSoundFonts(slotId, sf).then(flashHint);
  });
}

/** FL's "Loaded SoundFonts" list: the soundfonts of the state, the active one marked. */
function fontItems(slotId: string, s: SfState): MenuItem[] {
  const items: MenuItem[] = [{ header: true, label: 'Loaded SoundFonts' }];
  if (!s.fonts.length) items.push({ label: '(none)', disabled: true });
  s.fonts.forEach((f, i) => items.push({ label: f.name, radio: true, checked: i === s.active, onClick: () => selectFont(slotId, i) }));
  return items;
}

/** The soundfont, resampling, program mode and option entries (FL's options menu / the window menu). */
function optionItems(slotId: string, s: SfState): MenuItem[] {
  const items: MenuItem[] = fontItems(slotId, s);
  items.push({ separator: true }, { header: true, label: 'Resampling' });
  for (const [v, name] of RESAMPLING) {
    items.push({ label: name, radio: true, checked: s.resampling === v, onClick: () => setState(slotId, 'Resampling', 'resampling', v) });
  }
  items.push({ separator: true }, { header: true, label: 'Program mode' });
  PROGRAM_MODES.forEach((name, i) => {
    items.push({ label: name, radio: true, checked: s.programMode === i, onClick: () => setState(slotId, 'Program mode', 'programMode', i) });
  });
  items.push(
    { separator: true }, { header: true, label: 'Other options' },
    { label: 'Velocity filter cutoff', checked: s.velFc, onClick: () => setState(slotId, 'Velocity filter cutoff', 'velFc', !s.velFc) },
    { label: 'EMU volume envelope', checked: s.emu, onClick: () => setState(slotId, 'EMU volume envelope', 'emu', !s.emu) },
    { label: 'Fix unexpected levels', checked: s.ignoreLinks, hint: 'Ignore sample links', onClick: () => setState(slotId, 'Fix unexpected levels', 'ignoreLinks', !s.ignoreLinks) },
    { separator: true },
    { label: 'Select SoundFont editing tool...', disabled: true },
  );
  return items;
}

/** The text of a patch list entry: program number (bank before it when not 0) and the preset's name. */
function patchText(e: SfPresetEntry | undefined): string {
  if (!e) return '';
  return `${e.bank ? `${e.bank}:` : ''}${String(e.program + 1).padStart(3, '0')}  ${e.name}`;
}

/** A cog outline (8 teeth) for the options button. */
const GEAR = (() => {
  const pts: string[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i * Math.PI) / 8 - Math.PI / 16;
    const r = i % 2 === 0 ? 7.2 : 5.4;
    pts.push(`${(8 + r * Math.cos(a)).toFixed(2)} ${(8 + r * Math.sin(a)).toFixed(2)}`);
    const a2 = a + Math.PI / 16 * 0.9;
    pts.push(`${(8 + r * Math.cos(a2)).toFixed(2)} ${(8 + r * Math.sin(a2)).toFixed(2)}`);
  }
  return 'M' + pts.join(' L') + ' Z';
})();

/** A group (the form's panel with its title). */
function Group({ x, y, w, h, title, children }: { x: number; y: number; w: number; h: number; title: string; children?: React.ReactNode }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: COL.group, borderRadius: 2, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), inset 0 0 0 1px rgba(0,0,0,0.16)' }}>
      <div className="fxk-abs" style={{ left: 7, top: 2, height: 13, color: COL.title, font: 'bold 9px Arial, sans-serif', letterSpacing: '0.05em', lineHeight: '13px', pointerEvents: 'none' }}>{title}</div>
      {children}
    </div>
  );
}

/** A glassy form button (TQuickBtn, FS_SoberGlass). */
function GlassBtn({ x, y, w, h, hint, onClick, children }: { x: number; y: number; w: number; h: number; hint: string; onClick: (e: React.PointerEvent) => void; children?: React.ReactNode }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 2, cursor: 'default', color: COL.label, background: `linear-gradient(${COL.btnHi}, ${COL.btn} 55%, #4d565c)`, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12)' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      {children}
    </div>
  );
}

/** A plain form field (TQuickBtn / TQuickCombo, FS_SoberPlain): text and an optional drop arrow. */
function Field({ x, y, w, h, text, dim, arrow, hint, onClick, onWheel }: { x: number; y: number; w: number; h: number; text: string; dim?: boolean; arrow?: boolean; hint: string; onClick: (e: React.PointerEvent<HTMLDivElement>) => void; onWheel?: (dir: number) => void }) {
  const ref = useNoScrollWheel<HTMLDivElement>();
  return (
    <div ref={ref} className="fxk-abs" onWheel={onWheel ? (e) => { if (e.deltaY) onWheel(e.deltaY > 0 ? 1 : -1); } : undefined} style={{ left: x, top: y, width: w, height: h, background: COL.face, borderRadius: 2, boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(0,0,0,0.12)', color: dim ? COL.dim : '#eef2f4', font: '12px Arial, sans-serif', lineHeight: `${h}px`, paddingLeft: 7, paddingRight: arrow ? 20 : 7, boxSizing: 'border-box', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      {text}
      {arrow && <svg width="9" height="6" viewBox="0 0 9 6" style={{ position: 'absolute', right: 7, top: (h - 6) / 2 }}><path d="M0 0 L9 0 L4.5 6 Z" fill="#c4ccd0" /></svg>}
    </div>
  );
}

/** The SEND TO display (TVectorDigiWheel): the mixer track offset, dots when there is none (the built-in effect). */
function sendControl(slotId: string, key: 'revTo' | 'chorTo', value: number, label: string): ControlProps {
  return {
    value, min: -125, max: 125, defaultValue: 0, step: 1, label,
    format: (v) => (v === 0 ? '⋯' : String(v)),
    onChange: (v) => setState(slotId, label, key, v, key),
  };
}

/** One send group (REVERB or CHORUS): SEND TO, the use-level check, the LEVEL wheel and the BUILT-IN check. */
function SendGroup({ slotId, s, chorus, x }: { slotId: string; s: SfState; chorus: boolean; x: number }) {
  const to = chorus ? s.chorTo : s.revTo;
  const useLevel = chorus ? s.useChorLevel : s.useRevLevel;
  const on = chorus ? s.chorOn : s.revOn;
  const what = chorus ? 'chorus' : 'reverb';
  const WHAT = chorus ? 'Chorus' : 'Reverb';
  // positions of the form (reverb at the left, chorus 183 px to the right)
  const o = chorus ? 183 : 0;
  return (
    <>
      <Group x={x} y={77} w={178} h={81} title={WHAT.toUpperCase()} />
      <div className="fxk-abs" style={{ left: 22 + o, top: 107, width: 50, height: 17, background: COL.sub, borderRadius: 4, color: COL.label, font: 'bold 9px Arial, sans-serif', lineHeight: '17px', textAlign: 'center', pointerEvents: 'none' }}>SEND TO</div>
      <DigiWheelControl x={75 + o} y={104} w={38} h={23} control={sendControl(slotId, chorus ? 'chorTo' : 'revTo', to, `${WHAT} send track`)} text={(v) => (v === 0 ? '⋯' : String(v))} />
      <CheckView x={116 + o} y={107} w={21} h={17} on={useLevel} hint="Disable for preset default"
        onToggle={() => setState(slotId, `${WHAT} send level`, chorus ? 'useChorLevel' : 'useRevLevel', !useLevel)} />
      <Wheel k={chorus ? 'chorSend' : 'revSend'} x={133 + o} y={96} size={38} look="flat" color={COL.wheel} track={COL.track} />
      <Label x={133 + o} y={chorus ? 138 : 139} w={38} h={11} size={8} bold color={COL.label}>LEVEL</Label>
      <CheckView x={chorus ? 190 : 6} y={chorus ? 134 : 135} w={64} h={17} caption="BUILT-IN" on={on} hint={`Enable built-in ${what}`}
        onToggle={() => setState(slotId, `${WHAT} built-in`, chorus ? 'chorOn' : 'revOn', !on)} />
    </>
  );
}

function SoundFontEditor() {
  const { params, slotId } = useFxEditor();
  const s: SfState = sfState(params);
  const font = s.fonts[s.active];
  const patch = useParam('patch').value;
  const bank = useParam('bank').value;
  const list = useMemo(() => presetList(fontHydra(font)), [font?.hydra]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = currentPreset(list, patch, bank);

  const onDrop = (e: React.DragEvent) => {
    const fs = [...(e.dataTransfer.files ?? [])];
    if (!fs.length) return;
    e.preventDefault();
    const sf = fs.filter(isSf2);
    if (!sf.length) { flashHint('Not a SoundFont (.sf2) file.'); return; }
    void loadSoundFonts(slotId, sf).then(flashHint);
  };

  const patchMenu = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!list.length) { openMenu(r.left, r.bottom, [{ label: font ? '(no presets)' : 'Open a SoundFont first', disabled: true }], { minWidth: r.width }); return; }
    openMenu(r.left, r.bottom, list.map((p): MenuItem => ({
      label: patchText(p), radio: true, checked: p === cur,
      onClick: () => { const q = patchOf(p.bank, p.program); setPatch(slotId, q.patch, q.bank); },
    })), { minWidth: r.width });
  };

  // the wheel over the combo steps through the list (FL's combo boxes do)
  const stepPatch = (dir: number) => {
    if (!list.length) return;
    const i = Math.max(0, list.findIndex((p) => p === cur));
    const p = list[Math.min(list.length - 1, Math.max(0, i + dir))];
    if (p !== cur) { const q = patchOf(p.bank, p.program); setPatch(slotId, q.patch, q.bank); }
  };

  const fontsMenu = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    openMenu(r.left, r.bottom, [...fontItems(slotId, s), { separator: true }, { label: MSG_OPEN, onClick: () => openFiles(slotId) }], { minWidth: r.width });
  };

  return (
    <FxPanel width={W} height={H} style={{ background: COL.bg }}>
      <div className="fxk-abs" style={{ left: 0, top: 0, width: W, height: H }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
        onDrop={onDrop}>
        <GlassBtn x={9} y={9} w={31} h={24} hint={MSG_OPEN} onClick={() => openFiles(slotId)}>
          <svg width="18" height="14" viewBox="0 0 18 14"><path d="M1 2 H6.5 L8 3.8 H16.5 V12.5 H1 Z" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
        </GlassBtn>
        <Field x={43} y={9} w={283} h={24} text={font ? font.name : 'No SoundFont loaded'} dim={!font} hint="Soundfont name" onClick={fontsMenu} />
        <GlassBtn x={329} y={9} w={31} h={24} hint="Edit SoundFont..." onClick={() => flashHint('Edit SoundFont...: FL starts its external SoundFont editing tool, which is not available here')}>
          <svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 14 L2.8 10.6 L10.6 2.8 L13.2 5.4 L5.4 13.2 Z M9.4 4 L12 6.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
        </GlassBtn>
        <Label x={10} y={36} w={80} h={10} size={8} bold color={COL.dim} align="left">PATCH NAME</Label>
        <Field x={9} y={48} w={351} h={24} text={patchText(cur)} arrow hint="Patch" onClick={patchMenu} onWheel={stepPatch} />

        <SendGroup slotId={slotId} s={s} chorus={false} x={3} />
        <SendGroup slotId={slotId} s={s} chorus x={186} />

        <Group x={3} y={166} w={176} h={170} title="ENVELOPE 2" />
        <Slider k="envAtk" x={19} y={185} w={26} h={125} />
        <Slider k="envDec" x={59} y={185} w={26} h={125} />
        <Slider k="envSus" x={99} y={185} w={26} h={125} />
        <Slider k="envRel" x={140} y={185} w={26} h={125} />
        <Label x={16} y={318} w={32} h={11} size={9} bold color={COL.label}>A</Label>
        <Label x={56} y={318} w={32} h={11} size={9} bold color={COL.label}>D</Label>
        <Label x={96} y={318} w={32} h={11} size={9} bold color={COL.label}>S</Label>
        <Label x={137} y={318} w={32} h={11} size={9} bold color={COL.label}>R</Label>

        <Group x={186} y={166} w={178} h={88} title="LFO 2" />
        <Wheel k="lfoDelay" x={209} y={185} size={42} look="flat" color={COL.wheel} track={COL.track} />
        <Wheel k="lfoAmt" x={262} y={185} size={42} look="flat" color={COL.wheel} track={COL.track} />
        <Wheel k="lfoSpeed" x={314} y={185} size={42} look="flat" color={COL.wheel} track={COL.track} />
        <Label x={211} y={229} w={38} h={11} size={8} bold color={COL.label}>DEL</Label>
        <Label x={264} y={229} w={38} h={11} size={8} bold color={COL.label}>AMT</Label>
        <Label x={316} y={229} w={38} h={11} size={8} bold color={COL.label}>SPD</Label>

        <Group x={186} y={258} w={178} h={78} title="MISC" />
        <Wheel k="cutoff" x={262} y={274} size={42} look="flat" color={COL.wheel} track={COL.track} />
        <Wheel k="mod" x={314} y={274} size={42} look="flat" color={COL.wheel} track={COL.track} />
        <Label x={264} y={320} w={38} h={11} size={8} bold color={COL.label}>CUT</Label>
        <Label x={316} y={320} w={38} h={11} size={8} bold color={COL.label}>MOD</Label>

        <div className="fxk-abs" style={{ left: 151, top: 353, width: 212, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', font: 'bold 17px Arial, sans-serif', letterSpacing: '0.02em', pointerEvents: 'none', whiteSpace: 'pre' }}>
          <span style={{ color: COL.logo }}>SOUNDFONT</span><span style={{ color: COL.logo2 }}> PLAYER</span>
        </div>
        <GlassBtn x={5} y={360} w={20} h={20} hint="Options" onClick={(e) => openMenu(e.clientX, e.clientY, optionItems(slotId, s))}>
          <svg width="14" height="14" viewBox="0 0 16 16"><path d={GEAR} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
        </GlassBtn>
      </div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'soundfont',
  Editor: SoundFontEditor,
  menu: (slotId) => [
    { label: MSG_OPEN, onClick: () => openFiles(slotId) },
    { label: 'Import FL content...', hint: MSG_FL, onClick: () => { flashHint(MSG_FL); openFiles(slotId); } },
    { separator: true },
    ...optionItems(slotId, current(slotId)),
  ],
};
