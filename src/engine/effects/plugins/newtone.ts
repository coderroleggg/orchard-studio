// Newtone: an offline pitch editor in a mixer slot. The analysis, the note
// edits and the PSOLA rendering happen in the editor (see
// ui/plugins/fx/newtone and ./newtools); the rendered result lands in the
// sample pool and is delivered to the engine as 'newtone:<id>'. Here the
// live input passes through unchanged and the render plays on top of it
// while the Play button is on (or, slaved, while the song plays).

import type { EffectInstance, EffectModule, FxContext, FxEnv, FxMonitor } from '../types';
import { NT_SAMPLE_PREFIX } from '../../../model/fx/plugins/newtone';
import { PreviewPlayer } from './newtools/player';

class Newtone implements EffectInstance {
  tail = 0;
  private readonly player: PreviewPlayer;

  constructor(sampleRate: number, env: FxEnv) {
    this.player = new PreviewPlayer(sampleRate, env, NT_SAMPLE_PREFIX);
  }

  setParams(p: unknown): void {
    this.player.setState((p && typeof p === 'object' ? p : {}) as Record<string, unknown>);
    // keep the track running while the preview may sound
    this.tail = this.player.active ? Infinity : 0;
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    this.player.process(L, R, n, ctx);
  }

  reset(): void {
    this.player.reset();
  }

  monitor(): FxMonitor {
    return this.player.monitor();
  }
}

export const effect: EffectModule = {
  id: 'newtone',
  create: (sampleRate, _blockSize, env) => new Newtone(sampleRate, env),
};
