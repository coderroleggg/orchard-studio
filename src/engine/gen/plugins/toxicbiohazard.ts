import type { GenModule } from '../types';
import { TxPlugin } from './toxicbiohazard/plugin';

export const gen: GenModule = { id: 'toxicbiohazard', create: (sr, bs, env) => new TxPlugin(sr, bs, env) };
