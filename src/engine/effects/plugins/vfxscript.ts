// VFX Script: runs the compiled script over note events (audio passes
// through). processNotes plays the notes through the script tick by tick
// (vfx/vfxrun.ts: onTriggerVoice / onReleaseVoice / onTick, script voices
// from trigger() to release()), with the dialog controls' values taken from
// the automatable script controls (c1..) and the text fields.

import type { EffectInstance, EffectModule } from '../types';
import { SCRIPT_CONTROLS, controlValue, ctlKey } from '../../../model/fx/plugins/vfxscript';
import { runScript, type ScriptDialogInfo, type ScriptRun } from '../../../model/fx/plugins/vfx/vfxrun';
import type { VfxContext, VfxNote } from '../../../model/fx/plugins/vfx/notes';

type P = Record<string, unknown>;

/** The control values the script's getInputValue() sees. */
export function scriptValues(p: P): Record<string, number | string> {
  const dialog = p.dialog as ScriptDialogInfo | undefined;
  const texts = (p.texts && typeof p.texts === 'object' ? p.texts : {}) as Record<string, string>;
  const out: Record<string, number | string> = {};
  (dialog?.controls ?? []).forEach((c, i) => {
    if (c.kind === 'text') { if (c.name in texts) out[c.name] = texts[c.name]; return; }
    if (i >= SCRIPT_CONTROLS) return;
    const pos = p[ctlKey(i)];
    if (typeof pos === 'number') out[c.name] = controlValue(c, pos);
  });
  return out;
}

/** Full run: notes, output controllers, log and error. */
export function runNotes(notes: VfxNote[], p: P, ctx: VfxContext & { tail?: number; horizon?: number }): ScriptRun {
  const src = typeof p.compiled === 'string' ? p.compiled : '';
  return runScript(src, scriptValues(p), notes, ctx);
}

export function processNotes(notes: VfxNote[], p: P, ctx?: VfxContext & { tail?: number; horizon?: number }): VfxNote[] {
  return runNotes(notes, p, ctx ?? { ppq: 96, tempo: 120, random: Math.random }).notes;
}

class Script implements EffectInstance {
  private p: P = {};
  setParams(p: unknown): void { this.p = (p ?? {}) as P; }
  process(): void { /* audio passes through */ }
  reset(): void {}
  notes(n: VfxNote[], ctx?: VfxContext): VfxNote[] { return processNotes(n, this.p, ctx); }
}

export const effect: EffectModule = { id: 'vfxscript', create: () => new Script() };
