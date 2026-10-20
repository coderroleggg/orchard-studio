// Application singletons: the store and the audio host.
// They are kept on globalThis so a dev-server hot reload keeps the open
// project and the running audio context instead of creating new ones.

import { Store, useStoreSelector, type StoreState } from './createStore';
import type { Project } from '../model/types';
import { defaultUi, type UiState } from './ui';
import { createDefaultProject } from '../model/defaults';
import { loadBuiltins } from '../audio/samples';
import { AudioHost } from '../audio/AudioHost';

interface Singletons {
  store: Store<Project, UiState>;
  host: AudioHost;
  builtins: ReturnType<typeof loadBuiltins>;
}

const g = globalThis as unknown as { __orchard?: Singletons };

function create(): Singletons {
  const builtins = loadBuiltins();
  const store = new Store<Project, UiState>(createDefaultProject(builtins.infos, builtins.byKey), defaultUi());
  const host = new AudioHost(() => store.project);
  store.projectListeners.add((next) => host.sync(next));
  return { store, host, builtins };
}

const singletons: Singletons = g.__orchard ?? (g.__orchard = create());
// make sure builtin sample audio exists after a module reload
if (!g.__orchard.builtins) g.__orchard.builtins = loadBuiltins();

export const store = singletons.store;
export const host = singletons.host;
export const builtinSampleIds = singletons.builtins.byKey;

export type AppState = StoreState<Project, UiState>;

export function useApp<T>(sel: (s: AppState) => T): T {
  return useStoreSelector(store, sel);
}

export function useProject<T>(sel: (p: Project) => T): T {
  return useStoreSelector(store, (s) => sel(s.project));
}

export function useUi<T>(sel: (u: UiState) => T): T {
  return useStoreSelector(store, (s) => sel(s.ui));
}
