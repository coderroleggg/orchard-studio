// Mixer routing seen from an effect: the tracks its mixer track sends to (the
// targets of FL's plugin outputs: Send, Stereo Shaper, Transmitter, Frequency
// Splitter...) and the tracks routed into it, which are FL's sidechain inputs
// 1, 2... in source order (every route counts, whatever its level). Both are
// empty outside the mixer (gallery).

import { useMemo, type MouseEvent } from 'react';
import { useProject } from '../../../store';
import { editFx, findFx } from '../../../store/actions';
import { mixerTrackName } from '../../../model/defaults';
import type { Project } from '../../../model/types';
import type { ControlProps } from '../../widgets/control';
import { openMenu, type MenuItem } from '../../widgets/ContextMenu';
import { useFxEditor } from './context';

export interface Route { index: number; name: string }

/** 'out': the tracks the effect's track sends to; 'in': the tracks routed into it. Track order. */
export function routesOf(p: Project, slotId: string, dir: 'out' | 'in'): Route[] {
  const loc = findFx(p, slotId);
  if (!loc) return [];
  const me = loc.track;
  const ids = dir === 'out'
    ? Object.keys(p.mixer.tracks[me]?.sends ?? {}).map(Number).filter((k) => k !== me && p.mixer.tracks[k])
    : p.mixer.tracks.filter((t) => t.index !== me && t.sends && me in t.sends).map((t) => t.index);
  ids.sort((a, b) => a - b);
  return ids.map((k) => ({ index: k, name: mixerTrackName(p.mixer.tracks[k]) }));
}

/** routesOf, kept current. */
export function useRoutes(slotId: string, dir: 'out' | 'in' = 'out'): Route[] {
  const key = useProject((p) => JSON.stringify(routesOf(p, slotId, dir)));
  return useMemo(() => JSON.parse(key) as Route[], [key]);
}

/** FL's output menu: (none) plus the routed tracks by name. */
export function openRouteMenu(x: number, y: number, routes: Route[], current: number, pick: (track: number) => void): void {
  const items: MenuItem[] = [
    { label: '(none)', checked: current < 0, radio: true, onClick: () => pick(-1) },
    ...routes.map((r) => ({ label: r.name, checked: r.index === current, radio: true, onClick: () => pick(r.index) } as MenuItem)),
  ];
  openMenu(x, y, items);
}

export interface SidechainInput {
  /** Selected input (0 = none, k = FL's sidechain input k). */
  value: number;
  sources: Route[];
  /** Spinner text: the source track number, "⋯" for none. */
  text: string;
  /** Spinner binding (one undo step per drag). */
  control: ControlProps;
  /** Right-click menu: (none) and the routed tracks. */
  onContextMenu: (e: MouseEvent) => void;
}

/**
 * FL's "Sidechain input number" spinner (Limiter, Compressor...): state key
 * `key` holds the input number; the text shows the source track's number.
 */
export function useSidechainInput(key = 'sidechain'): SidechainInput {
  const { slotId, params } = useFxEditor();
  const value = Math.max(0, Math.round(Number(params[key] ?? 0) || 0));
  const sources = useRoutes(slotId, 'in');
  const textOf = (k: number) => (k <= 0 ? '⋯' : String(sources[k - 1]?.index ?? k));
  const set = (k: number) => editFx(slotId, 'Sidechain input', (p) => { p[key] = k; }, `sc:${slotId}:${key}`);
  return {
    value, sources, text: textOf(value),
    control: {
      value, min: 0, max: Math.max(value, sources.length), defaultValue: 0, step: 1,
      label: 'Sidechain input number',
      format: (v) => (v <= 0 ? 'none' : textOf(v)),
      onChange: set,
    },
    onContextMenu: (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(e.clientX, e.clientY, [
        { header: true, label: 'Sidechain input' },
        { label: '(none)', radio: true, checked: value === 0, onClick: () => set(0) },
        ...sources.map((s, i) => ({ label: `${s.index}. ${s.name}`, radio: true, checked: value === i + 1, onClick: () => set(i + 1) } as MenuItem)),
        ...(sources.length ? [] : [{ label: 'Route a track to this one ("Sidechain to this track")', disabled: true } as MenuItem]),
      ]);
    },
  };
}
