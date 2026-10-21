// Checks shared by FL 2026's 64-bit dummies (Wasp, Wasp XT, FL Slayer, Dashboard; docs/research/gen/wasp.md):
// registration as FL reports it (hidden, parameter list, DefPoly, form size), no voices and
// silence through a channel whatever the parameters, and the dummy window's text.
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { genDef, genInCategory, defaultGenParams } from '../../src/model/gen/registry';
import { createGen, hasGen } from '../../src/engine/gen';
import { newLevels } from '../../src/engine/gen/levels';
import type { GenVoiceParams } from '../../src/engine/gen/types';
import { createGenChannel } from '../../src/model/defaults';
import type { FxEditorModule } from '../../src/ui/plugins/registry';
import { makeEngine, play, peak } from './util';

/** The editor's kit reads the window at load (the store's pointer tracking): stub it before importing an editor. */
export function stubWindow(): void {
  const g = globalThis as Record<string, unknown>;
  g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
}

export function dummy64Suite(o: { id: string; params: number; defPoly: number; editor: FxEditorModule }): void {
  const { id, params, defPoly, editor } = o;

  describe(`${id}: FL 2026 64-bit dummy`, () => {
    it('is a hidden legacy definition with FL\'s parameter list', () => {
      const d = genDef(id)!;
      expect(d.hidden).toBe(true);
      expect(genInCategory(d.category).some((x) => x.id === id)).toBe(false);
      expect(hasGen(id)).toBe(true);
      expect(editor.id).toBe(id);
      expect(d.notes).toBe('voices');
      expect(d.defPoly ?? 0).toBe(defPoly);
      expect([d.width, d.height]).toEqual([356, 201]);
      expect(d.presets ?? []).toEqual([]);
      expect(d.params).toHaveLength(params);
      d.params.forEach((p, i) => {
        expect(p.index).toBe(i);
        expect(p.key).toBe(`p${i}`);
        expect([p.min, p.max, p.def]).toEqual([0, 1073741824, 0]);
        expect(p.name).toBe('');
        expect(p.format!(0)).toBe('');
      });
      expect(defaultGenParams(id)).toEqual(Object.fromEntries(d.params.map((p) => [p.key, 0])));
    });

    it('never starts a voice (FL: TriggerVoice returns -1)', () => {
      const g = createGen(id, 48000, 128)!;
      g.setParams(defaultGenParams(id));
      const init = newLevels(), levels = newLevels();
      for (const key of [0, 36, 60, 96, 131]) {
        const p: GenVoiceParams = { key, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init, levels };
        expect(g.triggerVoice!(p)).toBeNull();
      }
    });

    it('renders silence through a channel, also with parameters set', () => {
      const ch = createGenChannel(id);
      Object.keys(ch.plugin!.params).forEach((k, i) => { ch.plugin!.params[k] = 12345 + i; });
      const e = makeEngine();
      const notes = [{ pos: 0, len: 48, key: 60, vel: 127 }, { pos: 0, len: 48, key: 36, vel: 40 }, { pos: 24, len: 12, key: 96, vel: 100 }];
      const [L, R] = play(e, [ch], { [ch.id]: notes }, 48000);
      expect(peak(L)).toBe(0);
      expect(peak(R)).toBe(0);
    });

    it('shows FL\'s dummy window', () => {
      const html = renderToStaticMarkup(createElement(editor.Editor));
      for (const s of ['Dummy x64', 'a 64 bit version.', 'Your settings have been saved.', 'It makes no sound, as in the 64-bit original.']) {
        expect(html).toContain(s);
      }
    });
  });
}
