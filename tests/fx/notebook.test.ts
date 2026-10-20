import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, formatParam, fxDef, fxParamDef, normalizeFxParams } from '../../src/model/fx/registry';
import { NOTEBOOK_DEFAULT_PAGE } from '../../src/model/fx/plugins/notebook';
import { NOTEBOOK2_DEFAULT_PAGE } from '../../src/model/fx/plugins/notebook2';
import { sanitizeHtml } from '../../src/model/fx/plugins/htmlnotebook';
import { render, sine } from './util';

describe('NoteBook', () => {
  it('is registered with FL page index parameter (empty value text) and its default page', () => {
    const d = fxDef('notebook')!;
    expect([d.width, d.height, d.category]).toEqual([297, 211, 'Visual']);
    expect(d.params.map((q) => [q.name, q.index, q.min, q.max, q.def])).toEqual([['Page index', 0, 1, 100, 1]]);
    expect(formatParam(fxParamDef('notebook', 'page')!, 7)).toBe('');
    expect(defaultFxParams('notebook')).toEqual({ page: 1, pages: { 1: NOTEBOOK_DEFAULT_PAGE } });
    expect(d.presets!.map((p) => p.name)).toEqual(['Default', 'Empty']);
  });

  it('stores only valid pages and its default page is already clean HTML', () => {
    expect(normalizeFxParams('notebook', { pages: { 0: 'x', 3: '<p>t</p>', 101: 'y', a: 'z', 5: 7 } }).pages).toEqual({ 3: '<p>t</p>' });
    expect(sanitizeHtml(NOTEBOOK_DEFAULT_PAGE).html).toBe(NOTEBOOK_DEFAULT_PAGE);
  });

  it('passes audio through untouched', () => {
    const fx = createEffect('notebook', 48000, 128);
    const x = sine(440, 0.02);
    expect(render(fx, x)[0]).toEqual(x);
  });
});

describe('NoteBook 2', () => {
  it('is registered with FL page index parameter (value text "1"), default page and text size 13', () => {
    const d = fxDef('notebook2')!;
    expect([d.width, d.height, d.category]).toEqual([297, 211, 'Visual']);
    expect(d.params.map((q) => [q.name, q.index, q.min, q.max, q.def])).toEqual([['Page index', 0, 1, 100, 1]]);
    expect(formatParam(fxParamDef('notebook2', 'page')!, 7)).toBe('7');
    expect(defaultFxParams('notebook2')).toEqual({ page: 1, pages: { 1: NOTEBOOK2_DEFAULT_PAGE }, zoom: 13 });
    expect(NOTEBOOK2_DEFAULT_PAGE.split('\n')).toEqual(['', 'NoteBook 2', '', '100 pages for your project notes.', '', 'The page selector is automated, have fun!']);
    expect(d.presets!.find((p) => p.name === 'Empty')!.params.pages).toEqual({});
  });

  it('clamps the text size', () => {
    expect(normalizeFxParams('notebook2', { zoom: 200 }).zoom).toBe(48);
    expect(normalizeFxParams('notebook2', { zoom: 'x' }).zoom).toBe(13);
  });

  it('passes audio through untouched', () => {
    const fx = createEffect('notebook2', 48000, 128);
    const x = sine(440, 0.02);
    expect(render(fx, x)[0]).toEqual(x);
  });
});
