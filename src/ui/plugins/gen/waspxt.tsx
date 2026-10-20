// Wasp XT editor: FL 2026's 64-bit dummy window (see ./dummy64/Panel.tsx, docs/research/gen/waspxt.md).
import type { FxEditorModule } from '../registry';
import { Dummy64Editor } from './dummy64/Panel';

export const editor: FxEditorModule = { id: 'waspxt', Editor: Dummy64Editor };
