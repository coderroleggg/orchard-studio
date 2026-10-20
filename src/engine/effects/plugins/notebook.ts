// notebook: a text plugin; audio passes through untouched.

import type { EffectModule } from '../types';

export const effect: EffectModule = {
  id: 'notebook',
  create: () => ({ setParams() {}, process() {}, reset() {} }),
};
