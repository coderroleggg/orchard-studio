// VFX Script editor (FL: 799 x 521). Sheets: User interface (the controls the
// script's createDialog() defines, bound to the automatable script controls),
// Script (Compile, Restart, the options menu, the line / column label, the
// code memo with Python highlighting and the error memo), Log (print output;
// Backspace clears it) and API reference. "Hide script tabs" (options menu)
// keeps only the User interface; the button in the title band shows them again.

import { useMemo, useRef, useState } from 'react';
import { FxPanel, WheelControl, useFxEdit, useFxEditor, useFxView, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { SCRIPT_CONTROLS, compiledState, controlPos, controlValue, ctlKey } from '../../../../model/fx/plugins/vfxscript';
import { compileScript, type ScriptControl, type ScriptDialogInfo } from '../../../../model/fx/plugins/vfx/vfxrun';
import { SheetTabs, VfxTitle } from '../vfx/common';
import './vfxscript.css';
import { pluginTargetOf } from '../../../../model/fx/hosted';

const PY_KW = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);

/** Python highlighting as spans (FL's memo: keywords purple, strings brown-red, operators orange, comments green). */
function highlight(code: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|(#[^\n]*)|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_][A-Za-z_0-9]*)|([()[\]{}:,.=+\-*/%<>!&|^~@])/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const [txt, s, c, n, w, op] = m;
    if (s) out.push(<span key={k++} className="py-str">{txt}</span>);
    else if (c) out.push(<span key={k++} className="py-com">{txt}</span>);
    else if (n) out.push(<span key={k++} className="py-num">{txt}</span>);
    else if (w) out.push(PY_KW.has(w) ? <span key={k++} className="py-kw">{txt}</span> : txt);
    else if (op) out.push(<span key={k++} className="py-op">{txt}</span>);
    last = m.index + txt.length;
  }
  if (last < code.length) out.push(code.slice(last));
  out.push('\n');
  return out;
}

function ControlRow({ c, i, x, y }: { c: ScriptControl; i: number; x: number; y: number }) {
  const { slotId, params, pluginName, trackName } = useFxEditor();
  const edit = useFxEdit();
  const span = c.max - c.min;
  const fmt = (pos: number) => {
    const v = controlValue(c, pos);
    if (c.kind === 'combo') return c.options?.[v] ?? String(v);
    if (c.kind === 'check') return v ? 'On' : 'Off';
    if (c.kind === 'knobInt') return String(v);
    return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(Math.abs(span) <= 2 ? 2 : 1);
  };
  const p = useParam(ctlKey(i), {
    label: c.label,
    format: fmt,
    step: c.kind === 'knobInt' || c.kind === 'combo' ? 1 / Math.max(1, span) : 0,
    defaultValue: controlPos(c, Number(c.def)),
    auto: { ...pluginTargetOf(slotId, ctlKey(i)), label: `${pluginName} (${trackName}) - ${c.name}`, min: 0, max: 1, step: 0 },
  });
  const texts = (params.texts ?? {}) as Record<string, string>;
  const label = <div className="fxk-abs vfxs-ctl-label" style={{ left: x, top: y + 6, width: 130 }}>{c.label}</div>;
  if (c.kind === 'text') {
    return (
      <>
        {label}
        <input className="fxk-abs vfxs-ctl-text" style={{ left: x + 138, top: y + 4, width: 200, height: 22 }} value={texts[c.name] ?? String(c.def)}
          onChange={(e) => { const v = e.target.value; edit(c.label, (q) => { q.texts = { ...(q.texts as Record<string, string> ?? {}), [c.name]: v }; }, `vfxs-text:${slotId}:${c.name}`); }}
          onPointerEnter={() => setHint(c.hint || c.label)} onPointerLeave={clearHint} />
      </>
    );
  }
  if (c.kind === 'check') {
    const on = controlValue(c, p.value) === 1;
    return (
      <>
        {label}
        <div className={'fxk-abs vfxs-ctl-check' + (on ? ' on' : '')} style={{ left: x + 140, top: y + 6, width: 18, height: 18 }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); } }}
          onContextMenu={(e) => e.preventDefault()}
          onPointerEnter={() => setHint(`${c.hint || c.label}: ${on ? 'On' : 'Off'}`)} onPointerLeave={clearHint} />
      </>
    );
  }
  if (c.kind === 'combo') {
    const idx = controlValue(c, p.value);
    return (
      <>
        {label}
        <div className="fxk-abs vfxs-ctl-combo" style={{ left: x + 138, top: y + 4, width: 140, height: 22 }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openMenu(r.left, r.bottom, (c.options ?? []).map((o, k) => ({ label: o, radio: true, checked: k === idx, onClick: () => { p.control.onBegin?.(); p.set(controlPos(c, k)); p.control.onEnd?.(); } } as MenuItem)), { minWidth: r.width });
          }}
          onPointerEnter={() => setHint(`${c.hint || c.label}: ${c.options?.[idx] ?? ''}`)} onPointerLeave={clearHint}>
          <span>{c.options?.[idx] ?? ''}</span>
          <svg width="6" height="9" viewBox="0 0 6 9"><path d="M0.5 0.5 L5.5 4.5 L0.5 8.5 Z" fill="#9aa5ab" /></svg>
        </div>
      </>
    );
  }
  return (
    <>
      {label}
      <WheelControl x={x + 138} y={y} size={30} look="flat" color="#5ec8ff" track="#2b3236" control={p.control} />
      <div className="fxk-abs vfxs-ctl-value" style={{ left: x + 174, top: y + 6, width: 70 }}>{fmt(p.value)}</div>
    </>
  );
}

