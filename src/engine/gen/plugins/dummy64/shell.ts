// The DSP of FL 2026's 64-bit dummies (Wasp, Wasp XT, FL Slayer, Dashboard; docs/research/gen/wasp.md).
// FL's TriggerVoice returns -1 and Gen_Render is empty, so no note gets a voice and nothing is
// rendered; the parameters are ignored (flfxhost reads them back as 0). Nothing to keep. FL's
// Dashboard dummy keeps a state blob it is given; the clone copies no FL state (docs/research/gen/dashboard.md).

import type { GenInstance } from '../../types';

export function dummy64(): GenInstance {
  return {
    setParams() {},
    reset() {},
    triggerVoice: () => null,
  };
}
