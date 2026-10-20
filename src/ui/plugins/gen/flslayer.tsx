// FL Slayer editor: FL 2026's 64-bit dummy window (see ./dummy64/Panel.tsx, docs/research/gen/flslayer.md).
import type { FxEditorModule } from '../registry';
import { Dummy64Editor } from './dummy64/Panel';

export const editor: FxEditorModule = { id: 'flslayer', Editor: Dummy64Editor };