function UserInterface({ dialog }: { dialog: ScriptDialogInfo | null }) {
  const controls = (dialog?.controls ?? []).slice(0, SCRIPT_CONTROLS);
  const rows: { c: ScriptControl; i: number; head?: string }[] = [];
  let group = '';
  controls.forEach((c, i) => {
    if (c.group !== group) { group = c.group; if (group) rows.push({ c, i: -1, head: group }); }
    rows.push({ c, i });
  });
  const perCol = 11;
  return (
    <>
      <div className="fxk-abs vfxs-desc" style={{ left: 14, top: 33 + 10, width: 770, height: 40 }}>
        {dialog?.title ? <b>{dialog.title} </b> : null}{dialog?.description || (controls.length ? '' : 'This script has no user interface.')}
      </div>
      {dialog?.surface && <div className="fxk-abs vfxs-desc" style={{ left: 14, top: 33 + 50, width: 770 }}>(Embedded control surfaces are not available in this version.)</div>}
      {rows.map((r, k) => {
        const col = Math.floor(k / perCol), row = k % perCol;
        const x = 14 + col * 390, y = 33 + 56 + row * 33;
        return r.head
          ? <div key={`h${k}`} className="fxk-abs vfxs-group" style={{ left: x, top: y + 8, width: 360 }}>{r.head}</div>
          : <ControlRow key={`${r.i}-${r.c.name}`} c={r.c} i={r.i} x={x} y={y} />;
      })}
    </>
  );
}

const API_TEXT = `flvfx module (import flvfx as vfx)

vfx.context
  ticks          current song position in ticks
  PPQ            ticks per quarter note
  tempo          tempo in BPM
  isPlaying      True while the transport plays
  voices         the voices this script has triggered and not released
  form           the script's dialog (getInputValue / setNormalizedValue)

vfx.addOutputController(name, default)    define an output controller
vfx.setOutputController(name, value)      set its value

vfx.Voice() / vfx.Voice(otherVoice)       a new voice (a copy of otherVoice)
  note           note number, fractional for microtuning
  finePitch      extra pitch in note numbers
  velocity       0 .. 1
  pan            -1 (left) .. 1 (right)
  length         ticks; when set the voice releases itself
  output         voice output (0 based)
  fcut, fres     Mod X / Mod Y, -1 .. 1
  color          note colour 0 .. 15
  trigger()      start the voice
  release()      end the voice
  copyFrom(v)    copy v's properties (follows slides)

vfx.ScriptDialog(title, description)
  addInputKnob(name, default, min, max, hint)
  addInputKnobInt(name, default, min, max, hint)
  addInputCheckbox(name, default, hint)
  addInputCombo(name, options, defaultIndex, hint)
  addInputText(name, defaultText, hint)
  addGroup(name) / endGroup()      grouped controls are named 'Group: Name'
  getInputValue(name), setNormalizedValue(name, value)

Handlers
  createDialog()                 returns the ScriptDialog
  onTriggerVoice(incomingVoice)  a note starts
  onReleaseVoice(incomingVoice)  a note ends (the same object)
  onTick()                       every tick

This version runs scripts on a built-in interpreter for a subset of Python 3:
functions, classes, lists, dicts, comprehensions, f-strings, exceptions, and
the math and random modules. Other modules are not available.`;

