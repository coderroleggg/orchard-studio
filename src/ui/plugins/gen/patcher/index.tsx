// Patcher as an instrument (FL: Patcher, Generators > Patcher): the effect's editor
// (src/ui/plugins/fx/patcher/Editor.tsx) bound to the channel's plugin ("ch:<channel id>").
// It tells the two apart by the slot id: in a channel, From FL Studio has no audio
// output, the Add plugin menu lists the Generators first, and the hosted modules are
// addressed as "ch:<channel id>#<module id>".
// The editor is loaded when the window first shows it: it imports every effect editor
// (the hosted effect modules' editors), which the instrument registry's importers (and
// their tests) must not pull in with it.

import { Suspense, lazy } from 'react';
import type { FxEditorModule } from '../../registry';

const PatcherEditor = lazy(() => import('../../fx/patcher/Editor').then((m) => ({ default: m.PatcherEditor })));

export const editor: FxEditorModule = {
  id: 'patcher',
  Editor: () => <Suspense fallback={null}><PatcherEditor /></Suspense>,
};
