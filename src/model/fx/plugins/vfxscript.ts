// VFX Script (FL: VFX Script): note and controller processing written in
// Python. FL embeds CPython; this clone runs the scripts on a sandboxed
// interpreter for the Python subset the VFX API needs (vfx/pyvm.ts, no eval).
// Form: 799 x 521 (sheets User interface / Script / Log / API reference, the
// script memo with Compile / Restart and the options menu, title band).
// The plugin cannot be loaded by the test host (it starts embedded Python),
// so parameters are this clone's: 32 automatable script controls (`c1`..,
// 0..1 normalised; control i of the script's dialog uses `c<i+1>`).
// The example scripts are this clone's own (FL's factory scripts are not
// copied).

import type { FxParamDef, FxPluginDef, FxPreset } from '../types';
import { compileScript, type ScriptControl, type ScriptDialogInfo } from './vfx/vfxrun';

export const SCRIPT_CONTROLS = 32;
export const ctlKey = (i: number): string => `c${i + 1}`;

/** A control's value from its normalised parameter position. */
export function controlValue(c: ScriptControl, pos: number): number {
  const t = Math.min(1, Math.max(0, pos));
  switch (c.kind) {
    case 'check': return t >= 0.5 ? 1 : 0;
    case 'knobInt': case 'combo': return Math.round(c.min + (c.max - c.min) * t);
    default: return c.min + (c.max - c.min) * t;
  }
}

/** The normalised position of a control value. */
export function controlPos(c: ScriptControl, v: number): number {
  if (c.kind === 'check') return v ? 1 : 0;
  return c.max === c.min ? 0 : Math.min(1, Math.max(0, (v - c.min) / (c.max - c.min)));
}

const S = (lines: string[]) => lines.join('\n') + '\n';

const FOLLOW = [
  'def onTick():',
  '  for v in vfx.context.voices:',
  '    v.copyFrom(v.source)',
  '',
  'def onReleaseVoice(incomingVoice):',
  '  for v in vfx.context.voices:',
  '    if v.source == incomingVoice:',
  '      v.release()',
];

export const DEFAULT_SCRIPT = S([
  'import flvfx as vfx',
  '',
  '# Passes notes through unchanged: each incoming voice triggers a copy',
  '# that follows it (slides included) and ends with it.',
  '',
  'class FollowVoice(vfx.Voice):',
  '  source = None',
  '',
  'def onTriggerVoice(incomingVoice):',
  '  v = FollowVoice(incomingVoice)',
  '  v.source = incomingVoice',
  '  v.trigger()',
  '',
  ...FOLLOW,
  '',
  'def createDialog():',
  "  return vfx.ScriptDialog('', 'Passes notes through unchanged.')",
]);

