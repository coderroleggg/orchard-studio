// Patcher as an effect (FL: Patcher, effect slot): registers the editor of Editor.tsx.

import type { FxEditorModule } from '../../registry';
import { PatcherEditor } from './Editor';

export const editor: FxEditorModule = { id: 'patcher', Editor: PatcherEditor };
