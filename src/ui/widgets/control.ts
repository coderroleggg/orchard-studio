// Shared drag / wheel / context-menu behaviour for knobs, faders and sliders.

import { useRef, useCallback } from 'react';
import { clamp } from '../../engine/dsp/math';
import { setHint, clearHint, flashHint } from '../hint';
import { openMenu, type MenuItem } from './ContextMenu';
import { store } from '../../store';
import { sameTarget, type AutomationTarget } from '../../model/automation';
import { createAutomationClip, deleteInitialValue, hasInitialValue, initSongWithPosition, openAutomationWindow } from '../../store/actions';
import { openLinkDialog } from '../link/RemoteControlDialog';

/** Knob / slider tweaks are flagged so undo can skip them ("Undo knob tweaks" off). */
function begin(cp: ControlProps): void {
  store.nextGestureIsKnob = true;
  cp.onBegin?.();
  store.nextGestureIsKnob = false;
}

export interface ControlProps {
  value: number;
  min?: number;
  max?: number;
  defaultValue: number;
  label: string;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  onBegin?: () => void;
  onEnd?: () => void;
  /** Pixels of mouse travel for the full range. */
  travel?: number;
  /** Quantisation step in value units (0 = continuous). */
  step?: number;
  disabled?: boolean;
  extraMenu?: MenuItem[];
  /** Convert a typed-in number (in display units) to a control value. Default: percent. */
  parse?: (typed: number) => number;
  /**
   * Makes the control automatable: the parameter it edits. min / max default to
   * the control's own range (use explicit values when the control maps them).
   */
  auto?: AutoSpec;
}

export interface AutoSpec {
  scope: AutomationTarget['scope'];
  id: string;
  path: string;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
}

/** Build a full automation target for a control. */
export function autoTargetOf(p: ControlProps): AutomationTarget | null {
  const a = p.auto;
  if (!a) return null;
  return {
    scope: a.scope, id: a.id, path: a.path,
    min: a.min ?? p.min ?? 0, max: a.max ?? p.max ?? 1, step: a.step ?? p.step,
    label: a.label ?? p.label,
  };
}

let clipboardValue: number | null = null;

/**
 * The Automation and Remote control sections of a control's right-click menu
 * (FL's WheelMenu): Edit events, Init song with this position, Delete initial
 * value, Create automation clip, Edit automation clip... (a "Choose a clip"
 * list when several clips drive the control), Link to controller... (the
 * Remote control settings dialog). Features this clone lacks are shown disabled.
 */
export function automationMenuItems(target: AutomationTarget | null, x: number, y: number): MenuItem[] {
  const linked = target ? store.project.automation.filter((a) => sameTarget(a.target, target)) : [];
  const editClip = () => {
    if (linked.length === 1) { openAutomationWindow(linked[0].id); return; }
    openMenu(x, y, [{ header: true, label: 'Choose a clip' }, ...linked.map((a) => ({ label: a.name, onClick: () => openAutomationWindow(a.id) }))]);
  };
  return [
    { header: true, label: 'Automation' },
    { label: 'Edit events', disabled: true },
    { label: 'Init song with this position', disabled: !target, onClick: () => { if (target) initSongWithPosition(target); } },
    { label: 'Delete initial value', disabled: !target || !hasInitialValue(target), onClick: () => { if (target) deleteInitialValue(target); } },
    { separator: true },
    { label: 'Create automation clip', disabled: !target, onClick: () => { if (target) createAutomationClip(target); } },
    { label: 'Edit automation clip...', disabled: linked.length === 0, onClick: editClip },
    { header: true, label: 'Remote control' },
    { label: 'Link to controller...', disabled: !target, onClick: () => { if (target) openLinkDialog(target); } },
  ];
}

export function defaultFormat(v: number, min: number, max: number): string {
  return `${Math.round(((v - min) / (max - min)) * 100)}%`;
}

