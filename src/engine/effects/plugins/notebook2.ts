// notebook2: a text plugin; audio passes through untouched.

import type { EffectModule } from '../types';

export const effect: EffectModule = {
  id: 'notebook2',
  create: () => ({ setParams() {}, process() {}, reset() {} }),
};
