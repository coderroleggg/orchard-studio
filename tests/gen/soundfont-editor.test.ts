// SoundFont Player editor (tests/gen/soundfont.test.ts covers the model and the engine): FL's layout, the patch combo's
// text for the played preset, the empty state without a soundfont and the window menu. The soundfont is a tiny one
// built here (RIFF sfbk with INFO, sdta and pdta): the editor goes through the model's own importer.
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultGenParams, normalizeGenParams } from '../../src/model/gen/registry';
import { importSf2 } from '../../src/model/gen/plugins/soundfont/import';
import { currentPreset, fontHydra, presetList, sfState, type SfFont } from '../../src/model/gen/plugins/soundfont/state';

const enc = (s: string, n: number): number[] => { const b = new Array<number>(n).fill(0); for (let i = 0; i < Math.min(s.length, n - 1); i++) b[i] = s.charCodeAt(i); return b; };
const u16 = (v: number): number[] => [v & 255, (v >> 8) & 255];
const u32 = (v: number): number[] => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
const chunk = (id: string, body: number[]): number[] => [...enc(id, 5).slice(0, 4), ...u32(body.length), ...body, ...(body.length & 1 ? [0] : [])];
const list = (id: string, ...chunks: number[][]): number[] => chunk('LIST', [...enc(id, 5).slice(0, 4), ...chunks.flat()]);

/** A minimal SF2 file: one looped sine sample, one instrument, a preset per entry. */
function buildSf2(name: string, presets: { name: string; bank: number; program: number }[], frames = 256): Uint8Array {
  const smpl: number[] = [];
  for (let i = 0; i < frames + 46; i++) smpl.push(...u16(i < frames ? Math.round(Math.sin((2 * Math.PI * i) / 64) * 12000) & 0xffff : 0));
  const info = list('INFO', chunk('ifil', [2, 0, 1, 0]), chunk('isng', enc('EMU8000', 8)), chunk('INAM', enc(name, (name.length + 2) & ~1)));
  const sdta = list('sdta', chunk('smpl', smpl));
  const phdr: number[] = [], pbag: number[] = [], pgen: number[] = [];
  presets.forEach((p, i) => {
    phdr.push(...enc(p.name, 20), ...u16(p.program), ...u16(p.bank), ...u16(i), ...u32(0), ...u32(0), ...u32(0));
    pbag.push(...u16(i), ...u16(0));
    pgen.push(...u16(41), ...u16(0));
  });
  phdr.push(...enc('EOP', 20), ...u16(0), ...u16(0), ...u16(presets.length), ...u32(0), ...u32(0), ...u32(0));
  pbag.push(...u16(presets.length), ...u16(0));
  pgen.push(...u16(0), ...u16(0));
  const inst = [...enc('Sine', 20), ...u16(0), ...enc('EOI', 20), ...u16(1)];
  const ibag = [...u16(0), ...u16(0), ...u16(2), ...u16(0)];
  const igen = [...u16(54), ...u16(1), ...u16(53), ...u16(0), ...u16(0), ...u16(0)];
  const shdr = [...enc('sine', 20), ...u32(0), ...u32(frames), ...u32(0), ...u32(frames), ...u32(44100), 69, 0, ...u16(0), ...u16(1),
    ...enc('EOS', 20), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), 0, 0, ...u16(0), ...u16(0)];
  const pdta = list('pdta', chunk('phdr', phdr), chunk('pbag', pbag), chunk('pmod', new Array(10).fill(0)), chunk('pgen', pgen),
    chunk('inst', inst), chunk('ibag', ibag), chunk('imod', new Array(10).fill(0)), chunk('igen', igen), chunk('shdr', shdr));
  const body = [...enc('sfbk', 5).slice(0, 4), ...info, ...sdta, ...pdta];
  return Uint8Array.from([...enc('RIFF', 5).slice(0, 4), ...u32(body.length), ...body]);
}

const PRESETS = [{ name: 'Strings', bank: 0, program: 48 }, { name: 'Piano', bank: 0, program: 0 }, { name: 'Standard Kit', bank: 128, program: 0 }];

function fontOf(): SfFont {
  const r = importSf2(buildSf2('Test Font', PRESETS), 'fallback');
  if ('error' in r) throw new Error(r.error);
  return { ...r.font, sample: 'S' };
}

