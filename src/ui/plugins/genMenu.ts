// Generator picker menus (Channel rack "+" / Add one, the channel button's
// Replace and Insert): FL's Browser > Plugin database > Generators folders,
// each listing its plugins by FL name. The built-in channel kinds sit in
// their FL folders (MIDI Out in MIDI, the Sampler in Sampler, Layer in Misc).

import { genInCategory } from '../../model/gen/registry';
import { GEN_CATEGORIES } from '../../model/gen/types';
import type { GeneratorChoice } from '../../store/actions';
import type { MenuItem } from '../widgets/ContextMenu';

/** A generator listed in a plugin database folder. */
export interface GeneratorEntry {
  name: string;
  choice: GeneratorChoice;
  description?: string;
}

/** The plugin database's Generators folders that list something, with their entries sorted by name. */
export function generatorFolders(): { folder: string; entries: GeneratorEntry[] }[] {
  const out: { folder: string; entries: GeneratorEntry[] }[] = [];
  for (const cat of GEN_CATEGORIES) {
    const entries: GeneratorEntry[] = [];
    if (cat === 'MIDI') entries.push({ name: 'MIDI Out', choice: { kind: 'midiout' }, description: 'Sends its notes to the plugins listening on its MIDI port' });
    if (cat === 'Sampler') entries.push({ name: 'Sampler', choice: { kind: 'sampler' }, description: 'Plays a sample' });
    if (cat === 'Misc') entries.push({ name: 'Layer', choice: { kind: 'layer' }, description: 'Plays its notes on its child channels' });
    for (const d of genInCategory(cat)) entries.push({ name: d.name, choice: { kind: 'plugin', id: d.id }, description: d.description });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    if (entries.length) out.push({ folder: cat, entries });
  }
  return out;
}

const sameChoice = (a: GeneratorChoice, b?: GeneratorChoice) =>
  !!b && a.kind === b.kind && (a.kind !== 'plugin' || (b.kind === 'plugin' && a.id === b.id));

/** One submenu per Generators folder; `current` is checked (Replace). */
export function generatorMenuItems(pick: (g: GeneratorChoice) => void, current?: GeneratorChoice): MenuItem[] {
  return generatorFolders().map(({ folder, entries }) => ({
    label: folder,
    submenu: entries.map((e): MenuItem => ({
      label: e.name, hint: e.description, onClick: () => pick(e.choice),
      ...(current ? { radio: true, checked: sameChoice(e.choice, current) } : {}),
    })),
  }));
}

/** The generator a channel holds (for Replace's check mark). */
export function channelGenerator(c: { kind: string; plugin?: { id: string } }): GeneratorChoice {
  if (c.kind === 'plugin' && c.plugin) return { kind: 'plugin', id: c.plugin.id };
  if (c.kind === 'layer') return { kind: 'layer' };
  return c.kind === 'midiout' ? { kind: 'midiout' } : { kind: 'sampler' };
}
