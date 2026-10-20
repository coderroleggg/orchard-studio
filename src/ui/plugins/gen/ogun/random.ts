// "Generate random preset" and "Enter random preset number..." (FL's TTestPlug 0x72b00 seeds its Mersenne twister with the preset counter
// plug+0x610, an unsigned 32 bit number FL's constructor draws at random, and builds a patch; the number a user sees is the counter + 1,
// 1 .. 4294967296). The generator is src/model/gen/plugins/ogun/random.ts (`generateOgun(seed)` returns a plugin state: the flat
// parameters plus xi / b3 / i2 / info / arts / maps).

import * as A from '../../../../store/actions';
import { flashHint } from '../../../hint';
import { viewOf, type Params } from './settings';
import { setView } from './use';

export type OgunGenerator = (seed: number) => Record<string, unknown>;

const mods = import.meta.glob<{ generateOgun?: OgunGenerator }>('../../../../model/gen/plugins/ogun/random.ts', { eager: true });

/** The random preset generator, or null if the module is missing. */
export function ogunGenerator(): OgunGenerator | null {
  for (const m of Object.values(mods)) if (typeof m.generateOgun === 'function') return m.generateOgun;
  return null;
}

/**
 * The preset counter FL keeps (plug+0x610): the seed of the last generated preset. FL's constructor draws a random one for a new
 * instance; here it is a number derived from the instance's id (the same for the life of the instance) until a preset is generated.
 */
export function randomSeedOf(p: Params, slotId = ''): number {
  const rn = viewOf(p).rn;
  if (rn !== undefined) return rn;
  let h = 2166136261;
  for (let i = 0; i < slotId.length; i++) h = Math.imul(h ^ slotId.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

/** The number FL shows for a seed. */
export const presetNumber = (seed: number): number => seed + 1;

/** Replace the plugin state with a generated preset (no undo, like FL), keeping the editor view and the counter. */
export function applyGenerated(slotId: string, seed: number, gen: OgunGenerator): boolean {
  let st: Record<string, unknown>;
  try { st = gen(seed); } catch { return false; }
  if (!st || typeof st !== 'object') return false;
  A.setFxStateNoHistory(slotId, 'Generate random preset', (d) => {
    const view = { ...((d.view ?? {}) as Record<string, unknown>), rn: seed };
    for (const k of Object.keys(d)) delete d[k];
    Object.assign(d, structuredClone(st));
    d.view = view;
  });
  return true;
}

/** FL's "Generate random preset": the next number. */
export function generateRandom(slotId: string, params: Params): void {
  const gen = ogunGenerator();
  if (!gen) { flashHint('Ogun: the random preset generator is not available'); return; }
  const seed = (randomSeedOf(params, slotId) + 1) >>> 0;
  if (applyGenerated(slotId, seed, gen)) flashHint(`Ogun: random preset ${presetNumber(seed)}`);
}

/** FL's "Enter random preset number...": the number the user typed (seed = number - 1). */
export function enterRandomNumber(slotId: string, params: Params): void {
  const gen = ogunGenerator();
  if (!gen) { flashHint('Ogun: the random preset generator is not available'); return; }
  const txt = prompt('Random preset number', String(presetNumber(randomSeedOf(params, slotId))));
  if (txt === null) return;
  const n = Math.round(Number(txt.trim()));
  if (!Number.isFinite(n) || n < 1 || n > 4294967296) { flashHint('Ogun: not a preset number'); return; }
  if (applyGenerated(slotId, n - 1, gen)) flashHint(`Ogun: random preset ${n}`);
  else setView(slotId, 'Random preset', { rn: n - 1 });
}
