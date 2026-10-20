// Sytrus options menu (FL's MenuBtn popup, also in the plugin window's menu):
// unison distribution, arpeggiator invert, portamento options, velocity /
// release links and HQ waveshaper (`sy.g`). FL's unison / chorus / reverb
// presets and the size options are not reproduced.

import type { Draft } from 'immer';
import type { MenuItem } from '../../../widgets/ContextMenu';
import type { SyGlobal, SyState } from '../../../../model/gen/plugins/sytrus/types';

type Edit = (label: string, recipe: (sy: Draft<SyState>) => void) => void;

const UNI_DIST = ['Original', 'Improved', 'Uniform', 'Blurred'];
const PORTA_LIMITS = ['No limit', 'Octave wrap', '4 semitones limit', '3 semitones limit', '2 semitones limit', '1 semitone limit'];

export function optionsItems(sy: SyState, edit: Edit): MenuItem[] {
  const g = sy.g;
  const toggle = (k: keyof SyGlobal, label: string): MenuItem => ({
    label, checked: !!g[k], onClick: () => edit(label, (s) => { (s.g as unknown as Record<string, number>)[k] = g[k] ? 0 : 1; }),
  });
  const bit = (b: number, label: string): MenuItem => ({
    label, checked: (g.velAtt & b) !== 0, onClick: () => edit(label, (s) => { s.g.velAtt = g.velAtt ^ b; }),
  });
  return [
    { label: 'Unison', submenu: UNI_DIST.map((l, i) => ({ label: l, radio: true, checked: g.uniDist === i, onClick: () => edit(`Unison distribution: ${l}`, (s) => { s.g.uniDist = i; }) })) },
    { label: 'Arpeggiator', submenu: [toggle('arpInv', 'Invert')] },
    {
      label: 'Portamento', submenu: [
        toggle('portaVar', 'Variable time'),
        toggle('portaTrack', 'Track origin'),
        { separator: true },
        ...PORTA_LIMITS.map((l, i) => ({ label: l, radio: true, checked: g.portaLimit === i, onClick: () => edit(`Portamento: ${l}`, (s) => { s.g.portaLimit = i; }) })),
      ],
    },
    {
      label: 'Velocity', submenu: [
        toggle('velVol', 'Link velocity to volume'),
        bit(2, 'Link velocity to attack time'),
        bit(1, 'Link velocity to attack length'),
        toggle('relRel', 'Link release to release length'),
      ],
    },
    { header: true, label: 'Options' },
    toggle('hqWs', 'HQ WaveShaper'),
  ];
}
