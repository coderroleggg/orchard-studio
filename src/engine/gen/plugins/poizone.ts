// PoiZone (FL: PoiZone): Image-Line's virtual-analog synthesizer, a port of FL
// 2026's engine (see ./poizone/ and docs/research/gen/poizone.md).

import type { GenModule } from '../types';
import { PzPlugin } from './poizone/plugin';

export const gen: GenModule = {
  id: 'poizone',
  create: (sampleRate, blockSize) => new PzPlugin(sampleRate, blockSize),
};