const SCRIPTS: [string, string][] = [
  ['Default', DEFAULT_SCRIPT],
  ['Transpose', S([
    'import flvfx as vfx',
    '',
    'class Shifted(vfx.Voice):',
    '  source = None',
    '  shift = 0',
    '',
    'def onTriggerVoice(incomingVoice):',
    '  form = vfx.context.form',
    '  v = Shifted(incomingVoice)',
    '  v.source = incomingVoice',
    "  v.shift = form.getInputValue('Semitones') + 12 * form.getInputValue('Octaves')",
    '  v.note += v.shift',
    '  v.trigger()',
    '',
    'def onTick():',
    '  for v in vfx.context.voices:',
    '    v.copyFrom(v.source)',
    '    v.note += v.shift',
    '',
    'def onReleaseVoice(incomingVoice):',
    '  for v in vfx.context.voices:',
    '    if v.source == incomingVoice:',
    '      v.release()',
    '',
    'def createDialog():',
    "  form = vfx.ScriptDialog('', 'Transposes notes by semitones and octaves.')",
    "  form.addInputKnobInt('Semitones', 0, -12, 12, hint='Transpose in semitones')",
    "  form.addInputKnobInt('Octaves', 0, -4, 4, hint='Transpose in octaves')",
    '  return form',
  ])],
  ['Chord', S([
    'import flvfx as vfx',
    '',
    "NAMES = ['Major', 'Minor', 'Sus4', 'Seventh', 'Power']",
    "SHAPES = {'Major': [0, 4, 7], 'Minor': [0, 3, 7], 'Sus4': [0, 5, 7], 'Seventh': [0, 4, 7, 10], 'Power': [0, 7, 12]}",
    '',
    'class ChordVoice(vfx.Voice):',
    '  source = None',
    '  offset = 0',
    '  level = 1.0',
    '',
    'def onTriggerVoice(incomingVoice):',
    '  form = vfx.context.form',
    "  shape = SHAPES[NAMES[form.getInputValue('Chord')]]",
    "  drop = form.getInputValue('Spread')",
    '  for i, interval in enumerate(shape):',
    '    v = ChordVoice(incomingVoice)',
    '    v.source = incomingVoice',
    '    v.offset = interval',
    '    v.level = max(0.0, 1 - drop * i / len(shape))',
    '    v.note += interval',
    '    v.velocity = incomingVoice.velocity * v.level',
    '    v.trigger()',
    '',
    'def onTick():',
    '  for v in vfx.context.voices:',
    '    v.copyFrom(v.source)',
    '    v.note += v.offset',
    '    v.velocity = v.source.velocity * v.level',
    '',
    'def onReleaseVoice(incomingVoice):',
    '  for v in vfx.context.voices:',
    '    if v.source == incomingVoice:',
    '      v.release()',
    '',
    'def createDialog():',
    "  form = vfx.ScriptDialog('', 'Plays a chord on every note.')",
    "  form.addInputCombo('Chord', NAMES, 0, hint='Chord shape')",
    "  form.addInputKnob('Spread', 0.25, 0, 1, hint='Velocity drop of the upper notes')",
    '  return form',
  ])],
  ['Note Gate', S([
    'import flvfx as vfx',
    'import random',
    '',
    'class Passed(vfx.Voice):',
    '  source = None',
    '',
    'def onTriggerVoice(incomingVoice):',
    '  form = vfx.context.form',
    "  if form.getInputValue('Open') and random.random() < form.getInputValue('Probability'):",
    '    v = Passed(incomingVoice)',
    '    v.source = incomingVoice',
    '    v.trigger()',
    '',
    ...FOLLOW,
    '',
    'def createDialog():',
    "  form = vfx.ScriptDialog('', 'Lets notes through while open, each with a probability.')",
    "  form.addInputCheckbox('Open', 1, hint='Let notes pass')",
    "  form.addInputKnob('Probability', 1, 0, 1, hint='Chance that a note plays')",
    '  return form',
  ])],
  ['Arpeggiator', S([
    'import flvfx as vfx',
    '',
    'held = []',
    'step = 0',
    '',
    'def onTriggerVoice(incomingVoice):',
    '  held.append(incomingVoice)',
    '  held.sort(key=lambda v: v.note)',
    '',
    'def onReleaseVoice(incomingVoice):',
    '  if incomingVoice in held:',
    '    held.remove(incomingVoice)',
    '',
    'def onTick():',
    '  global step',
    '  form = vfx.context.form',
    "  rate = max(1, int(vfx.context.PPQ / form.getInputValue('Rate')))",
    '  if not held:',
    '    step = 0',
    '  elif vfx.context.ticks % rate == 0:',
    "    order = held if form.getInputValue('Direction') == 0 else held[::-1]",
    '    v = vfx.Voice(order[step % len(order)])',
    "    v.length = max(1, int(rate * form.getInputValue('Gate')))",
    '    v.trigger()',
    '    step += 1',
    '',
    'def createDialog():',
    "  form = vfx.ScriptDialog('', 'Plays the held notes one after another.')",
    "  form.addInputKnobInt('Rate', 4, 1, 8, hint='Notes per quarter note')",
    "  form.addInputKnob('Gate', 0.5, 0.1, 1, hint='Note length (part of a step)')",
    "  form.addInputCombo('Direction', ['Up', 'Down'], 0, hint='Order of the notes')",
    '  return form',
  ])],
  ['Pulse Generator', S([
    'import flvfx as vfx',
    '',
    'def onTick():',
    '  form = vfx.context.form',
    "  period = int(vfx.context.PPQ / 2 * form.getInputValue('Period'))",
    '  if vfx.context.isPlaying and period > 0 and vfx.context.ticks % period == 0:',
    '    v = vfx.Voice()',
    "    v.note = form.getInputValue('Note')",
    "    v.velocity = form.getInputValue('Velocity')",
    "    v.length = max(1, int(period * form.getInputValue('Length')))",
    '    v.trigger()',
    '',
    'def createDialog():',
    "  form = vfx.ScriptDialog('', 'Plays a note at a steady rate while the song plays.')",
    "  form.addInputKnobInt('Note', 60, 0, 131, hint='Note number')",
    "  form.addInputKnobInt('Period', 1, 1, 8, hint='Time between notes in 1/8 notes')",
    "  form.addInputKnob('Length', 0.5, 0.05, 1, hint='Note length (part of the period)')",
    "  form.addInputKnob('Velocity', 0.8, 0, 1, hint='Note velocity')",
    '  return form',
  ])],
  ['Sine LFO', S([
    'import flvfx as vfx',
    'import math',
    '',
    'def onTick():',
    '  form = vfx.context.form',
    "  phase = 2 * math.pi * form.getInputValue('Speed') * vfx.context.ticks / vfx.context.PPQ",
    "  depth = form.getInputValue('Depth')",
    "  vfx.setOutputController('LFO', 0.5 + 0.5 * depth * math.sin(phase))",
    '',
    'def createDialog():',
    "  form = vfx.ScriptDialog('', 'A sine LFO on the output controller (cycles per quarter note).')",
    "  form.addInputKnob('Speed', 0.5, 0.0625, 4, hint='Cycles per quarter note')",
    "  form.addInputKnob('Depth', 1, 0, 1, hint='LFO depth')",
    "  vfx.addOutputController('LFO', 0.5)",
    '  return form',
  ])],
];

