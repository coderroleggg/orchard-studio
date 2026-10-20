// Dance DSP (FL: Fruity Dance): the plugin makes no sound. What the engine
// does is FL's note handling, measured on the real plugin in the test host
// (docs/research/gen/dance.md):
//
// - Every note reaches the plugin as a voice (TriggerVoice). The plugin reads
//   only the key (velocity, colour, length, pan, fine pitch and the note off
//   are ignored), changes its own parameters through the note -> parameter
//   table (src/model/gen/plugins/dance.ts: keys 59..68 = move 0..9 with Mirror
//   off, keys 48..39 = move 0..9 with Mirror on, key 53 hides the window, key 54
//   shows it; with a sprite sheet that has fewer moves only the keys of its
//   moves answer) and kills the voice at once (FL: Voice_Kill inside
//   TriggerVoice, KillHandle 0, handle -1 returned), so no voice is ever
//   rendered and no note off arrives.
// - It does not tell FL's host about those changes (no OnParamChanged), the
//   editor follows them silently. Here they are reported with
//   takeStateChanges() so that the project and the editor (and the character
//   window) follow.
// - The animation itself (frames, speed, blend, Sync changes, Freestyle) is
//   the character window's job (src/ui/plugins/gen/dance): it follows the
//   song position, which the engine does not need to know.

import type { GenInstance, GenModule, GenVoice, GenVoiceParams } from '../types';
import { danceKeyEffect, danceKeyMovesOf, danceSheetNames, danceState } from '../../../model/gen/plugins/dance';

class Dance implements GenInstance {
  /** The state the plugin currently holds (the last setParams, then its own changes). */
  private move = 2;
  private mirror = 0;
  private visible = 1;
  /** The moves the note table reaches (the loaded sprite sheet's rows but the last). */
  private keyMoves = 9;
  /** Parameter changes not yet reported, by key (the last value wins). */
  private pending: [string, unknown][] = [];

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Record<string, unknown>;
    const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
    this.move = num(q.move, 2, 0, 9);
    this.mirror = num(q.mirror, 0, 0, 1);
    this.visible = num(q.visible, 1, 0, 1);
    this.keyMoves = danceKeyMovesOf(danceSheetNames(danceState(q)).length);
  }

  /** FL's TriggerVoice: apply the key's effect, make no voice. */
  triggerVoice(p: GenVoiceParams): GenVoice | null {
    const e = danceKeyEffect(p.key, this.keyMoves);
    if (!e) return null;
    if (e.move !== undefined && e.move !== this.move) { this.move = e.move; this.report('move', e.move); }
    if (e.mirror !== undefined && e.mirror !== this.mirror) { this.mirror = e.mirror; this.report('mirror', e.mirror); }
    if (e.visible !== undefined && e.visible !== this.visible) { this.visible = e.visible; this.report('visible', e.visible); }
    return null;
  }

  private report(key: string, value: number): void {
    const i = this.pending.findIndex((c) => c[0] === key);
    if (i >= 0) this.pending[i][1] = value;
    else this.pending.push([key, value]);
  }

  takeStateChanges(): [string, unknown][] | null {
    if (this.pending.length === 0) return null;
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** The plugin keeps its parameters; there are no voices to clear. */
  reset(): void {}
}

export const gen: GenModule = {
  id: 'dance',
  create: () => new Dance(),
};
