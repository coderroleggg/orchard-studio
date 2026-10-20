// Center (FL: Fruity Center, legacy): real-time DC offset removal. The
// input minus a slow two-pole "follower" of it (see the engine for the exact
// recursion). Form: 170 x 55; one TSwitchSelector, StatusCheckBox (Tag 0,
// 0..1, default 1 = On, captions Off / On). Not listed in FL's plugin
// database, kept loadable for old projects.

import type { FxPluginDef } from '../types';

export const def: FxPluginDef = {
  id: 'center',
  name: 'Center',
  category: 'Misc',
  width: 170,
  height: 55,
  hidden: true,
  description: 'Removes DC offset in real time',
  params: [{ key: 'status', name: 'Status', index: 0, min: 0, max: 1, def: 1, options: ['Off', 'On'] }],
  // FL's factory preset folder holds Default.fst (= the constructor state)
  presets: [{ name: 'Default', params: { status: 1 } }],
};