describe('SoundFont Player editor', () => {
  it('reads the test soundfont like the editor does (name, presets in FL\'s list order)', () => {
    const f = fontOf();
    expect(f.name).toBe('Test Font');
    expect(f.frames).toBe(256 + 46); // the sample points plus the spec's 46 zero points
    const list = presetList(fontHydra(f));
    expect(list.map((e) => `${e.bank}:${e.program}:${e.name}`)).toEqual(['0:0:Piano', '0:48:Strings', '128:0:Standard Kit']);
  });

  async function render(p: Record<string, unknown>): Promise<string> {
    const g = globalThis as Record<string, unknown>;
    g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };
    g.document ??= { body: {}, getElementById: () => null };
    const { FxEditorContext } = await import('../../src/ui/plugins/kit');
    const { editor } = await import('../../src/ui/plugins/gen/soundfont');
    return renderToStaticMarkup(createElement(FxEditorContext.Provider,
      { value: { slotId: 'ch:x', plugin: 'soundfont', params: p, trackName: 'SoundFont', pluginName: 'SoundFont Player' } }, createElement(editor.Editor)));
  }

  it('renders FL\'s layout without a soundfont (the default instance)', async () => {
    const html = await render(normalizeGenParams('soundfont', defaultGenParams('soundfont')));
    for (const t of [
      'PATCH NAME', 'REVERB', 'CHORUS', 'SEND TO', 'LEVEL', 'BUILT-IN', 'ENVELOPE 2', 'LFO 2', 'MISC',
      'DEL', 'AMT', 'SPD', 'CUT', 'MOD', 'SOUNDFONT', 'PLAYER', 'No SoundFont loaded',
    ]) expect(html).toContain(t);
    // A D S R captions, the two SEND TO displays show the dots (no mixer track)
    expect(html.match(/⋯/g)?.length).toBe(2);
    expect(html).not.toContain('Strings');
  }, 60000);

  it('shows the played preset in the patch combo and the name of the active soundfont', async () => {
    const base = normalizeGenParams('soundfont', defaultGenParams('soundfont'));
    const font = fontOf();
    const first = await render({ ...base, fonts: [font], active: 0 });
    expect(first).toContain('Test Font');
    expect(first).toContain('001  Piano');          // patch 1, bank 0
    const strings = await render({ ...base, fonts: [font], active: 0, patch: 49, bank: 0 });
    expect(strings).toContain('049  Strings');
    const drums = await render({ ...base, fonts: [font], active: 0, patch: 129, bank: 0 });  // patch above 128: bank 128
    expect(drums).toContain('128:001  Standard Kit');
    const unknown = await render({ ...base, fonts: [font], active: 0, patch: 100, bank: 5 }); // not in the font: the first entry plays
    expect(unknown).toContain('001  Piano');
    expect(currentPreset(presetList(fontHydra(font)), 100, 5)?.name).toBe('Piano');
  }, 60000);

  it('shows the send routing and the BUILT-IN switches of the state', async () => {
    const base = normalizeGenParams('soundfont', defaultGenParams('soundfont'));
    const html = await render({ ...base, revTo: 3, chorTo: -12, revOn: 1 });
    expect(html).toContain('>3<');
    expect(html).toContain('>-12<');
    expect(html.match(/⋯/g)?.length ?? 0).toBe(0);
    expect(sfState({ ...base, revTo: 999 }).revTo).toBe(125);
  }, 60000);

  it('offers FL\'s menu: open, import, loaded soundfonts, resampling, program mode and the options', async () => {
    const { editor } = await import('../../src/ui/plugins/gen/soundfont');
    const items = editor.menu!('ch:x');
    const labels = items.map((m) => m.label);
    for (const l of [
      'Open SoundFont...', 'Import FL content...', 'Loaded SoundFonts', '(none)', 'Resampling', 'Crunchy', 'Standard', 'HQ', 'Extreme HQ',
      'Program mode', 'Automatic', 'Instrument', 'Drum', 'Other options', 'Velocity filter cutoff', 'EMU volume envelope', 'Fix unexpected levels',
    ]) expect(labels).toContain(l);
    // defaults: Standard resampling, Automatic program mode, all three options on
    const checked = items.filter((m) => m.checked).map((m) => m.label);
    expect(checked).toEqual(['Standard', 'Automatic', 'Velocity filter cutoff', 'EMU volume envelope', 'Fix unexpected levels']);
  }, 60000);
});