const EMPTY_DIALOG: ScriptDialogInfo = { title: '', description: '', controls: [], surface: false };

/** A compiled script as plugin state: its dialog, outputs and the controls' default positions. */
export function compiledState(code: string): Record<string, unknown> {
  const c = compileScript(code);
  const dialog = c.dialog ?? EMPTY_DIALOG;
  const out: Record<string, unknown> = { code, compiled: c.error ? '' : code, dialog, outputs: c.outputs, error: c.error ?? '', log: c.log, texts: {} };
  dialog.controls.forEach((ctl, i) => {
    if (i >= SCRIPT_CONTROLS) return;
    if (ctl.kind === 'text') (out.texts as Record<string, string>)[ctl.name] = String(ctl.def);
    else out[ctlKey(i)] = controlPos(ctl, Number(ctl.def));
  });
  return out;
}

function params(): FxParamDef[] {
  return Array.from({ length: SCRIPT_CONTROLS }, (_, i) => ({
    key: ctlKey(i), name: `Script control ${i + 1}`, index: i, min: 0, max: 1, def: 0, step: 0,
    format: (v: number) => `${Math.round(v * 100)}%`,
  }));
}


export const def: FxPluginDef = {
  id: 'vfxscript',
  name: 'VFX Script',
  category: 'Patcher',
  width: 799,
  height: 521,
  description: 'Process notes and controllers with Python scripts (Patcher)',
  params: params(),
  state: () => ({ ...compiledState(DEFAULT_SCRIPT), tab: 0, hideTabs: 0 }),
  presets: SCRIPTS.map(([name, code]): FxPreset => ({ name, params: compiledState(code) })),
};

export { SCRIPTS };