function ScriptEditor() {
  const { slotId, params } = useFxEditor();
  const editFx = useFxEdit();
  const edit = useFxEdit();
  const writeView = useFxView();
  const code = typeof params.code === 'string' ? params.code : '';
  const error = typeof params.error === 'string' ? params.error : '';
  const log = typeof params.log === 'string' ? params.log : '';
  const dialog = (params.dialog as ScriptDialogInfo | undefined) ?? null;
  const tab = Math.round(Number(params.tab ?? 0)) || 0;
  const hideTabs = Number(params.hideTabs ?? 0) >= 1;
  const [pos, setPos] = useState('(1, 1)');
  const preRef = useRef<HTMLPreElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hl = useMemo(() => highlight(code), [code]);
  const setUi = (patch: Record<string, number>) => writeView('Script view', (p) => { Object.assign(p, patch); });
  const compile = () => {
    const c = compileScript(code);
    if (c.error) {
      editFx('Compile script', (p) => { p.error = c.error; p.log = c.log; });
      return;
    }
    const fresh = compiledState(code);
    const old = (dialog?.controls ?? []);
    editFx('Compile script', (p) => {
      const prev = old.map((oc, k) => ({ name: oc.name, kind: oc.kind, pos: p[ctlKey(k)] }));
      Object.assign(p, fresh);
      // controls keep their values by name
      ((fresh.dialog as ScriptDialogInfo).controls).forEach((nc, k) => {
        const o = prev.find((x) => x.name === nc.name && x.kind === nc.kind);
        if (o && typeof o.pos === 'number' && k < SCRIPT_CONTROLS) p[ctlKey(k)] = o.pos;
      });
    });
  };
  const restart = () => {
    const c = compileScript(typeof params.compiled === 'string' ? params.compiled : code);
    writeView('Restart script', (p) => { p.log = c.log; p.error = c.error ?? ''; });
  };
  const caret = () => {
    const ta = taRef.current;
    if (!ta) return;
    const before = ta.value.slice(0, ta.selectionStart);
    const line = before.split('\n').length, col = before.length - before.lastIndexOf('\n');
    setPos(`(${line}, ${col})`);
  };
  const tabs = hideTabs ? [{ label: 'User interface', w: 118 }] : [{ label: 'User interface', w: 118 }, { label: 'Script', w: 62 }, { label: 'Log', w: 44 }, { label: 'API reference', w: 112 }];
  const shown = hideTabs ? 0 : tab;
  return (
    <FxPanel width={799} height={521} style={{ background: '#4e585e' }}>
      <div className="fxk-abs" style={{ left: 0, top: 0, width: 799, height: 33, background: '#454f55' }} />
      <SheetTabs x={8} y={4} h={29} value={shown} onChange={(i) => setUi({ tab: i })}
        look={{ on: '#4e585e', off: '#3c444c', onText: '#fbdf4c', offText: '#c9d2d7', font: '15px var(--font-ui)', slant: 12, line: '#363f44' }} tabs={tabs} />
      {shown === 0 && <UserInterface dialog={dialog} />}
      {shown === 1 && (
        <>
          <div className="fxk-abs vfxs-btn" style={{ left: 6, top: 33 + 6, width: 105, height: 30 }}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); compile(); } }}
            onPointerEnter={() => setHint('Compile and run the script')} onPointerLeave={clearHint}>C<u>o</u>mpile</div>
          <div className="fxk-abs vfxs-btn" style={{ left: 116, top: 33 + 6, width: 105, height: 30 }}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); restart(); } }}
            onPointerEnter={() => setHint('Restart the script without resetting the user interface')} onPointerLeave={clearHint}><u>R</u>estart</div>
          <div className="fxk-abs vfxs-menubtn" style={{ left: 768, top: 33 + 6, width: 25, height: 21 }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              openMenu(e.clientX, e.clientY, [
                { label: 'Embed surface preset...', disabled: true },
                { label: 'Remove embedded surface preset', disabled: true },
                { label: 'Save embedded surface preset...', disabled: true },
                { separator: true },
                { label: 'Hide script tabs', checked: hideTabs, onClick: () => setUi({ hideTabs: hideTabs ? 0 : 1, tab: 0 }) },
                { separator: true },
                { label: 'Select external editor...', disabled: true },
                { label: 'Open script in external editor', disabled: true },
              ]);
            }}
            onPointerEnter={() => setHint('Options')} onPointerLeave={clearHint}>
            <svg width="6" height="9" viewBox="0 0 6 9"><path d="M0.5 0.5 L5.5 4.5 L0.5 8.5 Z" fill="#e3e8ea" /></svg>
          </div>
          <div className="fxk-abs vfxs-linenr" style={{ left: 719, top: 33 + 29, width: 74, height: 15 }}>{pos}</div>
          <div className="fxk-abs vfxs-code" style={{ left: 6, top: 33 + 44, width: 787, height: 272 }}>
            <pre ref={preRef} className="vfxs-hl" aria-hidden>{hl}</pre>
            <textarea ref={taRef} className="vfxs-ta" value={code} spellCheck={false} wrap="off"
              onChange={(e) => { const v = e.target.value; edit('Edit script', (p) => { p.code = v; }, `vfxs-code:${slotId}`); }}
              onScroll={(e) => { const t = e.currentTarget; if (preRef.current) { preRef.current.scrollTop = t.scrollTop; preRef.current.scrollLeft = t.scrollLeft; } }}
              onSelect={caret} onKeyUp={caret} onClick={caret}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Tab') {
                  e.preventDefault();
                  const t = e.currentTarget, s = t.selectionStart, en = t.selectionEnd;
                  const v = t.value.slice(0, s) + '  ' + t.value.slice(en);
                  edit('Edit script', (p) => { p.code = v; }, `vfxs-code:${slotId}`);
                  requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = s + 2; });
                }
                if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.key === 'o')) { e.preventDefault(); compile(); }
              }} />
          </div>
          <div className="fxk-abs vfxs-error" style={{ left: 3, top: 33 + 322, width: 793, height: 104 }}>{error}</div>
        </>
      )}
      {shown === 2 && (
        <>
          <div className="fxk-abs vfxs-loglabel" style={{ left: 8, top: 33 + 10, width: 400, height: 15 }}>Use print-function in script to output text to this log</div>
          <pre className="fxk-abs vfxs-log" tabIndex={0} style={{ left: 3, top: 33 + 28, width: 793, height: 401 }}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Backspace') { e.preventDefault(); writeView('Clear log', (p) => { p.log = ''; }); } }}>{log}</pre>
        </>
      )}
      {shown === 3 && <pre className="fxk-abs vfxs-log" style={{ left: 3, top: 33 + 3, width: 793, height: 426 }}>{API_TEXT}</pre>}
      <VfxTitle y={465} w={799} h={56} name="Script" />
      {hideTabs && (
        <div className="fxk-abs vfxs-menubtn" style={{ left: 770, top: 495, width: 25, height: 21 }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setUi({ hideTabs: 0 }); } }}
          onPointerEnter={() => setHint('Show script tabs')} onPointerLeave={clearHint}>
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 3 H9 M1 5 H9 M1 7 H9" stroke="#e3e8ea" strokeWidth="1.2" /></svg>
        </div>
      )}
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'vfxscript', Editor: ScriptEditor };