export function useControl(p: ControlProps, orientation: 'vertical' | 'horizontal' = 'vertical') {
  const min = p.min ?? 0;
  const max = p.max ?? 1;
  const propsRef = useRef(p);
  propsRef.current = p;
  const drag = useRef<{ start: number; startValue: number; acc: number; last: number; detent: number } | null>(null);

  const fmt = (v: number) => (propsRef.current.format ? propsRef.current.format(v) : defaultFormat(v, min, max));
  const showHint = (v: number) => setHint(`${propsRef.current.label}: ${fmt(v)}`);

  const quant = (v: number) => {
    const s = propsRef.current.step ?? 0;
    const q = s > 0 ? Math.round((v - min) / s) * s + min : v;
    return clamp(q, min, max);
  };

  const set = (v: number) => {
    const q = quant(v);
    if (q !== propsRef.current.value) propsRef.current.onChange(q);
    showHint(q);
  };

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const cp = propsRef.current;
    if (cp.disabled) return;
    // Alt+click or middle-click resets to the default value
    if ((e.button === 0 && e.altKey) || e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      begin(cp);
      set(cp.defaultValue);
      cp.onEnd?.();
      return;
    }
    if (e.button === 0) {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      const pos = orientation === 'vertical' ? e.clientY : e.clientX;
      drag.current = { start: pos, startValue: cp.value, acc: cp.value, last: pos, detent: 0 };
      document.body.classList.add('dragging-control');
      begin(cp);
      showHint(cp.value);
    }
  }, [orientation]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) {
      if (!propsRef.current.disabled) showHint(propsRef.current.value);
      return;
    }
    const pos = orientation === 'vertical' ? e.clientY : e.clientX;
    let delta = orientation === 'vertical' ? d.last - pos : pos - d.last;
    d.last = pos;
    const travel = propsRef.current.travel ?? 180;
    const fine = e.ctrlKey || e.metaKey || (e.buttons & 3) === 3 ? 0.1 : 1; // Ctrl (or both buttons) = fine
    // pause briefly at the default value while dragging across it (Shift skips the pause)
    const def = propsRef.current.defaultValue;
    if (d.detent > 0 && !e.shiftKey) {
      d.detent -= Math.abs(delta);
      if (d.detent > 0) return;
      delta = 0;
    }
    const next = clamp(d.acc + (delta / travel) * (max - min) * fine, min, max);
    if (!e.shiftKey && def > min && def < max && (d.acc - def) * (next - def) < 0) {
      d.acc = def;
      d.detent = 10;
      set(def);
      return;
    }
    d.acc = next;
    set(d.acc);
  }, [orientation, min, max]);

  const endDrag = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove('dragging-control');
    propsRef.current.onEnd?.();
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    const cp = propsRef.current;
    if (cp.disabled) return;
    e.stopPropagation();
    const dir = e.deltaY < 0 ? 1 : -1;
    const stepSize = cp.step && cp.step > 0 ? cp.step : (max - min) / (e.ctrlKey || e.metaKey ? 500 : 50);
    begin(cp);
    set(cp.value + dir * stepSize);
    cp.onEnd?.();
  }, [min, max]);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const cp = propsRef.current;
    if (cp.disabled) return;
    // FL's control menu order: Reset, context items, Automation, Remote control, Value
    const items: MenuItem[] = [
      { label: 'Reset', onClick: () => { begin(cp); set(cp.defaultValue); cp.onEnd?.(); } },
      ...(cp.extraMenu ?? []),
      ...automationMenuItems(autoTargetOf(cp), e.clientX, e.clientY),
      { header: true, label: 'Value' },
      { label: 'Copy value', onClick: () => { clipboardValue = cp.value; flashHint(`Copied: ${fmt(cp.value)}`); } },
      {
        label: 'Paste value', disabled: clipboardValue === null,
        onClick: () => { if (clipboardValue !== null) { begin(cp); set(clipboardValue); cp.onEnd?.(); } },
      },
      {
        label: 'Type in value...', onClick: () => {
          const shown = fmt(cp.value);
          const txt = prompt(`${cp.label}`, shown.replace(/\u2212/g, '-').replace(/[^0-9.+-]/g, ''));
          if (txt === null) return;
          const num = parseFloat(txt.replace(/\u2212/g, '-'));
          if (!isFinite(num)) return;
          begin(cp);
          set(cp.parse ? cp.parse(num) : num / 100 * (max - min) + min);
          cp.onEnd?.();
        },
      },
    ];
    openMenu(e.clientX, e.clientY, items);
  }, []);

  const onPointerLeave = useCallback(() => {
    if (!drag.current) clearHint();
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
    onWheel,
    onContextMenu,
    onPointerLeave,
    onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
  };
}
