// Big Clock: no audio processing (audio passes through untouched). The
// editor reads the transport position itself (src/audio/live.ts).

import type { EffectInstance, EffectModule } from '../types';

const passThrough: EffectInstance = {
  setParams() {},
  process() {},
  reset() {},
};

export const effect: EffectModule = {
  id: 'bigclock',
  create: () => ({ ...passThrough }),
};
