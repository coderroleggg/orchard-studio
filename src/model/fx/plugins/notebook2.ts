// NoteBook 2 (FL: Fruity NoteBook 2): a 100-page plain-text notepad.
// Parameter 0 "Page index" 1..100 (value text "1"). State: the page texts
// and the text size (Ctrl+wheel; FL saves 13). Read-only until the pencil
// button enables editing. Form: 297 x 211 (memo 297 x 192, page bar below).

import type { FxPluginDef } from '../types';
import { notebookPages } from './notebook';

/** FL's Default preset page (UTF-16 text in its state). */
export const NOTEBOOK2_DEFAULT_PAGE = '\nNoteBook 2\n\n100 pages for your project notes.\n\nThe page selector is automated, have fun!';

export const NOTEBOOK2_ZOOM = { min: 6, max: 48, def: 13 };

export const def: FxPluginDef = {
  id: 'notebook2',
  name: 'NoteBook 2',
  category: 'Visual',
  width: 297,
  height: 211,
  description: '100-page text notepad',
  params: [
    { key: 'page', name: 'Page index', index: 0, min: 1, max: 100, def: 1, format: (v) => String(Math.round(v)) },
  ],
  state: () => ({ pages: { 1: NOTEBOOK2_DEFAULT_PAGE }, zoom: NOTEBOOK2_ZOOM.def }),
  normalize: (p) => {
    const z = Math.round(Number(p.zoom));
    return { ...p, pages: notebookPages(p), zoom: Number.isFinite(z) ? Math.max(NOTEBOOK2_ZOOM.min, Math.min(NOTEBOOK2_ZOOM.max, z)) : NOTEBOOK2_ZOOM.def };
  },
  presets: [
    { name: 'Default', params: { page: 1, pages: { 1: NOTEBOOK2_DEFAULT_PAGE }, zoom: NOTEBOOK2_ZOOM.def } },
    { name: 'Empty', params: { page: 1, pages: {}, zoom: NOTEBOOK2_ZOOM.def } },
  ],
};
