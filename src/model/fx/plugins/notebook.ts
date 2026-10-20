// NoteBook (FL: Fruity NoteBook): a 100-page rich-text notepad. Parameter 0
// "Page index" 1..100 (FL's value text is empty), automatable to turn pages
// with the song. FL stores RTF per page; here a page is sanitised HTML (rich
// text from the browser clipboard is HTML), kept only for pages with text.
// The editor is read-only until the pencil button enables editing.
// Form: 297 x 211 (text 289 x 187 at (4,4), page bar and pencil below).

import type { FxPluginDef } from '../types';

/** FL's default page (its DefaultText.rtf: centred Arial in #333333, 13 pt title, 9 pt text). */
export const NOTEBOOK_DEFAULT_PAGE = [
  '<p style="text-align:center;color:#333333;font-size:12px"><br></p>',
  '<p style="text-align:center;color:#333333;font-size:17px">NoteBook</p>',
  '<p style="text-align:center;color:#333333;font-size:12px"><br></p>',
  '<p style="text-align:center;color:#333333;font-size:12px"><br></p>',
  '<p style="text-align:center;color:#333333;font-size:12px">100 pages for your project notes.</p>',
  '<p style="text-align:center;color:#333333;font-size:12px"><br></p>',
  '<p style="text-align:center;color:#333333;font-size:12px">The page selector is automated, have fun!</p>',
].join('');

export const NOTEBOOK_PAGES = 100;

/** Pages object of a state, sanitised to string values for keys 1..100. */
export function notebookPages(p: Record<string, unknown>): Record<string, string> {
  const src = p.pages && typeof p.pages === 'object' ? (p.pages as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    const n = Number(k);
    if (Number.isInteger(n) && n >= 1 && n <= NOTEBOOK_PAGES && typeof v === 'string' && v) out[String(n)] = v;
  }
  return out;
}

export const def: FxPluginDef = {
  id: 'notebook',
  name: 'NoteBook',
  category: 'Visual',
  width: 297,
  height: 211,
  description: '100-page rich text notepad',
  params: [
    { key: 'page', name: 'Page index', index: 0, min: 1, max: 100, def: 1, format: () => '' },
  ],
  state: () => ({ pages: { 1: NOTEBOOK_DEFAULT_PAGE } }),
  normalize: (p) => ({ ...p, pages: notebookPages(p) }),
  presets: [
    { name: 'Default', params: { page: 1, pages: { 1: NOTEBOOK_DEFAULT_PAGE } } },
    { name: 'Empty', params: { page: 1, pages: {} } },
  ],
};
